const { execFileSync } = require("node:child_process");
const { ProxyAgent, EnvHttpProxyAgent } = require("undici");

function proxyUrl(value) {
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) throw new Error();
    return url.href;
  } catch {
    const error = new Error("Invalid database proxy configuration.");
    error.code = "INVALID_DATABASE_PROXY";
    throw error;
  }
}

function readWindowsProxy() {
  // Read the current user's settings without changing them or opening a window.
  const script = "$gameProxy = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; [pscustomobject]@{ enabled = [bool]$gameProxy.ProxyEnable; server = $gameProxy.ProxyServer; bypass = $gameProxy.ProxyOverride } | ConvertTo-Json -Compress";
  try {
    return JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"]
    }));
  } catch { return null; }
}

function windowsProxyFor(settings, databaseUrl) {
  if (!settings?.enabled || !settings.server) return null;
  const target = new URL(databaseUrl.replace(/^libsql:/i, "https:"));
  if (target.searchParams.get("tls") === "0") target.protocol = "http:";
  for (const entry of (settings.bypass || "").split(";")) {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) continue;
    if (pattern === "<local>") { if (!target.hostname.includes(".")) return null; continue; }
    const expression = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    const candidate = pattern.includes("://") ? target.origin : pattern.includes(":") ? target.host : target.hostname;
    if (new RegExp(`^${expression}$`, "i").test(candidate)) return null;
  }
  if (!settings.server.includes("=")) return proxyUrl(settings.server.trim());
  const entries = new Map(settings.server.split(";").map(entry => {
    const split = entry.indexOf("=");
    return [entry.slice(0, split).trim().toLowerCase(), entry.slice(split + 1).trim()];
  }));
  const address = entries.get(target.protocol.slice(0, -1));
  return address ? proxyUrl(address) : null;
}

function createDatabaseTransport(config, { env = process.env, platform = process.platform, readSystemProxy = readWindowsProxy } = {}) {
  const direct = { fetch: config.fetch, route: "direct", close: async () => {} };
  // Local SQLite and caller-supplied transports never need proxy discovery.
  if (config.fetch || !/^(libsql|https?):/i.test(config.url)) return direct;
  let dispatcher, route;
  const explicit = config.proxyUrl?.trim();
  if (explicit?.toLowerCase() === "direct") {
    route = "direct";
  } else if (explicit) {
    dispatcher = new ProxyAgent(proxyUrl(explicit)); route = "configured proxy";
  } else {
    const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? "";
    const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? "";
    if (httpProxy || httpsProxy) {
      dispatcher = new EnvHttpProxyAgent({
        httpProxy: httpProxy ? proxyUrl(httpProxy) : "",
        httpsProxy: httpsProxy ? proxyUrl(httpsProxy) : "",
        noProxy: env.no_proxy ?? env.NO_PROXY ?? ""
      });
      route = "environment proxy";
    } else if (platform === "win32" && config.useSystemProxy !== false) {
      const address = windowsProxyFor(readSystemProxy(), config.url);
      if (address) {
        dispatcher = new EnvHttpProxyAgent({ httpProxy: address, httpsProxy: address, noProxy: env.no_proxy ?? env.NO_PROXY ?? "" });
        route = "Windows proxy";
      }
    }
  }
  const timeoutMs = config.requestTimeoutMs ?? 5000;
  return {
    // Scope the dispatcher to database requests; do not change global fetch.
    // The signal also bounds reading the body after response headers arrive.
    fetch: (request, init) => {
      const deadline = AbortSignal.timeout(timeoutMs);
      const callerSignal = init?.signal || request?.signal;
      return globalThis.fetch(request, { ...init, ...(dispatcher ? { dispatcher } : {}),
        signal: callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline });
    },
    route: route || "direct",
    close: async () => { if (dispatcher) await dispatcher.destroy(); }
  };
}

module.exports = { createDatabaseTransport, windowsProxyFor };
