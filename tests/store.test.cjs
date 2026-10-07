const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RoomStore } = require("../server/store.cjs");
const Rules = require("../js/rules.js");

test("database initialization retries temporary network failures", async t => {
  const store = new RoomStore({ url: ":memory:" }); t.after(() => store.close());
  const batch = store.client.batch.bind(store.client); let attempts = 0;
  store.client.batch = (...args) => {
    if (++attempts === 1) return Promise.reject(new TypeError("fetch failed"));
    return batch(...args);
  };
  await store.init(); assert.equal(attempts, 2);
  assert.equal((await store.client.execute("SELECT COUNT(*) AS count FROM baagh_chaal_rooms")).rows[0].count, 0);
});
test("database initialization does not retry permanent SQL errors", async t => {
  const store = new RoomStore({ url: ":memory:" }); t.after(() => store.close()); let attempts = 0;
  store.client.batch = () => { attempts++; const error = new Error("failure"); error.code = "SQLITE_AUTH"; return Promise.reject(error); };
  await assert.rejects(store.init(), { code: "SQLITE_AUTH" }); assert.equal(attempts, 1);
});

async function savedMove(t) {
  const store = new RoomStore({ url: ":memory:" }); t.after(() => store.close()); await store.init();
  const room = { code: "TESTROOM", gameId: "test-game", version: 0, expiresAt: 10000, updatedAt: 1, startedAt: 1, game: Rules.newGame() };
  await store.create(room);
  const next = structuredClone(room); next.version = 1; next.updatedAt = 2;
  const action = Rules.play(next.game, { from: null, to: 12 });
  const move = { playerId: "test-player", id: "test-move", request: "first request", response: { ok: true, version: 1 }, action };
  await store.save(next, 0, move);
  return { store, room: next, move };
}

test("a stale batched update cannot insert a receipt or change a match", async t => {
  const { store, room, move } = await savedMove(t);
  const stale = structuredClone(room); stale.game.board[13] = "goat";
  await assert.rejects(store.save(stale, 0, { ...move, id: "stale-move" }), { code: "STATE_CONFLICT" });
  assert.deepEqual(await store.get(room.code), room);
  assert.equal(await store.findMove(room.gameId, move.playerId, "stale-move"), null);
  const match = await store.client.execute("SELECT state_json FROM baagh_chaal_matches");
  assert.deepEqual(JSON.parse(match.rows[0].state_json), room.game);
});

test("an insert failure rolls back every write in the move batch", async t => {
  const { store, room, move } = await savedMove(t);
  const next = structuredClone(room); next.version = 2;
  Rules.play(next.game, { from: 0, to: 1 });
  await assert.rejects(store.save(next, 1, { ...move, request: "reused ID", action: next.game.lastMove }));
  assert.deepEqual(await store.get(room.code), room);
  assert.equal((await store.findMove(room.gameId, move.playerId, move.id)).request, "first request");
  const match = await store.client.execute("SELECT state_json FROM baagh_chaal_matches");
  assert.deepEqual(JSON.parse(match.rows[0].state_json), room.game);
});
