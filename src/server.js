import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as store from "./db.js";
import * as auth from "./auth.js";
import { parseChat, findTeams } from "./parser.js";
import * as bbc from "./bbc.js";
import { roundTable, seasonTable, prizePot } from "./scoring.js";

const app = express();
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));   // WhatsApp exports can be chunky

/** Minimal cookie reader; avoids pulling in cookie-parser for one header. */
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";").map(c => {
      const i = c.indexOf("=");
      return i < 0 ? null : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
    }).filter(Boolean)
  );
  next();
});
app.use(auth.sessionMiddleware);

const { requireLogin, requireAdmin } = auth;
const asInt = v => (v === null || v === undefined || v === "" ? null : Number.parseInt(v, 10));
const isScore = v => Number.isInteger(v) && v >= 0 && v <= 99;
const roundLocked = r => !!(r.deadline && Date.now() > r.deadline);

/* ============================ auth ============================ */

// Names only. No PINs, no hashes, nothing about who has logged in.
app.get("/api/bootstrap", (req, res) => {
  const s = store.getSettings();
  res.json({
    leagueName: s.league_name,
    players: store.listPlayers().map(p => ({ name: p.name, hasPin: !!p.has_pin })),
    me: req.user ? { id: req.user.id, name: req.user.name, isAdmin: !!req.user.is_admin } : null,
  });
});

app.post("/api/login", (req, res) => {
  const { name, pin } = req.body || {};
  if (!name) return res.status(400).json({ error: "Pick your name." });
  const result = auth.attemptLogin(String(name), String(pin ?? ""), req);
  if (!result.ok) {
    if (result.error === "no-pin") return res.status(409).json({ error: "no-pin" });
    return res.status(401).json({ error: result.error, retryAfter: result.retryAfter });
  }
  auth.startSession(res, result.player.id);
  res.json({ id: result.player.id, name: result.player.name, isAdmin: !!result.player.is_admin });
});

// First time in: claim your name by choosing a PIN. Only works while unset.
app.post("/api/set-pin", (req, res) => {
  const { name, pin } = req.body || {};
  if (auth.ipThrottled(req)) return res.status(429).json({ error: "Too many attempts. Try again later." });
  store.recordAttempt(auth.clientIp(req));
  if (!auth.isValidPinFormat(String(pin ?? "")))
    return res.status(400).json({ error: "PIN must be exactly 4 digits." });
  if (auth.isWeakPin(String(pin)))
    return res.status(400).json({ error: "That PIN is too easy to guess. Pick another." });

  const player = store.getPlayerByName(String(name ?? ""));
  if (!player) return res.status(404).json({ error: "No such player." });
  if (player.pin_hash) return res.status(409).json({ error: "That player already has a PIN." });

  const { hash, salt } = auth.hashPin(String(pin));
  store.setPin(player.id, hash, salt);
  auth.startSession(res, player.id);
  res.json({ id: player.id, name: player.name, isAdmin: !!player.is_admin });
});

app.post("/api/change-pin", requireLogin, (req, res) => {
  const { currentPin, newPin } = req.body || {};
  const player = store.getPlayer(req.user.id);
  if (!auth.verifyPin(String(currentPin ?? ""), player.pin_hash, player.pin_salt))
    return res.status(401).json({ error: "Current PIN is wrong." });
  if (!auth.isValidPinFormat(String(newPin ?? "")))
    return res.status(400).json({ error: "PIN must be exactly 4 digits." });
  if (auth.isWeakPin(String(newPin)))
    return res.status(400).json({ error: "That PIN is too easy to guess. Pick another." });
  const { hash, salt } = auth.hashPin(String(newPin));
  store.setPin(player.id, hash, salt);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => { auth.endSession(req, res); res.json({ ok: true }); });

/* ============================ rounds ============================ */

app.get("/api/rounds", requireLogin, (_req, res) => {
  res.json(store.listRounds().map(r => ({
    id: r.id, name: r.name, deadline: r.deadline, gameCount: r.game_count,
    resultsIn: !!r.results_in, locked: roundLocked(r),
  })));
});

app.get("/api/rounds/:id", requireLogin, (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  const games = store.gamesFor(round.id);
  const locked = roundLocked(round);
  const mine = new Map(store.myPredictions(req.user.id, round.id).map(p => [p.game_id, p]));

  res.json({
    id: round.id, name: round.name, deadline: round.deadline,
    locked, resultsIn: !!round.results_in,
    games: games.map(g => ({
      id: g.id, home: g.home, away: g.away,
      hg: g.hg, ag: g.ag,
      pick: mine.get(g.id) ? { hg: mine.get(g.id).hg, ag: mine.get(g.id).ag } : null,
    })),
  });
});

app.post("/api/rounds/:id/predictions", requireLogin, (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  if (roundLocked(round)) return res.status(403).json({ error: "Deadline has passed for this round." });

  const valid = new Set(store.gamesFor(round.id).map(g => g.id));
  const picks = [];
  for (const raw of req.body?.picks || []) {
    const game_id = asInt(raw.game_id), hg = asInt(raw.hg), ag = asInt(raw.ag);
    if (!valid.has(game_id)) return res.status(400).json({ error: "Unknown game in submission." });
    if (hg === null || ag === null) continue;                 // left blank, skip it
    if (!isScore(hg) || !isScore(ag)) return res.status(400).json({ error: "Scores must be 0-99." });
    picks.push({ game_id, hg, ag });
  }
  store.savePredictions(req.user.id, picks, "web");
  res.json({ ok: true, saved: picks.length });
});

/** Everyone's picks for a round. Hidden until the deadline so nobody copies. */
app.get("/api/rounds/:id/table", requireLogin, (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  if (!roundLocked(round) && !req.user.is_admin)
    return res.status(403).json({ error: "Picks stay hidden until the deadline." });

  const settings = store.getSettings();
  const games = store.gamesFor(round.id);
  const table = roundTable(games, store.predictionsFor(round.id), store.listPlayers(), settings);
  res.json({ round: { id: round.id, name: round.name, locked: roundLocked(round) }, games, table });
});

app.get("/api/season", requireLogin, (_req, res) => {
  const settings = store.getSettings();
  const players = store.listPlayers();
  const rounds = store.listRounds();
  const gamesByRound = new Map(rounds.map(r => [r.id, store.gamesFor(r.id)]));
  const predsByRound = new Map(rounds.map(r => [r.id, store.predictionsFor(r.id)]));
  const table = seasonTable(rounds, gamesByRound, predsByRound, players, settings);
  res.json({ table, pot: prizePot(players, table, settings), settings });
});

/* ============================ admin ============================ */

/** Turn a pasted fixture list into rows. Same engine as the WhatsApp import. */
app.post("/api/admin/parse-fixtures", requireLogin, requireAdmin, (req, res) => {
  const lines = String(req.body?.text || "").split("\n");
  const fixtures = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const teams = findTeams(line);
    if (teams.length >= 2) fixtures.push({ home: teams[0], away: teams[1] });
  }
  res.json({ fixtures });
});

app.post("/api/admin/rounds", requireLogin, requireAdmin, (req, res) => {
  const { name, deadline, fixtures } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: "Give the round a name." });
  const info = store.createRound(name.trim(), deadline ? Number(deadline) : null);
  const roundId = info.lastInsertRowid;
  (fixtures || []).forEach((f, i) => {
    if (f.home?.trim() && f.away?.trim()) store.addGame(roundId, i, f.home.trim(), f.away.trim());
  });
  res.json({ id: roundId });
});

app.put("/api/admin/rounds/:id", requireLogin, requireAdmin, (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  const { name, deadline, fixtures } = req.body || {};
  store.updateRound(round.id, {
    name: name?.trim(),
    deadline: deadline === null || deadline === "" ? null : Number(deadline),
  });
  if (Array.isArray(fixtures)) {
    // Replacing fixtures drops the picks attached to them, so only do it
    // when the round has no predictions yet.
    if (store.predictionsFor(round.id).length)
      return res.status(409).json({ error: "Picks are already in — edit the games individually." });
    store.clearGames(round.id);
    fixtures.forEach((f, i) => {
      if (f.home?.trim() && f.away?.trim()) store.addGame(round.id, i, f.home.trim(), f.away.trim());
    });
  }
  res.json({ ok: true });
});

app.delete("/api/admin/rounds/:id", requireLogin, requireAdmin, (req, res) => {
  store.deleteRound(asInt(req.params.id));
  res.json({ ok: true });
});

app.post("/api/admin/rounds/:id/results", requireLogin, requireAdmin, (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  const valid = new Set(store.gamesFor(round.id).map(g => g.id));
  for (const r of req.body?.results || []) {
    const id = asInt(r.game_id), hg = asInt(r.hg), ag = asInt(r.ag);
    if (!valid.has(id)) continue;
    if (hg === null || ag === null) { store.setResult(id, null, null); continue; }
    if (!isScore(hg) || !isScore(ag)) return res.status(400).json({ error: "Scores must be 0-99." });
    store.setResult(id, hg, ag);
  }
  store.updateRound(round.id, { deadline: round.deadline, results_in: 1 });
  res.json({ ok: true });
});

/**
 * Import a WhatsApp export into a round. Creates any player it has not seen
 * before (without a PIN, so they claim the name themselves on first login).
 */
app.post("/api/admin/rounds/:id/import", requireLogin, requireAdmin, (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  const parsed = parseChat(String(req.body?.text || ""));
  if (!parsed.entries.length) return res.status(400).json({ error: "No predictions found in that text." });

  let games = store.gamesFor(round.id);
  if (!games.length) {
    parsed.fixtures.forEach((f, i) => store.addGame(round.id, i, f.home, f.away));
    games = store.gamesFor(round.id);
  }
  // Line up parsed fixtures with the round's games by team pair.
  const key = (h, a) => [h, a].slice().sort().join("|");
  const gameByKey = new Map(games.map(g => [key(g.home, g.away), g]));

  const created = [], skipped = [];
  let picksSaved = 0;
  for (const entry of parsed.entries) {
    // By alias too: someone who changed their WhatsApp name, or was renamed
    // here from whatever the export called them, still resolves to one player.
    let player = store.getPlayerByAnyName(entry.player);
    if (!player) {
      if (!req.body?.createMissing) { skipped.push(entry.player); continue; }
      store.createPlayer(entry.player);
      player = store.getPlayerByName(entry.player);
      created.push(entry.player);
    }
    const picks = [];
    entry.picks.forEach((p, i) => {
      if (!p) return;
      const f = parsed.fixtures[i];
      const g = gameByKey.get(key(f.home, f.away));
      if (!g) return;
      const flip = g.home !== f.home;
      picks.push({ game_id: g.id, hg: flip ? p.ag : p.hg, ag: flip ? p.hg : p.ag });
    });
    if (picks.length) { store.savePredictions(player.id, picks, "whatsapp"); picksSaved += picks.length; }
  }
  res.json({
    fixtures: parsed.fixtures, players: parsed.entries.length, picksSaved,
    created, skipped,
    notes: parsed.entries.filter(e => e.notes.length).map(e => ({ player: e.player, notes: e.notes })),
  });
});

/** Line a list of {home,away,hg,ag} up against a round's games. */
function matchToGames(games, incoming) {
  const key = (h, a) => [h, a].slice().sort().join("|");
  const byKey = new Map(games.map(g => [key(g.home, g.away), g]));
  const matched = [], unmatched = [];
  for (const f of incoming) {
    const g = byKey.get(key(f.home, f.away));
    if (!g) { unmatched.push(`${f.home} v ${f.away}`); continue; }
    const flip = g.home !== f.home;
    matched.push({ game_id: g.id, hg: flip ? f.ag : f.hg, ag: flip ? f.hg : f.ag });
  }
  return { matched, unmatched };
}

/** Admin enters picks on someone's behalf — used for the pundit. */
app.post("/api/admin/rounds/:id/picks-for", requireLogin, requireAdmin, (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  const player = store.getPlayer(asInt(req.body?.playerId));
  if (!player) return res.status(404).json({ error: "No such player." });

  const valid = new Set(store.gamesFor(round.id).map(g => g.id));
  const picks = [];
  for (const raw of req.body?.picks || []) {
    const game_id = asInt(raw.game_id), hg = asInt(raw.hg), ag = asInt(raw.ag);
    if (!valid.has(game_id) || hg === null || ag === null) continue;
    if (!isScore(hg) || !isScore(ag)) return res.status(400).json({ error: "Scores must be 0-99." });
    picks.push({ game_id, hg, ag });
  }
  store.savePredictions(player.id, picks, player.is_fallback ? "fallback" : "web");
  res.json({ ok: true, saved: picks.length });
});

/** Pull this round's results off the BBC. */
app.post("/api/admin/rounds/:id/bbc-results", requireLogin, requireAdmin, async (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  const settings = store.getSettings();
  try {
    const fixtures = await bbc.fetchResults({ url: settings.bbc_results_url || undefined });
    const games = store.gamesFor(round.id);
    const played = fixtures.filter(f => f.hg !== null && f.ag !== null);
    const { matched, unmatched } = matchToGames(games, played);
    for (const m of matched) store.setResult(m.game_id, m.hg, m.ag);
    if (matched.length) store.updateRound(round.id, { deadline: round.deadline, results_in: 1 });
    res.json({ applied: matched.length, seen: fixtures.length, unmatched });
  } catch (e) {
    res.status(502).json({ error: `${e.message} You can still type the results in by hand.` });
  }
});

/** Pull Chris Sutton's predictions off the BBC article. */
app.post("/api/admin/rounds/:id/bbc-predictions", requireLogin, requireAdmin, async (req, res) => {
  const round = store.getRound(asInt(req.params.id));
  if (!round) return res.status(404).json({ error: "No such round." });
  const pundit = store.getFallbackPlayer();
  if (!pundit) return res.status(409).json({ error: "No pundit set. Mark a player as the pundit first." });

  const settings = store.getSettings();
  const url = (req.body?.url || settings.bbc_predictions_url || "").trim();
  try {
    const preds = req.body?.text
      ? bbc.extractPredictions(bbc.htmlToText(String(req.body.text)))
      : await bbc.fetchPredictions(url);
    if (!preds.length) return res.status(400).json({ error: "No predictions found." });
    const { matched, unmatched } = matchToGames(store.gamesFor(round.id), preds);
    store.savePredictions(pundit.id, matched, "fallback");
    if (url && url !== settings.bbc_predictions_url) store.setSetting("bbc_predictions_url", url);
    res.json({ pundit: pundit.name, saved: matched.length, seen: preds.length, unmatched });
  } catch (e) {
    res.status(502).json({ error: `${e.message}` });
  }
});

app.get("/api/admin/players", requireLogin, requireAdmin, (_req, res) =>
  res.json(store.allPlayers().map(p => ({ ...p, aliases: store.listAliases(p.id) }))));

/** Fold a duplicate player into the one being kept. */
app.post("/api/admin/players/:id/merge", requireLogin, requireAdmin, (req, res) => {
  const keepId = asInt(req.params.id);
  const sourceId = asInt(req.body?.sourceId);
  if (!keepId || !sourceId) return res.status(400).json({ error: "Two players are needed." });
  if (keepId === sourceId) return res.status(400).json({ error: "That is the same player." });
  const source = store.getPlayer(sourceId);
  if (!store.getPlayer(keepId) || !source) return res.status(404).json({ error: "No such player." });
  if (source.is_admin) return res.status(409).json({ error: "Remove admin from that player first." });
  if (source.is_fallback) return res.status(409).json({ error: "That player is the pundit." });
  const result = store.mergePlayers(keepId, sourceId);
  if (!result) return res.status(409).json({ error: "Could not merge those two." });
  res.json(result);
});

app.post("/api/admin/players", requireLogin, requireAdmin, (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required." });
  if (store.getPlayerByName(name)) return res.status(409).json({ error: "That name is taken." });
  store.createPlayer(name, req.body?.isAdmin ? 1 : 0);
  res.json({ ok: true });
});

app.put("/api/admin/players/:id", requireLogin, requireAdmin, (req, res) => {
  const id = asInt(req.params.id);
  const player = store.getPlayer(id);
  if (!player) return res.status(404).json({ error: "No such player." });
  const { name, is_admin, is_active, paid, is_fallback, resetPin } = req.body || {};
  if (name && name.trim() !== player.name) {
    const clash = store.getPlayerByName(name.trim());
    if (clash && clash.id !== id) return res.status(409).json({ error: "That name is taken." });
  }
  // Never let an admin strip the last admin, or nobody can run the league.
  if (is_admin === 0 && player.is_admin) {
    const admins = store.allPlayers().filter(p => p.is_admin).length;
    if (admins <= 1) return res.status(409).json({ error: "There has to be at least one admin." });
  }
  // Renaming keeps the old name as an alias, so the next WhatsApp import still
  // recognises them instead of creating a second player under the old name.
  if (name && name.trim() !== player.name) store.addAlias(id, player.name);
  store.updatePlayer(id, {
    ...(name ? { name: name.trim() } : {}),
    ...(is_admin === undefined ? {} : { is_admin: is_admin ? 1 : 0 }),
    ...(is_active === undefined ? {} : { is_active: is_active ? 1 : 0 }),
    ...(paid === undefined ? {} : { paid: paid ? 1 : 0 }),
    ...(is_fallback === undefined ? {} : { is_fallback: is_fallback ? 1 : 0 }),
  });
  // Only one pundit at a time.
  if (is_fallback)
    for (const other of store.allPlayers())
      if (other.id !== id && other.is_fallback) store.updatePlayer(other.id, { is_fallback: 0 });
  if (resetPin) store.setPin(id, null, null);   // they choose a new one next login
  res.json({ ok: true });
});

app.post("/api/admin/settings", requireLogin, requireAdmin, (req, res) => {
  const allowed = ["points_exact", "points_result", "entry_fee", "currency",
                   "share_season", "share_best_week", "league_name",
                   "bbc_results_url", "bbc_predictions_url"];
  for (const [k, v] of Object.entries(req.body || {}))
    if (allowed.includes(k)) store.setSetting(k, v);
  res.json(store.getSettings());
});

app.get("/api/settings", requireLogin, (_req, res) => res.json(store.getSettings()));

/* ============================ health ============================ */
// Platform health checks (Render, Fly) hit this. Touches the DB so a probe
// failure means the disk is genuinely unreachable, not just that Node is up.
app.get("/api/health", (_req, res) => {
  try {
    store.getSettings();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

/* ============================ static ============================ */
app.use(express.static(join(ROOT, "public"), { maxAge: "1h" }));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(join(ROOT, "public", "index.html"));
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown endpoint." }));

/** Errors go back as JSON, and the stack stays in the log where it belongs. */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: "Something went wrong on the server." });
});

setInterval(() => { store.purgeSessions(); store.purgeAttempts(24 * 60 * 60 * 1000); }, 60 * 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lawro running on http://localhost:${PORT}`));

export default app;
