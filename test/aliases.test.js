/**
 * Player identity across imports. db.js opens its database at import time from
 * DATABASE_PATH, so this is set before the module is pulled in.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lawro-alias-"));
process.env.DATABASE_PATH = join(dir, "test.db");
const store = await import("../src/db.js");

after(() => rmSync(dir, { recursive: true, force: true }));

const mkPlayer = name => { store.createPlayer(name); return store.getPlayerByName(name); };

test("a player resolves by their own name", () => {
  const p = mkPlayer("Richard Marns");
  assert.equal(store.getPlayerByAnyName("Richard Marns").id, p.id);
  assert.equal(store.getPlayerByAnyName("richard marns").id, p.id, "case-insensitive");
});

test("an unknown name resolves to nobody", () => {
  assert.equal(store.getPlayerByAnyName("Nobody At All"), undefined);
});

test("an alias resolves to the player, so a rename survives the next import", () => {
  const p = mkPlayer("Gary Clark");
  store.addAlias(p.id, "Gc");                    // what WhatsApp called them
  assert.equal(store.getPlayerByAnyName("Gc").id, p.id);
  assert.deepEqual(store.listAliases(p.id), ["Gc"]);
});

test("an alias cannot be stolen from another player", () => {
  const a = mkPlayer("Alias Owner");
  const b = mkPlayer("Alias Rival");
  assert.equal(store.addAlias(a.id, "Contested"), true);
  assert.equal(store.addAlias(b.id, "Contested"), false, "already pointed at someone");
  assert.equal(store.getPlayerByAnyName("Contested").id, a.id);
});

test("an alias cannot shadow a real player's name", () => {
  const real = mkPlayer("Simon Turner");
  const other = mkPlayer("Someone Else");
  assert.equal(store.addAlias(other.id, "Simon Turner"), false);
  assert.equal(store.getPlayerByAnyName("Simon Turner").id, real.id);
});

test("a real name beats an alias pointing elsewhere", () => {
  const ghost = mkPlayer("Ghost Name");
  const holder = mkPlayer("Holder");
  store.addAlias(holder.id, "Later Real Person");
  const real = mkPlayer("Later Real Person");
  assert.equal(store.getPlayerByAnyName("Later Real Person").id, real.id);
  assert.notEqual(real.id, ghost.id);
});

test("merging moves picks and keeps the absorbed name matching on import", () => {
  const keep = mkPlayer("Stuart Walker");
  const dupe = mkPlayer("Stuart");
  const rid = Number(store.createRound("R", null).lastInsertRowid);
  store.addGame(rid, 0, "Arsenal", "Coventry");
  store.addGame(rid, 1, "Hull", "Man Utd");
  const [g1, g2] = store.gamesFor(rid);

  store.savePredictions(keep.id, [{ game_id: g1.id, hg: 2, ag: 0 }], "web");
  store.savePredictions(dupe.id, [{ game_id: g1.id, hg: 5, ag: 5 },     // clashes
                                  { game_id: g2.id, hg: 0, ag: 2 }], "whatsapp");

  const r = store.mergePlayers(keep.id, dupe.id);
  assert.equal(r.moved, 1, "only the game the keeper had no pick for");
  assert.equal(r.discarded, 1, "the clashing pick is dropped");
  assert.equal(store.getPlayer(dupe.id), undefined, "duplicate row is gone");
  assert.equal(store.getPlayerByAnyName("Stuart").id, keep.id, "old name still imports");

  const picks = store.myPredictions(keep.id, rid);
  assert.equal(picks.length, 2);
  const kept = picks.find(p => p.game_id === g1.id);
  assert.equal(kept.hg, 2, "the keeper's own pick stands");
  assert.equal(kept.ag, 0);
});

test("merging a player into themselves does nothing", () => {
  const p = mkPlayer("Lonely");
  assert.equal(store.mergePlayers(p.id, p.id), null);
});
