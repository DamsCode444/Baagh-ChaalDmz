// Socket transport, private seats and an immediate preview of unconfirmed moves.
// The room snapshot stays authoritative until the server confirms a move.
const Multiplayer = (() => {
  const KEY = "baagh-chaal-seat-v1";
  const LOBBY_KEY = "baagh-chaal-lobby-v1";
  const state = { room: null, playerId: null, side: null, connected: false, busy: false,
    pending: false, preview: null, operation: "", error: "", available: typeof io === "function" };
  const listeners = new Set();
  let socket = null, credentials = null, enabled = false, connecting = null, cancelConnect = null;
  let lobbyRequest = null, operationId = 0;
  const requestId = () => typeof crypto.randomUUID === "function" ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const messages = {
    ROOM_NOT_FOUND: "This room has expired or does not exist.", ROOM_FULL: "This room already has two players.",
    INVALID_ROOM_CODE: "Enter an 8-character room code.", INVALID_NAME: "Use a name of at most 24 characters.",
    INVALID_SESSION: "Your saved seat could not be verified. Join or create a room.",
    SESSION_EXPIRED: "The reconnect window ended. Reconnect to view the result.",
    ROOM_CLOSED: "This room has closed.", ALREADY_IN_ROOM: "Leave your current room first.",
    NOT_IN_ROOM: "You are no longer in this room.", NOT_YOUR_TURN: "Wait for your turn.",
    ROOM_NOT_ACTIVE: "Wait for both players to connect.", STALE_STATE: "The board changed. Try your move again.",
    STALE_GAME: "A new match has started. Your board has been refreshed.",
    ILLEGAL_MOVE: "That move is not allowed.", INVALID_POSITION: "That position is not valid.", GAME_OVER: "This match has ended.",
    INVALID_REQUEST: "The request was not accepted.", MOVE_ID_REUSED: "Please try a new move.",
    REQUEST_ID_REUSED: "The room request changed. Please try again.",
    OPPONENT_OFFLINE: "Both players must be connected for a rematch.", GAME_NOT_FINISHED: "Finish this match first.",
    RATE_LIMITED: "Too many requests. Please wait a moment.", SERVER_FULL: "The server is full. Try again later.",
    DATABASE_UNAVAILABLE: "The game could not be saved. Please try again.", STATE_CONFLICT: "The board changed. Please reconnect.",
    DATABASE_TIMEOUT: "The database connection timed out. Check that the server's proxy is running, then retry.",
    SERVER_RESTARTING: "The server is restarting. Reconnecting…", TIMEOUT: "The connection is slow. Checking the latest board…",
    OFFLINE: "You are offline. Reconnecting…"
  };
  function notify() { for (const listener of listeners) listener(state); }
  function readSeat() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch { return null; }
  }
  function readLobby() {
    try {
      const value = JSON.parse(sessionStorage.getItem(LOBBY_KEY) || "null");
      return value && ["room:create", "room:join"].includes(value.event) && typeof value.fingerprint === "string"
        && typeof value.data?.requestId === "string" && /^[a-f0-9]{64}$/.test(value.data?.recoveryToken || "") ? value : null;
    } catch { return null; }
  }
  function saveLobby(value) {
    lobbyRequest = value;
    try { if (value) sessionStorage.setItem(LOBBY_KEY, JSON.stringify(value)); else sessionStorage.removeItem(LOBBY_KEY); } catch { /* Retry can still use the in-memory intent. */ }
  }
  function saveSeat(value) {
    credentials = value;
    try { if (value) sessionStorage.setItem(KEY, JSON.stringify(value)); else sessionStorage.removeItem(KEY); } catch { /* In-memory recovery still works. */ }
  }
  function accept(result) {
    if (result.credentials) {
      saveSeat(result.credentials);
      if (result.requestId === lobbyRequest?.data.requestId) { saveLobby(null); state.error = ""; }
    }
    if (result.player) state.playerId = result.player.id;
    if (result.room && (!state.room || state.room.code === result.room.code && result.room.version >= state.room.version)) {
      state.room = result.room;
      if (state.preview && (result.room.gameId !== state.preview.gameId || result.room.version > state.preview.baseVersion)) state.preview = null;
      const me = state.room.players.find(p => p.id === state.playerId);
      state.side = me ? me.side : null;
    }
    if (result.ok === false) state.preview = null;
    notify();
  }
  function raw(event, data) {
    return new Promise((resolve, reject) => {
      if (!socket?.connected) return reject(new Error("OFFLINE"));
      let settled = false;
      const lobby = event === "room:create" || event === "room:join";
      const cleanup = () => { socket.off("disconnect", disconnected); if (lobby) socket.off("room:joined", joined); };
      const fail = code => { if (settled) return; settled = true; cleanup(); reject(new Error(code)); };
      const receive = response => {
        if (settled) return;
        if (!response || typeof response.ok !== "boolean") return fail("INVALID_REQUEST");
        settled = true; cleanup();
        accept(response);
        if (!response.ok) return reject(new Error(response.error));
        resolve(response);
      };
      const disconnected = () => fail("OFFLINE");
      const joined = result => { if (result.requestId === data.requestId) receive(result); };
      socket.once("disconnect", disconnected);
      if (lobby) socket.on("room:joined", joined);
      socket.timeout(12000).emit(event, data, (error, response) => {
        if (error) return fail(socket.connected ? "TIMEOUT" : "OFFLINE");
        receive(response);
      });
    });
  }
  async function resume() {
    const currentOperation = ++operationId;
    state.busy = true; state.operation = "room:resume"; notify();
    try { await raw("room:resume", credentials); state.error = ""; }
    catch (error) {
      state.error = messages[error.message] || "Could not resume this room.";
      if (["ROOM_NOT_FOUND", "INVALID_SESSION", "ROOM_CLOSED"].includes(error.message)) {
        saveSeat(null); state.room = null; state.playerId = null; state.side = null;
      }
    } finally { if (currentOperation === operationId) { state.busy = false; state.operation = ""; notify(); } }
  }
  function ensureSocket() {
    if (socket || !state.available) return;
    socket = io({ autoConnect: false, reconnection: true, transports: ["websocket", "polling"], tryAllTransports: true });
    socket.on("connect", async () => {
      state.connected = true; state.error = ""; notify();
      if (enabled && credentials) await resume();
      else if (enabled && lobbyRequest && !state.busy && !state.pending) await command(lobbyRequest.event, lobbyRequest.data);
    });
    socket.on("disconnect", () => { state.connected = false; state.preview = null; if (enabled) state.error = messages.OFFLINE; notify(); });
    socket.on("connect_error", () => { state.connected = false; state.error = "Could not connect to the game server. Retrying…"; notify(); });
    socket.on("room:state", room => {
      if (state.room?.code === room.code || credentials?.roomId === room.code) accept({ room });
    });
    socket.on("room:joined", result => {
      if (enabled && (result.requestId === lobbyRequest?.data.requestId || result.credentials?.roomId === credentials?.roomId)) accept(result);
    });
    socket.on("room:expired", () => { saveSeat(null); saveLobby(null); state.room = null; state.preview = null; state.side = null; state.playerId = null;
      state.error = messages.ROOM_NOT_FOUND; notify(); });
    socket.on("session:replaced", () => {
      enabled = false; saveSeat(null); saveLobby(null); state.room = null; state.preview = null; state.side = null; state.playerId = null;
      state.error = "Your seat is open in another window. You can create or join another room."; notify();
    });
  }
  async function connect() {
    ensureSocket();
    if (!socket) throw new Error("SERVER_REQUIRED");
    if (socket.connected) return;
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error("OFFLINE")); }, 12000);
      const connected = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timeout); socket.off("connect", connected); connecting = null; cancelConnect = null; };
      cancelConnect = () => { cleanup(); reject(new Error("OFFLINE")); };
      socket.once("connect", connected); socket.connect();
    });
    return connecting;
  }
  async function command(event, data, pending = false, preview = null) {
    if (state.busy || state.pending) return null;
    const currentOperation = ++operationId;
    state.busy = !pending; state.pending = pending; state.preview = preview; state.operation = event; state.error = ""; notify();
    try { await connect(); return await raw(event, data); }
    catch (error) {
      if (currentOperation !== operationId) return null;
      state.preview = null;
      state.error = messages[error.message] || (error.message === "SERVER_REQUIRED"
        ? "Start the game with npm start to play online." : "The request failed. Please try again.");
      const lobby = event === "room:create" || event === "room:join";
      if (lobby) {
        if (error.message === "TIMEOUT") state.error = `${event === "room:create" ? "Creating" : "Joining"} the room could not be confirmed. Click Retry to recover the same request.`;
        if (error.message === "DATABASE_UNAVAILABLE") state.error = `The room could not be ${event === "room:create" ? "created" : "joined"}. Check the server's database connection, then retry.`;
        if (!["TIMEOUT", "OFFLINE", "DATABASE_TIMEOUT", "DATABASE_UNAVAILABLE"].includes(error.message)) saveLobby(null);
      }
      notify();
      if (error.message === "TIMEOUT" && !lobby && state.room && socket?.connected) {
        state.busy = false; state.pending = false; notify();
        try { await raw("room:sync", { roomId: state.room.code }); } catch { /* The next reconnect resynchronizes. */ }
      }
      return null;
    } finally {
      if (currentOperation === operationId) { state.busy = false; state.pending = false; state.preview = null; state.operation = ""; notify(); }
    }
  }
  function lobbyCommand(event, data) {
    if (state.busy || state.pending) return Promise.resolve(null);
    const fingerprint = JSON.stringify(data);
    if (lobbyRequest && (lobbyRequest.event !== event || lobbyRequest.fingerprint !== fingerprint)) {
      state.error = "The previous room request is unconfirmed. Click Retry to recover it first."; notify(); return Promise.resolve(null);
    }
    if (!lobbyRequest) saveLobby({ event, fingerprint, data: { ...data, requestId: requestId(),
      recoveryToken: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("") } });
    return command(event, lobbyRequest.data);
  }
  async function start() {
    enabled = true;
    credentials = readSeat();
    lobbyRequest ||= readLobby();
    if (credentials) state.playerId = credentials.playerId;
    ensureSocket();
    try { await connect(); }
    catch { if (enabled) { state.error = "Start the game with npm start to play online, or check your connection."; notify(); } }
  }
  async function leave() {
    if (state.busy || state.pending) return false;
    if (state.room || credentials) {
      if (!socket?.connected) { state.error = "Reconnect before leaving your seat."; notify(); return false; }
      const response = await command("room:leave", { roomId: state.room?.code || credentials.roomId });
      if (!response && state.room) return false;
    }
    enabled = false; saveLobby(null); cancelConnect?.(); saveSeat(null); state.room = null; state.preview = null; state.playerId = null; state.side = null; state.error = "";
    socket?.disconnect(); state.connected = false; notify(); return true;
  }
  return {
    state, start, leave,
    async retry() {
      if (state.busy || state.pending) return;
      enabled = true; state.error = ""; notify();
      if (lobbyRequest) await command(lobbyRequest.event, lobbyRequest.data);
      else if (socket?.connected && credentials) await resume();
      else await start();
    },
    hasSavedSeat: () => !!readSeat() || !!readLobby(),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    create(side, name) { return lobbyCommand("room:create", { side, name }); },
    join(roomId, name) { return lobbyCommand("room:join", { roomId: roomId.trim().toUpperCase(), name }); },
    move(from, to) {
      if (!state.room || !state.connected || state.busy || state.pending || state.room.status !== "active"
          || state.room.game.turn !== state.side) return Promise.resolve(null);
      const game = { ...state.room.game, board: [...state.room.game.board] };
      let action;
      try { action = Rules.resolveMove(game, { from, to }); }
      catch (error) { state.error = messages[error.code] || "That move is not allowed."; notify(); return Promise.resolve(null); }
      Rules.apply(game, game.turn, action);
      game.turn = game.turn === "goat" ? "tiger" : "goat"; game.lastMove = action;
      // Preview the board only. Wins and draws still come from the server.
      const preview = { game, gameId: state.room.gameId, baseVersion: state.room.version, moveNumber: state.room.moveNumber + 1 };
      return command("game:move", { roomId: state.room.code, gameId: state.room.gameId,
        expectedVersion: state.room.version,
        moveId: requestId(),
        from, to }, true, preview);
    },
    resign() { return state.room && command("game:resign", { roomId: state.room.code, gameId: state.room.gameId }); },
    rematch() { return state.room && command("game:rematch", { roomId: state.room.code, gameId: state.room.gameId }); }
  };
})();
