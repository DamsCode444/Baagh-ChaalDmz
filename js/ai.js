// ai.js: the computer player. It only talks to Rules; it knows nothing about the screen.
// Idea: try each move, imagine the opponent's best reply, and so on a few moves deep ("minimax").
// Positions get a score: positive = good for tigers, negative = good for goats.
const AI = (() => {
  const R = (typeof Rules !== "undefined") ? Rules : require("./rules.js");

  const evaluate = g => g.captured * 120 + R.allMoves(g, "tiger").length * 3;   // captures matter most, then tiger freedom

  function search(g, side, depth, alpha, beta) {
    if (g.captured >= R.config.capturesToWin) return 10000 + depth;               // tigers won (sooner = better)
    const moves = R.allMoves(g, side);
    if (moves.length === 0) return side === "tiger" ? -(10000 + depth) : 10000 + depth;
    if (depth === 0) return evaluate(g);

    const maximizing = side === "tiger";
    let best = maximizing ? -Infinity : Infinity;
    for (const m of moves) {
      R.apply(g, side, m);
      const score = search(g, maximizing ? "goat" : "tiger", depth - 1, alpha, beta);
      R.undo(g, side, m);
      if (maximizing) { best = Math.max(best, score); alpha = Math.max(alpha, best); }
      else            { best = Math.min(best, score); beta  = Math.min(beta, best); }
      if (beta <= alpha) break;                      // this branch can't matter any more
    }
    return best;
  }

  // Would this move create the 3rd repetition (a draw)?
  function repeats(g, side, m) {
    R.apply(g, side, m);
    const count = g.positionCounts[R.keyFor(g, side === "tiger" ? "goat" : "tiger")] || 0;
    const again = g.goatsInHand === 0 && count >= R.config.repeatsForDraw - 1;
    R.undo(g, side, m);
    return again;
  }

  // depth = how many moves ahead to look (the "level").
  function chooseMove(g, side, depth) {
    const moves = R.allMoves(g, side);
    if (depth === 1 && Math.random() < 0.3) return moves[Math.floor(Math.random() * moves.length)];  // Easy: sometimes random

    let pool = moves.filter(m => !repeats(g, side, m));   // avoid drawing if there's any alternative
    if (pool.length === 0) pool = moves;

    const maximizing = side === "tiger";
    let bestScore = maximizing ? -Infinity : Infinity, best = [];
    for (const m of pool) {
      R.apply(g, side, m);
      const score = search(g, maximizing ? "goat" : "tiger", depth - 1, -Infinity, Infinity);
      R.undo(g, side, m);
      if (score === bestScore) best.push(m);
      else if (maximizing ? score > bestScore : score < bestScore) { bestScore = score; best = [m]; }
    }
    return best[Math.floor(Math.random() * best.length)];  // random among equally good moves
  }

  return { chooseMove };
})();

if (typeof module !== "undefined") module.exports = AI;
