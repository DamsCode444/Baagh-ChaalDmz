const { AsyncLocalStorage } = require("node:async_hooks");
const { performance: gamePerformance } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");
const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity };
const allowed = new Set(["trace", "socket", "event", "room", "request", "transport", "reason", "durationMs", "waitMs",
  "queueDepth", "operation", "route", "version", "rooms", "port", "timeoutMs", "step", "outcome", "error", "cause"]);
function errorDetails(error) {
  const label = value => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value) ? value : "UnknownError";
  return { error: label(error?.code || error?.name), ...(error?.cause ? { cause: label(error.cause.code || error.cause.name) } : {}) };
}
function createLogger({ level = "info", filePath, writer = (line, severity) => severity === "error" || severity === "warn" ? console.error(line) : console.log(line) } = {}) {
  const context = new AsyncLocalStorage(), threshold = levels[level] ?? levels.info;
  let output;
  if (filePath && threshold !== Infinity) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    output = fs.createWriteStream(filePath, { flags: "a" });
    output.on("error", error => writer(JSON.stringify({ time: new Date().toISOString(), level: "error", message: "logging.file.failed", ...errorDetails(error) }), "error"));
  }
  function log(severity, event, fields = {}) {
    if (levels[severity] < threshold) return;
    const entry = { time: new Date().toISOString(), level: severity, message: event };
    // Explicitly select scalar metadata; never serialize requests, SQL values,
    // URLs, names, auth tokens, seat credentials, or exception messages.
    for (const [key, value] of Object.entries({ ...context.getStore(), ...fields })) {
      if (!allowed.has(key) || value === undefined || value === null) continue;
      if (typeof value === "string") entry[key] = value.slice(0, 120);
      else if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean") entry[key] = value;
    }
    writer(JSON.stringify(entry), severity);
    if (output && !output.destroyed) output.write(JSON.stringify(entry) + "\n");
  }
  return {
    debug: (event, fields) => log("debug", event, fields), info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields), error: (event, fields) => log("error", event, fields),
    withContext: (fields, work) => context.run({ ...context.getStore(), ...fields }, work),
    async close() { if (output && !output.destroyed) await new Promise(resolve => output.end(resolve)); },
    async measure(operation, work, fields = {}) {
      const started = gamePerformance.now(); log("info", "database.started", { ...fields, operation });
      try {
        const result = await work(); log("info", "database.completed", { ...fields, operation, durationMs: Math.round(gamePerformance.now() - started) }); return result;
      } catch (error) {
        log("error", "database.failed", { ...fields, operation, durationMs: Math.round(gamePerformance.now() - started), ...errorDetails(error) }); throw error;
      }
    }
  };
}
const silentLogger = createLogger({ level: "silent" });
module.exports = { createLogger, silentLogger, errorDetails };
