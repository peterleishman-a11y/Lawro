/**
 * Pulling results and Chris Sutton's predictions off the BBC.
 *
 * IMPORTANT — the BBC publishes no supported public API for either of these.
 * The results endpoint is the internal JSON its own site calls, and the
 * predictions come from a weekly article, so both can change without notice.
 * Two things keep that from turning into a maintenance problem:
 *
 *   1. Both URLs are settings, not constants. When the BBC moves something,
 *      change the URL in Admin, not the code.
 *   2. Nothing here is load-bearing. Every fetch has a manual equivalent —
 *      paste the article, or type the ten results in. If the BBC changes
 *      shape mid-season the league carries on.
 *
 * The JSON is walked rather than indexed by a fixed path, so a fixture is
 * found wherever it happens to sit in the response.
 *
 * Test the live endpoints with:
 *   node src/bbc.js results
 *   node src/bbc.js predictions "<article url>"
 */
import { parseLine, findTeams } from "./parser.js";

export const DEFAULTS = {
  // BBC Sport's own scores-and-fixtures feed.
  results_url:
    "https://web-cdn.api.bbci.co.uk/wc-poll-data/container/sport-data-scores-fixtures" +
    "?selectedStartDate={from}&selectedEndDate={to}" +
    "&todayDate={today}&urn=urn%3Abbc%3Asportsdata%3Afootball%3Atournament%3Apremier-league",
  // The weekly "Premier League predictions" article.
  predictions_url: "",
};

const UA = "Mozilla/5.0 (compatible; LawroLeague/1.0)";
const ymd = d => new Date(d).toISOString().slice(0, 10);

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "*/*" } });
  if (!res.ok) throw new Error(`BBC returned ${res.status} for ${url}`);
  return res.text();
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

/** True for an object that looks like a played or scheduled fixture. */
function asFixture(node) {
  if (!node || typeof node !== "object") return null;
  const home = node.home ?? node.homeTeam ?? node.competitor1;
  const away = node.away ?? node.awayTeam ?? node.competitor2;
  if (!home || !away || typeof home !== "object" || typeof away !== "object") return null;

  const nameOf = t => t.fullName ?? t.name ?? t.shortName ?? t.displayName ?? t.title ?? null;
  const scoreOf = t => {
    const raw = t.score ?? t.goals ?? t.fullTimeScore ?? null;
    if (raw === null || raw === undefined || raw === "") return null;
    const n = Number.parseInt(String(raw), 10);
    return Number.isNaN(n) ? null : n;
  };
  const hName = nameOf(home), aName = nameOf(away);
  if (!hName || !aName) return null;

  const status = String(node.status ?? node.eventStatus ?? node.state ?? "").toLowerCase();
  return {
    home: hName, away: aName,
    hg: scoreOf(home), ag: scoreOf(away),
    finished: /post|full|ft|finished|complete/.test(status),
    status: status || null,
  };
}

/** Walk any shape of JSON and collect everything fixture-like. */
export function collectFixtures(json) {
  const out = [], seen = new Set();
  const visit = node => {
    if (!node || typeof node !== "object") return;
    const fx = asFixture(node);
    if (fx) {
      const key = `${fx.home}|${fx.away}`;
      if (!seen.has(key)) { seen.add(key); out.push(fx); }
    }
    for (const v of Array.isArray(node) ? node : Object.values(node)) visit(v);
  };
  visit(json);
  return out;
}

/** Map BBC's team names onto ours; drop anything we don't recognise. */
export function normaliseFixtures(list) {
  const out = [];
  for (const f of list) {
    const h = findTeams(f.home), a = findTeams(f.away);
    if (!h.length || !a.length || h[0] === a[0]) continue;
    out.push({ ...f, home: h[0], away: a[0] });
  }
  return out;
}

export async function fetchResults({ url = DEFAULTS.results_url, from, to } = {}) {
  const today = ymd(Date.now());
  const start = ymd(from ?? Date.now() - 4 * 864e5);
  const end = ymd(to ?? Date.now() + 3 * 864e5);
  const target = url.replace("{from}", start).replace("{to}", end).replace("{today}", today);
  const body = await getText(target);
  let json;
  try { json = JSON.parse(body); }
  catch { throw new Error("BBC did not return JSON — the results URL may have moved."); }
  const found = normaliseFixtures(collectFixtures(json));
  if (!found.length) throw new Error("No fixtures found in the BBC response — the format may have changed.");
  return found;
}

/* ------------------------------------------------------------------ *
 * Sutton's predictions
 * ------------------------------------------------------------------ */

/** Strip an article down to readable lines. */
export function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean)
    .join("\n");
}

/**
 * Pull predictions out of article text.
 *
 * Handles the inline form ("Arsenal 2-0 Coventry") and the BBC's usual
 * layout, where the fixture is a heading and the score follows underneath:
 *
 *     Arsenal v Coventry
 *     Sutton's prediction: 2-0
 */
export function extractPredictions(text) {
  const lines = text.split("\n");
  const out = [];
  const push = (home, away, hg, ag) => {
    if (!out.some(p => p.home === home && p.away === away)) out.push({ home, away, hg, ag });
  };

  let pending = null;                     // a fixture heading waiting for its score
  for (const line of lines) {
    const direct = parseLine(line);
    if (direct) {
      const [t1, t2] = direct.teams;
      push(t1, t2, direct.a, direct.b);
      pending = null;
      continue;
    }
    const teams = findTeams(line);
    const nums = line.match(/\d+/g) || [];
    if (teams.length >= 2 && nums.length < 2) { pending = [teams[0], teams[1]]; continue; }
    if (pending && teams.length === 0) {
      const m = line.match(/(\d+)\s*[-–:]\s*(\d+)/);
      if (m) { push(pending[0], pending[1], +m[1], +m[2]); pending = null; }
    }
  }
  return out;
}

export async function fetchPredictions(url) {
  if (!url) throw new Error("No predictions URL set — add this week's BBC article in Admin.");
  const found = extractPredictions(htmlToText(await getText(url)));
  if (!found.length) throw new Error("No predictions found in that article — paste the text in instead.");
  return found;
}

/* ------------------------------------------------------------------ *
 * CLI, for checking the live endpoints from a machine with web access
 * ------------------------------------------------------------------ */
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , cmd, arg] = process.argv;
  try {
    if (cmd === "results") console.table(await fetchResults({}));
    else if (cmd === "predictions") console.table(await fetchPredictions(arg));
    else console.log("usage: node src/bbc.js results | predictions <article-url>");
  } catch (e) {
    console.error("failed:", e.message);
    process.exitCode = 1;
  }
}
