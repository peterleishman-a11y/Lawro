"use strict";

/* ---------------------------------------------------------------- *
 * State + helpers
 * ---------------------------------------------------------------- */
const S = { me:null, players:[], leagueName:"Lawro", rounds:[], round:null,
            settings:null, tab:"predict", draft:new Map(), dirty:false };

const $  = sel => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { data, status: res.status });
  return data;
}

const fmtDeadline = ms => !ms ? "No deadline" :
  new Date(ms).toLocaleString(undefined, { weekday:"short", day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" });
const toLocalInput = ms => {
  if (!ms) return "";
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
function flash(kind, text, host) {
  const box = host || $("#main");
  const n = el("div", `msg ${kind}`, text);
  box.prepend(n);
  if (kind === "ok") setTimeout(() => n.remove(), 3500);
  return n;
}

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */
(async function boot() {
  try {
    const b = await api("/api/bootstrap");
    S.players = b.players; S.me = b.me; S.leagueName = b.leagueName || "Lawro";
    $("#leagueName").textContent = S.leagueName;
    S.me ? await enterApp() : renderLogin();
  } catch (e) {
    $("#main").innerHTML = "";
    flash("bad", `Could not reach the server. ${esc(e.message)}`);
  }
})();

$("#signOut").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  location.reload();
});

/* ---------------------------------------------------------------- *
 * Login: pick your name from the dropdown, then type your PIN
 * ---------------------------------------------------------------- */
function renderLogin() {
  $("#appHeader").classList.add("hide");
  $("#tabs").classList.add("hide");
  $("#saveBar").classList.add("hide");

  const main = $("#main");
  main.innerHTML = `
    <div class="login">
      <div class="badge">&#9917;</div>
      <h1 class="center" style="color:var(--green-dark);margin-bottom:2px">${esc(S.leagueName)}</h1>
      <p class="center muted" style="margin-bottom:16px">Pick your name, then enter your PIN</p>
      <div class="card">
        <div class="field">
          <label for="who">Player</label>
          <select id="who" autocomplete="username">
            <option value="">Choose your name&hellip;</option>
            ${S.players.map(p => `<option value="${esc(p.name)}">${esc(p.name)}${p.hasPin ? "" : " &mdash; set a PIN"}</option>`).join("")}
          </select>
        </div>
        <div id="nameWrap" class="field hide">
          <label for="realName">Your name</label>
          <input id="realName" autocomplete="name" maxlength="60">
          <p class="muted" style="margin:6px 0 0;font-size:.82em">
            This is how you'll appear on the table. WhatsApp may have shown you
            under something odd &mdash; change it here. Your picks still import either way.
          </p>
        </div>
        <div class="field">
          <label for="pin" id="pinLabel">PIN</label>
          <input id="pin" class="pin-input" type="password" inputmode="numeric"
                 pattern="[0-9]*" maxlength="4" autocomplete="current-password" placeholder="&bull;&bull;&bull;&bull;">
        </div>
        <div id="confirmWrap" class="field hide">
          <label for="pin2">Confirm PIN</label>
          <input id="pin2" class="pin-input" type="password" inputmode="numeric"
                 pattern="[0-9]*" maxlength="4" autocomplete="new-password" placeholder="&bull;&bull;&bull;&bull;">
        </div>
        <button class="btn" type="button" id="go" disabled>Sign in</button>
        <p class="muted center" style="margin-top:12px" id="loginHint">
          First time? Find yourself in the list, check your name, and pick a 4-digit PIN.
        </p>
      </div>
    </div>`;

  const who = $("#who"), pin = $("#pin"), pin2 = $("#pin2"), go = $("#go");
  const digitsOnly = e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4); update(); };
  const isNew = () => { const p = S.players.find(x => x.name === who.value); return p && !p.hasPin; };

  function update() {
    const newUser = isNew();
    $("#nameWrap").classList.toggle("hide", !newUser);
    const rn = $("#realName");
    if (newUser && rn.dataset.for !== who.value) {   // prefill once per selection
      rn.value = who.value; rn.dataset.for = who.value;
    }
    $("#confirmWrap").classList.toggle("hide", !newUser);
    $("#pinLabel").textContent = newUser ? "Choose a 4-digit PIN" : "PIN";
    go.textContent = newUser ? "Set PIN and sign in" : "Sign in";
    pin.autocomplete = newUser ? "new-password" : "current-password";
    const ok = who.value && pin.value.length === 4 && (!newUser || pin2.value.length === 4);
    go.disabled = !ok;
  }

  who.addEventListener("change", () => { pin.value = ""; pin2.value = ""; update(); pin.focus(); });
  pin.addEventListener("input", digitsOnly);
  pin2.addEventListener("input", digitsOnly);
  for (const box of [pin, pin2])
    box.addEventListener("keydown", e => { if (e.key === "Enter" && !go.disabled) go.click(); });

  go.addEventListener("click", async () => {
    document.querySelectorAll(".msg").forEach(m => m.remove());
    go.disabled = true;
    const name = who.value, newUser = isNew();
    try {
      if (newUser) {
        if (pin.value !== pin2.value) throw new Error("The two PINs do not match.");
        S.me = await api("/api/set-pin",
          { method:"POST", body:{ name, pin: pin.value, displayName: $("#realName").value.trim() } });
      } else {
        S.me = await api("/api/login", { method:"POST", body:{ name, pin: pin.value } });
      }
      await enterApp();
    } catch (e) {
      if (e.data?.error === "no-pin") {          // list was stale; switch to set-up mode
        S.players = S.players.map(p => p.name === name ? { ...p, hasPin:false } : p);
        update();
        flash("warn", "That name has no PIN yet — choose one now.", $(".login"));
      } else {
        flash("bad", e.message, $(".login"));
      }
      pin.value = ""; if (pin2) pin2.value = "";
      update();
    }
  });
  update();
}

/* ---------------------------------------------------------------- *
 * App shell
 * ---------------------------------------------------------------- */
async function enterApp() {
  $("#appHeader").classList.remove("hide");
  $("#whoami").textContent = S.me.name;
  S.settings = await api("/api/settings").catch(() => null);
  buildTabs();
  await go("predict");
}

function buildTabs() {
  const tabs = [["predict","Predict"], ["table","Results"], ["season","Season"]];
  if (S.me.isAdmin) tabs.push(["admin","Admin"]);
  tabs.push(["account","PIN"]);
  const nav = $("#tabs");
  nav.classList.remove("hide");
  nav.innerHTML = "";
  for (const [id, label] of tabs) {
    const b = el("button", null, label);
    b.type = "button"; b.setAttribute("role","tab");
    b.setAttribute("aria-selected", String(S.tab === id));
    b.addEventListener("click", () => go(id));
    nav.append(b);
  }
}

async function go(tab) {
  if (S.dirty && S.tab === "predict" && tab !== "predict" &&
      !confirm("You have unsaved predictions. Leave without saving?")) return;
  S.tab = tab; S.dirty = false;
  buildTabs();
  $("#saveBar").classList.add("hide");
  $("#main").innerHTML = `<div class="spinner">Loading&hellip;</div>`;
  try {
    if (tab === "predict") await viewPredict();
    else if (tab === "table") await viewResults();
    else if (tab === "season") await viewSeason();
    else if (tab === "admin") await viewAdmin();
    else if (tab === "account") viewAccount();
  } catch (e) {
    $("#main").innerHTML = "";
    flash("bad", e.message);
  }
}

/* ---------------------------------------------------------------- *
 * Predict: pick a round, then set every score and save
 * ---------------------------------------------------------------- */
async function viewPredict() {
  S.rounds = await api("/api/rounds");
  const open = S.rounds.filter(r => !r.locked);
  const main = $("#main"); main.innerHTML = "";

  if (!S.rounds.length) {
    main.append(cardEmpty("No rounds yet.", S.me.isAdmin
      ? "Head to Admin to create the first round."
      : "The organiser hasn't opened a round yet."));
    return;
  }
  const target = S.round && S.rounds.find(r => r.id === S.round.id) ? S.round.id
               : (open[0]?.id ?? S.rounds[0].id);
  main.append(roundPicker(target, id => { loadRound(id); }));
  await loadRound(target);
}

function roundPicker(selectedId, onPick) {
  const card = el("div","card");
  card.append(el("h2",null,"Round"));
  const sel = el("select"); sel.id = "roundPick";
  for (const r of S.rounds) {
    const o = el("option", null, `${r.name} — ${r.locked ? "closed" : "open"} (${r.gameCount} games)`);
    o.value = r.id; o.selected = r.id === selectedId;
    sel.append(o);
  }
  sel.addEventListener("change", () => onPick(Number(sel.value)));
  card.append(sel);
  return card;
}

async function loadRound(id) {
  document.querySelectorAll("#roundBody").forEach(n => n.remove());
  const body = el("div"); body.id = "roundBody";
  $("#main").append(body);
  body.innerHTML = `<div class="spinner">Loading&hellip;</div>`;

  const r = await api(`/api/rounds/${id}`);
  S.round = r; S.draft = new Map(); S.dirty = false;
  for (const g of r.games) if (g.pick) S.draft.set(g.id, { hg:g.pick.hg, ag:g.pick.ag });
  body.innerHTML = "";

  const head = el("div","card");
  head.append(el("h2", null, r.name));
  head.append(el("p","muted", r.locked
    ? `Closed — deadline was ${fmtDeadline(r.deadline)}`
    : `Open until ${fmtDeadline(r.deadline)}`));
  body.append(head);

  if (!r.games.length) { body.append(cardEmpty("No fixtures in this round yet.")); return; }

  const list = el("div","card");
  list.append(el("h2", null, r.locked ? "Your picks" : "Your predictions"));
  for (const g of r.games) list.append(fixtureRow(g, r.locked));
  body.append(list);

  if (!r.locked) {
    $("#saveBar").classList.remove("hide");
    updateSaveBar();
  }
}

/** One fixture: team name on the left, a thumb-sized stepper on the right. */
function fixtureRow(game, locked) {
  const wrap = el("div","fixture");
  const played = game.hg !== null && game.ag !== null;
  if (played) {
    const top = el("div","kickoff");
    top.append(el("span", null, "Final "));
    const chip = el("span","result-chip", `${game.hg}–${game.ag}`);
    top.append(chip);
    wrap.append(top);
  }
  for (const side of ["home","away"]) {
    const row = el("div","side");
    row.append(el("span","team", game[side]));
    row.append(locked ? staticScore(game, side) : stepper(game, side, false));
    wrap.append(row);
  }
  if (!locked) markDone(wrap, game.id);
  else wrap.classList.add("locked");
  return wrap;
}

/** Read-only score for a round that has closed. */
function staticScore(game, side) {
  const key = side === "home" ? "hg" : "ag";
  const v = S.draft.get(game.id)?.[key];
  return el("span", "score-static", v === null || v === undefined ? "—" : String(v));
}

function stepper(game, side, locked) {
  const key = side === "home" ? "hg" : "ag";
  const box = el("div","stepper");
  const input = el("input");
  input.type = "text"; input.inputMode = "numeric"; input.maxLength = 2;
  input.setAttribute("aria-label", `${game[side]} goals`);
  input.value = S.draft.get(game.id)?.[key] ?? "";
  input.disabled = locked;

  const bump = delta => {
    const cur = Number.parseInt(input.value, 10);
    const next = Math.max(0, Math.min(20, (Number.isNaN(cur) ? 0 : cur) + delta));
    input.value = String(next);
    commit();
  };
  const commit = () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 2);
    const d = S.draft.get(game.id) || { hg:null, ag:null };
    d[key] = input.value === "" ? null : Number(input.value);
    S.draft.set(game.id, d);
    S.dirty = true;
    markDone(input.closest(".fixture"), game.id);
    updateSaveBar();
  };

  const minus = el("button", null, "−"); minus.type = "button";
  const plus  = el("button", null, "+");      plus.type = "button";
  minus.disabled = plus.disabled = locked;
  minus.addEventListener("click", () => bump(-1));
  plus.addEventListener("click", () => bump(1));
  input.addEventListener("input", commit);

  box.append(minus, input, plus);
  return box;
}

const isComplete = id => {
  const d = S.draft.get(id);
  return !!d && d.hg !== null && d.ag !== null;
};
function markDone(wrap, id) { if (wrap) wrap.classList.toggle("done", isComplete(id)); }

function updateSaveBar() {
  if (!S.round) return;
  const total = S.round.games.length;
  const done = S.round.games.filter(g => isComplete(g.id)).length;
  $("#saveCount").textContent = `${done}/${total}`;
  $("#saveBtn").disabled = done === 0;
}

$("#saveBtn").addEventListener("click", async () => {
  const btn = $("#saveBtn"); btn.disabled = true; btn.textContent = "Saving…";
  const picks = [...S.draft.entries()]
    .filter(([id]) => isComplete(id))
    .map(([game_id, d]) => ({ game_id, hg:d.hg, ag:d.ag }));
  try {
    const out = await api(`/api/rounds/${S.round.id}/predictions`, { method:"POST", body:{ picks } });
    S.dirty = false;
    const missing = S.round.games.length - out.saved;
    flash("ok", missing > 0
      ? `Saved ${out.saved} of ${S.round.games.length}. ${missing} still blank.`
      : `All ${out.saved} predictions saved.`);
  } catch (e) {
    flash("bad", e.message);
  } finally {
    btn.textContent = "Save predictions"; updateSaveBar();
  }
});

window.addEventListener("beforeunload", e => { if (S.dirty) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------------------------------------------------------- *
 * Results: one round's table, once the deadline has passed
 * ---------------------------------------------------------------- */
async function viewResults() {
  S.rounds = await api("/api/rounds");
  const main = $("#main"); main.innerHTML = "";
  if (!S.rounds.length) { main.append(cardEmpty("No rounds yet.")); return; }

  const visible = S.rounds.filter(r => r.locked || S.me.isAdmin);
  if (!visible.length) {
    main.append(cardEmpty("Nothing to show yet.", "Tables open up once a round's deadline passes."));
    return;
  }
  // Default to the newest round that has actually been scored, not just the
  // newest round — otherwise you land on a table of nils.
  const pick = (visible.find(r => r.resultsIn) || visible[0]).id;
  const card = el("div","card");
  card.append(el("h2",null,"Round"));
  const sel = el("select");
  for (const r of visible) {
    const o = el("option", null, `${r.name}${r.locked ? "" : " (still open)"}${r.resultsIn ? "" : " — no results yet"}`);
    o.value = r.id; o.selected = r.id === pick; sel.append(o);
  }
  sel.addEventListener("change", () => showTable(Number(sel.value)));
  card.append(sel); main.append(card);
  await showTable(pick);
}

async function showTable(id) {
  document.querySelectorAll("#tableBody").forEach(n => n.remove());
  const body = el("div"); body.id = "tableBody"; $("#main").append(body);
  body.innerHTML = `<div class="spinner">Loading&hellip;</div>`;
  let data;
  try { data = await api(`/api/rounds/${id}/table`); }
  catch (e) { body.innerHTML = ""; body.append(cardEmpty(e.message)); return; }
  body.innerHTML = "";

  const settled = data.games.filter(g => g.hg !== null).length;
  const card = el("div","card");
  card.append(el("h2", null, `${data.round.name} — table`));
  if (!settled) card.append(el("p","muted","No results entered yet, so everyone is on nil."));

  const scroll = el("div","scroll");
  const t = el("table");
  t.innerHTML = `<thead><tr><th class="rank">#</th><th>Player</th>
    <th class="num">Exact</th><th class="num">Result</th><th class="num">Pts</th></tr></thead>`;
  const tb = el("tbody");
  for (const row of data.table) {
    const tr = el("tr");
    if (row.isFallback) tr.className = "pundit";
    else if (row.playerId === S.me.id) tr.className = "me";
    const tag = row.isFallback ? ' <span class="pill pundit">pundit</span>'
              : row.creditedFromPundit ? ' <span class="pill credited">Sutton</span>' : "";
    tr.innerHTML = `<td class="rank">${row.isFallback ? "—" : row.rank}</td>
      <td class="name">${esc(row.player)}${tag}</td>
      <td class="num">${row.exact}</td><td class="num">${row.results}</td>
      <td class="num pts">${row.points}</td>`;
    tb.append(tr);
  }
  t.append(tb); scroll.append(t); card.append(scroll); body.append(card);

  // Your own line, game by game.
  const mine = data.table.find(r => r.playerId === S.me.id);
  if (mine) {
    const det = el("div","card");
    det.append(el("h2",null,"Your round"));
    const s2 = el("div","scroll"); const t2 = el("table");
    t2.innerHTML = `<thead><tr><th>Game</th><th class="num">You</th><th class="num">Result</th><th class="num">Pts</th></tr></thead>`;
    const b2 = el("tbody");
    data.games.forEach((g, i) => {
      const c = mine.cells[i];
      const tr = el("tr");
      const badge = c.credited ? '<span class="pill credited">Sutton</span>'
                  : c.kind === "exact" ? '<span class="pill exact">40</span>'
                  : c.kind === "result" ? '<span class="pill result">10</span>' : "";
      tr.innerHTML = `<td class="name">${esc(g.home)} v ${esc(g.away)}</td>
        <td class="num">${c.pick ? `${c.pick.hg}–${c.pick.ag}` : "—"}</td>
        <td class="num">${g.hg === null ? "—" : `${g.hg}–${g.ag}`}</td>
        <td class="num pts">${c.points || ""} ${badge}</td>`;
      b2.append(tr);
    });
    t2.append(b2); s2.append(t2); det.append(s2); body.append(det);
  }
}

/* ---------------------------------------------------------------- *
 * Season
 * ---------------------------------------------------------------- */
async function viewSeason() {
  const data = await api("/api/season");
  const main = $("#main"); main.innerHTML = "";
  const cur = data.pot.currency || "";

  const potCard = el("div","card");
  potCard.append(el("h2",null,"Prize pot"));
  const pot = el("div","pot");
  pot.innerHTML = `
    <div><div class="l">Pot</div><div class="v">${cur}${data.pot.pot}</div>
      <div class="s">${data.table.length} &times; ${cur}${data.settings.entry_fee}</div></div>
    <div><div class="l">Season (${data.settings.share_season}%)</div><div class="v">${cur}${data.pot.seasonPrize}</div>
      <div class="s">${data.pot.leader ? esc(data.pot.leader.player) : "—"}</div></div>
    <div><div class="l">Best round (${data.settings.share_best_week}%)</div><div class="v">${cur}${data.pot.bestPrize}</div>
      <div class="s">${data.pot.best ? `${esc(data.pot.best.player)} · ${data.pot.best.points}` : "—"}</div></div>
    <div><div class="l">Players</div><div class="v">${data.table.length}</div>
      <div class="s">${data.table.filter(r => r.played).length} scored</div></div>`;
  potCard.append(pot);
  main.append(potCard);

  const card = el("div","card");
  card.append(el("h2",null,"Season table"));
  const scroll = el("div","scroll"); const t = el("table");
  t.innerHTML = `<thead><tr><th class="rank">#</th><th>Player</th><th class="num">Exact</th>
    <th class="num">Best</th><th class="num">Pts</th></tr></thead>`;
  const tb = el("tbody");
  for (const r of data.table) {
    const tr = el("tr");
    if (r.isFallback) tr.className = "pundit";
    else if (r.playerId === S.me.id) tr.className = "me";
    const tag = r.isFallback ? ' <span class="pill pundit">pundit</span>' : "";
    tr.innerHTML = `<td class="rank">${r.isFallback ? "—" : r.rank}</td>
      <td class="name">${esc(r.player)}${tag}</td>
      <td class="num">${r.exact}</td><td class="num">${r.best}</td><td class="num pts">${r.points}</td>`;
    tb.append(tr);
  }
  t.append(tb); scroll.append(t); card.append(scroll);
  if (!data.table.length) card.append(cardEmpty("No players yet."));
  main.append(card);
}

/* ---------------------------------------------------------------- *
 * Account
 * ---------------------------------------------------------------- */
function viewAccount() {
  const main = $("#main"); main.innerHTML = "";
  const card = el("div","card");
  card.innerHTML = `
    <h2>Change your PIN</h2>
    <div class="field"><label for="cur">Current PIN</label>
      <input id="cur" class="pin-input" type="password" inputmode="numeric" maxlength="4"></div>
    <div class="field"><label for="nw">New PIN</label>
      <input id="nw" class="pin-input" type="password" inputmode="numeric" maxlength="4"></div>
    <div class="field"><label for="nw2">Confirm new PIN</label>
      <input id="nw2" class="pin-input" type="password" inputmode="numeric" maxlength="4"></div>
    <button class="btn" type="button" id="chg">Change PIN</button>
    <p class="muted" style="margin-top:12px">Signed in as <strong>${esc(S.me.name)}</strong>.</p>`;
  main.append(card);
  for (const id of ["cur","nw","nw2"])
    $("#" + id).addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g,"").slice(0,4); });
  $("#chg").addEventListener("click", async () => {
    if ($("#nw").value !== $("#nw2").value) return flash("bad","The new PINs do not match.");
    try {
      await api("/api/change-pin", { method:"POST", body:{ currentPin:$("#cur").value, newPin:$("#nw").value } });
      flash("ok","PIN changed.");
      for (const id of ["cur","nw","nw2"]) $("#" + id).value = "";
    } catch (e) { flash("bad", e.message); }
  });
}

function cardEmpty(title, sub) {
  const c = el("div","card");
  c.append(el("div","empty", title));
  if (sub) c.append(el("p","muted center", sub));
  return c;
}

/* ---------------------------------------------------------------- *
 * Admin
 * ---------------------------------------------------------------- */
async function viewAdmin() {
  S.rounds = await api("/api/rounds");
  const main = $("#main"); main.innerHTML = "";
  main.append(adminNewRound(), adminRounds(), await adminPlayers(), adminSettings());
}

/* ---- new round: paste the fixture list, tweak, save ---- */
function adminNewRound() {
  const card = el("div","card");
  card.innerHTML = `
    <h2>New round</h2>
    <div class="field"><label for="rName">Name</label>
      <input id="rName" placeholder="Week ${S.rounds.length + 1}" value="Week ${S.rounds.length + 1}"></div>
    <div class="field"><label for="rDead">Deadline</label>
      <input id="rDead" type="datetime-local">
      <p class="muted" style="margin-top:6px">Predictions lock at this time and the table opens up.</p></div>
    <div class="field"><label for="rPaste">Fixtures — paste the list</label>
      <textarea id="rPaste" placeholder="Arsenal v Coventry&#10;Hull v Man Utd&#10;Everton v Cry Palace&#10;..."></textarea>
      <p class="muted" style="margin-top:6px">Paste straight from WhatsApp. Nicknames are fine — <em>B'mouth</em>, <em>Liverpoo</em>, <em>NottsForest</em> all resolve.</p></div>
    <div class="btnrow">
      <button class="btn ghost" type="button" id="rParse">Read fixtures</button>
      <button class="btn" type="button" id="rSave" disabled>Create round</button>
    </div>
    <div id="rPreview"></div>`;

  let fixtures = [];
  const preview = () => {
    const box = $("#rPreview"); box.innerHTML = "";
    if (!fixtures.length) return;
    box.append(el("h3", null, `${fixtures.length} fixtures`));
    fixtures.forEach((f, i) => {
      const row = el("div","fixture");
      const line = el("div","side");
      const h = el("input"); h.value = f.home; h.addEventListener("input", () => fixtures[i].home = h.value);
      const a = el("input"); a.value = f.away; a.addEventListener("input", () => fixtures[i].away = a.value);
      const v = el("span","muted"); v.textContent = "v"; v.style.flex = "0 0 auto";
      const del = el("button", null, "×");
      del.type = "button"; del.className = "btn ghost small"; del.style.flex = "0 0 auto";
      del.addEventListener("click", () => { fixtures.splice(i, 1); preview(); });
      line.append(h, v, a, del);
      row.append(line); box.append(row);
    });
    const add = el("button", null, "+ Add a fixture");
    add.type = "button"; add.className = "btn ghost small";
    add.addEventListener("click", () => { fixtures.push({ home:"", away:"" }); preview(); });
    box.append(add);
    $("#rSave").disabled = false;
  };

  card.querySelector("#rParse").addEventListener("click", async () => {
    try {
      const out = await api("/api/admin/parse-fixtures", { method:"POST", body:{ text:$("#rPaste").value } });
      fixtures = out.fixtures;
      if (!fixtures.length) return flash("warn","No fixtures recognised in that text.");
      preview();
    } catch (e) { flash("bad", e.message); }
  });

  card.querySelector("#rSave").addEventListener("click", async () => {
    const name = $("#rName").value.trim();
    if (!name) return flash("bad","Give the round a name.");
    const deadRaw = $("#rDead").value;
    try {
      await api("/api/admin/rounds", { method:"POST", body:{
        name, deadline: deadRaw ? new Date(deadRaw).getTime() : null, fixtures } });
      flash("ok", `${name} created.`);
      await go("admin");
    } catch (e) { flash("bad", e.message); }
  });
  return card;
}

/* ---- existing rounds: results, import, deadline, delete ---- */
function adminRounds() {
  const card = el("div","card");
  card.append(el("h2",null,"Rounds"));
  if (!S.rounds.length) { card.append(el("div","empty","Nothing yet.")); return card; }
  for (const r of S.rounds) {
    const item = el("div","round-item");
    const label = el("div","rname");
    label.append(document.createTextNode(r.name));
    const meta = el("div","rmeta",
      `${r.gameCount} games · ${r.locked ? "closed" : "open"} · ${fmtDeadline(r.deadline)}`);
    label.append(meta);
    const chip = el("span", `pill ${r.locked ? "shut" : "open"}`, r.locked ? "closed" : "open");
    item.append(label, chip);
    item.addEventListener("click", () => openRoundAdmin(r.id));
    card.append(item);
  }
  return card;
}

async function openRoundAdmin(id) {
  document.querySelectorAll("#adminRound").forEach(n => n.remove());
  const box = el("div"); box.id = "adminRound"; $("#main").append(box);
  box.scrollIntoView({ behavior:"smooth", block:"start" });
  box.innerHTML = `<div class="spinner">Loading…</div>`;

  const r = await api(`/api/rounds/${id}`);
  box.innerHTML = "";

  /* deadline + delete */
  const head = el("div","card");
  head.innerHTML = `<h2>${esc(r.name)}</h2>
    <div class="field"><label for="edDead">Deadline</label>
      <input id="edDead" type="datetime-local" value="${toLocalInput(r.deadline)}"></div>
    <div class="btnrow">
      <button class="btn ghost" type="button" id="edSave">Update deadline</button>
      <button class="btn danger" type="button" id="edDel">Delete round</button>
    </div>`;
  head.querySelector("#edSave").addEventListener("click", async () => {
    const v = $("#edDead").value;
    try {
      await api(`/api/admin/rounds/${id}`, { method:"PUT",
        body:{ deadline: v ? new Date(v).getTime() : null } });
      flash("ok","Deadline updated."); await go("admin");
    } catch (e) { flash("bad", e.message); }
  });
  head.querySelector("#edDel").addEventListener("click", async () => {
    if (!confirm(`Delete "${r.name}" and every prediction in it?`)) return;
    await api(`/api/admin/rounds/${id}`, { method:"DELETE" });
    flash("ok","Round deleted."); await go("admin");
  });
  box.append(head);

  /* results */
  if (r.games.length) {
    const res = el("div","card");
    res.append(el("h2",null,"Enter results"));
    res.append(el("p","muted","Leave a game blank until it's played."));
    const draft = new Map(r.games.map(g => [g.id, { hg:g.hg, ag:g.ag }]));
    for (const g of r.games) {
      const wrap = el("div","fixture");
      for (const side of ["home","away"]) {
        const key = side === "home" ? "hg" : "ag";
        const row = el("div","side");
        row.append(el("span","team", g[side]));
        const st = el("div","stepper");
        const input = el("input");
        input.type = "text"; input.inputMode = "numeric"; input.maxLength = 2;
        input.setAttribute("aria-label", `${g[side]} goals`);
        input.value = g[key] ?? "";
        const commit = () => {
          input.value = input.value.replace(/\D/g,"").slice(0,2);
          draft.get(g.id)[key] = input.value === "" ? null : Number(input.value);
        };
        const bump = d => {
          const cur = Number.parseInt(input.value, 10);
          input.value = String(Math.max(0, Math.min(20, (Number.isNaN(cur) ? 0 : cur) + d)));
          commit();
        };
        const m = el("button",null,"−"), p = el("button",null,"+");
        m.type = p.type = "button";
        m.addEventListener("click", () => bump(-1));
        p.addEventListener("click", () => bump(1));
        input.addEventListener("input", commit);
        st.append(m, input, p); row.append(st); wrap.append(row);
      }
      res.append(wrap);
    }
    const save = el("button",null,"Save results");
    save.type = "button"; save.className = "btn";
    save.addEventListener("click", async () => {
      const results = [...draft.entries()].map(([game_id, v]) => ({ game_id, hg:v.hg, ag:v.ag }));
      try {
        await api(`/api/admin/rounds/${id}/results`, { method:"POST", body:{ results } });
        flash("ok","Results saved. Tables updated.");
      } catch (e) { flash("bad", e.message); }
    });
    const fromBbc = el("button", null, "Fetch from BBC");
    fromBbc.type = "button"; fromBbc.className = "btn ghost";
    fromBbc.addEventListener("click", async () => {
      fromBbc.disabled = true; fromBbc.textContent = "Fetching…";
      try {
        const d = await api(`/api/admin/rounds/${id}/bbc-results`, { method:"POST", body:{} });
        flash("ok", `${d.applied} results applied from the BBC.` +
          (d.unmatched.length ? ` Not in this round: ${d.unmatched.join(", ")}.` : ""));
        await openRoundAdmin(id);
      } catch (e) { flash("bad", e.message); }
      finally { fromBbc.disabled = false; fromBbc.textContent = "Fetch from BBC"; }
    });
    const rowBtns = el("div","btnrow"); rowBtns.append(save, fromBbc);
    res.append(rowBtns);
    box.append(res);

    /* Chris Sutton's picks, which cover anyone who misses the round */
    box.append(punditCard(id, r));
  }

  /* WhatsApp import */
  const imp = el("div","card");
  imp.innerHTML = `
    <h2>Import from WhatsApp</h2>
    <p class="muted">For anyone who still replies in the group. Paste the export and their
      picks land in this round. Handles the usual mess — nicknames, reversed teams,
      re-sends, corrections.</p>
    <div class="field" style="margin-top:12px">
      <textarea id="waText" placeholder="[18/8/2026, 9:22:00 pm] Sam: Arsenal 2-0 Coventry&#10;Hull 0-2 Man Utd&#10;..."></textarea>
    </div>
    <label style="display:flex;gap:9px;align-items:center;font-weight:600">
      <input type="checkbox" id="waCreate" style="width:auto;min-height:auto" checked>
      Add players I haven't seen before
    </label>
    <button class="btn ghost" type="button" id="waGo" style="margin-top:12px">Import predictions</button>
    <div id="waOut"></div>`;
  imp.querySelector("#waGo").addEventListener("click", async () => {
    const out = $("#waOut"); out.innerHTML = `<div class="spinner">Parsing…</div>`;
    try {
      const d = await api(`/api/admin/rounds/${id}/import`, { method:"POST",
        body:{ text:$("#waText").value, createMissing:$("#waCreate").checked } });
      out.innerHTML = "";
      out.append(el("div","msg ok",
        `${d.players} players, ${d.picksSaved} picks imported.` +
        (d.created.length ? ` Added: ${d.created.join(", ")}.` : "") +
        (d.skipped.length ? ` Skipped (unknown): ${d.skipped.join(", ")}.` : "")));
      if (d.notes.length) {
        const det = el("details");
        det.append(el("summary", null, `${d.notes.length} entries needed interpreting`));
        const ul = el("ul");
        for (const n of d.notes) {
          const li = el("li");
          li.style.fontSize = ".85em"; li.style.margin = "5px 0 5px 18px";
          li.textContent = `${n.player}: ${n.notes.join("; ")}`;
          ul.append(li);
        }
        det.append(ul); out.append(det);
      }
    } catch (e) { out.innerHTML = ""; out.append(el("div","msg bad", e.message)); }
  });
  box.append(imp);
}

/**
 * Chris Sutton's predictions for a round. Whoever misses the round entirely
 * inherits these, scored on the result only.
 */
function punditCard(roundId, round) {
  const card = el("div","card");
  card.innerHTML = `
    <h2>Chris Sutton's predictions</h2>
    <p class="muted">Anyone who misses this round is credited with these, on the result
      only — 10 a game, never 40. Sutton appears in the tables in purple and cannot win a prize.</p>
    <div class="field" style="margin-top:12px">
      <label for="pdUrl">BBC article URL</label>
      <input id="pdUrl" placeholder="https://www.bbc.co.uk/sport/football/articles/...">
    </div>
    <button class="btn ghost" type="button" id="pdFetch">Fetch from BBC</button>
    <details>
      <summary>Or paste the article text</summary>
      <div class="field" style="margin-top:10px">
        <textarea id="pdText" placeholder="Arsenal v Coventry&#10;Sutton's prediction: 2-0&#10;..."></textarea>
      </div>
      <button class="btn ghost" type="button" id="pdPaste">Read pasted text</button>
    </details>
    <div id="pdOut"></div>`;

  const send = async body => {
    const out = $("#pdOut"); out.innerHTML = `<div class="spinner">Reading…</div>`;
    try {
      const d = await api(`/api/admin/rounds/${roundId}/bbc-predictions`, { method:"POST", body });
      out.innerHTML = "";
      out.append(el("div","msg ok",
        `${d.saved} of ${round.games.length} saved for ${d.pundit}.` +
        (d.unmatched.length ? ` Not in this round: ${d.unmatched.join(", ")}.` : "")));
    } catch (e) { out.innerHTML = ""; out.append(el("div","msg bad", e.message)); }
  };
  card.querySelector("#pdFetch").addEventListener("click", () => send({ url: $("#pdUrl").value.trim() }));
  card.querySelector("#pdPaste").addEventListener("click", () => send({ text: $("#pdText").value }));
  return card;
}

/* ---- players ---- */
async function adminPlayers() {
  const players = await api("/api/admin/players");
  const card = el("div","card");
  card.append(el("h2",null,`Players (${players.length})`));

  const add = el("div","field");
  add.innerHTML = `<label for="npName">Add a player</label>
    <div style="display:flex;gap:8px">
      <input id="npName" placeholder="Name exactly as it shows in WhatsApp">
      <button class="btn small" type="button" id="npGo" style="flex:0 0 auto">Add</button>
    </div>`;
  add.querySelector("#npGo").addEventListener("click", async () => {
    const name = $("#npName").value.trim();
    if (!name) return;
    try { await api("/api/admin/players", { method:"POST", body:{ name } });
          flash("ok",`${name} added.`); await go("admin"); }
    catch (e) { flash("bad", e.message); }
  });
  card.append(add);

  const scroll = el("div","scroll"); const t = el("table");
  t.innerHTML = `<thead><tr><th>Player</th><th class="num">PIN</th><th class="num">Paid</th><th class="num"></th></tr></thead>`;
  const tb = el("tbody");
  for (const p of players) {
    const tr = el("tr");
    const paid = el("input"); paid.type = "checkbox"; paid.checked = !!p.paid;
    paid.style.width = "auto"; paid.style.minHeight = "auto";
    paid.addEventListener("change", () =>
      api(`/api/admin/players/${p.id}`, { method:"PUT", body:{ paid: paid.checked ? 1 : 0 } })
        .catch(e => flash("bad", e.message)));

    const reset = el("button", null, "Reset PIN");
    reset.type = "button"; reset.className = "btn ghost small";
    reset.addEventListener("click", async () => {
      if (!confirm(`Clear ${p.name}'s PIN? They'll choose a new one next time they sign in.`)) return;
      try { await api(`/api/admin/players/${p.id}`, { method:"PUT", body:{ resetPin:true } });
            flash("ok","PIN cleared."); await go("admin"); }
      catch (e) { flash("bad", e.message); }
    });

    // Editable in place: WhatsApp names like "Gc" or "Y44BBE" are how the
    // export identifies people, not what anyone wants on the table.
    const nameCell = el("td","name");
    const nameIn = el("input"); nameIn.value = p.name; nameIn.className = "namein";
    nameIn.setAttribute("aria-label", `Name for ${p.name}`);
    const saveName = async () => {
      const v = nameIn.value.trim();
      if (!v || v === p.name) { nameIn.value = p.name; return; }
      try {
        await api(`/api/admin/players/${p.id}`, { method:"PUT", body:{ name: v } });
        flash("ok", `${p.name} is now ${v}. The old name still matches on import.`);
        await go("admin");
      } catch (e) { flash("bad", e.message); nameIn.value = p.name; }
    };
    nameIn.addEventListener("blur", saveName);
    nameIn.addEventListener("keydown", e => { if (e.key === "Enter") nameIn.blur(); });
    nameCell.append(nameIn);
    if (p.is_admin) nameCell.append(el("span","pill wa"," admin"));
    if (p.is_fallback) nameCell.append(el("span","pill pundit"," pundit"));
    if (p.aliases?.length) {
      const also = el("div","alsoknown");
      also.textContent = `also imports as ${p.aliases.join(", ")}`;
      nameCell.append(also);
    }
    const pinCell = el("td","num"); pinCell.textContent = p.has_pin ? "set" : "—";
    const paidCell = el("td","num"); paidCell.append(paid);
    // Merge: two rows, one human — someone who submitted under two WhatsApp
    // names. Picks move across and the absorbed name becomes an alias.
    const merge = el("button", null, "Merge…");
    merge.type = "button"; merge.className = "btn ghost small";
    merge.addEventListener("click", async () => {
      const others = players.filter(o => o.id !== p.id && !o.is_admin && !o.is_fallback);
      const who = prompt(
        `Merge another player INTO ${p.name}.\n\n` +
        `Type the name exactly. Their picks move to ${p.name}, and their name ` +
        `keeps matching on future imports. Where both picked the same game, ` +
        `${p.name}'s pick is kept.\n\n` +
        others.map(o => o.name).join("\n"));
      if (!who) return;
      const src = others.find(o => o.name.toLowerCase() === who.trim().toLowerCase());
      if (!src) return flash("bad", `No player called "${who.trim()}".`);
      if (!confirm(`Merge ${src.name} into ${p.name}? This cannot be undone.`)) return;
      try {
        const r = await api(`/api/admin/players/${p.id}/merge`, { method:"POST", body:{ sourceId: src.id } });
        flash("ok", `${r.absorbed} merged into ${r.into}: ${r.moved} picks moved` +
                    (r.discarded ? `, ${r.discarded} duplicate picks discarded.` : "."));
        await go("admin");
      } catch (e) { flash("bad", e.message); }
    });

    const actCell = el("td","num"); actCell.append(merge, reset);
    tr.append(nameCell, pinCell, paidCell, actCell);
    tb.append(tr);
  }
  t.append(tb); scroll.append(t); card.append(scroll);
  return card;
}

/* ---- settings ---- */
function adminSettings() {
  const s = S.settings || {};
  const card = el("div","card");
  card.innerHTML = `
    <h2>League settings</h2>
    <div class="grid2">
      <div class="field"><label for="sExact">Correct score</label><input id="sExact" inputmode="numeric" value="${s.points_exact ?? 40}"></div>
      <div class="field"><label for="sResult">Correct result</label><input id="sResult" inputmode="numeric" value="${s.points_result ?? 10}"></div>
      <div class="field"><label for="sFee">Entry fee</label><input id="sFee" inputmode="numeric" value="${s.entry_fee ?? 25}"></div>
      <div class="field"><label for="sCur">Currency</label><input id="sCur" value="${esc(s.currency ?? "€")}"></div>
      <div class="field"><label for="sSeason">Season share %</label><input id="sSeason" inputmode="numeric" value="${s.share_season ?? 80}"></div>
      <div class="field"><label for="sBest">Best round share %</label><input id="sBest" inputmode="numeric" value="${s.share_best_week ?? 20}"></div>
    </div>
    <div class="field"><label for="sName">League name</label><input id="sName" value="${esc(s.league_name ?? "Lawro")}"></div>
    <h3>BBC</h3>
    <p class="muted">The BBC publishes no supported API, so these can move. If a fetch stops
      working, update the address here rather than waiting for a code change — and everything
      can still be entered by hand.</p>
    <div class="field" style="margin-top:10px"><label for="sBbcR">Results feed URL</label>
      <input id="sBbcR" value="${esc(s.bbc_results_url ?? "")}" placeholder="leave blank for the built-in default"></div>
    <div class="field"><label for="sBbcP">Sutton predictions article URL</label>
      <input id="sBbcP" value="${esc(s.bbc_predictions_url ?? "")}" placeholder="this week's BBC predictions article"></div>
    <button class="btn ghost" type="button" id="sSave">Save settings</button>`;
  card.querySelector("#sSave").addEventListener("click", async () => {
    try {
      S.settings = await api("/api/admin/settings", { method:"POST", body:{
        points_exact:$("#sExact").value, points_result:$("#sResult").value,
        entry_fee:$("#sFee").value, currency:$("#sCur").value,
        share_season:$("#sSeason").value, share_best_week:$("#sBest").value,
        league_name:$("#sName").value,
        bbc_results_url:$("#sBbcR").value.trim(),
        bbc_predictions_url:$("#sBbcP").value.trim() } });
      $("#leagueName").textContent = S.settings.league_name;
      flash("ok","Settings saved.");
    } catch (e) { flash("bad", e.message); }
  });
  return card;
}
