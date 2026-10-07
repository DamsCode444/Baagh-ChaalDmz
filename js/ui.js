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
const localMatch = new GameController.LocalMatch();
let game, selected = null, thinking = false, popupClosed = false;
let animate = null;      // the move to animate on the NEXT render (set right after a move, then cleared)
let popupTimer = null;
let computerTimer = null, generation = 0, focusPoint = 12, returnFocus = null, boardSignature = null;
let previousMode = $("mode").value, seenGameId = null, seenMoveNumber = 0;

const vsComputer     = () => $("mode").value === "cpu";
const isOnline       = () => $("mode").value === "online";
const computerSide   = () => $("mySide").value === "goat" ? "tiger" : "goat";
const isComputerTurn = () => !game.winner && vsComputer() && game.turn === computerSide();
const roomOperationText = () => ({ "room:create": "Creating room…", "room:join": "Joining room…",
  "room:resume": "Reconnecting to room…", "game:rematch": "Preparing rematch…" }[Multiplayer.state.operation] || "Updating room…");

function newGame() {
  if (isOnline()) {
    if (Multiplayer.state.room?.status === "finished") Multiplayer.rematch();
    else $("createRoom").focus();
    return;
  }
  resetLocal();
}

function resetLocal() {
  clearTimeout(computerTimer); computerTimer = null; generation++; thinking = false;
  clearTimeout(popupTimer); animate = null;
  game = localMatch.reset();
  selected = null; popupClosed = false; seenGameId = null; seenMoveNumber = 0;
  render();
  maybeComputerMove();
}

// Make a move for whoever's turn it is (human or computer). Saves a snapshot first, for Undo.
function playMove(m) {
  if (isOnline()) { selected = null; Multiplayer.move(m.from, m.to); return; }
  m = localMatch.play(m);
  selected = null;
  animate = m;                       // tell render() to animate this move
}

function onPointClick(p) {
  focusPoint = p;
  if (!canPlay()) return;
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
  const scheduledGeneration = generation;
  computerTimer = setTimeout(() => {
    if (generation !== scheduledGeneration) return;
    computerTimer = null;
    thinking = false;
    if (isComputerTurn()) {
      const move = AI.chooseMove(game, game.turn, Number($("level").value));
      if (move) playMove(move);
    }
    render();
    maybeComputerMove();
  }, 600);                                                      // a bit longer than the move animations
}

// Undo goes back to a snapshot where it's YOUR turn (so against the computer it undoes both moves).
function findUndoIndex() {
  if (isOnline() || thinking || isComputerTurn()) return -1;
  return localMatch.undoIndex(vsComputer() ? computerSide() : null);
}
function undo() {
  const i = findUndoIndex();
  if (i < 0) return;
  game = localMatch.undo(i);
  selected = null; popupClosed = false;
  render();
}

// How did the game end for the person at the screen? "win", "lose" or "draw" (null while playing).
function resultForMe() {
  if (!game.winner) return null;
  if (game.winner === "Draw") return "draw";
  if (!vsComputer() && !isOnline()) return "win";
  return (game.winner === "Tigers" ? "tiger" : "goat") === (isOnline() ? Multiplayer.state.side : $("mySide").value) ? "win" : "lose";
}

function statusText(result) {
  const vs = vsComputer() || isOnline(), me = isOnline() ? Multiplayer.state.side : $("mySide").value;
  if (result === "draw") return WORDS.draw;
  if (result) return !vs ? WORDS.win(game.winner) : (result === "win" ? WORDS.youWin : WORDS.youLose)(icon(me));
  if (isOnline()) {
    const state = Multiplayer.state;
    if (!state.room) return state.busy ? roomOperationText() : "Create or join an online room";
    if (!state.connected) return "Connection lost — reconnecting";
    if (state.busy) return roomOperationText();
    if (state.room.status === "waiting") return "Waiting for your friend to join";
    if (state.room.status === "paused") return "Match paused — waiting for reconnection";
    if (state.room.status === "closed") return "Room closed";
    if (state.pending) return "Confirming your move…";
    if (game.turn !== state.side) return `Opponent's turn (${icon(game.turn)})`;
  }
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
  const focused = document.activeElement?.dataset?.p;
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
    const label = `Row ${Math.floor(p / 5) + 1}, column ${p % 5 + 1}: ${game.board[p] || "empty"}${m ? m.over !== null ? ", capture available" : ", legal move" : ""}`;
    points += `<button type="button" class="${cls}" style="${place(p)}" data-p="${p}" tabindex="${focusPoint === p ? 0 : -1}" aria-label="${label}" aria-pressed="${selected === p}" aria-disabled="${!canPlay()}"></button>`;

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
  const signature = JSON.stringify([game.board, selected, game.lastMove, canPlay()]);
  if (signature !== boardSignature || anim) {
    $("grid").innerHTML = `<svg class="lines" viewBox="0 0 100 100" preserveAspectRatio="none">${lines}</svg>${points}${pieces}`;
    boardSignature = signature;
    if (focused !== undefined) $("grid").querySelector(`[data-p="${focused}"]`)?.focus();
  }

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
  renderOnline();

  // game-over popup: after a move, wait a moment so you can watch the last move first
  clearTimeout(popupTimer);
  if (anim && game.winner) popupTimer = setTimeout(() => updatePopup(result), popupDelay());
  else updatePopup(result);
}

function updatePopup(result) {
  const wasOpen = $("overlay").style.display === "flex";
  const showPopup = game.winner && !popupClosed;
  $("overlay").style.display = showPopup ? "flex" : "none";
  setResult($("popup"), showPopup ? result : null);
  if (showPopup) {
    $("overTitle").textContent = result === "draw" ? "Draw" : vsComputer() || isOnline() ? statusText(result) : `${icon(game.winner === "Tigers" ? "tiger" : "goat")} ${WORDS.win(game.winner)}`;
    $("overMsg").textContent = game.winner === "Draw" ? WORDS.over.draw
      : game.winner === "Goats" ? WORDS.over.trapped
      : game.captured >= Rules.config.capturesToWin ? WORDS.over.captured : WORDS.over.stuck;
    if (game.resultReason === "resignation") $("overMsg").textContent = result === "win" ? "Your opponent resigned." : "You resigned.";
    if (game.resultReason === "disconnect") $("overMsg").textContent = "The reconnect window ended.";
    if (game.resultReason === "abandoned") $("overMsg").textContent = "Both players disconnected.";
    if (!wasOpen) { returnFocus = document.activeElement; $("overClose").focus(); }
  } else if (wasOpen) {
    if (returnFocus?.isConnected) returnFocus.focus();
    else $("grid").querySelector(`[data-p="${focusPoint}"]`)?.focus();
  }
}

function canPlay() {
  if (!game || game.winner || isComputerTurn()) return false;
  if (!isOnline()) return true;
  const state = Multiplayer.state;
  return state.connected && !state.busy && !state.pending && state.room?.status === "active" && state.side === game.turn;
}

function canRematch() {
  const state = Multiplayer.state;
  return state.connected && !state.busy && !state.pending && state.room?.status === "finished"
    && state.room.players.every(p => p.connected && !p.left) && !state.room.rematchVotes.includes(state.playerId);
}

function renderOnline() {
  const online = isOnline(), state = Multiplayer.state, room = state.room;
  $("onlinePanel").hidden = !online;
  $("undo").hidden = online;
  $("new").hidden = online && !room;
  $("new").textContent = online ? "Request rematch" : "New game";
  $("new").disabled = online && !canRematch();
  $("overNew").textContent = online ? "Request rematch" : "New game";
  $("overNew").disabled = online && !canRematch();
  $("mode").disabled = online && (state.busy || state.pending);
  if (!online) return;
  $("connectionStatus").textContent = state.connected ? state.busy ? roomOperationText() : "Connected" : state.available ? "Connecting to server…" : "Start with npm start for online play";
  $("connectionStatus").dataset.connected = String(state.connected);
  $("retryConnection").hidden = state.connected && !state.error;
  $("retryConnection").disabled = state.busy || state.pending;
  $("roomLobby").hidden = !!room; $("roomDetails").hidden = !room;
  $("createRoom").disabled = $("joinRoom").disabled = !state.connected || state.busy || state.pending;
  $("networkError").textContent = state.error; $("networkError").hidden = !state.error;
  if (!room) return;
  $("activeRoomCode").textContent = room.code;
  $("playerList").textContent = room.players.map(p => `${p.id === state.playerId ? "You" : p.name} · ${p.side === "goat" ? "Goats" : "Tigers"} · ${p.left ? "Left" : p.connected ? "Connected" : "Disconnected"}`).join("\n");
  const voted = room.rematchVotes.includes(state.playerId);
  $("roomHelp").textContent = room.status === "waiting" ? "Share the invite link with your friend."
    : room.status === "paused" ? "Your seat is reserved while reconnecting. Play resumes when both players return."
    : room.status === "finished" ? voted ? "Rematch requested. Waiting for your opponent." : room.players.some(p => p.left) ? "Your opponent left. Leave this room to create another." : "Both players can request a rematch to play again and swap sides."
    : "You control your assigned side. Leaving or switching modes resigns this match.";
  $("resign").disabled = !state.connected || state.busy || state.pending || !["active", "paused"].includes(room.status);
  $("leaveRoom").disabled = !state.connected || state.busy || state.pending;
  const url = new URL(window.location.href); url.search = ""; url.searchParams.set("room", room.code); url.hash = "";
  $("inviteLink").value = url.href;
}

Multiplayer.subscribe(state => {
  if (!isOnline()) return;
  if (state.room) {
    const displayedGame = state.preview?.game || state.room.game;
    const moveNumber = state.preview?.moveNumber ?? state.room.moveNumber;
    if (seenGameId !== state.room.gameId) { popupClosed = false; selected = null; animate = null; }
    else if (moveNumber > seenMoveNumber) { animate = displayedGame.lastMove; selected = null; }
    seenGameId = state.room.gameId; seenMoveNumber = moveNumber;
    game = { ...displayedGame, positionCounts: {} };
  } else if (seenGameId) {
    game = Rules.newGame(); seenGameId = null; seenMoveNumber = 0; popupClosed = false; selected = null;
  }
  render();
});

// ---- start-up ----
document.querySelectorAll("[data-icon]").forEach(el => el.textContent = `${icon(el.dataset.icon)} ${el.textContent}`.trim());
document.querySelectorAll("[data-rule]").forEach(el => el.textContent = Rules.config[el.dataset.rule]);

$("grid").addEventListener("click", e => { const pt = e.target.closest(".point"); if (pt) onPointClick(Number(pt.dataset.p)); });
$("grid").addEventListener("keydown", e => {
  const point = e.target.closest(".point"); if (!point) return;
  const p = Number(point.dataset.p), row = Math.floor(p / 5), col = p % 5;
  const next = e.key === "ArrowLeft" && col > 0 ? p - 1 : e.key === "ArrowRight" && col < 4 ? p + 1
    : e.key === "ArrowUp" && row > 0 ? p - 5 : e.key === "ArrowDown" && row < 4 ? p + 5 : null;
  if (!e.key.startsWith("Arrow")) return;
  e.preventDefault();
  if (next !== null) {
    focusPoint = next; $("grid").querySelectorAll(".point").forEach(el => el.tabIndex = Number(el.dataset.p) === next ? 0 : -1);
    $("grid").querySelector(`[data-p="${next}"]`).focus();
  }
});
$("new").onclick = newGame;
$("undo").onclick = undo;
$("overNew").onclick = newGame;
$("overClose").onclick = () => { popupClosed = true; render(); };
$("mode").onchange = async () => {
  const mode = $("mode").value;
  if (previousMode === "online" && !await Multiplayer.leave()) { $("mode").value = "online"; render(); return; }
  previousMode = mode; resetLocal();
  if (mode === "online") Multiplayer.start();
};
$("mySide").onchange = newGame;
if (window.innerWidth > 1100) $("about").open = true;   // show the rules on wide screens

$("createRoom").onclick = () => Multiplayer.create($("roomSide").value, $("playerName").value);
$("retryConnection").onclick = () => Multiplayer.retry();
$("joinForm").onsubmit = e => { e.preventDefault(); Multiplayer.join($("roomCode").value, $("playerName").value); };
$("resign").onclick = () => Multiplayer.resign();
$("leaveRoom").onclick = async () => { if (await Multiplayer.leave()) { resetLocal(); Multiplayer.start(); } };
$("copyInvite").onclick = async () => {
  try { await navigator.clipboard.writeText($("inviteLink").value); $("copyInvite").textContent = "Invite copied"; }
  catch { $("inviteFallback").hidden = false; $("inviteLink").focus(); $("inviteLink").select(); }
};
$("popup").addEventListener("keydown", e => {
  if (e.key === "Escape") { e.preventDefault(); popupClosed = true; render(); }
  if (e.key === "Tab") {
    const buttons = [...$("popup").querySelectorAll("button:not(:disabled)")];
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
const invitedRoom = new URLSearchParams(window.location.search).get("room");
if (invitedRoom || Multiplayer.hasSavedSeat()) {
  $("mode").value = "online"; previousMode = "online"; if (invitedRoom) $("roomCode").value = invitedRoom.toUpperCase();
}
resetLocal();
if (isOnline()) Multiplayer.start();
