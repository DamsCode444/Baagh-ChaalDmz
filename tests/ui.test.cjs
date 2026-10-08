const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM, VirtualConsole } = require("jsdom");
const { createServer } = require("../server/app.cjs");
const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const scripts = ["rules.js", "ai.js", "controller.js", "multiplayer.js", "ui.js"];
async function waitFor(check, timeout = 7000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > timeout) throw new Error("UI condition timed out"); await new Promise(r => setTimeout(r, 20)); }
}
function localUi(t, mySide = "goat") {
  const dom = new JSDOM(html, { url: "http://localhost", runScripts: "outside-only" }), win = dom.window;
  t.after(() => win.close());
  const pending = new Map(); let now = 0, id = 0;
  win.setTimeout = (fn, delay) => { pending.set(++id, { fn, due: now + delay }); return id; };
  win.clearTimeout = id => pending.delete(id);
  win.document.getElementById("mySide").value = mySide;
  for (const file of scripts) vm.runInContext(fs.readFileSync(path.join(root, "js", file), "utf8"), dom.getInternalVMContext());
  return { win, pending, advance(time) { now = time; for (const [key, timer] of [...pending]) if (timer.due <= now) { pending.delete(key); timer.fn(); } },
    click(p) { win.document.querySelector(`[data-p="${p}"]`).click(); }, state() { return JSON.parse(win.eval("JSON.stringify(game)")); } };
}
test("reset cancels the previous computer timer and gives the new match its own delay", t => {
  const ui = localUi(t, "tiger"); ui.advance(500); ui.win.document.getElementById("new").click();
  ui.advance(600); assert.equal(ui.state().goatsInHand, 20);
  ui.advance(1100); assert.equal(ui.state().goatsInHand, 19);
});
test("switching away from computer play clears thinking and restores local undo", async t => {
  const ui = localUi(t, "tiger"), mode = ui.win.document.getElementById("mode");
  mode.value = "2p"; await mode.onchange(); ui.click(12);
  assert.equal(ui.win.document.getElementById("undo").disabled, false);
  ui.win.document.getElementById("undo").click(); assert.equal(ui.state().goatsInHand, 20);
  ui.advance(600); assert.equal(ui.state().goatsInHand, 20);
});
test("board buttons support arrow navigation, labels and focus preservation", async t => {
  const ui = localUi(t), win = ui.win, mode = win.document.getElementById("mode");
  mode.value = "2p"; await mode.onchange();
  const point = win.document.querySelector('[data-p="12"]');
  assert.equal(point.tagName, "BUTTON"); assert(point.getAttribute("aria-label").includes("Row 3, column 3"));
  point.focus(); point.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  assert.equal(win.document.activeElement.dataset.p, "13"); ui.click(13);
  assert.equal(win.document.activeElement.dataset.p, "13"); assert.equal(ui.state().board[13], "goat");
});
async function onlineUi(t, beforeConnect = () => {}) {
  const server = await createServer({ database: { url: ":memory:" }, rateLimits: false, logLevel: "silent" });
  beforeConnect(server);
  const address = await server.listen(0, "127.0.0.1"), base = `http://127.0.0.1:${address.port}`, windows = [], errors = [];
  t.after(async () => {
    for (const win of windows) { await win.eval("Multiplayer.leave()"); win.close(); }
    await server.close();
  });
  async function page(url, seat = null) {
    const virtualConsole = new VirtualConsole(); virtualConsole.on("jsdomError", error => errors.push(error.message));
    const dom = await JSDOM.fromURL(url, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole,
      beforeParse(win) { if (seat) win.sessionStorage.setItem("baagh-chaal-seat-v1", JSON.stringify(seat)); } });
    windows.push(dom.window); await waitFor(() => dom.window.document.querySelectorAll(".point").length === 25);
    return dom.window;
  }
  const a = await page(base), docA = a.document;
  docA.getElementById("mode").value = "online"; await docA.getElementById("mode").onchange();
  await waitFor(() => !docA.getElementById("createRoom").disabled);
  docA.getElementById("playerName").value = "Host"; docA.getElementById("createRoom").click();
  await waitFor(() => !docA.getElementById("roomDetails").hidden);
  const code = docA.getElementById("activeRoomCode").textContent; assert.equal(code.length, 8);
  const b = await page(`${base}/?room=${code}`), docB = b.document;
  await waitFor(() => !docB.getElementById("joinRoom").disabled);
  assert.equal(docB.getElementById("roomCode").value, code);
  docB.getElementById("joinForm").dispatchEvent(new b.Event("submit", { bubbles: true, cancelable: true }));
  await waitFor(() => a.eval("Multiplayer.state.room?.status") === "active" && b.eval("Multiplayer.state.room?.status") === "active");
  await waitFor(() => !a.eval("Multiplayer.state.busy") && !b.eval("Multiplayer.state.busy"));
  return { server, a, b, docA, docB, base, page, errors };
}

test("real frontend scripts create, invite, join, synchronize, resign and rematch", async t => {
  const { a, b, docA, docB, base, page, errors } = await onlineUi(t);
  docB.querySelector('[data-p="12"]').click(); assert.equal(docB.getElementById("inHand").textContent, "20");
  docA.querySelector('[data-p="12"]').click();
  await waitFor(() => docA.getElementById("inHand").textContent === "19" && docB.getElementById("inHand").textContent === "19");
  assert.equal(docB.getElementById("undo").hidden, true);
  assert.equal(docA.querySelector('[data-p="12"]').getAttribute("aria-label"), "Row 3, column 3: goat");
  docB.querySelector('[data-p="0"]').click(); docB.querySelector('[data-p="1"]').click();
  await waitFor(() => a.eval("game.board[1]") === "tiger" && b.eval("game.board[1]") === "tiger");
  // A fresh page uses only its stored private seat credentials to resume.
  const seat = JSON.parse(b.sessionStorage.getItem("baagh-chaal-seat-v1"));
  const refreshed = await page(base, seat);
  await waitFor(() => refreshed.eval("Multiplayer.state.room?.status") === "active");
  assert.equal(refreshed.eval("game.board[1]"), "tiger");
  assert(b.document.getElementById("networkError").textContent.includes("another window"));
  docA.getElementById("resign").click();
  await waitFor(() => docA.getElementById("status").textContent.includes("lose") && refreshed.document.getElementById("status").textContent.includes("win"));
  docA.getElementById("overNew").click();
  await waitFor(() => docA.getElementById("roomHelp").textContent.includes("Waiting for your opponent"));
  refreshed.document.getElementById("overNew").click();
  await waitFor(() => a.eval("Multiplayer.state.side") === "tiger" && refreshed.eval("Multiplayer.state.side") === "goat");
  assert.equal(docA.getElementById("inHand").textContent, "20");
  assert.equal(docA.getElementById("overlay").style.display, "none");
  assert.deepEqual(errors, []);
});

test("private room results release lobby controls even when socket acknowledgements are lost", async t => {
  const { a, b, docA, docB, errors } = await onlineUi(t, server => {
    server.io.on("connection", socket => {
      socket.use((packet, next) => {
        if (["room:create", "room:join"].includes(packet[0]) && typeof packet.at(-1) === "function") packet[packet.length - 1] = () => {};
        next();
      });
    });
  });
  assert.equal(a.eval("Multiplayer.state.busy"), false); assert.equal(b.eval("Multiplayer.state.busy"), false);
  assert(a.sessionStorage.getItem("baagh-chaal-seat-v1")); assert(b.sessionStorage.getItem("baagh-chaal-seat-v1"));
  assert.equal(docA.getElementById("connectionStatus").textContent, "Connected");
  assert.equal(docB.getElementById("networkError").hidden, true);
  assert.deepEqual(errors, []);
});

test("moves render before a delayed save, confirm without replaying animation and roll back on rejection", async t => {
  const { server, a, b, docA, docB, errors } = await onlineUi(t);
  const save = server.store.save.bind(server.store); let release;
  const delayed = new Promise(resolve => { release = resolve; }); let saving = false;
  server.store.save = async (...args) => { saving = true; await delayed; return save(...args); };
  try {
    docA.querySelector('[data-p="12"]').click();
    assert.equal(a.eval("game.board[12]"), "goat");
    assert.equal(docA.getElementById("inHand").textContent, "19");
    assert.equal(a.eval("Multiplayer.state.room.game.board[12]"), null);
    assert.equal(a.eval("Multiplayer.state.pending"), true);
    assert.equal(b.eval("game.board[12]"), null);
    const previewPiece = docA.querySelector(".piece.goat"); assert(previewPiece.classList.contains("drop"));
    docA.querySelector('[data-p="13"]').click(); assert.equal(a.eval("game.board[13]"), null);
    await waitFor(() => saving);
    assert.equal((await server.store.get(a.eval("Multiplayer.state.room.code"))).moveNumber, 0);
    release();
    await waitFor(() => !a.eval("Multiplayer.state.pending") && b.eval("game.board[12]") === "goat");
    assert.equal(a.eval("Multiplayer.state.preview"), null);
    assert.equal(docA.querySelector(".piece.goat"), previewPiece);
    assert.equal(server.service.rooms.get(a.eval("Multiplayer.state.room.code")).moveNumber, 1);

    server.store.save = async () => { const error = new Error("simulated save rejection"); error.code = "TEST_DB_FAILURE"; throw error; };
    docB.querySelector('[data-p="0"]').click(); docB.querySelector('[data-p="1"]').click();
    assert.equal(b.eval("game.board[1]"), "tiger"); assert.equal(b.eval("game.board[0]"), null);
    await waitFor(() => !b.eval("Multiplayer.state.pending") && !!b.eval("Multiplayer.state.error"));
    assert.equal(b.eval("game.board[1]"), null); assert.equal(b.eval("game.board[0]"), "tiger");
    assert.equal(b.eval("Multiplayer.state.preview"), null);
    assert.equal(a.eval("game.board[1]"), null);
    assert(docB.getElementById("networkError").textContent.includes("could not be saved"));
    assert.deepEqual(errors, []);
  } finally { release(); server.store.save = save; }
});

test("disconnecting clears an unconfirmed preview immediately", async t => {
  const { server, a, docA } = await onlineUi(t);
  const save = server.store.save.bind(server.store); let release, saving = false;
  const delayed = new Promise(resolve => { release = resolve; });
  server.store.save = async (...args) => { saving = true; await delayed; return save(...args); };
  try {
    docA.querySelector('[data-p="12"]').click(); assert.equal(a.eval("game.board[12]"), "goat");
    await waitFor(() => saving);
    const playerId = a.eval("Multiplayer.state.playerId");
    [...server.io.sockets.sockets.values()].find(socket => socket.data.playerId === playerId).disconnect(true);
    await waitFor(() => !a.eval("Multiplayer.state.connected"));
    assert.equal(a.eval("Multiplayer.state.preview"), null);
    assert.equal(a.eval("game.board[12]"), null);
    release();
    await server.service.drain();
  } finally { release(); server.store.save = save; }
});
