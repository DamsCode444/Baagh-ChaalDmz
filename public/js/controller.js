// Local state and undo history. Online state is owned by the server.
const GameController = (() => {
  const R = typeof Rules !== "undefined" ? Rules : require("./rules.js");
  class LocalMatch {
    constructor() { this.reset(); }
    reset() { this.game = R.newGame(); this.history = []; return this.game; }
    play(request) {
      const move = R.resolveMove(this.game, request);
      this.history.push(JSON.stringify(this.game));
      R.play(this.game, move);
      return move;
    }
    undoIndex(computerSide = null) {
      let i = this.history.length - 1;
      while (i >= 0 && computerSide && JSON.parse(this.history[i]).turn === computerSide) i--;
      return i;
    }
    undo(index) {
      if (!Number.isInteger(index) || index < 0 || index >= this.history.length) return null;
      this.game = JSON.parse(this.history[index]); this.history.length = index;
      return this.game;
    }
  }
  return { LocalMatch };
})();
if (typeof module !== "undefined") module.exports = GameController;
