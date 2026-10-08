// ai.js: the computer player. It only talks to Rules; it knows nothing about the screen.
// Idea: try each move, imagine the opponent's best reply, and so on a few moves deep ("minimax").
// Positions get a score: positive = good for tigers, negative = good for goats.
const AI = (() => {
  const R = (typeof Rules !== "undefined") ? Rules : require("./rules.js");

  const evaluate = g => g.captured * 120 + R.allMoves(g, "tiger").length * 3;   // captures matter most, then tiger freedom

  // Repetition follows each imagined branch, and the real state is restored.
  function imagine(g, side, move, visit) {
    R.apply(g, side, move);
    const next = side === "tiger" ? "goat" : "tiger";
    const key = g.goatsInHand === 0 ? R.keyFor(g, next) : null;
    const previous = key === null ? 0 : g.positionCounts[key] || 0;
    if (key !== null) g.positionCounts[key] = previous + 1;
    try { return visit(next); }
    finally {
      if (key !== null) { if (previous) g.positionCounts[key] = previous; else delete g.positionCounts[key]; }
      R.undo(g, side, move);
    }
  }

  function search(g, side, depth, alpha, beta) {
    if (g.captured >= R.config.capturesToWin) return 10000 + depth;               // tigers won (sooner = better)
    const moves = R.allMoves(g, side);
    if (moves.length === 0) return side === "tiger" ? -(10000 + depth) : 10000 + depth;
    if (g.goatsInHand === 0 && (g.positionCounts[R.keyFor(g, side)] || 0) >= R.config.repeatsForDraw) return 0;
    if (depth === 0) return evaluate(g);

    const maximizing = side === "tiger";
    let best = maximizing ? -Infinity : Infinity;
    for (const m of moves) {
      const score = imagine(g, side, m, next => search(g, next, depth - 1, alpha, beta));
      if (maximizing) { best = Math.max(best, score); alpha = Math.max(alpha, best); }
      else            { best = Math.min(best, score); beta  = Math.min(beta, best); }
      if (beta <= alpha) break;                      // this branch can't matter any more
    }
    return best;
  }

  // depth = how many moves ahead to look (the "level").
  function chooseMove(g, side, depth) {
    const moves = R.allMoves(g, side);
    if (!moves.length) return null;
    depth = Number.isInteger(depth) ? Math.max(1, Math.min(6, depth)) : 2;
    if (depth === 1 && Math.random() < 0.3) return moves[Math.floor(Math.random() * moves.length)];  // Easy: sometimes random

    const maximizing = side === "tiger";
    let bestScore = maximizing ? -Infinity : Infinity, best = [];
    for (const m of moves) {
      const score = imagine(g, side, m, next => search(g, next, depth - 1, -Infinity, Infinity));
      if (score === bestScore) best.push(m);
      else if (maximizing ? score > bestScore : score < bestScore) { bestScore = score; best = [m]; }
    }
    return best[Math.floor(Math.random() * best.length)];  // random among equally good moves
  }

  return { chooseMove };
})();

if (typeof module !== "undefined") module.exports = AI;
