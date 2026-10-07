const { loadConfig } = require("./config.cjs");
const { createServer } = require("./app.cjs");
const { startupError } = require("./startup-error.cjs");
let config;
async function main() {
  config = loadConfig();
  const server = await createServer(config);
  try { await server.listen(config.port, config.host); }
  catch (error) { await server.close().catch(() => {}); throw error; }
  const route = server.store.transport.route;
  console.log(`Baagh-Chaal ready at http://localhost:${config.port} (database connected${route === "direct" ? "" : ` via ${route}`})`);
  let stopping = false;
  async function stop() { if (stopping) return; stopping = true; await server.close(); }
  process.on("SIGINT", () => stop().catch(() => { process.exitCode = 1; }));
  process.on("SIGTERM", () => stop().catch(() => { process.exitCode = 1; }));
}
main().catch(error => { console.error("Could not start Baagh-Chaal:", startupError(error, config)); process.exitCode = 1; });
