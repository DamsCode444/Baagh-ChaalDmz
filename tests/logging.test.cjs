const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createLogger, errorDetails } = require("../server/logging.cjs");

test("concurrent database logs preserve their request context and exclude sensitive values", async () => {
  const records = [], logger = createLogger({ writer: line => records.push(JSON.parse(line)) });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = logger.withContext({ trace: "first", event: "room:join", authToken: "private-auth" }, () =>
    logger.measure("saveRoom", async () => {
      await gate;
      logger.info("safe.metadata", { room: "TESTROOM", requestBody: { resumeToken: "private-seat" },
        url: "https://private-database", name: "Private Name", sql: "secret SQL" });
    }));
  await logger.withContext({ trace: "second", event: "room:create" }, () => logger.measure("createRoom", async () => {}));
  release(); await first;
  const completed = records.filter(row => row.message === "database.completed");
  assert.deepEqual(completed.map(row => [row.trace, row.event, row.operation]), [
    ["second", "room:create", "createRoom"], ["first", "room:join", "saveRoom"]
  ]);
  assert(completed.every(row => Number.isFinite(row.durationMs)));
  const text = JSON.stringify(records);
  for (const secret of ["private-auth", "private-seat", "private-database", "Private Name", "secret SQL"]) assert(!text.includes(secret));
  const error = new TypeError("secret connection string", { cause: Object.assign(new Error("private token"), { code: "ETIMEDOUT" }) });
  await assert.rejects(logger.withContext({ trace: "failure" }, () => logger.measure("saveRoom", async () => { throw error; })), TypeError);
  const failed = records.at(-1);
  assert.equal(failed.trace, "failure"); assert.equal(failed.error, "TypeError"); assert.equal(failed.cause, "ETIMEDOUT");
  assert(!JSON.stringify(failed).includes("secret connection string"));
  assert.deepEqual(errorDetails({ code: "https://secret-database/?token=abc" }), { error: "UnknownError" });
  await logger.close();
});

test("file logs are flushed on close and the configured severity filters console and file output", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "baagh-chaal-logs-"));
  const filePath = path.join(dir, "server.log"), records = [];
  const logger = createLogger({ level: "warn", filePath, writer: line => records.push(line) });
  logger.info("filtered.info"); logger.debug("filtered.debug");
  logger.warn("request.waiting", { trace: "slow", durationMs: 3000 });
  logger.error("database.failed", { error: "TimeoutError" });
  await logger.close();
  const written = (await fs.readFile(filePath, "utf8")).trim().split("\n");
  assert.deepEqual(written, records); assert.equal(written.length, 2);
  assert.deepEqual(written.map(line => JSON.parse(line).message), ["request.waiting", "database.failed"]);
});
