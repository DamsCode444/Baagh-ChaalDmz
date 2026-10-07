const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const { createDatabaseTransport, windowsProxyFor } = require("../server/db-transport.cjs");
const { startupError } = require("../server/startup-error.cjs");

async function networkFixture(t) {
  const target = http.createServer((req, res) => {
    if (req.url === "/stall-headers") return;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/stall-body") { res.write('{"incomplete":'); return; }
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization || null }));
  });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const sockets = new Set(), connections = [];
  const proxy = http.createServer();
  proxy.on("connect", (request, downstream, head) => {
    connections.push(request.url);
    const upstream = net.connect(target.address().port, "127.0.0.1");
    for (const socket of [downstream, upstream]) {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { downstream.destroy(); upstream.destroy(); });
    }
    upstream.once("connect", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    target.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => target.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  });
  return { connections, targetUrl: `http://127.0.0.1:${target.address().port}`, proxyUrl: `http://127.0.0.1:${proxy.address().port}` };
}

test("database fetch reaches a remote host through the configured proxy without changing global fetch", async t => {
  const fixture = await networkFixture(t), originalFetch = globalThis.fetch;
  const transport = createDatabaseTransport({ url: "http://database.invalid", proxyUrl: fixture.proxyUrl }, { env: {} });
  try {
    const response = await transport.fetch(new Request("http://database.invalid/v2/pipeline", { headers: { authorization: "Bearer test-token" } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { path: "/v2/pipeline", authorization: "Bearer test-token" });
    assert.deepEqual(fixture.connections, ["database.invalid:80"]);
    assert.equal(globalThis.fetch, originalFetch);
  } finally { await transport.close(); }
});

test("Windows system proxy routes database requests automatically", async t => {
  const fixture = await networkFixture(t);
  const transport = createDatabaseTransport({ url: "http://database.invalid" }, {
    env: {}, platform: "win32", readSystemProxy: () => ({ enabled: true, server: fixture.proxyUrl })
  });
  try {
    assert.equal(transport.route, "Windows proxy");
    assert.equal((await transport.fetch("http://database.invalid/probe")).status, 200);
    assert.deepEqual(fixture.connections, ["database.invalid:80"]);
  } finally { await transport.close(); }
});

test("environment proxy honors NO_PROXY for direct local requests", async t => {
  const fixture = await networkFixture(t);
  const transport = createDatabaseTransport({ url: fixture.targetUrl }, {
    env: { HTTP_PROXY: fixture.proxyUrl, NO_PROXY: "127.0.0.1" }, platform: "linux"
  });
  try {
    assert.equal((await transport.fetch(`${fixture.targetUrl}/direct`)).status, 200);
    assert.equal(fixture.connections.length, 0);
    assert.equal((await transport.fetch("http://database.invalid/proxied")).status, 200);
    assert.deepEqual(fixture.connections, ["database.invalid:80"]);
  } finally { await transport.close(); }
});

test("Windows proxy parsing respects protocol maps, disabled settings and bypass lists", () => {
  const settings = { enabled: true, server: "http=127.0.0.1:8080;https=127.0.0.1:8443", bypass: "<local>;*.internal;exact.example" };
  assert.equal(windowsProxyFor(settings, "libsql://database.example"), "http://127.0.0.1:8443/");
  assert.equal(windowsProxyFor(settings, "http://database.example"), "http://127.0.0.1:8080/");
  assert.equal(windowsProxyFor(settings, "libsql://database.example?tls=0"), "http://127.0.0.1:8080/");
  for (const url of ["https://localserver", "https://db.internal", "https://exact.example"]) assert.equal(windowsProxyFor(settings, url), null);
  assert.equal(windowsProxyFor({ ...settings, enabled: false }, "https://database.example"), null);
  assert.equal(windowsProxyFor({ enabled: true, server: "http=127.0.0.1:8080" }, "https://database.example"), null);
});

test("local databases, direct overrides and custom fetch skip Windows proxy discovery", async () => {
  let reads = 0;
  const options = { env: { HTTPS_PROXY: "http://127.0.0.1:9999" }, platform: "win32", readSystemProxy: () => { reads++; throw new Error("unexpected discovery"); } };
  for (const config of [{ url: ":memory:" }, { url: "file:test.db" }]) {
    const transport = createDatabaseTransport(config, options);
    assert.equal(transport.fetch, undefined); await transport.close();
  }
  const direct = createDatabaseTransport({ url: "libsql://database.example", proxyUrl: "direct" }, options);
  assert.equal(typeof direct.fetch, "function"); assert.equal(direct.route, "direct"); await direct.close();
  const customFetch = async () => new Response();
  const custom = createDatabaseTransport({ url: "libsql://database.example", fetch: customFetch }, options);
  assert.equal(custom.fetch, customFetch); await custom.close();
  const disabled = createDatabaseTransport({ url: "libsql://database.example", useSystemProxy: false }, { ...options, env: {} });
  assert.equal(typeof disabled.fetch, "function"); assert.equal(disabled.route, "direct"); await disabled.close();
  assert.equal(reads, 0);
});

test("database deadlines abort stalled response headers and bodies", async t => {
  const fixture = await networkFixture(t);
  const transport = createDatabaseTransport({ url: fixture.targetUrl, proxyUrl: fixture.proxyUrl, requestTimeoutMs: 100 }, { env: {} });
  try {
    for (const path of ["/stall-headers", "/stall-body"]) {
      const started = Date.now();
      await assert.rejects(async () => { const response = await transport.fetch(`${fixture.targetUrl}${path}`); await response.text(); }, { name: "TimeoutError" });
      assert(Date.now() - started < 1500);
    }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(transport.fetch(fixture.targetUrl, { signal: controller.signal }), { name: "AbortError" });
  } finally { await transport.close(); }
});

test("proxy and startup failures explain the problem without exposing secret messages", () => {
  const secret = "private-auth-token";
  let proxyError;
  try { createDatabaseTransport({ url: "libsql://database.example", proxyUrl: `ftp://user:${secret}@proxy.example` }, { env: {} }); }
  catch (error) { proxyError = error; }
  assert.equal(proxyError.code, "INVALID_DATABASE_PROXY");
  assert.match(startupError(proxyError), /Invalid database proxy/);
  const timeout = new TypeError(`fetch failed ${secret}`, { cause: Object.assign(new Error(`https://user:${secret}@database.example`), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
  const message = startupError(timeout);
  assert.match(message, /Cannot reach the database/); assert.match(message, /proxy/);
  assert.ok(!message.includes(secret)); assert.ok(!message.includes("database.example"));
  assert.match(startupError({ code: "EADDRINUSE" }, { port: 3001 }), /Port 3001 is already in use/);
  assert.ok(!startupError({ message: secret, code: `error:${secret}` }).includes(secret));
});
