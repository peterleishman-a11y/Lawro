/**
 * Parse a WhatsApp chat export into fixtures and per-player predictions.
 *
 * The group submits in whatever shape they fancy. All of these are real
 * lines from the 2026/27 export and all of them parse:
 *
 *   Arsenal 2-0 Coventry          Arsenal v Coventry 3-0     Arsenal 3 v 0 Coventry
 *   Ars-Cov 2:0                   Man City v B'mouth  3- 1    Brentford v Spurs 0'2
 *   Hull 0-3Man Utd               Newcastle  1v 2 Liverpool   Fulham v Chelsea 1 - 3
 *
 * plus emoji inside team names, curly apostrophes, en-dashes, teams written
 * the wrong way round, a fixture split over two lines, re-submissions, and
 * one-line corrections sent after the fact.
 */

const TEAMS = {
  "Arsenal":["arsenal","ars"], "Coventry":["coventry","cov"], "Hull":["hull","hul"],
  "Man Utd":["man utd","man united","manutd","man u","manu","mufc","utd"],
  "Everton":["everton","ever","eve"],
  "Crystal Palace":["crystal palace","cry palace","c palace","palace","cpal","cp"],
  "Ipswich":["ipswich","ips"], "Sunderland":["sunderland","sund","sun"],
  "Nottm Forest":["nottingham forest","nottsforest","notts forest","n forest","forest","notts","nott","not","nfo"],
  "Leeds":["leeds"], "Brentford":["brentford","brent","bre"],
  "Spurs":["tottenham","spurs","thfc","tot"], "Brighton":["brighton","bright","bha","bri"],
  "Aston Villa":["aston villa","villa","avfc","av"],
  "Man City":["man city","mancity","man c","manc","city","mcfc","mc"],
  "Bournemouth":["bournemouth","b'mouth","bmouth","bourn","afcb","bou"],
  "Newcastle":["newcastle","newc","nufc","new"],
  "Liverpool":["liverpool","liverpoo","lpool","liver","lfc","lpl"],
  "Fulham":["fulham","fulh","full","ful"], "Chelsea":["chelsea","chels","chel","che"],
  "West Ham":["west ham","westham","whu","hammers"], "Wolves":["wolves","wolverhampton","wwfc"],
  "Burnley":["burnley","burn"], "Sheff Utd":["sheffield united","sheff utd","sheff u","sufc"],
  "Leicester":["leicester","leics","lcfc"], "Southampton":["southampton","soton","saints"],
  "Norwich":["norwich","ncfc"], "Watford":["watford"], "Middlesbrough":["middlesbrough","boro"],
  "Stoke":["stoke"], "Preston":["preston","pne"], "Millwall":["millwall"], "QPR":["qpr"],
  "Birmingham":["birmingham","brum"], "Bristol City":["bristol city"], "Cardiff":["cardiff"],
  "Swansea":["swansea"], "Blackburn":["blackburn"], "Derby":["derby"], "Oxford":["oxford"],
  "Portsmouth":["portsmouth","pompey"], "Plymouth":["plymouth"], "Luton":["luton"],
  "Sheff Wed":["sheffield wednesday","sheff wed","swfc"], "West Brom":["west brom","wba","albion"],
};

// Longest alias first, so "man city" is matched before "city".
const ALIASES = Object.entries(TEAMS)
  .flatMap(([canon, list]) => list.map(a => [a, canon]))
  .sort((x, y) => y[0].length - x[0].length);

const INVIS  = /[‎‏‪-‮⁦-⁩﻿]/g;
const DASHES = /[‐-―−]/g;
const CURLY  = /[‘’]/g;
const PICTO  = /[\p{Extended_Pictographic}\p{Cf}]/gu;

const clean   = s => s.replace(INVIS, "").replace(DASHES, "-").replace(CURLY, "'");
const deEmoji = s => s.replace(PICTO, "");

const MSG_RE   = /^\[(\d{1,2}\/\d{1,2}\/\d{4}), ([^\]]+)\]\s*([^:]+?):\s?(.*)$/;
const TRAIL_RE = /(\d+)\s*[-:']?\s*(?:v|vs)?\s*[-:']?\s*(\d+)\s*$/;

export function parseMessages(text) {
  const out = [];
  let cur = null;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = clean(raw);
    const m = line.match(MSG_RE);
    if (m) {
      if (cur) out.push(cur);
      cur = { date: m[1], time: m[2].trim(),
              sender: m[3].trim().replace(/^~\s*/, "").trim(), lines: [m[4]] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) out.push(cur);
  return out;
}

/** Canonical teams named in a line, left to right, without overlapping matches. */
export function findTeams(line) {
  const low = deEmoji(line).toLowerCase();
  const taken = [], hits = [];
  for (const [alias, canon] of ALIASES) {
    let start = 0;
    for (;;) {
      const i = low.indexOf(alias, start);
      if (i < 0) break;
      const j = i + alias.length;
      const leftOk  = i === 0 || !/[a-z']/.test(low[i - 1]);
      const rightOk = j >= low.length || !/[a-z']/.test(low[j]);
      if (leftOk && rightOk && !taken.some(([a, b]) => i < b && j > a)) {
        taken.push([i, j]); hits.push([i, canon]);
      }
      start = j;
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  const seq = [];
  for (const [, c] of hits) if (seq[seq.length - 1] !== c) seq.push(c);
  return seq;
}

/** One line -> {teams:[t1,t2], a, b, note}; a/b are in the order written. */
export function parseLine(line) {
  const s = clean(line).trim().replace(/^\.+|\.+$/g, "");
  if (!s) return null;
  const teams = findTeams(s);
  const nums = (s.match(/\d+/g) || []).map(Number);
  if (teams.length < 2 || nums.length < 2) return null;

  let a, b, note = "";
  if (nums.length === 2) { [a, b] = nums; }
  else {
    const m = s.match(TRAIL_RE);
    if (m) { a = +m[1]; b = +m[2]; note = "extra digits, used the trailing score"; }
    else { a = nums.at(-2); b = nums.at(-1); note = "extra digits, used the last two"; }
  }
  if (Math.max(a, b) > 12) return null;         // a phone number, not a scoreline
  return { teams: [teams[0], teams[1]], a, b, note };
}

/** Rejoin a fixture broken across two lines: "Hull 1 - 2" then "Man utd". */
function mergeSplitLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (i + 1 < lines.length && !parseLine(cur)) {
      const nextLine = lines[i + 1];
      const oneTeamAndScore = findTeams(cur).length === 1 && (cur.match(/\d+/g) || []).length >= 2;
      const bareTeam = findTeams(nextLine).length >= 1 && !/\d/.test(nextLine);
      if (oneTeamAndScore && bareTeam) {
        const joined = `${cur.trimEnd()} ${nextLine.trimStart()}`;
        if (parseLine(joined)) { out.push(joined); i++; continue; }
      }
    }
    out.push(cur);
  }
  return out;
}

const readMessage = msg => mergeSplitLines(msg.lines).map(parseLine).filter(Boolean);
const fixKey = (h, a) => [h, a].slice().sort().join("|");

/**
 * Fixtures for the round are whatever most submissions agree on, ordered by
 * where they typically appear. Derived from the crowd rather than from one
 * organiser message, which is often reworded or missing from the export.
 */
const DISCOVERY_MIN = 3;   // a message with this many scorelines is worth counting

export function inferFixtures(msgs) {
  const tally = new Map();
  let submissions = 0;
  for (const m of msgs) {
    const found = readMessage(m);
    if (found.length < DISCOVERY_MIN) continue;
    submissions++;
    found.forEach((r, idx) => {
      const k = fixKey(r.teams[0], r.teams[1]);
      const e = tally.get(k) || { count: 0, posSum: 0, orient: new Map() };
      e.count++; e.posSum += idx;
      const o = r.teams.join(">");
      e.orient.set(o, (e.orient.get(o) || 0) + 1);
      tally.set(k, e);
    });
  }
  if (!submissions) return [];
  return [...tally.values()]
    .filter(e => e.count >= Math.max(2, submissions * 0.25))
    .sort((x, y) => x.posSum / x.count - y.posSum / y.count)
    .map(e => {
      const [home, away] = [...e.orient.entries()].sort((a, b) => b[1] - a[1])[0][0].split(">");
      return { home, away };
    });
}

/**
 * Full parse. Returns { fixtures, entries, messageCount }, where each entry is
 * { player, at, picks: [{hg,ag}|null], notes: [] } aligned to fixtures.
 */
export function parseChat(text) {
  const msgs = parseMessages(text);
  const fixtures = inferFixtures(msgs);
  if (!fixtures.length) return { fixtures: [], entries: [], messageCount: msgs.length };

  const indexOf = new Map(fixtures.map((f, i) => [fixKey(f.home, f.away), i]));
  const byPlayer = new Map();
  // Half the round counts as a submission; anything smaller is a comment or a
  // correction. Scaling with the round size keeps short rounds working.
  const submissionMin = Math.max(DISCOVERY_MIN, Math.ceil(fixtures.length / 2));

  for (const m of msgs) {
    const picks = new Map(), notes = [];
    for (const r of readMessage(m)) {
      const k = fixKey(r.teams[0], r.teams[1]);
      if (!indexOf.has(k)) continue;
      const fi = indexOf.get(k), f = fixtures[fi];
      let hg = r.a, ag = r.b, note = r.note;
      if (r.teams[0] !== f.home) {
        [hg, ag] = [r.b, r.a];
        note = `${note ? note + "; " : ""}teams written the other way round`;
      }
      const seen = picks.get(fi);
      if (seen && (seen.hg !== hg || seen.ag !== ag))
        notes.push(`${f.home} v ${f.away}: listed twice, kept the later one`);
      picks.set(fi, { hg, ag });
      if (note) notes.push(`${f.home} v ${f.away}: ${note}`);
    }

    if (picks.size >= submissionMin) {
      const previous = byPlayer.get(m.sender);
      if (previous) notes.unshift("sent more than once, using the latest message");
      byPlayer.set(m.sender, { player: m.sender, at: `${m.date} ${m.time}`, picks, notes });
    } else if (picks.size && byPlayer.has(m.sender)) {
      // A later one-liner fixing or adding a single game.
      const s = byPlayer.get(m.sender);
      for (const [fi, score] of picks) {
        const f = fixtures[fi];
        s.notes.push(`${f.home} v ${f.away}: ${s.picks.has(fi) ? "changed" : "added"} by a later message`);
        s.picks.set(fi, score);
      }
    }
  }

  const entries = [...byPlayer.values()].map(s => ({
    player: s.player, at: s.at, notes: s.notes,
    picks: fixtures.map((_, i) => s.picks.get(i) || null),
  }));
  return { fixtures, entries, messageCount: msgs.length };
}
