import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePick, roundTable, seasonTable, prizePot } from "../src/scoring.js";

const RULES = { points_exact: 40, points_result: 10, entry_fee: 25,
                currency: "€", share_season: 80, share_best_week: 20 };

test("40 for the exact score, 10 for the right result, 0 otherwise", () => {
  const game = { id: 1, hg: 2, ag: 0 };
  assert.equal(scorePick({ hg:2, ag:0 }, game, RULES).points, 40);
  assert.equal(scorePick({ hg:3, ag:1 }, game, RULES).points, 10);
  assert.equal(scorePick({ hg:0, ag:2 }, game, RULES).points, 0);
  assert.equal(scorePick({ hg:1, ag:1 }, game, RULES).points, 0);
});

test("a correct draw scores the result, an exact draw scores the score", () => {
  const game = { id: 1, hg: 1, ag: 1 };
  assert.equal(scorePick({ hg:1, ag:1 }, game, RULES).kind, "exact");
  assert.equal(scorePick({ hg:2, ag:2 }, game, RULES).kind, "result");
});

test("unplayed games and missing picks score nothing", () => {
  assert.equal(scorePick({ hg:1, ag:0 }, { id:1, hg:null, ag:null }, RULES).kind, "pending");
  assert.equal(scorePick(null, { id:1, hg:1, ag:0 }, RULES).kind, "none");
});

test("a fallback pick can only ever score the result", () => {
  const game = { id: 1, hg: 2, ag: 0 };
  assert.equal(scorePick({ hg:2, ag:0 }, game, RULES, true).points, 10);
});

test("round table ranks, counts and ties correctly", () => {
  const games = [{ id:1, hg:2, ag:0 }, { id:2, hg:1, ag:1 }];
  const players = [{ id:1, name:"Alice" }, { id:2, name:"Bob" }, { id:3, name:"Cara" }];
  const preds = [
    { player_id:1, player_name:"Alice", game_id:1, hg:2, ag:0, source:"web" },  // 40
    { player_id:1, player_name:"Alice", game_id:2, hg:1, ag:1, source:"web" },  // 40  = 80
    { player_id:2, player_name:"Bob",   game_id:1, hg:3, ag:1, source:"web" },  // 10
    { player_id:2, player_name:"Bob",   game_id:2, hg:2, ag:2, source:"web" },  // 10  = 20
    { player_id:3, player_name:"Cara",  game_id:1, hg:0, ag:3, source:"web" },  //  0
  ];
  const table = roundTable(games, preds, players, RULES);
  assert.deepEqual(table.map(r => [r.player, r.points, r.rank]),
    [["Alice",80,1], ["Bob",20,2], ["Cara",0,3]]);
  assert.equal(table[0].exact, 2);
});

test("players who submitted nothing still appear on nil", () => {
  const table = roundTable([{ id:1, hg:1, ag:0 }], [], [{ id:9, name:"Ghost" }], RULES);
  assert.equal(table.length, 1);
  assert.equal(table[0].points, 0);
});

test("equal points share a rank and the next rank skips", () => {
  const games = [{ id:1, hg:1, ag:0 }];
  const players = [{ id:1, name:"A" }, { id:2, name:"B" }, { id:3, name:"C" }];
  const preds = [
    { player_id:1, player_name:"A", game_id:1, hg:1, ag:0, source:"web" },
    { player_id:2, player_name:"B", game_id:1, hg:1, ag:0, source:"web" },
    { player_id:3, player_name:"C", game_id:1, hg:0, ag:1, source:"web" },
  ];
  assert.deepEqual(roundTable(games, preds, players, RULES).map(r => r.rank), [1, 1, 3]);
});

test("season totals accumulate and track each player's best round", () => {
  const rounds = [{ id:1, name:"Week 1" }, { id:2, name:"Week 2" }];
  const players = [{ id:1, name:"Alice" }, { id:2, name:"Bob" }];
  const gamesByRound = new Map([[1, [{ id:1, hg:2, ag:0 }]], [2, [{ id:2, hg:1, ag:1 }]]]);
  const predsByRound = new Map([
    [1, [{ player_id:1, player_name:"Alice", game_id:1, hg:2, ag:0, source:"web" },
         { player_id:2, player_name:"Bob",   game_id:1, hg:3, ag:1, source:"web" }]],
    [2, [{ player_id:1, player_name:"Alice", game_id:2, hg:0, ag:1, source:"web" },
         { player_id:2, player_name:"Bob",   game_id:2, hg:1, ag:1, source:"web" }]],
  ]);
  const table = seasonTable(rounds, gamesByRound, predsByRound, players, RULES);
  assert.deepEqual(table.map(r => [r.player, r.points]), [["Bob",50], ["Alice",40]]);
  assert.equal(table.find(r => r.player === "Bob").best, 40);
  assert.equal(table.find(r => r.player === "Bob").bestRound, "Week 2");
});

test("rounds with no results yet are left out of the season table", () => {
  const rounds = [{ id:1, name:"Week 1" }];
  const table = seasonTable(rounds, new Map([[1, [{ id:1, hg:null, ag:null }]]]),
                            new Map([[1, []]]), [{ id:1, name:"Alice" }], RULES);
  assert.equal(table[0].points, 0);
  assert.equal(table[0].played, 0);
});

test("pot splits 80/20 and names the leader and the best round", () => {
  const season = [
    { playerId:1, player:"Alice", points:120, best:80,  bestRound:"Week 1" },
    { playerId:2, player:"Bob",   points:90,  best:90,  bestRound:"Week 2" },
  ];
  const pot = prizePot(40, season, RULES);
  assert.equal(pot.pot, 1000);
  assert.equal(pot.seasonPrize, 800);
  assert.equal(pot.bestPrize, 200);
  assert.equal(pot.leader.player, "Alice");
  assert.equal(pot.best.player, "Bob");
  assert.equal(pot.best.round, "Week 2");
});

/* ---------------- the pundit who covers a missed round ---------------- */

const PUNDIT = { id: 99, name: "Chris Sutton", is_fallback: 1 };
const punditPicks = games => games.map(g => (
  { player_id: 99, player_name: "Chris Sutton", game_id: g.id, hg: 2, ag: 0, source: "fallback" }));

test("miss the round entirely and you inherit the pundit's picks, result only", () => {
  const games = [{ id:1, hg:2, ag:0 }, { id:2, hg:3, ag:1 }];
  const players = [{ id:1, name:"Absent" }, PUNDIT];
  const table = roundTable(games, punditPicks(games), players, RULES);

  const absent = table.find(r => r.player === "Absent");
  assert.equal(absent.creditedFromPundit, true);
  assert.equal(absent.points, 20);            // two right results, no 40s
  assert.equal(absent.exact, 0);
  assert.ok(absent.cells.every(c => c.credited));
});

test("the pundit keeps his own picks scored result-only as well", () => {
  const games = [{ id:1, hg:2, ag:0 }];
  const table = roundTable(games, punditPicks(games), [PUNDIT], RULES);
  const sutton = table.find(r => r.isFallback);
  assert.equal(sutton.points, 10);            // exact 2-0, but still only 10
  assert.equal(sutton.exact, 0);
});

test("submit anything at all and you are on your own", () => {
  const games = [{ id:1, hg:2, ag:0 }, { id:2, hg:3, ag:1 }];
  const players = [{ id:1, name:"Partial" }, PUNDIT];
  const preds = [...punditPicks(games),
    { player_id:1, player_name:"Partial", game_id:1, hg:2, ag:0, source:"web" }];
  const partial = roundTable(games, preds, players, RULES).find(r => r.player === "Partial");
  assert.equal(partial.creditedFromPundit, false);
  assert.equal(partial.points, 40);           // own exact score counts in full
  assert.equal(partial.cells[1].points, 0);   // the game he skipped scores nothing
});

test("with no pundit picks in, an absent player just scores nil", () => {
  const games = [{ id:1, hg:2, ag:0 }];
  const table = roundTable(games, [], [{ id:1, name:"Absent" }, PUNDIT], RULES);
  assert.equal(table.find(r => r.player === "Absent").points, 0);
  assert.equal(table.find(r => r.player === "Absent").creditedFromPundit, false);
});

test("the pundit pays no entry and cannot win either prize", () => {
  const players = [{ id:1, name:"Alice" }, { id:2, name:"Bob" }, PUNDIT];
  const season = [
    { playerId:99, player:"Chris Sutton", points:500, best:500, bestRound:"Week 1", isFallback:true },
    { playerId:1,  player:"Alice",        points:120, best:80,  bestRound:"Week 1", isFallback:false },
    { playerId:2,  player:"Bob",          points:90,  best:90,  bestRound:"Week 2", isFallback:false },
  ];
  const pot = prizePot(players, season, RULES);
  assert.equal(pot.paying, 2);
  assert.equal(pot.pot, 50);                  // Sutton is not in the pot
  assert.equal(pot.leader.player, "Alice");   // ...nor at the top of it
  assert.equal(pot.best.player, "Bob");
});
