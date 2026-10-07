class GameError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
function requireValue(condition, code) { if (!condition) throw new GameError(code); }
function payload(value, allowed) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "INVALID_REQUEST");
  requireValue(Object.keys(value).every(key => allowed.includes(key)), "INVALID_REQUEST");
  return value;
}
module.exports = { GameError, requireValue, payload };
