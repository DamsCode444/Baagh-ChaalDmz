const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

async function clientFixture(t, savedLobby) {
  const dom = new JSDOM("", { url: "http://localhost", runScripts: "outside-only" }), win = dom.window;
  t.after(() => win.close());
  if (savedLobby) win.sessionStorage.setItem("baagh-chaal-lobby-v1", savedLobby);
  const timers = new Map(), events = new Map(), requests = []; let timerId = 0;
  win.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  win.clearTimeout = id => timers.delete(id);
  const socket = {
    connected: false,
    on(event, callback) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(callback); return this; },
    off(event, callback) { events.get(event)?.delete(callback); return this; },
    once(event, callback) { const once = (...args) => { this.off(event, once); callback(...args); }; return this.on(event, once); },
    deliver(event, data) { for (const callback of [...(events.get(event) || [])]) callback(data); },
    connect() { queueMicrotask(() => { this.connected = true; this.deliver("connect"); }); },
    disconnect() { this.connected = false; this.deliver("disconnect"); },
    timeout(ms) {
      return { emit(event, data, callback) {
        const timeout = win.setTimeout(() => callback(new Error("timeout")), ms);
        requests.push({ event, data, reply(result) { win.clearTimeout(timeout); callback(null, result); } });
      } };
    }
  };
  win.io = () => socket;
  for (const file of ["rules.js", "multiplayer.js"]) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8"), dom.getInternalVMContext());
  const client = win.eval("Multiplayer"); await client.start();
  return { win, client, socket, requests, timeout() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function joinedResult(f, request) {
  return { ok: true, requestId: request.data.requestId, player: { id: "test-player", side: "goat" },
    credentials: { roomId: "TESTROOM", playerId: "test-player", resumeToken: request.data.recoveryToken },
    room: { code: "TESTROOM", gameId: "test-game", version: 0, status: "waiting", moveNumber: 0,
      game: JSON.parse(f.win.eval("JSON.stringify(Rules.newGame())")),
      players: [{ id: "test-player", side: "goat" }], rematchVotes: [] } };
}

test("a lobby timeout releases controls and Retry reuses the same request", async t => {
  const f = await clientFixture(t), creating = f.client.create("goat", "A"); await tick();
  const first = f.requests.at(-1); assert.equal(first.event, "room:create");
  f.timeout(); await creating;
  assert.equal(f.client.state.busy, false); assert.equal(f.client.state.operation, "");
  assert.match(f.client.state.error, /Creating the room could not be confirmed/);
  assert.ok(!f.client.state.error.includes("latest board"));
  const retrying = f.client.retry(); await tick();
  const retry = f.requests.at(-1); assert.equal(retry.data.requestId, first.data.requestId);
  f.socket.deliver("room:joined", joinedResult(f, retry)); await retrying;
  assert.equal(f.client.state.busy, false); assert.equal(f.client.state.room.code, "TESTROOM");
  assert.equal(f.client.state.error, ""); assert(f.win.sessionStorage.getItem("baagh-chaal-seat-v1"));
});

test("a delayed private result recovers a timed-out join without a second seat", async t => {
  const f = await clientFixture(t), joining = f.client.join("TESTROOM", "A"); await tick();
  const request = f.requests.at(-1); f.timeout(); await joining;
  assert.equal(f.client.state.busy, false); assert.match(f.client.state.error, /Joining the room/);
  f.socket.deliver("room:joined", joinedResult(f, request));
  assert.equal(f.client.state.error, ""); assert.equal(f.client.state.room.code, "TESTROOM");
  assert.equal(f.requests.length, 1);
});

test("disconnecting immediately releases a pending room command", async t => {
  const f = await clientFixture(t), creating = f.client.create("goat", "A"); await tick();
  f.socket.disconnect(); await creating;
  assert.equal(f.client.state.busy, false); assert.equal(f.client.state.connected, false);
  assert.match(f.client.state.error, /offline/i); assert.equal(f.client.state.operation, "");
});

test("reconnecting automatically retries a join using the persisted request and private recovery token", async t => {
  const f = await clientFixture(t), joining = f.client.join("TESTROOM", "A"); await tick();
  const first = f.requests.at(-1);
  const stored = JSON.parse(f.win.sessionStorage.getItem("baagh-chaal-lobby-v1"));
  assert.equal(stored.data.requestId, first.data.requestId);
  assert.match(first.data.recoveryToken, /^[a-f0-9]{64}$/);
  assert.equal(stored.data.recoveryToken, first.data.recoveryToken);
  f.socket.disconnect(); await joining;
  f.socket.connect(); await tick(); await tick();
  const retried = f.requests.at(-1); assert.equal(f.requests.length, 2);
  assert.equal(retried.event, "room:join"); assert.deepEqual(retried.data, first.data);
  retried.reply(joinedResult(f, retried)); await tick(); await tick();
  assert.equal(f.client.state.busy, false); assert.equal(f.client.state.error, "");
  assert.equal(f.win.sessionStorage.getItem("baagh-chaal-lobby-v1"), null);
  assert.equal(JSON.parse(f.win.sessionStorage.getItem("baagh-chaal-seat-v1")).resumeToken, first.data.recoveryToken);
});

test("a refreshed tab recovers an unfinished lobby intent instead of creating a new seat", async t => {
  const first = await clientFixture(t), creating = first.client.create("goat", "A"); await tick();
  const original = first.requests.at(-1), stored = first.win.sessionStorage.getItem("baagh-chaal-lobby-v1");
  first.socket.disconnect(); await creating;
  const fresh = await clientFixture(t, stored); await tick();
  const recovered = fresh.requests.at(-1); assert.equal(recovered.event, "room:create");
  assert.equal(recovered.data.requestId, original.data.requestId);
  assert.equal(recovered.data.recoveryToken, original.data.recoveryToken);
  recovered.reply(joinedResult(fresh, recovered)); await tick(); await tick();
  assert.equal(fresh.client.state.room.code, "TESTROOM"); assert.equal(fresh.client.state.busy, false);
  assert.equal(fresh.win.sessionStorage.getItem("baagh-chaal-lobby-v1"), null);
});

test("database failures keep the pending lobby intent, while a definitive rejection clears it", async t => {
  const f = await clientFixture(t), joining = f.client.join("TESTROOM", "A"); await tick();
  const first = f.requests.at(-1);
  first.reply({ ok: false, error: "DATABASE_TIMEOUT" }); await joining;
  assert(f.win.sessionStorage.getItem("baagh-chaal-lobby-v1"));
  const retrying = f.client.retry(); await tick();
  const retry = f.requests.at(-1); assert.deepEqual(retry.data, first.data);
  retry.reply({ ok: false, error: "ROOM_NOT_FOUND" }); await retrying;
  assert.equal(f.win.sessionStorage.getItem("baagh-chaal-lobby-v1"), null);
  assert.equal(f.client.state.busy, false);
});
