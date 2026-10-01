// rules.js: the game itself. No HTML, no colours, no icons in here.
// Change this file only when you want to change HOW THE GAME WORKS.
const Rules = (() => {

  const config = { goatsTotal: 20, capturesToWin: 5, repeatsForDraw: 3 };

  // The board: points 0-24, left to right, top to bottom.
  // adj[p]   = points you can step to from p
  // jumps[p] = {over, to}: a tiger at p can jump over "over" and land on "to"
  // Diagonals only exist from points where (row + col) is even.
  const adj = [], jumps = [];
  for (let p = 0; p < 25; p++) {
    const row = Math.floor(p / 5), col = p % 5;
    const straight = [[1,0],[-1,0],[0,1],[0,-1]];
    const diagonal = [[1,1],[1,-1],[-1,1],[-1,-1]];
    adj[p] = []; jumps[p] = [];
    for (const [dr, dc] of ((row + col) % 2 === 0 ? straight.concat(diagonal) : straight)) {
      const r1 = row + dr, c1 = col + dc, r2 = row + 2 * dr, c2 = col + 2 * dc;
      if (r1 < 0 || r1 > 4 || c1 < 0 || c1 > 4) continue;
      adj[p].push(r1 * 5 + c1);
      if (r2 >= 0 && r2 <= 4 && c2 >= 0 && c2 <= 4) jumps[p].push({ over: r1 * 5 + c1, to: r2 * 5 + c2 });
    }
  }

  // A game is plain data (easy to save, undo, or send over a network later).
  function newGame() {
    const board = Array(25).fill(null);                    // each point: null, "tiger" or "goat"
    [0, 4, 20, 24].forEach(p => board[p] = "tiger");
    return { board, turn: "goat", goatsInHand: config.goatsTotal, captured: 0,
             winner: null, lastMove: null, positionCounts: {} };
  }

  // A move is {from, to, over}. from === null means "place a goat". over = goat being captured (or null).
  function movesFrom(g, p) {
    const list = [];
    for (const q of adj[p]) if (g.board[q] === null) list.push({ from: p, to: q, over: null });
    if (g.board[p] === "tiger")
      for (const j of jumps[p])
        if (g.board[j.over] === "goat" && g.board[j.to] === null) list.push({ from: p, to: j.to, over: j.over });
    return list;
  }

  function allMoves(g, side) {
    const list = [];
    if (side === "goat" && g.goatsInHand > 0) {
      g.board.forEach((v, p) => { if (v === null) list.push({ from: null, to: p, over: null }); });
    } else {
      g.board.forEach((v, p) => { if (v === side) list.push(...movesFrom(g, p)); });
    }
    return list.sort((a, b) => (b.over !== null) - (a.over !== null));   // captures first
  }

  // Low-level: change the board, and take it back. (The computer uses these to "imagine" moves.)
  function apply(g, side, m) {
    if (m.from === null) { g.board[m.to] = "goat"; g.goatsInHand--; return; }
    g.board[m.to] = side; g.board[m.from] = null;
    if (m.over !== null) { g.board[m.over] = null; g.captured++; }
  }
  function undo(g, side, m) {
    if (m.from === null) { g.board[m.to] = null; g.goatsInHand++; return; }
    g.board[m.from] = side; g.board[m.to] = null;
    if (m.over !== null) { g.board[m.over] = "goat"; g.captured--; }
  }

  // A short fingerprint of the board + whose turn it is (for the draw rule).
  const keyFor = (g, turn) => g.board.map(v => v ? v[0] : ".").join("") + turn;

  // Play a real move: change the board, switch turns, check for a winner or draw.
  function play(g, m) {
    const side = g.turn;
    apply(g, side, m);
    g.lastMove = { from: m.from, to: m.to };
    g.turn = side === "goat" ? "tiger" : "goat";

    if (g.captured >= config.capturesToWin)       g.winner = "Tigers";
    else if (allMoves(g, g.turn).length === 0)    g.winner = g.turn === "tiger" ? "Goats" : "Tigers";  // can't move = loses
    else if (g.goatsInHand === 0) {
      const key = keyFor(g, g.turn);
      g.positionCounts[key] = (g.positionCounts[key] || 0) + 1;
      if (g.positionCounts[key] >= config.repeatsForDraw) g.winner = "Draw";
    }
  }

  return { config, adj, jumps, newGame, movesFrom, allMoves, apply, undo, keyFor, play };
})();

if (typeof module !== "undefined") module.exports = Rules;   // lets Node load it for testing
