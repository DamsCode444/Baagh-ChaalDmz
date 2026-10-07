const express = require("express");
const http = require("node:http");
const path = require("node:path");
const { Server } = require("socket.io");
const { RoomStore } = require("./store.cjs");
const { RoomService, publicRoom } = require("./rooms.cjs");

async function createServer(options) {
  const root = options.root || path.resolve(__dirname, "..");
  const store = options.store || new RoomStore(options.database);
  try { await store.init(); }
  catch (error) { await store.close().catch(() => {}); throw error; }
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
      callback(null, allowed);
    },
    ...(origins.length ? { cors: { origin: origins } } : {})
  });
  const service = new RoomService(store, io, options);
  try { await service.init(); }
  catch (error) { await new Promise(resolve => io.close(resolve)); await store.close().catch(() => {}); throw error; }
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
    let commands = Promise.resolve();
    const events = { "room:create": "create", "room:join": "join", "room:resume": "resume", "room:sync": "sync",
      "game:move": "move", "game:resign": "resign", "game:rematch": "rematch", "room:leave": "leave" };
    for (const [event, method] of Object.entries(events)) socket.on(event, (request, ack) => {
      commands = commands.catch(() => {}).then(async () => {
      const reply = typeof ack === "function" ? ack : () => {};
      if (service.closing) return reply({ ok: false, error: "SERVER_RESTARTING" });
      if (!withinLimit(socket, event)) return reply({ ok: false, error: "RATE_LIMITED" });
      try {
        const result = await service[method](socket, request);
        if (["create", "join"].includes(method)) socket.emit("room:joined", result);
        reply(result);
      } catch (error) {
        const known = ["GAME_OVER", "INVALID_POSITION", "ILLEGAL_MOVE"].includes(error.code) || error.constructor.name === "GameError";
        if (!known) console.error("Room operation failed:", error.code || error.name);
        const room = socket.data.roomCode && service.rooms.get(socket.data.roomCode);
        reply({ ok: false, error: known ? error.code : "DATABASE_UNAVAILABLE", ...(room ? { room: publicRoom(room) } : {}) });
      }
      });
    });
    socket.on("disconnect", () => { service.disconnected(socket).catch(error => console.error("Disconnect save failed:", error.code || error.name)); });
  });
  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return; sweeping = true;
    try { await service.sweep(); }
    catch (error) { console.error("Room cleanup failed:", error.code || error.name); }
    finally { sweeping = false; }
    for (const [key, value] of limits) if (value.until <= Date.now()) limits.delete(key);
  }, options.sweepIntervalMs || 1000);
  timer.unref();
  return {
    app, io, httpServer, service, store,
    listen(port = 3000, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => { httpServer.removeListener("error", reject); resolve(httpServer.address()); });
      });
    },
    async close() {
      service.closing = true; clearInterval(timer);
      await new Promise(resolve => io.close(resolve));
      await service.drain(); await store.close();
    }
  };
}
module.exports = { createServer };
