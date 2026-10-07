const { createClient } = require("@libsql/client");
const { GameError } = require("./errors.cjs");
const { createDatabaseTransport } = require("./db-transport.cjs");
class RoomStore {
  constructor(config) {
    this.transport = createDatabaseTransport(config);
    const { proxyUrl, useSystemProxy, ...database } = config;
    try { this.client = createClient({ ...database, fetch: this.transport.fetch }); }
    catch (error) { this.transport.close().catch(() => {}); throw error; }
  }
  async retrySafe(operation) {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        const transient = error.name === "TypeError" || /^(UND_ERR_|ECONN|ETIMEDOUT|EAI_AGAIN)/.test(error.code || error.cause?.code || "");
        if (!transient || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
  async init() {
    await this.retrySafe(() => this.client.batch([
      `CREATE TABLE IF NOT EXISTS baagh_chaal_rooms (
        code TEXT PRIMARY KEY, version INTEGER NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS baagh_chaal_moves (
        game_id TEXT NOT NULL, player_id TEXT NOT NULL, move_id TEXT NOT NULL,
        room_code TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL,
        action_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (game_id, player_id, move_id),
        FOREIGN KEY (room_code) REFERENCES baagh_chaal_rooms(code) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS baagh_chaal_matches (
        game_id TEXT PRIMARY KEY, room_code TEXT NOT NULL, started_at INTEGER NOT NULL,
        finished_at INTEGER, result_json TEXT, state_json TEXT NOT NULL,
        FOREIGN KEY (room_code) REFERENCES baagh_chaal_rooms(code) ON DELETE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS baagh_chaal_rooms_expiry ON baagh_chaal_rooms(expires_at)"
    ], "write"));
  }
  async loadAll(now) {
    const result = await this.retrySafe(() => this.client.execute({ sql: "SELECT data FROM baagh_chaal_rooms WHERE expires_at > ?", args: [now] }));
    return result.rows.map(row => JSON.parse(row.data));
  }
  async purgeExpired(now) {
    await this.retrySafe(() => this.client.batch([
      { sql: "DELETE FROM baagh_chaal_moves WHERE room_code IN (SELECT code FROM baagh_chaal_rooms WHERE expires_at <= ?)", args: [now] },
      { sql: "DELETE FROM baagh_chaal_matches WHERE room_code IN (SELECT code FROM baagh_chaal_rooms WHERE expires_at <= ?)", args: [now] },
      { sql: "DELETE FROM baagh_chaal_rooms WHERE expires_at <= ?", args: [now] }
    ], "write"));
  }
  async get(code) {
    const result = await this.retrySafe(() => this.client.execute({ sql: "SELECT data FROM baagh_chaal_rooms WHERE code = ?", args: [code] }));
    return result.rows[0] ? JSON.parse(result.rows[0].data) : null;
  }
  async create(room) {
    await this.client.execute({
      sql: "INSERT INTO baagh_chaal_rooms(code, version, expires_at, data) VALUES (?, ?, ?, ?)",
      args: [room.code, room.version, room.expiresAt, JSON.stringify(room)]
    });
  }
  async findMove(gameId, playerId, moveId) {
    const result = await this.retrySafe(() => this.client.execute({
      sql: "SELECT request_json, response_json FROM baagh_chaal_moves WHERE game_id = ? AND player_id = ? AND move_id = ?",
      args: [gameId, playerId, moveId]
    }));
    return result.rows[0] ? { request: result.rows[0].request_json, response: JSON.parse(result.rows[0].response_json) } : null;
  }
  // State and request acknowledgement commit together, before broadcasting.
  async save(room, expectedVersion, move = null) {
    const statements = [{
      sql: "UPDATE baagh_chaal_rooms SET version = ?, expires_at = ?, data = ? WHERE code = ? AND version = ?",
      args: [room.version, room.expiresAt, JSON.stringify(room), room.code, expectedVersion]
    }];
    // changes() chains each write to the successful preceding write. A stale
    // version performs no inserts; any SQL error rolls the entire batch back.
    if (move) statements.push({
      sql: `INSERT INTO baagh_chaal_moves(game_id, player_id, move_id, room_code, request_json, response_json, action_json, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      args: [room.gameId, move.playerId, move.id, room.code, move.request, JSON.stringify(move.response), JSON.stringify(move.action), room.updatedAt]
    });
    if (room.startedAt) statements.push({
      sql: `INSERT INTO baagh_chaal_matches(game_id, room_code, started_at, finished_at, result_json, state_json)
            SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(game_id) DO UPDATE SET
            finished_at = excluded.finished_at, result_json = excluded.result_json, state_json = excluded.state_json`,
      args: [room.gameId, room.code, room.startedAt, room.finishedAt || null,
        room.game.winner ? JSON.stringify({ winner: room.game.winner, reason: room.game.resultReason }) : null,
        JSON.stringify(room.game)]
    });
    // libSQL sends this transaction, including BEGIN/COMMIT, in one request.
    const results = await this.client.batch(statements, "write");
    if (results[0].rowsAffected !== 1) throw new GameError("STATE_CONFLICT");
  }
  async remove(code) {
    await this.client.batch([
      { sql: "DELETE FROM baagh_chaal_moves WHERE room_code = ?", args: [code] },
      { sql: "DELETE FROM baagh_chaal_matches WHERE room_code = ?", args: [code] },
      { sql: "DELETE FROM baagh_chaal_rooms WHERE code = ?", args: [code] }
    ], "write");
  }
  async close() { this.client.close(); await this.transport.close(); }
}
module.exports = { RoomStore };
