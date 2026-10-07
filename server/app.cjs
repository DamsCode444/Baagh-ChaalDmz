const express = require("express");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const { Server } = require("socket.io");
const { RoomStore } = require("./store.cjs");
const { RoomService, publicRoom } = require("./rooms.cjs");
const { createLogger, errorDetails } = require("./logging.cjs");

async function createServer(options) {
  const root = options.root || path.resolve(__dirname, "..");
  const logger = options.logger || createLogger({ level: options.logLevel, filePath: options.logFile });
  let store;
  try {
    store = options.store || new RoomStore(options.database, logger);
    logger.info("server.initializing", { route: store.transport?.route, timeoutMs: options.database?.requestTimeoutMs ?? 5000 });
    await store.init();
  } catch (error) {
    logger.error("server.initialization.failed", errorDetails(error));
    if (store) await store.close().catch(() => {});
    await logger.close(); throw error;
  }
  const app = express(); app.disable("x-powered-by");
  app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin"); next(); });
  app.get("/health", (req, res) => res.json({ ok: true, database: "ready" }));
  app.get("/", (req, res) => res.sendFile(path.join(root, "index.html")));
  // Never serve the project root: .env, server files and database stay private.
  for (const dir of ["css", "js", "img"]) app.use(`/${dir}`, express.static(path.join(root, dir), { dotfiles: "deny" }));
  app.use((req, res) => res.status(404).json({ error: "NOT_FOUND" }));
  const httpServer = http.createServer(app);
  const origins = options.allowedOrigins || [];
  const io = new Server(httpServer, {
    maxHttpBufferSize: 8192,
    allowRequest(req, callback) {
      const origin = req.headers.origin;
      let allowed = !origin;
      if (origin) {
        try { allowed = origins.length ? origins.includes(origin) : new URL(origin).host === req.headers.host; }
        catch { allowed = false; }
      }
      if (!allowed) logger.warn("socket.rejected", { error: "ORIGIN_NOT_ALLOWED" });
      callback(null, allowed);
    },
    ...(origins.length ? { cors: { origin: origins } } : {})
  });
  const service = new RoomService(store, io, { ...options, logger });
  try { await service.init(); }
  catch (error) { logger.error("server.roomRestore.failed", errorDetails(error)); await new Promise(resolve => io.close(resolve)); await store.close().catch(() => {}); await logger.close(); throw error; }
  const limits = new Map();
  function withinLimit(socket, event) {
    if (options.rateLimits === false) return true;
    const key = `${socket.handshake.address}:${event === "room:create" ? "create" : "event"}`;
    const now = Date.now(), windowMs = event === "room:create" ? 600000 : 60000;
    let entry = limits.get(key);
    if (!entry || entry.until <= now) { entry = { count: 0, until: now + windowMs }; limits.set(key, entry); }
    return ++entry.count <= (event === "room:create" ? 30 : 120);
  }
  io.on("connection", socket => {
    let commands = Promise.resolve(), queueDepth = 0;
    logger.info("socket.connected", { socket: socket.id, transport: socket.conn.transport.name });
    socket.conn.on("upgrade", transport => logger.info("socket.transport.changed", { socket: socket.id, transport: transport.name }));
    const events = { "room:create": "create", "room:join": "join", "room:resume": "resume", "room:sync": "sync",
      "game:move": "move", "game:resign": "resign", "game:rematch": "rematch", "room:leave": "leave" };
    for (const [event, method] of Object.entries(events)) socket.on(event, (request, ack) => {
      const received = Date.now(), trace = crypto.randomUUID().slice(0, 8);
      const fields = { trace, socket: socket.id, event,
        room: typeof request?.roomId === "string" && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(request.roomId.toUpperCase()) ? request.roomId.toUpperCase() : socket.data.roomCode,
        request: typeof request?.requestId === "string" ? crypto.createHash("sha256").update(request.requestId).digest("hex").slice(0, 12) : undefined };
      logger.info("request.received", { ...fields, queueDepth: ++queueDepth });
      let step = "socket queue";
      const slow = setTimeout(() => logger.warn("request.waiting", { ...fields, step, durationMs: Date.now() - received }), 3000); slow.unref();
      commands = commands.catch(() => {}).then(() => logger.withContext(fields, async () => {
        step = "room operation";
        logger.info("request.started", { waitMs: Date.now() - received, queueDepth });
        const reply = result => {
          logger[result.ok ? "info" : "warn"]("request.completed", { durationMs: Date.now() - received, outcome: result.ok ? "ok" : "error",
            error: result.error, room: result.room?.code || fields.room, version: result.room?.version });
          if (typeof ack === "function") ack(result);
        };
        try {
          if (service.closing) return reply({ ok: false, error: "SERVER_RESTARTING" });
          if (!socket.connected) { logger.warn("request.cancelled", { outcome: "disconnected", durationMs: Date.now() - received }); return; }
          if (!withinLimit(socket, event)) return reply({ ok: false, error: "RATE_LIMITED" });
          try {
            const result = await service[method](socket, request);
            if (["create", "join"].includes(method)) { socket.emit("room:joined", result); logger.info("room.result.sent", { room: result.room.code }); }
            reply(result);
          } catch (error) {
            const known = ["GAME_OVER", "INVALID_POSITION", "ILLEGAL_MOVE"].includes(error.code) || error.constructor.name === "GameError";
            logger[known ? "warn" : "error"]("request.failed", { durationMs: Date.now() - received, ...errorDetails(error) });
            const room = socket.data.roomCode && service.rooms.get(socket.data.roomCode);
            let cause = error, timeout = false;
            for (let depth = 0; cause && depth < 8; depth++, cause = cause.cause) {
              if (cause.name === "TimeoutError") timeout = true;
            }
            reply({ ok: false, error: known ? error.code : timeout ? "DATABASE_TIMEOUT" : "DATABASE_UNAVAILABLE", ...(room ? { room: publicRoom(room) } : {}) });
          }
        } finally {
          clearTimeout(slow); queueDepth--;
        }
      }));
    });
    socket.on("disconnect", reason => {
      logger.info("socket.disconnected", { socket: socket.id, room: socket.data.roomCode, reason });
      logger.withContext({ socket: socket.id, event: "disconnect", room: socket.data.roomCode }, () =>
        service.disconnected(socket).catch(error => logger.error("room.disconnect.failed", errorDetails(error))));
    });
  });
  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return; sweeping = true;
    try { await service.sweep(); }
    catch (error) { logger.error("room.cleanup.failed", errorDetails(error)); }
    finally { sweeping = false; }
    for (const [key, value] of limits) if (value.until <= Date.now()) limits.delete(key);
  }, options.sweepIntervalMs || 1000);
  timer.unref();
  return {
    app, io, httpServer, service, store, logger,
    listen(port = 3000, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => { httpServer.removeListener("error", reject); logger.info("server.ready", { port: httpServer.address().port, rooms: service.rooms.size }); resolve(httpServer.address()); });
      });
    },
    async close() {
      service.closing = true; clearInterval(timer);
      await new Promise(resolve => io.close(resolve));
      await service.drain(); await store.close();
      logger.info("server.stopped"); await logger.close();
    }
  };
}
module.exports = { createServer };
