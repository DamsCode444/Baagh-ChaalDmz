const { loadConfig } = require("./config.cjs");
const { RoomStore } = require("./store.cjs");
const { startupError } = require("./startup-error.cjs");
async function main() {
  const store = new RoomStore(loadConfig().database);
  try {
    await store.init();
    await store.client.execute("SELECT 1 AS connected");
    console.log(`Database connected${store.transport.route === "direct" ? "" : ` via ${store.transport.route}`}; Baagh-Chaal tables are ready.`);
  } finally { await store.close(); }
}
main().catch(error => { console.error("Database check failed:", startupError(error)); process.exitCode = 1; });
