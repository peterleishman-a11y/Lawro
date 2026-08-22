/**
 * SQLite storage. Every query the app makes lives in this file, so swapping
 * SQLite for Postgres/D1 later means rewriting this module and nothing else.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PATH = process.env.DATABASE_PATH || "./data/lawro.db";
mkdirSync(dirname(PATH), { recursive: true });

export const db = new Database(PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  pin_hash      TEXT,                      -- null until the player sets a PIN
  pin_salt      TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  is_fallback   INTEGER NOT NULL DEFAULT 0,   -- the pundit whose picks cover a missed round
  paid          INTEGER NOT NULL DEFAULT 0,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- WhatsApp shows whatever name a sender has set for themselves, and it can
-- change mid-season. Every name a player has ever appeared under lives here,
-- so an import recognises them and their season total stays in one row.
CREATE TABLE IF NOT EXISTS player_aliases (
  alias      TEXT PRIMARY KEY,             -- matched case-insensitively
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aliases_player ON player_aliases(player_id);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions(player_id);

CREATE TABLE IF NOT EXISTS rounds (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  deadline   INTEGER,                      -- epoch ms; predictions lock after this
  results_in INTEGER NOT NULL DEFAULT 0,   -- 1 once the admin has published results
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id       INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  home     TEXT NOT NULL,
  away     TEXT NOT NULL,
  hg       INTEGER,                        -- null until played
  ag       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_games_round ON games(round_id);

CREATE TABLE IF NOT EXISTS predictions (
  id         INTEGER PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  game_id    INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  hg         INTEGER NOT NULL,
  ag         INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT 'web',  -- web | whatsapp | fallback
  updated_at INTEGER NOT NULL,
  UNIQUE (player_id, game_id)
);
CREATE INDEX IF NOT EXISTS idx_pred_game ON predictions(game_id);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip       TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON login_attempts(ip, at);
`);

// Add columns introduced after the first release.
const columns = db.prepare("PRAGMA table_info(players)").all().map(c => c.name);
if (!columns.includes("is_fallback"))
  db.exec("ALTER TABLE players ADD COLUMN is_fallback INTEGER NOT NULL DEFAULT 0");

const DEFAULTS = {
  points_exact: "40", points_result: "10", entry_fee: "25", currency: "€",
  share_season: "80", share_best_week: "20", league_name: "Lawro",
  bbc_results_url: "", bbc_predictions_url: "",
};
const insSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [k, v] of Object.entries(DEFAULTS)) insSetting.run(k, v);

/* ---------------- settings ---------------- */
export const getSettings = () => {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    ...s,
    points_exact: +s.points_exact, points_result: +s.points_result,
    entry_fee: +s.entry_fee, share_season: +s.share_season,
    share_best_week: +s.share_best_week,
  };
};
export const setSetting = (k, v) =>
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(k, String(v));

/* ---------------- players ---------------- */
export const listPlayers = () =>
  db.prepare(`SELECT id, name, is_admin, is_active, is_fallback, paid, (pin_hash IS NOT NULL) AS has_pin
              FROM players WHERE is_active = 1 ORDER BY name COLLATE NOCASE`).all();
export const allPlayers = () =>
  db.prepare(`SELECT id, name, is_admin, is_active, is_fallback, paid, (pin_hash IS NOT NULL) AS has_pin
              FROM players ORDER BY name COLLATE NOCASE`).all();
/** The pundit whose picks cover anyone who misses a round. */
export const getFallbackPlayer = () =>
  db.prepare("SELECT * FROM players WHERE is_fallback = 1 LIMIT 1").get();
export const getPlayer = id => db.prepare("SELECT * FROM players WHERE id = ?").get(id);
export const getPlayerByName = name =>
  db.prepare("SELECT * FROM players WHERE name = ? COLLATE NOCASE").get(name);
/**
 * Resolve a WhatsApp sender to a player: their current name first, then any
 * name they have previously gone by. Imports use this so a renamed player is
 * still recognised the next time the group's export is pasted in.
 */
export const getPlayerByAnyName = name => {
  const direct = getPlayerByName(name);
  if (direct) return direct;
  const row = db.prepare(
    `SELECT p.* FROM player_aliases a JOIN players p ON p.id = a.player_id
     WHERE a.alias = ? COLLATE NOCASE`).get(String(name ?? "").trim());
  return row || undefined;
};
export const listAliases = playerId =>
  db.prepare("SELECT alias FROM player_aliases WHERE player_id = ? ORDER BY alias COLLATE NOCASE")
    .all(playerId).map(r => r.alias);
export const allAliases = () =>
  db.prepare("SELECT alias, player_id FROM player_aliases").all();
/** Silently ignores an alias that is already taken, or equals a player's name. */
export const addAlias = (playerId, alias) => {
  const a = String(alias ?? "").trim();
  if (!a) return false;
  const owner = getPlayerByName(a);
  if (owner && owner.id !== playerId) return false;
  try {
    db.prepare("INSERT INTO player_aliases (alias, player_id, created_at) VALUES (?,?,?)")
      .run(a, playerId, Date.now());
    return true;
  } catch { return false; }          // UNIQUE clash: already pointed somewhere
};
export const removeAlias = alias =>
  db.prepare("DELETE FROM player_aliases WHERE alias = ? COLLATE NOCASE").run(alias);

export const createPlayer = (name, isAdmin = 0, isFallback = 0) =>
  db.prepare("INSERT INTO players (name, is_admin, is_fallback, created_at) VALUES (?,?,?,?)")
    .run(name.trim(), isAdmin ? 1 : 0, isFallback ? 1 : 0, Date.now());
/**
 * Fold `sourceId` into `keepId`: the source's picks move across, its name and
 * aliases become aliases of the keeper, and the source row is deleted.
 *
 * Where both players picked the same game the keeper's pick stands — a merge
 * is for one human who appeared twice, so the duplicate is the same person
 * having submitted twice, and the keeper is the row the admin chose to keep.
 * Returns what happened so the admin panel can say so rather than merging
 * silently.
 */
export const mergePlayers = (keepId, sourceId) => {
  const keep = getPlayer(keepId), src = getPlayer(sourceId);
  if (!keep || !src || keepId === sourceId) return null;

  const run = db.transaction(() => {
    const clashes = db.prepare(
      `SELECT COUNT(*) AS n FROM predictions a
       JOIN predictions b ON b.game_id = a.game_id AND b.player_id = ?
       WHERE a.player_id = ?`).get(keepId, sourceId).n;

    // Only picks the keeper has no pick for; the UNIQUE constraint would
    // reject the rest anyway, so drop them explicitly rather than by error.
    const moved = db.prepare(
      `UPDATE predictions SET player_id = ? WHERE player_id = ?
       AND game_id NOT IN (SELECT game_id FROM predictions WHERE player_id = ?)`)
      .run(keepId, sourceId, keepId).changes;

    db.prepare("UPDATE player_aliases SET player_id = ? WHERE player_id = ?").run(keepId, sourceId);
    db.prepare("DELETE FROM players WHERE id = ?").run(sourceId);   // cascades the rest
    addAlias(keepId, src.name);
    return { moved, discarded: clashes, absorbed: src.name, into: keep.name };
  });
  return run();
};

export const setPin = (id, hash, salt) =>
  db.prepare("UPDATE players SET pin_hash=?, pin_salt=?, failed_count=0, locked_until=0 WHERE id=?")
    .run(hash, salt, id);
export const updatePlayer = (id, fields) => {
  const allowed = ["name", "is_admin", "is_active", "paid", "is_fallback"];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return;
  db.prepare(`UPDATE players SET ${keys.map(k => `${k}=?`).join(", ")} WHERE id=?`)
    .run(...keys.map(k => fields[k]), id);
};
export const noteFailure = (id, lockedUntil) =>
  db.prepare("UPDATE players SET failed_count = failed_count + 1, locked_until = ? WHERE id = ?")
    .run(lockedUntil, id);
export const clearFailures = id =>
  db.prepare("UPDATE players SET failed_count = 0, locked_until = 0 WHERE id = ?").run(id);

/* ---------------- sessions ---------------- */
export const createSession = (token, playerId, ttlMs) =>
  db.prepare("INSERT INTO sessions (token, player_id, created_at, expires_at) VALUES (?,?,?,?)")
    .run(token, playerId, Date.now(), Date.now() + ttlMs);
export const findSession = token =>
  db.prepare(`SELECT s.token, s.expires_at, p.id, p.name, p.is_admin
              FROM sessions s JOIN players p ON p.id = s.player_id
              WHERE s.token = ? AND s.expires_at > ? AND p.is_active = 1`).get(token, Date.now());
export const deleteSession = token => db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
export const purgeSessions = () =>
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());

/* ---------------- login throttle ---------------- */
export const recordAttempt = ip =>
  db.prepare("INSERT INTO login_attempts (ip, at) VALUES (?,?)").run(ip, Date.now());
export const countAttempts = (ip, sinceMs) =>
  db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?")
    .get(ip, Date.now() - sinceMs).n;
export const purgeAttempts = sinceMs =>
  db.prepare("DELETE FROM login_attempts WHERE at <= ?").run(Date.now() - sinceMs);

/* ---------------- rounds & games ---------------- */
export const listRounds = () =>
  db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM games g WHERE g.round_id = r.id) AS game_count
              FROM rounds r ORDER BY r.id DESC`).all();
export const getRound = id => db.prepare("SELECT * FROM rounds WHERE id = ?").get(id);
export const createRound = (name, deadline) =>
  db.prepare("INSERT INTO rounds (name, deadline, created_at) VALUES (?,?,?)")
    .run(name, deadline ?? null, Date.now());
export const updateRound = (id, { name, deadline, results_in }) =>
  db.prepare("UPDATE rounds SET name = COALESCE(?,name), deadline = ?, results_in = COALESCE(?,results_in) WHERE id = ?")
    .run(name ?? null, deadline ?? null, results_in ?? null, id);
export const deleteRound = id => db.prepare("DELETE FROM rounds WHERE id = ?").run(id);

export const gamesFor = roundId =>
  db.prepare("SELECT * FROM games WHERE round_id = ? ORDER BY position, id").all(roundId);
export const addGame = (roundId, position, home, away) =>
  db.prepare("INSERT INTO games (round_id, position, home, away) VALUES (?,?,?,?)")
    .run(roundId, position, home, away);
export const clearGames = roundId => db.prepare("DELETE FROM games WHERE round_id = ?").run(roundId);
export const setResult = (gameId, hg, ag) =>
  db.prepare("UPDATE games SET hg = ?, ag = ? WHERE id = ?").run(hg, ag, gameId);

/* ---------------- predictions ---------------- */
export const predictionsFor = (roundId) =>
  db.prepare(`SELECT pr.*, p.name AS player_name
              FROM predictions pr
              JOIN players p ON p.id = pr.player_id
              JOIN games  g ON g.id = pr.game_id
              WHERE g.round_id = ?`).all(roundId);
export const myPredictions = (playerId, roundId) =>
  db.prepare(`SELECT pr.game_id, pr.hg, pr.ag, pr.source FROM predictions pr
              JOIN games g ON g.id = pr.game_id
              WHERE pr.player_id = ? AND g.round_id = ?`).all(playerId, roundId);
const upsertPred = db.prepare(`
  INSERT INTO predictions (player_id, game_id, hg, ag, source, updated_at)
  VALUES (?,?,?,?,?,?)
  ON CONFLICT(player_id, game_id)
  DO UPDATE SET hg=excluded.hg, ag=excluded.ag, source=excluded.source, updated_at=excluded.updated_at`);
export const savePredictions = db.transaction((playerId, picks, source) => {
  const now = Date.now();
  for (const p of picks) upsertPred.run(playerId, p.game_id, p.hg, p.ag, source, now);
});
export const allPredictionsWithRounds = () =>
  db.prepare(`SELECT pr.player_id, p.name AS player_name, pr.hg, pr.ag, pr.source,
                     g.id AS game_id, g.round_id, g.home, g.away, g.hg AS res_hg, g.ag AS res_ag
              FROM predictions pr
              JOIN players p ON p.id = pr.player_id
              JOIN games   g ON g.id = pr.game_id`).all();
