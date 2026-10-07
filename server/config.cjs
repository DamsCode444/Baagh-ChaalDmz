const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL, fileURLToPath } = require("node:url");
const dotenv = require("dotenv");
function positive(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`Invalid ${name}`);
  return number;
}
function loadConfig() {
  const root = path.resolve(__dirname, "..");
  dotenv.config({ path: path.join(root, ".env"), quiet: true });
  let url = process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL || process.env.turbo_db_url;
  const authToken = process.env.TURSO_AUTH_TOKEN || process.env.turbo_db_token;
  if (!url) {
    fs.mkdirSync(path.join(root, ".data"), { recursive: true });
    url = pathToFileURL(path.join(root, ".data", "baagh-chaal.db")).href;
  }
  if (url.startsWith("file:") && url !== "file::memory:") {
    if (!url.startsWith("file://")) url = pathToFileURL(path.resolve(root, url.slice(5))).href;
    fs.mkdirSync(path.dirname(fileURLToPath(url)), { recursive: true });
  }
  return {
    root, database: { url, authToken, proxyUrl: process.env.DATABASE_PROXY_URL,
      useSystemProxy: process.env.DATABASE_USE_SYSTEM_PROXY !== "false" },
    port: positive(process.env.PORT, 3000, "PORT"), host: process.env.HOST || "0.0.0.0",
    graceMs: positive(process.env.RECONNECT_GRACE_MS, 90000, "RECONNECT_GRACE_MS"),
    roomTtlMs: positive(process.env.ROOM_TTL_MS, 86400000, "ROOM_TTL_MS"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean)
  };
}
module.exports = { loadConfig };
