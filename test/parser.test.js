import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChat, parseLine, findTeams } from "../src/parser.js";

const msg = (who, body) => `[18/8/2026, 9:00:00 pm] ${who}: ${body}`;

test("reads every score format the group actually uses", () => {
  const cases = [
    ["Arsenal 2-0 Coventry",        ["Arsenal","Coventry"], 2, 0],
    ["Arsenal v Coventry 3-0",      ["Arsenal","Coventry"], 3, 0],
    ["Arsenal 3 v 0 Coventry",      ["Arsenal","Coventry"], 3, 0],
    ["Ars-Cov 2:0",                 ["Arsenal","Coventry"], 2, 0],
    ["Man City v B'mouth  3- 1",    ["Man City","Bournemouth"], 3, 1],
    ["Brentford v Spurs 0'2",       ["Brentford","Spurs"], 0, 2],
    ["Hull 0-3Man Utd",             ["Hull","Man Utd"], 0, 3],
    ["Newcastle  1v 2 Liverpool",   ["Newcastle","Liverpool"], 1, 2],
    ["Fulham v Chelsea 1 - 3",      ["Fulham","Chelsea"], 1, 3],
    ["Newcastle v Liverpoo  1-3",   ["Newcastle","Liverpool"], 1, 3],
    ["Not-Leeds 1:1",               ["Nottm Forest","Leeds"], 1, 1],
    ["ManC v Bourn 3-1",            ["Man City","Bournemouth"], 3, 1],
  ];
  for (const [line, teams, a, b] of cases) {
    const r = parseLine(line);
    assert.ok(r, `failed to parse: ${line}`);
    assert.deepEqual(r.teams, teams, line);
    assert.equal(r.a, a, line);
    assert.equal(r.b, b, line);
  }
});

test("handles curly apostrophes, en-dashes and emoji in team names", () => {
  assert.deepEqual(parseLine("Man City 2- 1 B’mouth").teams, ["Man City","Bournemouth"]);
  assert.equal(parseLine("Hull v Man Utd 0–2").b, 2);
  assert.deepEqual(findTeams("Hull🐅 v Man Utd 1-3"), ["Hull","Man Utd"]);
});

test("ignores lines that only look like scores", () => {
  assert.equal(parseLine("40 points for a correct score"), null);
  assert.equal(parseLine("25Euro entry"), null);
  assert.equal(parseLine("Arsenal v Coventry"), null);          // fixture list, no score
  assert.equal(parseLine("Leeds 12??"), null);                  // one team only
});

test("picks the fixture list out of the crowd and orders it", () => {
  const chat = [
    msg("Alice","Arsenal 1-0 Coventry\nHull 0-2 Man Utd\nEverton 1-1 Cry Palace\nIpswich 2-1 Sunderland\nBrentford 0-1 Spurs"),
    msg("Bob",  "Arsenal 2-0 Coventry\nHull 1-3 Man Utd\nEverton 0-0 Cry Palace\nIpswich 1-1 Sunderland\nBrentford 1-1 Spurs"),
    msg("Cara", "Arsenal 3-0 Coventry\nHull 0-1 Man Utd\nEverton 2-1 Cry Palace\nIpswich 0-2 Sunderland\nBrentford 2-2 Spurs"),
  ].join("\n");
  const out = parseChat(chat);
  assert.equal(out.fixtures.length, 5);
  assert.deepEqual(out.fixtures.map(f => f.home),
    ["Arsenal","Hull","Everton","Ipswich","Brentford"]);
  assert.equal(out.entries.length, 3);
});

test("normalises reversed team order to the round's home/away", () => {
  const chat = [
    msg("Alice","Arsenal 1-0 Coventry\nHull 0-2 Man Utd\nEverton 1-1 Palace\nIpswich 2-1 Sunderland\nBrentford 0-1 Spurs"),
    msg("Bob",  "Arsenal 2-0 Coventry\nHull 1-3 Man Utd\nEverton 0-0 Palace\nIpswich 1-1 Sunderland\nBrentford 1-1 Spurs"),
    // Cara writes the first game the other way round: Coventry 0-4 Arsenal
    msg("Cara", "Coventry 0-4 Arsenal\nHull 0-1 Man Utd\nEverton 2-1 Palace\nIpswich 0-2 Sunderland\nBrentford 2-2 Spurs"),
  ].join("\n");
  const out = parseChat(chat);
  const cara = out.entries.find(e => e.player === "Cara");
  assert.deepEqual(cara.picks[0], { hg: 4, ag: 0 });            // stored as Arsenal 4-0
  assert.ok(cara.notes.some(n => /other way round/.test(n)));
});

test("a later message replaces an earlier full submission", () => {
  const chat = [
    msg("Alice","Arsenal 1-0 Coventry\nHull 0-2 Man Utd\nEverton 1-1 Palace\nIpswich 2-1 Sunderland\nBrentford 0-1 Spurs"),
    msg("Bob",  "Arsenal 2-0 Coventry\nHull 1-3 Man Utd\nEverton 0-0 Palace\nIpswich 1-1 Sunderland\nBrentford 1-1 Spurs"),
    msg("Alice","Arsenal 5-0 Coventry\nHull 0-9 Man Utd\nEverton 3-3 Palace\nIpswich 4-1 Sunderland\nBrentford 0-6 Spurs"),
  ].join("\n");
  const alice = parseChat(chat).entries.find(e => e.player === "Alice");
  assert.deepEqual(alice.picks[0], { hg: 5, ag: 0 });
  assert.ok(alice.notes.some(n => /latest message/.test(n)));
});

test("a one-line follow-up fills in a game that was left out", () => {
  const chat = [
    msg("Alice","Arsenal 1-0 Coventry\nHull 0-2 Man Utd\nEverton 1-1 Palace\nIpswich 2-1 Sunderland\nBrentford 0-1 Spurs"),
    msg("Bob",  "Arsenal 2-0 Coventry\nHull 1-3 Man Utd\nEverton 0-0 Palace\nIpswich 1-1 Sunderland\nBrentford 1-1 Spurs"),
    msg("Cara", "Arsenal 3-0 Coventry\nHull 0-1 Man Utd\nEverton 2-1 Palace\nIpswich 0-2 Sunderland"),
    msg("Cara", "sorry forgot Brent-Spurs 2:1 please"),
  ].join("\n");
  const cara = parseChat(chat).entries.find(e => e.player === "Cara");
  assert.deepEqual(cara.picks[4], { hg: 2, ag: 1 });
  assert.ok(cara.notes.some(n => /added by a later message/.test(n)));
});

test("rejoins a fixture split over two lines", () => {
  const chat = [
    msg("Alice","Arsenal 1-0 Coventry\nHull 1 - 2 \nMan utd\nEverton 1-1 Palace\nIpswich 2-1 Sunderland\nBrentford 0-1 Spurs"),
    msg("Bob",  "Arsenal 2-0 Coventry\nHull 1-3 Man Utd\nEverton 0-0 Palace\nIpswich 1-1 Sunderland\nBrentford 1-1 Spurs"),
  ].join("\n");
  const alice = parseChat(chat).entries.find(e => e.player === "Alice");
  assert.deepEqual(alice.picks[1], { hg: 1, ag: 2 });
});
