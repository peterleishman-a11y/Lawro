import { test } from "node:test";
import assert from "node:assert/strict";
import { collectFixtures, normaliseFixtures, htmlToText, extractPredictions } from "../src/bbc.js";

test("finds fixtures however deeply the JSON buries them", () => {
  const payload = { data: { some: { wrapper: [{ groups: [{ events: [
    { status: "PostEvent", home: { fullName: "Arsenal", score: "2" },
                           away: { fullName: "Coventry City", score: "0" } },
    { status: "PreEvent",  home: { fullName: "Hull City", score: null },
                           away: { fullName: "Manchester United", score: null } },
  ] }] }] } } };
  const found = collectFixtures(payload);
  assert.equal(found.length, 2);
  assert.equal(found[0].hg, 2);
  assert.equal(found[0].finished, true);
  assert.equal(found[1].finished, false);
  assert.equal(found[1].hg, null);
});

test("copes with the other field names the BBC has used", () => {
  const found = collectFixtures({ x: [
    { eventStatus:"FullTime", homeTeam:{ name:"Everton", goals:1 }, awayTeam:{ name:"Crystal Palace", goals:1 } },
    { state:"post", competitor1:{ shortName:"Fulham", fullTimeScore:0 }, competitor2:{ shortName:"Chelsea", fullTimeScore:2 } },
  ] });
  assert.equal(found.length, 2);
  assert.deepEqual([found[0].hg, found[0].ag], [1, 1]);
  assert.deepEqual([found[1].hg, found[1].ag], [0, 2]);
});

test("ignores objects that only look a bit like fixtures", () => {
  assert.equal(collectFixtures({ home: "Arsenal", away: "Coventry" }).length, 0);   // strings
  assert.equal(collectFixtures({ home: {}, away: {} }).length, 0);                  // no names
  assert.equal(collectFixtures({ nothing: [1, 2, 3] }).length, 0);
});

test("maps BBC's long team names onto ours", () => {
  const out = normaliseFixtures([
    { home:"Manchester City", away:"AFC Bournemouth", hg:3, ag:0 },
    { home:"Nottingham Forest", away:"Leeds United", hg:2, ag:1 },
    { home:"Tottenham Hotspur", away:"Brighton & Hove Albion", hg:1, ag:1 },
  ]);
  assert.deepEqual(out.map(f => [f.home, f.away]), [
    ["Man City","Bournemouth"], ["Nottm Forest","Leeds"], ["Spurs","Brighton"],
  ]);
});

test("drops fixtures from competitions we don't track", () => {
  assert.equal(normaliseFixtures([{ home:"Real Madrid", away:"Barcelona", hg:1, ag:2 }]).length, 0);
});

test("turns article HTML into plain lines", () => {
  const txt = htmlToText("<h2>Arsenal v Coventry</h2><p>Big game.</p><p>Sutton&rsquo;s prediction: <b>2-0</b></p>");
  assert.deepEqual(txt.split("\n"), ["Arsenal v Coventry", "Big game.", "Sutton's prediction: 2-0"]);
});

test("reads the BBC layout: fixture heading, score underneath", () => {
  const text = [
    "Premier League predictions",
    "Arsenal v Coventry",
    "Sutton's prediction: 2-0",
    "Hull v Man Utd",
    "Sutton's prediction: 0-3",
  ].join("\n");
  assert.deepEqual(extractPredictions(text), [
    { home:"Arsenal", away:"Coventry", hg:2, ag:0 },
    { home:"Hull", away:"Man Utd", hg:0, ag:3 },
  ]);
});

test("reads inline predictions too, and does not double-count", () => {
  const text = ["Everton 1-1 Crystal Palace", "Everton v Crystal Palace", "Sutton's prediction: 3-3"].join("\n");
  assert.deepEqual(extractPredictions(text), [{ home:"Everton", away:"Crystal Palace", hg:1, ag:1 }]);
});

test("a heading with no score following is left alone", () => {
  assert.deepEqual(extractPredictions("Arsenal v Coventry\nNo prediction this week."), []);
});
