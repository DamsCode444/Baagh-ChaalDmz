const { test } = require("node:test");
const assert = require("node:assert/strict");
const Rules = require("../js/rules.js");
const AI = require("../js/ai.js");
const { LocalMatch } = require("../js/controller.js");

function movementGame() {
  const game = Rules.newGame();
  for (let p = 0; p < 25; p++) if (![0, 4, 20, 24, 1, 2, 13, 18, 22].includes(p)) game.board[p] = "goat";
  game.goatsInHand = 0; game.captured = 4;
  return game;
}
test("initial board and jump graph are consistent", () => {
  const game = Rules.newGame();
  assert.equal(game.turn, "goat"); assert.equal(Rules.allMoves(game, "goat").length, 21);
  for (let p = 0; p < 25; p++) {
    for (const q of Rules.adj[p]) assert(Rules.adj[q].includes(p));
    for (const j of Rules.jumps[p]) { assert(Rules.adj[p].includes(j.over)); assert(Rules.adj[j.over].includes(j.to)); }
  }
});
test("invalid moves reject without mutating state", () => {
  const cases = [
    [null, { from: null, to: 0 }], [null, { from: null, to: 25 }],
    [null, { from: 0, to: 1 }], [null, { from: null, to: "12" }], [null, { to: 12 }],
    [g => Rules.play(g, { from: null, to: 12 }), { from: 0, to: 23 }],
    [g => Rules.play(g, { from: null, to: 12 }), { from: 0, to: 1, over: 12 }],
    [g => { Rules.play(g, { from: null, to: 12 }); Rules.play(g, { from: 0, to: 1 }); }, { from: 12, to: 13 }],
    [g => g.winner = "Tigers", { from: null, to: 12 }]
  ];
  for (const [setup, request] of cases) {
    const game = Rules.newGame(); if (setup) setup(game);
    const before = JSON.stringify(game); assert.throws(() => Rules.play(game, request));
    assert.equal(JSON.stringify(game), before);
  }
  assert.deepEqual(Rules.movesFrom(Rules.newGame(), 25), []);
  assert.deepEqual(Rules.movesFrom(Rules.newGame(), 12), []);
});
test("captures are derived and the fifth capture wins", () => {
  const game = Rules.newGame(); Rules.play(game, { from: null, to: 1 });
  game.captured = 4; game.goatsInHand = 15;
  assert.throws(() => Rules.play(game, { from: 0, to: 2, over: 12 }));
  const move = Rules.play(game, { from: 0, to: 2 });
  assert.equal(move.over, 1); assert.equal(game.board[1], null);
  assert.equal(game.winner, "Tigers"); assert.equal(game.resultReason, "captures");
});
test("final placement can trap all tigers", () => {
  const game = Rules.newGame();
  for (let p = 0; p < 25; p++) if (![0, 4, 20, 24, 1, 11].includes(p)) game.board[p] = "goat";
  game.goatsInHand = 1; Rules.play(game, { from: null, to: 1 });
  assert.equal(game.goatsInHand, 0); assert.equal(game.winner, "Goats"); assert.equal(game.resultReason, "trapped");
});
test("movement repetition counts the side to move", () => {
  const game = movementGame(); game.positionCounts[Rules.keyFor(game, game.turn)] = 1;
  const cycle = [{ from: 12, to: 13 }, { from: 0, to: 1 }, { from: 13, to: 12 }, { from: 1, to: 0 }];
  for (let round = 0; round < 2; round++) for (const move of cycle) Rules.play(game, move);
  assert.equal(game.winner, "Draw"); assert.equal(game.resultReason, "repetition");
});
test("100 legal games preserve pieces and apply/undo symmetry", () => {
  let seed = 123456789;
  const rand = n => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 100; run++) {
    const game = Rules.newGame();
    for (let step = 0; step < 400 && !game.winner; step++) {
      const moves = Rules.allMoves(game, game.turn), move = moves[rand(moves.length)], before = JSON.stringify(game);
      Rules.apply(game, game.turn, move); Rules.undo(game, game.turn, move); assert.equal(JSON.stringify(game), before);
      Rules.play(game, move);
      assert.equal(game.board.length, 25); assert.equal(game.board.filter(p => p === "tiger").length, 4);
      assert.equal(game.board.filter(p => p === "goat").length + game.goatsInHand + game.captured, 20);
    }
  }
});
test("AI chooses a drawing continuation over losing to the fifth capture", () => {
  const game = movementGame(), move = Rules.resolveMove(game, { from: 12, to: 13 });
  Rules.apply(game, "goat", move); const key = Rules.keyFor(game, "tiger"); Rules.undo(game, "goat", move);
  game.positionCounts[key] = 2;
  const before = JSON.stringify(game), chosen = AI.chooseMove(game, "goat", 2);
  assert.equal(JSON.stringify(game), before); assert.deepEqual(chosen, move);
  Rules.play(game, chosen); assert.equal(game.winner, "Draw");
});
test("local controller rejects invalid history and undoes a computer reply", () => {
  const match = new LocalMatch(), initial = JSON.stringify(match.game);
  assert.throws(() => match.play({ from: null, to: 0 })); assert.equal(match.history.length, 0);
  match.play({ from: null, to: 12 }); match.play({ from: 0, to: 1 });
  assert.equal(match.undoIndex("tiger"), 0); match.undo(0);
  assert.equal(JSON.stringify(match.game), initial); assert.equal(match.history.length, 0);
});
