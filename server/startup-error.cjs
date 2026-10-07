function startupError(error, config = {}) {
  const errors = [], pending = [error], seen = new Set();
  while (pending.length && errors.length < 20) {
    const current = pending.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current); errors.push(current);
    pending.push(current.cause, ...(Array.isArray(current.errors) ? current.errors : []));
  }
  const codes = new Set(errors.map(item => item.code));
  if (codes.has("EADDRINUSE")) return `Port ${config.port || 3000} is already in use. Close the existing game server or set PORT to another number in .env.`;
  if (codes.has("INVALID_DATABASE_PROXY")) return "Invalid database proxy setting. Use an http:// or https:// proxy URL, or set DATABASE_PROXY_URL=direct.";
  if ([...codes].some(code => /^(UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_SOCKET|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)$/.test(code))) {
    return "Cannot reach the database (network connection failed). Check your internet connection and proxy. Windows proxies are detected automatically; DATABASE_PROXY_URL can override the proxy or be set to direct. Run npm run db:check to retry.";
  }
  if ([...codes].some(code => /^(CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)/.test(code))) {
    return "The database TLS certificate could not be verified. Check the proxy's certificate configuration and system clock.";
  }
  if (codes.has("SQLITE_AUTH") || codes.has("UNAUTHORIZED") || errors.some(item => item.status === 401 || item.status === 403)) {
    return "Database authentication failed. Check the database URL and auth token in .env.";
  }
  if (errors.some(item => item.name === "TypeError")) return "The database request failed. Check the database URL, internet connection and proxy; run npm run db:check to retry.";
  // Avoid printing raw SDK messages, URLs, tokens, or proxy credentials.
  const code = errors.map(item => item.code).find(value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value));
  return `Initialization failed${code ? ` (${code})` : ""}. Check the server settings in .env and run npm run db:check.`;
}
module.exports = { startupError };
