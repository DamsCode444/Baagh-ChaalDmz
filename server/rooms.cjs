const crypto = require("node:crypto");
const Rules = require("../js/rules.js");
const { requireValue, payload } = require("./errors.cjs");
const { silentLogger, errorDetails } = require("./logging.cjs");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const channel = code => `game:${code}`;
const hash = token => crypto.createHash("sha256").update(token).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));

function publicRoom(room) {
  const { positionCounts, ...game } = room.game;
  return {
    code: room.code, gameId: room.gameId, status: room.status, version: room.version,
    moveNumber: room.moveNumber, game, updatedAt: room.updatedAt, expiresAt: room.expiresAt,
    players: room.players.map(p => ({ id: p.id, name: p.name, side: p.side,
      connected: p.connected, left: p.left, disconnectDeadline: p.disconnectDeadline })),
    rematchVotes: [...room.rematchVotes]
  };
}
function roomCode(value) {
  requireValue(typeof value === "string", "INVALID_ROOM_CODE");
  const code = value.trim().toUpperCase();
  requireValue(code.length === 8 && [...code].every(c => ALPHABET.includes(c)), "INVALID_ROOM_CODE");
  return code;
}
function playerName(value) {
  if (value === undefined || value === "") return "Player";
  requireValue(typeof value === "string" && value.trim().length <= 24, "INVALID_NAME");
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "") || "Player";
}
function makePlayer(side, name, socketId, recoveryToken) {
  const token = recoveryToken || crypto.randomBytes(32).toString("hex");
  return { token, player: { id: crypto.randomUUID(), side, name, tokenHash: hash(token),
    socketId, connected: true, left: false, disconnectDeadline: null } };
}
function lobbyRequest(request) {
  requireValue(request.requestId === undefined || typeof request.requestId === "string"
    && /^[a-zA-Z0-9_-]{8,80}$/.test(request.requestId), "INVALID_REQUEST");
  requireValue(request.recoveryToken === undefined || typeof request.requestId === "string"
    && typeof request.recoveryToken === "string" && /^[a-f0-9]{64}$/.test(request.recoveryToken), "INVALID_REQUEST");
}

class RoomService {
  constructor(store, io, options = {}) {
    this.store = store; this.io = io; this.rooms = new Map(); this.queues = new Map();
    this.moveReceipts = new Map();
    this.creatingRooms = 0;
    this.logger = options.logger || silentLogger;
    this.lobbyAttempts = new Map();
    this.graceMs = options.graceMs || 90000; this.ttlMs = options.roomTtlMs || 86400000;
    this.now = options.now || Date.now; this.closing = false;
  }
  // Every operation on one room is serialized, including async database writes.
  exclusive(code, work) {
    const previous = this.queues.get(code) || Promise.resolve();
    const waiting = this.queues.has(code), received = Date.now();
    if (waiting) this.logger.info("room.queued", { room: code.startsWith("_create:") ? undefined : code });
    const task = previous.catch(() => {}).then(() => {
      if (waiting) this.logger.info("room.queue.started", { room: code.startsWith("_create:") ? undefined : code, waitMs: Date.now() - received });
      return work();
    });
    this.queues.set(code, task);
    const cleanup = () => { if (this.queues.get(code) === task) this.queues.delete(code); };
    task.then(cleanup, cleanup);
    return task;
  }
  async init() {
    const now = this.now();
    await this.store.purgeExpired(now);
    for (const saved of await this.store.loadAll(now)) {
      this.rooms.set(saved.code, saved);
      const room = clone(saved);
      for (const player of room.players) {
        player.connected = false; player.socketId = null;
        if (!player.left && ["active", "paused"].includes(room.status)) {
          player.disconnectDeadline = player.disconnectDeadline || now + this.graceMs;
        }
      }
      if (["active", "paused"].includes(room.status)) room.status = "paused";
      await this.commit(room, saved.version, null, false);
    }
  }
  get(code) {
    const room = this.rooms.get(code);
    requireValue(room && room.expiresAt > this.now(), "ROOM_NOT_FOUND");
    return room;
  }
  member(socket, request) {
    requireValue(socket.data.roomCode && socket.data.playerId, "NOT_IN_ROOM");
    const room = this.get(socket.data.roomCode);
    if (request.roomId !== undefined) requireValue(roomCode(request.roomId) === room.code, "NOT_IN_ROOM");
    const player = room.players.find(p => p.id === socket.data.playerId);
    requireValue(player && !player.left && player.connected && player.socketId === socket.id, "NOT_IN_ROOM");
    return { room, player };
  }
  receiptKey(code, gameId, playerId, moveId) { return JSON.stringify([code, gameId, playerId, moveId]); }
  rememberMove(room, move, response) {
    const key = this.receiptKey(room.code, room.gameId, move.playerId, move.id);
    this.moveReceipts.set(key, { request: move.request, response });
    if (this.moveReceipts.size > 1024) this.moveReceipts.delete(this.moveReceipts.keys().next().value);
  }
  previousLobby(socket, event, request, fingerprint) {
    if (!socket.data.roomCode) return null;
    const previous = socket.data.lobbyResult;
    if (previous?.event === event && previous.requestId === request.requestId) {
      requireValue(previous.fingerprint === fingerprint, "REQUEST_ID_REUSED");
      const { room, player } = this.member(socket, { roomId: previous.result.room.code });
      return { ...previous.result, room: publicRoom(room), player: { id: player.id, side: player.side } };
    }
    requireValue(false, "ALREADY_IN_ROOM");
  }
  async bindLobby(socket, event, request, fingerprint, room, player, token) {
    const result = { ...await this.bind(socket, room, player, token),
      ...(request.requestId ? { requestId: request.requestId } : {}) };
    socket.data.lobbyResult = { event, requestId: request.requestId, fingerprint, result };
    if (request.recoveryToken) this.lobbyAttempts.delete(`${event}:${request.requestId}`);
    return result;
  }
  rememberLobby(event, request, fingerprint, room, player) {
    if (!request.recoveryToken) return;
    player.lobbyRequest = { id: request.requestId, event, fingerprint };
    this.lobbyAttempts.set(`${event}:${request.requestId}`, { room: clone(room), playerId: player.id });
    if (this.lobbyAttempts.size > 1024) this.lobbyAttempts.delete(this.lobbyAttempts.keys().next().value);
  }
  async recoverLobby(socket, event, request, fingerprint, ownsRoomQueue = false) {
    if (!request.recoveryToken) return null;
    const key = `${event}:${request.requestId}`, attempted = this.lobbyAttempts.get(key);
    if (event === "room:create" && !ownsRoomQueue) {
      // Creation has its own queue, but recovering an existing seat must also
      // serialize with joins, moves and disconnects in that room.
      const code = attempted?.room.code || [...this.rooms.values()].find(room => room.players.some(player =>
        player.lobbyRequest?.id === request.requestId && player.lobbyRequest.event === event))?.code;
      return code ? this.exclusive(code, () => this.recoverLobby(socket, event, request, fingerprint, true)) : null;
    }
    if (attempted) {
      const player = attempted.room.players.find(p => p.id === attempted.playerId);
      requireValue(player?.tokenHash === hash(request.recoveryToken), "INVALID_SESSION");
      requireValue(player.lobbyRequest.fingerprint === fingerprint, "REQUEST_ID_REUSED");
      // A retry after a lost database response must check the original room.
      const current = await this.store.get(attempted.room.code);
      if (current) this.rooms.set(current.code, current);
    }
    const saved = [...this.rooms.values()].find(room => room.players.some(player => player.lobbyRequest?.id === request.requestId
      && player.lobbyRequest.event === event));
    if (!saved) return null;
    const found = saved.players.find(player => player.lobbyRequest?.id === request.requestId && player.lobbyRequest.event === event);
    requireValue(found.tokenHash === hash(request.recoveryToken), "INVALID_SESSION");
    requireValue(found.lobbyRequest.fingerprint === fingerprint, "REQUEST_ID_REUSED");
    requireValue(!found.left && saved.status !== "closed", "ROOM_CLOSED");
    requireValue(saved.expiresAt > this.now(), "ROOM_NOT_FOUND");
    requireValue(saved.status !== "paused" || found.disconnectDeadline === null || found.disconnectDeadline > this.now(), "SESSION_EXPIRED");
    const room = clone(saved), player = room.players.find(p => p.id === found.id);
    const oldSocket = player.socketId && this.io.sockets.sockets.get(player.socketId);
    player.connected = true; player.socketId = socket.id; player.disconnectDeadline = null;
    if (room.status === "paused" && room.players.every(p => p.connected && !p.left)) room.status = "active";
    await this.commit(room, saved.version);
    if (oldSocket && oldSocket.id !== socket.id) { oldSocket.data = {}; oldSocket.emit("session:replaced"); oldSocket.disconnect(true); }
    this.logger.info("room.seat.recovered", { room: room.code });
    return this.bindLobby(socket, event, request, fingerprint, room, player, request.recoveryToken);
  }
  async commit(room, expectedVersion, move = null, renewExpiry = true) {
    room.version = expectedVersion + 1; room.updatedAt = this.now();
    if (renewExpiry) room.expiresAt = room.updatedAt + this.ttlMs;
    const response = { ok: true, room: publicRoom(room) };
    if (move) move.response = response;
    try { await this.store.save(room, expectedVersion, move); }
    catch (error) {
      // Recover a lost commit response from confirmed stored state.
      // Uncertain writes are never blindly replayed.
      let accepted;
      try {
        const current = await this.store.get(room.code);
        if (current && current.version !== expectedVersion) {
          this.rooms.set(room.code, current);
          this.io.to(channel(room.code)).emit("room:state", publicRoom(current));
          if (!move && JSON.stringify(current) === JSON.stringify(room)) return { ok: true, room: publicRoom(current) };
        }
        if (move) accepted = await this.store.findMove(room.gameId, move.playerId, move.id);
      } catch { /* Preserve the original error when recovery is unavailable. */ }
      if (accepted) {
        requireValue(accepted.request === move.request, "MOVE_ID_REUSED");
        this.rememberMove(room, move, accepted.response);
        return accepted.response;
      }
      throw error;
    }
    this.rooms.set(room.code, room);
    if (move) this.rememberMove(room, move, response);
    this.io.to(channel(room.code)).emit("room:state", response.room);
    return response;
  }
  async bind(socket, room, player, token) {
    socket.data.roomCode = room.code; socket.data.playerId = player.id;
    await socket.join(channel(room.code));
    if (!socket.connected) {
      // bind runs inside the room queue. Awaiting another operation in that
      // queue would wait for this very operation and permanently deadlock it.
      this.logger.warn("room.bind.disconnected", { room: room.code });
      this.disconnected(socket).catch(error => this.logger.error("room.disconnect.failed", { room: room.code, ...errorDetails(error) }));
    }
    return { ok: true, room: publicRoom(room), player: { id: player.id, side: player.side },
      ...(token ? { credentials: { roomId: room.code, playerId: player.id, resumeToken: token } } : {}) };
  }
  async create(socket, request) {
    payload(request, ["side", "name", "requestId", "recoveryToken"]); lobbyRequest(request);
    requireValue(["goat", "tiger"].includes(request.side), "INVALID_SIDE");
    const name = playerName(request.name);
    const fingerprint = JSON.stringify({ side: request.side, name });
    // Independent creations must not wait behind another user's database call.
    return this.exclusive(`_create:${request.recoveryToken ? request.requestId + ":" + hash(request.recoveryToken) : socket.id}`, async () => {
      const previous = this.previousLobby(socket, "room:create", request, fingerprint);
      if (previous) return previous;
      requireValue(socket.connected, "OFFLINE");
      const recovered = await this.recoverLobby(socket, "room:create", request, fingerprint);
      if (recovered) return recovered;
      requireValue(this.rooms.size + this.creatingRooms < 1000, "SERVER_FULL");
      this.creatingRooms++;
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const key = `room:create:${request.requestId}`, pending = request.recoveryToken && this.lobbyAttempts.get(key);
          const code = pending?.room.code || Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
          if (this.rooms.has(code)) { if (pending) this.lobbyAttempts.delete(key); continue; }
          const seat = makePlayer(request.side, name, socket.id, request.recoveryToken), now = this.now();
          const room = pending ? clone(pending.room) : { code, gameId: crypto.randomUUID(), status: "waiting", version: 0, moveNumber: 0,
            players: [seat.player], game: Rules.newGame(), rematchVotes: [], startedAt: null, finishedAt: null,
            createdAt: now, updatedAt: now, expiresAt: now + this.ttlMs };
          const player = room.players[0], token = request.recoveryToken || seat.token;
          this.rememberLobby("room:create", request, fingerprint, room, player);
          let created;
          try { created = await this.store.create(room); }
          catch (error) {
            // A dropped response may hide a successful INSERT. Recover that
            // exact room before returning an error or trying another code.
            let confirmed;
            try { confirmed = await this.store.get(code); } catch { /* Preserve the original failure. */ }
            if (!confirmed || JSON.stringify(confirmed) !== JSON.stringify(room)) throw error;
            created = true;
          }
          if (!created) {
            if (pending) { const recovered = await this.recoverLobby(socket, "room:create", request, fingerprint); if (recovered) return recovered; }
            this.lobbyAttempts.delete(key); continue; // A confirmed primary-key collision.
          }
          this.rooms.set(code, room);
          if (pending && player.socketId !== socket.id) return this.recoverLobby(socket, "room:create", request, fingerprint);
          return this.bindLobby(socket, "room:create", request, fingerprint, room, player, token);
        }
        requireValue(false, "SERVER_FULL");
      } finally { this.creatingRooms--; }
    });
  }
  async join(socket, request) {
    payload(request, ["roomId", "name", "requestId", "recoveryToken"]); lobbyRequest(request);
    const code = roomCode(request.roomId), name = playerName(request.name);
    const fingerprint = JSON.stringify({ roomId: code, name });
    return this.exclusive(code, async () => {
      const previous = this.previousLobby(socket, "room:join", request, fingerprint);
      if (previous) return previous;
      requireValue(socket.connected, "OFFLINE");
      const recovered = await this.recoverLobby(socket, "room:join", request, fingerprint);
      if (recovered) return recovered;
      const saved = this.get(code);
      requireValue(saved.players.length < 2, "ROOM_FULL");
      requireValue(saved.status === "waiting", "ROOM_CLOSED");
      const room = clone(saved);
      const side = room.players[0].side === "goat" ? "tiger" : "goat";
      const { token, player } = makePlayer(side, name, socket.id, request.recoveryToken);
      room.players.push(player); room.startedAt = this.now();
      room.status = room.players.every(p => p.connected) ? "active" : "paused";
      if (room.status === "paused") for (const p of room.players) if (!p.connected) p.disconnectDeadline = this.now() + this.graceMs;
      this.rememberLobby("room:join", request, fingerprint, room, player);
      await this.commit(room, saved.version);
      return this.bindLobby(socket, "room:join", request, fingerprint, room, player, token);
    });
  }
  async resume(socket, request) {
    payload(request, ["roomId", "playerId", "resumeToken"]);
    const code = roomCode(request.roomId);
    requireValue(!socket.data.roomCode || socket.data.roomCode === code, "ALREADY_IN_ROOM");
    requireValue(typeof request.playerId === "string" && typeof request.resumeToken === "string"
      && /^[a-f0-9]{64}$/.test(request.resumeToken), "INVALID_SESSION");
    return this.exclusive(code, async () => {
      const saved = this.get(code);
      const found = saved.players.find(p => p.id === request.playerId && !p.left);
      requireValue(found && crypto.timingSafeEqual(Buffer.from(found.tokenHash, "hex"), Buffer.from(hash(request.resumeToken), "hex")), "INVALID_SESSION");
      requireValue(saved.status !== "closed", "ROOM_CLOSED");
      requireValue(saved.status !== "paused" || found.disconnectDeadline === null || found.disconnectDeadline > this.now(), "SESSION_EXPIRED");
      const room = clone(saved), player = room.players.find(p => p.id === found.id);
      const oldSocket = player.socketId && this.io.sockets.sockets.get(player.socketId);
      player.connected = true; player.socketId = socket.id; player.disconnectDeadline = null;
      if (room.status === "paused" && room.players.every(p => p.connected && !p.left)) room.status = "active";
      await this.commit(room, saved.version);
      if (oldSocket && oldSocket.id !== socket.id) {
        oldSocket.data = {}; oldSocket.emit("session:replaced"); oldSocket.disconnect(true);
      }
      return this.bind(socket, room, player);
    });
  }
  async sync(socket, request) {
    payload(request, ["roomId"]);
    const { room, player } = this.member(socket, request);
    return { ok: true, room: publicRoom(room), player: { id: player.id, side: player.side } };
  }
  async move(socket, request) {
    payload(request, ["roomId", "gameId", "expectedVersion", "moveId", "from", "to"]);
    requireValue(typeof request.gameId === "string" && typeof request.moveId === "string"
      && /^[a-zA-Z0-9_-]{8,80}$/.test(request.moveId) && Number.isSafeInteger(request.expectedVersion)
      && request.expectedVersion >= 0, "INVALID_REQUEST");
    const code = socket.data.roomCode;
    requireValue(code, "NOT_IN_ROOM");
    return this.exclusive(code, async () => {
      const { room: saved, player } = this.member(socket, request);
      requireValue(saved.gameId === request.gameId, "STALE_GAME");
      const fingerprint = JSON.stringify({ from: request.from, to: request.to, expectedVersion: request.expectedVersion });
      const key = this.receiptKey(saved.code, saved.gameId, player.id, request.moveId);
      // A new move at the current version cannot be an old accepted request.
      // Durable receipts are needed only for retries from earlier versions.
      // Reused IDs are still protected by the transaction's unique constraint.
      const previous = this.moveReceipts.get(key) || (request.expectedVersion !== saved.version
        ? await this.store.findMove(saved.gameId, player.id, request.moveId) : null);
      if (previous) {
        requireValue(previous.request === fingerprint, "MOVE_ID_REUSED");
        if (previous.response.room.version > saved.version) {
          const current = await this.store.get(saved.code);
          if (current) { this.rooms.set(saved.code, current); this.io.to(channel(saved.code)).emit("room:state", publicRoom(current)); }
        }
        return previous.response;
      }
      requireValue(saved.status === "active", "ROOM_NOT_ACTIVE");
      requireValue(saved.version === request.expectedVersion, "STALE_STATE");
      requireValue(saved.game.turn === player.side, "NOT_YOUR_TURN");
      const room = clone(saved);
      const action = Rules.play(room.game, { from: request.from, to: request.to });
      room.moveNumber++;
      if (room.game.winner) { room.status = "finished"; room.finishedAt = this.now(); }
      return this.commit(room, saved.version, { playerId: player.id, id: request.moveId, request: fingerprint, action });
    });
  }
  finish(room, winner, reason) {
    room.game.winner = winner; room.game.resultReason = reason;
    room.status = "finished"; room.finishedAt = this.now(); room.rematchVotes = [];
  }
  async resign(socket, request) {
    payload(request, ["roomId", "gameId"]);
    const code = socket.data.roomCode; requireValue(code, "NOT_IN_ROOM");
    return this.exclusive(code, async () => {
      const { room: saved, player } = this.member(socket, request);
      requireValue(saved.gameId === request.gameId, "STALE_GAME");
      requireValue(["active", "paused"].includes(saved.status), "ROOM_NOT_ACTIVE");
      const room = clone(saved);
      this.finish(room, player.side === "tiger" ? "Goats" : "Tigers", "resignation");
      return this.commit(room, saved.version);
    });
  }
  async rematch(socket, request) {
    payload(request, ["roomId", "gameId"]);
    const code = socket.data.roomCode; requireValue(code, "NOT_IN_ROOM");
    return this.exclusive(code, async () => {
      const { room: saved, player } = this.member(socket, request);
      requireValue(saved.gameId === request.gameId, "STALE_GAME");
      requireValue(saved.status === "finished", "GAME_NOT_FINISHED");
      requireValue(saved.players.length === 2 && saved.players.every(p => p.connected && !p.left), "OPPONENT_OFFLINE");
      if (saved.rematchVotes.includes(player.id)) return { ok: true, room: publicRoom(saved) };
      const room = clone(saved); room.rematchVotes.push(player.id);
      if (room.rematchVotes.length === 2) {
        room.game = Rules.newGame(); room.gameId = crypto.randomUUID(); room.moveNumber = 0;
        room.status = "active"; room.startedAt = this.now(); room.finishedAt = null; room.rematchVotes = [];
        for (const p of room.players) p.side = p.side === "goat" ? "tiger" : "goat";
      }
      return this.commit(room, saved.version);
    });
  }
  async leave(socket, request) {
    payload(request, ["roomId"]);
    const code = socket.data.roomCode; requireValue(code, "NOT_IN_ROOM");
    return this.exclusive(code, async () => {
      const { room: saved, player: original } = this.member(socket, request);
      const room = clone(saved), player = room.players.find(p => p.id === original.id);
      if (["active", "paused"].includes(room.status)) this.finish(room, player.side === "tiger" ? "Goats" : "Tigers", "resignation");
      if (room.status === "waiting") room.status = "closed";
      player.left = true; player.connected = false; player.socketId = null; player.disconnectDeadline = null;
      if (room.players.every(p => p.left)) room.status = "closed";
      const response = await this.commit(room, saved.version);
      await socket.leave(channel(code)); socket.data = {};
      return response;
    });
  }
  async disconnected(socket) {
    if (this.closing || !socket.data.roomCode) return;
    const code = socket.data.roomCode, id = socket.data.playerId;
    return this.exclusive(code, async () => {
      const saved = this.rooms.get(code);
      if (!saved) return;
      const original = saved.players.find(p => p.id === id);
      if (!original || original.socketId !== socket.id || original.left) return;
      const room = clone(saved), player = room.players.find(p => p.id === id);
      player.connected = false; player.socketId = null;
      if (["active", "paused"].includes(room.status)) {
        player.disconnectDeadline = this.now() + this.graceMs; room.status = "paused";
      }
      room.rematchVotes = [];
      await this.commit(room, saved.version);
    });
  }
  async sweep() {
    if (this.closing) return;
    const now = this.now();
    for (const [code, candidate] of this.rooms) {
      if (this.closing) break;
      if (candidate.expiresAt > now && !(candidate.status === "paused" && candidate.players.some(p => !p.connected && p.disconnectDeadline !== null && p.disconnectDeadline <= now))) continue;
      await this.exclusive(code, async () => {
        const saved = this.rooms.get(code); if (!saved) return;
        if (saved.expiresAt <= this.now()) {
          await this.store.remove(code); this.rooms.delete(code);
          for (const socket of this.io.sockets.sockets.values()) if (socket.data.roomCode === code) {
            socket.data = {}; await socket.leave(channel(code)); socket.emit("room:expired");
          }
          return;
        }
        if (saved.status !== "paused") return;
        const expired = saved.players.filter(p => !p.connected && p.disconnectDeadline !== null && p.disconnectDeadline <= this.now());
        if (!expired.length) return;
        const room = clone(saved), online = room.players.find(p => p.connected && !p.left);
        this.finish(room, online ? (online.side === "tiger" ? "Tigers" : "Goats") : "Draw", online ? "disconnect" : "abandoned");
        await this.commit(room, saved.version);
      });
    }
  }
  async drain() {
    // A binding can enqueue disconnect cleanup while its operation completes.
    // Include that follow-up work before shutdown closes the database.
    while (this.queues.size) await Promise.allSettled([...this.queues.values()]);
  }
}
module.exports = { RoomService, publicRoom, roomCode };
