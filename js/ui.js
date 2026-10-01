// ui.js: everything you SEE and CLICK.
// It never decides rules (that's rules.js) and never picks colours/icons (that's theme.css).

// ---- the wording shown to players (edit freely) ----
// (ic) is the tiger or goat icon from theme.css.
const WORDS = {
  placeGoat: "place a goat",
  moveGoat:  "move a goat",
  moveTiger: "move a tiger",

  // vs Computer: the messages speak to YOU
  yourTurn: (ic, action) => `Your turn (${ic}): ${action}`,
  thinking: ic => `Computer (${ic}) is thinking…`,
  youWin:   ic => `You (${ic}) win!`,
  youLose:  ic => `You (${ic}) lose`,

  // 2 players: neutral wording
  turn2p: (ic, side, action) => `${ic} ${side}: ${action}`,
  win: who => `${who} win!`,

  draw: "Draw: same position repeated",
  over: {
    draw:    "The same position happened too many times.",
    trapped: "All the tigers are trapped.",
    captured:"Enough goats were captured.",
    stuck:   "The goats have no legal moves."
  }
};

// ---- small helpers ----
const $ = id => document.getElementById(id);
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim().replace(/^["']|["']$/g, "");
const icon = side => cssVar(`--${side}-icon`) || side;       // icons come from theme.css
const popupDelay = () => (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) ? 0
                       : parseFloat(cssVar("--anim-popup-delay")) || 0;   // timing comes from theme.css (in ms)

// ---- what the screen remembers (the game itself lives in `game`) ----
let game, selected = null, history = [], thinking = false, popupClosed = false;
let animate = null;      // the move to animate on the NEXT render (set right after a move, then cleared)
let popupTimer = null;

const vsComputer     = () => $("mode").value === "cpu";
const computerSide   = () => $("mySide").value === "goat" ? "tiger" : "goat";
const isComputerTurn = () => !game.winner && vsComputer() && game.turn === computerSide();

function newGame() {
  game = Rules.newGame();
  selected = null; history = []; popupClosed = false;
  render();
  maybeComputerMove();
}

// Make a move for whoever's turn it is (human or computer). Saves a snapshot first, for Undo.
function playMove(m) {
  history.push(JSON.stringify(game));
  Rules.play(game, m);
  selected = null;
  animate = m;                       // tell render() to animate this move
}

function onPointClick(p) {
  if (game.winner || isComputerTurn()) return;
  const piece = game.board[p];

  if (game.turn === "goat" && game.goatsInHand > 0) {           // placement phase
    if (piece === null) playMove({ from: null, to: p, over: null });
  } else if (piece === game.turn) {                             // pick (or un-pick) one of your pieces
    selected = selected === p ? null : p;
  } else if (selected !== null) {                               // move it
    const m = Rules.movesFrom(game, selected).find(mv => mv.to === p);
    if (m) playMove(m);
  }
  render();
  maybeComputerMove();
}

function maybeComputerMove() {
  if (!isComputerTurn() || thinking) return;
  thinking = true;
  setTimeout(() => {                                            // short pause so you can see the board
    thinking = false;
    if (isComputerTurn()) playMove(AI.chooseMove(game, game.turn, Number($("level").value)));
    render();
    maybeComputerMove();
  }, 600);                                                      // a bit longer than the move animations
}

// Undo goes back to a snapshot where it's YOUR turn (so against the computer it undoes both moves).
function findUndoIndex() {
  if (thinking || isComputerTurn()) return -1;
  let i = history.length - 1;
  if (vsComputer()) while (i >= 0 && JSON.parse(history[i]).turn === computerSide()) i--;
  return i;
}
function undo() {
  const i = findUndoIndex();
  if (i < 0) return;
  game = JSON.parse(history[i]);
  history.length = i;
  selected = null; popupClosed = false;
  render();
}

// How did the game end for the person at the screen? "win", "lose" or "draw" (null while playing).
function resultForMe() {
  if (!game.winner) return null;
  if (game.winner === "Draw") return "draw";
  if (!vsComputer()) return "win";                          // 2 players: someone always wins
  return (game.winner === "Tigers" ? "tiger" : "goat") === $("mySide").value ? "win" : "lose";
}

function statusText(result) {
  const vs = vsComputer(), me = $("mySide").value;
  if (result === "draw") return WORDS.draw;
  if (result) return !vs ? WORDS.win(game.winner) : (result === "win" ? WORDS.youWin : WORDS.youLose)(icon(me));
  if (isComputerTurn()) return WORDS.thinking(icon(game.turn));
  const action = game.turn === "tiger" ? WORDS.moveTiger : game.goatsInHand > 0 ? WORDS.placeGoat : WORDS.moveGoat;
  return vs ? WORDS.yourTurn(icon(game.turn), action)
            : WORDS.turn2p(icon(game.turn), game.turn === "tiger" ? "Tigers" : "Goats", action);
}

// Put a data-result="win|lose|draw" label on an element (CSS colours it), or remove it.
function setResult(el, result) { if (result) el.dataset.result = result; else delete el.dataset.result; }

// ---- drawing: builds simple HTML elements; the CSS decides how they look ----
const place = p => `left:${(p % 5) * 25}%;top:${Math.floor(p / 5) * 25}%`;

function render() {
  const anim = animate; animate = null;           // the move to animate (only right after a move; undo/select never animate)
  let lines = "", points = "", pieces = "";
  const moves = selected === null ? [] : Rules.movesFrom(game, selected);
  const last = game.lastMove;

  for (let p = 0; p < 25; p++) {
    for (const q of Rules.adj[p])
      if (q > p) lines += `<line x1="${(p % 5) * 25}" y1="${Math.floor(p / 5) * 25}" x2="${(q % 5) * 25}" y2="${Math.floor(q / 5) * 25}"/>`;

    const m = moves.find(mv => mv.to === p);
    let cls = "point";
    if (m)                          cls += m.over !== null ? " capture" : " move";
    if (last && last.to === p)      cls += " last-to";
    if (last && last.from === p)    cls += " last-from";
    points += `<div class="${cls}" style="${place(p)}" data-p="${p}"></div>`;

    if (game.board[p]) {
      let cls = `piece ${game.board[p]}${selected === p ? " selected" : ""}`, vars = "";
      if (anim && anim.to === p) {                                           // the piece that just moved
        cls += anim.from === null ? " drop" : anim.over !== null ? " hop" : " slide";
        if (anim.from !== null) vars = `;--fx:${(anim.from % 5) * 25}%;--fy:${Math.floor(anim.from / 5) * 25}%`;   // where it came from
      }
      pieces += `<div class="${cls}" style="${place(p)}${vars}"></div>`;
    }
  }
  if (anim && anim.over !== null) pieces = `<div class="piece goat dying" style="${place(anim.over)}"></div>` + pieces;   // the captured goat fades out
  $("grid").innerHTML = `<svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>${points}${pieces}`;

  // status line + turn banner colour
  const result = resultForMe();
  $("status").textContent = statusText(result);

  // side panel
  $("phaseLine").textContent = game.winner ? "Game over" : game.goatsInHand > 0 ? "Placement phase" : "Movement phase";
  if (game.winner) delete $("turn").dataset.side; else $("turn").dataset.side = game.turn;   // while playing: tinted by side
  setResult($("turn"), result);                                                              // at the end: green / red / blue
  document.querySelectorAll(".cpu-only").forEach(el => el.hidden = !vsComputer());   // hide computer options in 2-player mode
  $("inHand").textContent   = game.goatsInHand;
  $("onBoard").textContent  = game.board.filter(v => v === "goat").length;
  $("captured").textContent = game.captured;
  if (anim && anim.over !== null) {                            // bump the counter when a goat is captured
    const tile = $("captured").closest(".stat");
    tile.classList.remove("bump"); void tile.offsetWidth; tile.classList.add("bump");
  }
  $("undo").disabled        = findUndoIndex() < 0;

  // game-over popup: after a move, wait a moment so you can watch the last move first
  clearTimeout(popupTimer);
  if (anim && game.winner) popupTimer = setTimeout(() => updatePopup(result), popupDelay());
  else updatePopup(result);
}

function updatePopup(result) {
  const showPopup = game.winner && !popupClosed;
  $("overlay").style.display = showPopup ? "flex" : "none";
  setResult($("popup"), showPopup ? result : null);
  if (showPopup) {
    $("overTitle").textContent = result === "draw" ? "Draw" : vsComputer() ? statusText(result) : `${icon(game.winner === "Tigers" ? "tiger" : "goat")} ${WORDS.win(game.winner)}`;
    $("overMsg").textContent = game.winner === "Draw" ? WORDS.over.draw
      : game.winner === "Goats" ? WORDS.over.trapped
      : game.captured >= Rules.config.capturesToWin ? WORDS.over.captured : WORDS.over.stuck;
  }
}

// ---- start-up ----
document.querySelectorAll("[data-icon]").forEach(el => el.textContent = `${icon(el.dataset.icon)} ${el.textContent}`.trim());
document.querySelectorAll("[data-rule]").forEach(el => el.textContent = Rules.config[el.dataset.rule]);

$("grid").addEventListener("click", e => { const pt = e.target.closest(".point"); if (pt) onPointClick(Number(pt.dataset.p)); });
$("new").onclick = newGame;
$("undo").onclick = undo;
$("overNew").onclick = newGame;
$("overClose").onclick = () => { popupClosed = true; render(); };
$("mode").onchange = newGame;       // changing mode or side starts a fresh game
$("mySide").onchange = newGame;
if (window.innerWidth > 1100) $("about").open = true;   // show the rules on wide screens

newGame();
