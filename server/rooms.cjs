const crypto = require("node:crypto");
const Rules = require("../js/rules.js");
const { requireValue, payload } = require("./errors.cjs");
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
function makePlayer(side, name, socketId) {
  const token = crypto.randomBytes(32).toString("hex");
  return { token, player: { id: crypto.randomUUID(), side, name, tokenHash: hash(token),
    socketId, connected: true, left: false, disconnectDeadline: null } };
}

class RoomService {
  constructor(store, io, options = {}) {
    this.store = store; this.io = io; this.rooms = new Map(); this.queues = new Map();
    this.moveReceipts = new Map();
    this.graceMs = options.graceMs || 90000; this.ttlMs = options.roomTtlMs || 86400000;
    this.now = options.now || Date.now; this.closing = false;
  }
  // Every operation on one room is serialized, including async database writes.
  exclusive(code, work) {
    const previous = this.queues.get(code) || Promise.resolve();
    const task = previous.catch(() => {}).then(work);
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
    if (!socket.connected) await this.disconnected(socket);
    return { ok: true, room: publicRoom(room), player: { id: player.id, side: player.side },
      ...(token ? { credentials: { roomId: room.code, playerId: player.id, resumeToken: token } } : {}) };
  }
  async create(socket, request) {
    payload(request, ["side", "name"]);
    requireValue(!socket.data.roomCode, "ALREADY_IN_ROOM");
    requireValue(["goat", "tiger"].includes(request.side), "INVALID_SIDE");
    requireValue(this.rooms.size < 1000, "SERVER_FULL");
    const name = playerName(request.name);
    return this.exclusive("_create", async () => {
      requireValue(!socket.data.roomCode, "ALREADY_IN_ROOM");
      requireValue(this.rooms.size < 1000, "SERVER_FULL");
      let code;
      do { code = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join(""); }
      while (this.rooms.has(code) || await this.store.get(code));
      const { token, player } = makePlayer(request.side, name, socket.id);
      const now = this.now();
      const room = { code, gameId: crypto.randomUUID(), status: "waiting", version: 0, moveNumber: 0,
        players: [player], game: Rules.newGame(), rematchVotes: [], startedAt: null, finishedAt: null,
        createdAt: now, updatedAt: now, expiresAt: now + this.ttlMs };
      await this.store.create(room); this.rooms.set(code, room);
      return this.bind(socket, room, player, token);
    });
  }
  async join(socket, request) {
    payload(request, ["roomId", "name"]);
    requireValue(!socket.data.roomCode, "ALREADY_IN_ROOM");
    const code = roomCode(request.roomId), name = playerName(request.name);
    return this.exclusive(code, async () => {
      requireValue(!socket.data.roomCode, "ALREADY_IN_ROOM");
      const saved = this.get(code);
      requireValue(saved.players.length < 2, "ROOM_FULL");
      requireValue(saved.status === "waiting", "ROOM_CLOSED");
      const room = clone(saved);
      const side = room.players[0].side === "goat" ? "tiger" : "goat";
      const { token, player } = makePlayer(side, name, socket.id);
      room.players.push(player); room.startedAt = this.now();
      room.status = room.players.every(p => p.connected) ? "active" : "paused";
      if (room.status === "paused") for (const p of room.players) if (!p.connected) p.disconnectDeadline = this.now() + this.graceMs;
      await this.commit(room, saved.version);
      return this.bind(socket, room, player, token);
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
  async drain() { await Promise.allSettled([...this.queues.values()]); }
}
module.exports = { RoomService, publicRoom, roomCode };
