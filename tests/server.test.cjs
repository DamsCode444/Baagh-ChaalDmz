const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { io } = require("socket.io-client");
const { createServer } = require("../server/app.cjs");

async function waitFor(check, timeout = 5000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error("Condition timed out"); await new Promise(r => setTimeout(r, 15)); }
}
async function fixture(t, options = {}) {
  const server = await createServer({ database: { url: ":memory:" }, rateLimits: false, ...options });
  const address = await server.listen(0, "127.0.0.1"), url = `http://127.0.0.1:${address.port}`, clients = [];
  t.after(async () => { for (const client of clients) client.disconnect(); await server.close(); });
  async function client() {
    const socket = io(url, { transports: ["websocket"], reconnection: false }); clients.push(socket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    socket.on("room:state", room => { socket.room = room; });
    return socket;
  }
  return { server, url, client };
}
const request = (socket, event, payload) => new Promise((resolve, reject) => {
  socket.timeout(5000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
});
async function pair(f) {
  const a = await f.client(), b = await f.client();
  const created = await request(a, "room:create", { side: "goat", name: "A" }); assert(created.ok);
  const joined = await request(b, "room:join", { roomId: created.room.code, name: "B" }); assert(joined.ok);
  await waitFor(() => a.room?.version === joined.room.version);
  return { a, b, created, joined, room: joined.room };
}
function move(room, from, to) { return { roomId: room.code, gameId: room.gameId, expectedVersion: room.version, moveId: crypto.randomUUID(), from, to }; }

test("rooms assign opposite sides, reject a third player and keep credentials private", async t => {
  const f = await fixture(t), p = await pair(f), third = await f.client();
  assert.equal(p.created.player.side, "goat"); assert.equal(p.joined.player.side, "tiger");
  assert.equal(p.room.status, "active");
  assert.equal((await request(third, "room:join", { roomId: p.room.code })).error, "ROOM_FULL");
  const serialized = JSON.stringify(p.room);
  assert(!serialized.includes("token")); assert(!serialized.includes("socketId")); assert(!serialized.includes("positionCounts"));
  assert.equal((await request(third, "room:sync", { roomId: p.room.code })).error, "NOT_IN_ROOM");
});
test("moves validate ownership, shape, legal destinations and stale versions", async t => {
  const f = await fixture(t), p = await pair(f), before = JSON.stringify(p.room.game);
  assert.equal((await request(p.b, "game:move", move(p.room, 0, 1))).error, "NOT_YOUR_TURN");
  assert.equal((await request(p.a, "game:move", move(p.room, null, 0))).error, "ILLEGAL_MOVE");
  assert.equal((await request(p.a, "game:move", { ...move(p.room, null, 12), over: 1 })).error, "INVALID_REQUEST");
  assert.equal((await request(p.a, "game:move", move(p.room, null, 25))).error, "INVALID_POSITION");
  assert.equal(JSON.stringify(f.server.service.rooms.get(p.room.code).game.board), JSON.stringify(p.room.game.board));
  const accepted = await request(p.a, "game:move", move(p.room, null, 12)); assert(accepted.ok);
  assert.equal(accepted.room.game.goatsInHand, 19); assert.equal(accepted.room.game.turn, "tiger");
  await waitFor(() => p.b.room?.version === accepted.room.version);
  assert.deepEqual(p.a.room.game, p.b.room.game);
  assert.equal((await request(p.b, "game:move", move(p.room, 0, 1))).error, "STALE_STATE");
  assert.notEqual(JSON.stringify(accepted.room.game), before);
});
test("duplicate moves acknowledge once, including retries after another move", async t => {
  const f = await fixture(t), p = await pair(f), action = move(p.room, null, 12);
  const first = await request(p.a, "game:move", action), duplicate = await request(p.a, "game:move", action);
  assert.deepEqual(duplicate, first);
  const second = await request(p.b, "game:move", move(first.room, 0, 1)); assert(second.ok);
  assert.deepEqual(await request(p.a, "game:move", action), first);
  assert.equal((await request(p.a, "game:move", { ...action, to: 13 })).error, "MOVE_ID_REUSED");
  assert.equal(f.server.service.rooms.get(p.room.code).moveNumber, 2);
  const result = await f.server.store.client.execute("SELECT COUNT(*) AS count FROM baagh_chaal_moves");
  assert.equal(Number(result.rows[0].count), 2);
});

test("new moves skip receipt reads while evicted and restarted receipts still reject reused IDs", async t => {
  const f = await fixture(t), p = await pair(f), action = move(p.room, null, 12);
  const findMove = f.server.store.findMove.bind(f.server.store); let reads = 0;
  f.server.store.findMove = (...args) => { reads++; return findMove(...args); };
  const first = await request(p.a, "game:move", action); assert(first.ok); assert.equal(reads, 0);
  assert.deepEqual(await request(p.a, "game:move", action), first); assert.equal(reads, 0);
  f.server.service.moveReceipts.clear();
  assert.deepEqual(await request(p.a, "game:move", action), first); assert.equal(reads, 1);
  const second = await request(p.b, "game:move", move(first.room, 0, 1)); assert(second.ok);
  assert.equal(reads, 1);
  const reused = await request(p.a, "game:move", { ...move(second.room, null, 13), moveId: action.moveId });
  assert.equal(reused.error, "MOVE_ID_REUSED");
  assert.equal(f.server.service.rooms.get(p.room.code).moveNumber, 2);
  assert.equal((await f.server.store.get(p.room.code)).game.board[13], null);
});
test("concurrent moves cannot apply twice", async t => {
  const f = await fixture(t), p = await pair(f);
  const results = await Promise.all([request(p.a, "game:move", move(p.room, null, 12)), request(p.a, "game:move", move(p.room, null, 13))]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(f.server.service.rooms.get(p.room.code).moveNumber, 1);
});
test("a single socket cannot concurrently join two rooms", async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client(), c = await f.client();
  const r1 = await request(a, "room:create", { side: "goat" }), r2 = await request(b, "room:create", { side: "goat" });
  const results = await Promise.all([request(c, "room:join", { roomId: r1.room.code }), request(c, "room:join", { roomId: r2.room.code })]);
  assert.equal(results.filter(r => r.ok).length, 1);
});
test("disconnect pauses play and a valid private token restores the same seat", async t => {
  const f = await fixture(t), p = await pair(f); p.b.disconnect();
  await waitFor(() => p.a.room?.status === "paused");
  assert.equal((await request(p.a, "game:move", move(p.a.room, null, 12))).error, "ROOM_NOT_ACTIVE");
  const replacement = await f.client();
  assert.equal((await request(replacement, "room:resume", { ...p.joined.credentials, resumeToken: "0".repeat(64) })).error, "INVALID_SESSION");
  const resumed = await request(replacement, "room:resume", p.joined.credentials); assert(resumed.ok);
  assert.equal(resumed.player.id, p.joined.player.id); assert.equal(resumed.room.status, "active");
  await waitFor(() => p.a.room?.status === "active");
});
test("refresh replaces an old connection without marking the new seat offline", async t => {
  const f = await fixture(t), p = await pair(f), replacement = await f.client();
  const resumed = await request(replacement, "room:resume", p.joined.credentials); assert(resumed.ok);
  await waitFor(() => !p.b.connected);
  await f.server.service.drain();
  const room = f.server.service.rooms.get(p.room.code);
  assert.equal(room.status, "active"); assert(room.players.every(p => p.connected));
});
test("expired reconnection awards the connected opponent the match", async t => {
  const f = await fixture(t, { graceMs: 60, sweepIntervalMs: 20 }), p = await pair(f);
  p.b.disconnect(); await waitFor(() => p.a.room?.status === "finished");
  assert.equal(p.a.room.game.winner, "Goats"); assert.equal(p.a.room.game.resultReason, "disconnect");
});
test("a seat cannot resume after its deadline before the cleanup timer runs", async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now, graceMs: 100, sweepIntervalMs: 60000 }), p = await pair(f);
  p.b.disconnect(); await waitFor(() => p.a.room?.status === "paused");
  now = 1101;
  const replacement = await f.client();
  assert.equal((await request(replacement, "room:resume", p.joined.credentials)).error, "SESSION_EXPIRED");
  await f.server.service.sweep();
  const result = await request(replacement, "room:resume", p.joined.credentials);
  assert(result.ok); assert.equal(result.room.game.winner, "Goats");
});
test("room expiry removes its records, invalidates seats and frees connected sockets", async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now, roomTtlMs: 100, sweepIntervalMs: 60000 }), p = await pair(f);
  assert((await request(p.a, "game:move", move(p.room, null, 12))).ok);
  now = 1101; await f.server.service.sweep();
  assert.equal(await f.server.store.get(p.room.code), null);
  for (const table of ["baagh_chaal_moves", "baagh_chaal_matches"]) {
    const result = await f.server.store.client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
    assert.equal(Number(result.rows[0].count), 0);
  }
  assert.equal((await request(p.a, "room:resume", p.created.credentials)).error, "ROOM_NOT_FOUND");
  assert((await request(p.a, "room:create", { side: "goat" })).ok);
});
test("resignation and mutual rematch swap sides and reject an old match action", async t => {
  const f = await fixture(t), p = await pair(f);
  const finished = await request(p.a, "game:resign", { roomId: p.room.code, gameId: p.room.gameId });
  assert.equal(finished.room.game.winner, "Tigers");
  const vote = await request(p.a, "game:rematch", { roomId: p.room.code, gameId: p.room.gameId });
  assert.equal(vote.room.status, "finished");
  const restarted = await request(p.b, "game:rematch", { roomId: p.room.code, gameId: p.room.gameId });
  assert(restarted.ok); assert.equal(restarted.room.status, "active"); assert.notEqual(restarted.room.gameId, p.room.gameId);
  assert.equal(restarted.room.players.find(player => player.id === p.created.player.id).side, "tiger");
  assert.equal((await request(p.a, "game:move", move(p.room, null, 12))).error, "STALE_GAME");
});
test("leaving resigns, frees the socket and invalidates the former seat", async t => {
  const f = await fixture(t), p = await pair(f);
  assert((await request(p.a, "room:leave", { roomId: p.room.code })).ok);
  await waitFor(() => p.b.room?.status === "finished"); assert.equal(p.b.room.game.winner, "Tigers");
  assert((await request(p.a, "room:create", { side: "goat" })).ok);
  const c = await f.client(); assert.equal((await request(c, "room:resume", p.created.credentials)).error, "INVALID_SESSION");
});
test("database failures do not apply or broadcast a move", async t => {
  const f = await fixture(t), p = await pair(f), before = JSON.stringify(f.server.service.rooms.get(p.room.code));
  const save = f.server.store.save;
  f.server.store.save = async () => { const e = new Error("simulated failure"); e.code = "TEST_DB_FAILURE"; throw e; };
  const result = await request(p.a, "game:move", move(p.room, null, 12));
  f.server.store.save = save;
  assert.equal(result.error, "DATABASE_UNAVAILABLE"); assert.equal(JSON.stringify(f.server.service.rooms.get(p.room.code)), before);
});
test("a lost database response after commit recovers the accepted move for both players", async t => {
  const f = await fixture(t), p = await pair(f), save = f.server.store.save.bind(f.server.store);
  f.server.store.save = async (...args) => { await save(...args); throw new TypeError("fetch failed after commit"); };
  const action = move(p.room, null, 12), result = await request(p.a, "game:move", action);
  f.server.store.save = save;
  assert(result.ok); await waitFor(() => p.b.room?.moveNumber === 1);
  assert.equal(f.server.service.rooms.get(p.room.code).game.board[12], "goat");
  assert.deepEqual(await request(p.a, "game:move", action), result);
  assert.deepEqual(p.a.room.game, p.b.room.game);
});
test("HTTP exposes the frontend while keeping credentials and backend private", async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url)).status, 200);
  assert.equal((await fetch(`${f.url}/socket.io/socket.io.js`)).status, 200);
  for (const resource of ["/.env", "/server/config.cjs", "/package.json", "/js/../.env", "/.data/baagh-chaal.db"]) {
    assert.equal((await fetch(f.url + resource)).status, 404);
  }
});
test("stored rooms, credentials and duplicate acknowledgements survive a server restart", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "baagh-chaal-test-"));
  const database = { url: pathToFileURL(path.join(dir, "rooms.db")).href };
  const first = await fixture(t, { database }), p = await pair(first), action = move(p.room, null, 12);
  const accepted = await request(p.a, "game:move", action); assert(accepted.ok);
  await first.server.close();
  const second = await fixture(t, { database }), a = await second.client(), b = await second.client();
  assert((await request(a, "room:resume", p.created.credentials)).ok);
  const resumed = await request(b, "room:resume", p.joined.credentials); assert(resumed.ok);
  assert.equal(resumed.room.game.board[12], "goat"); assert.equal(resumed.room.moveNumber, 1);
  assert.deepEqual(await request(a, "game:move", action), accepted);
  // The temporary database is deliberately outside the project; OS temp cleanup owns it.
});
