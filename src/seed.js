/**
 * Bootstrap a league.
 *
 *   node src/seed.js                          -> just the admin from .env
 *   node src/seed.js chat.txt "Week 1"        -> admin + players + round from a WhatsApp export
 *
 * Safe to re-run: it never overwrites an existing player or PIN.
 */
import { readFileSync } from "node:fs";
import * as store from "./db.js";
import { hashPin, isValidPinFormat } from "./auth.js";
import { parseChat } from "./parser.js";

const [, , chatPath, roundName] = process.argv;

/* --- admin --- */
const adminName = (process.env.ADMIN_NAME || "").trim();
const adminPin = (process.env.ADMIN_PIN || "").trim();
if (adminName) {
  let admin = store.getPlayerByName(adminName);
  if (!admin) { store.createPlayer(adminName, 1); admin = store.getPlayerByName(adminName);
                console.log(`admin created: ${adminName}`); }
  else { store.updatePlayer(admin.id, { is_admin: 1 }); console.log(`admin confirmed: ${adminName}`); }
  if (adminPin && !admin.pin_hash) {
    if (!isValidPinFormat(adminPin)) { console.error("ADMIN_PIN must be 4 digits — skipped."); }
    else { const { hash, salt } = hashPin(adminPin); store.setPin(admin.id, hash, salt);
           console.log("admin PIN set from ADMIN_PIN — change it after first login"); }
  } else if (!admin.pin_hash) {
    console.log("admin has no PIN yet — pick one on the sign-in screen");
  }
} else {
  console.log("no ADMIN_NAME set, skipping admin bootstrap");
}

/* --- the pundit whose picks cover a missed round --- */
const punditName = (process.env.PUNDIT_NAME || "Chris Sutton").trim();
let pundit = store.getPlayerByName(punditName);
if (!pundit) { store.createPlayer(punditName, 0, 1); pundit = store.getPlayerByName(punditName);
               console.log(`pundit created: ${punditName}`); }
else { store.updatePlayer(pundit.id, { is_fallback: 1 }); console.log(`pundit confirmed: ${punditName}`); }

/* --- optional: players, fixtures and picks from a WhatsApp export --- */
if (chatPath) {
  const parsed = parseChat(readFileSync(chatPath, "utf8"));
  if (!parsed.entries.length) { console.error("no predictions found in that export"); process.exit(1); }

  const name = roundName || "Week 1";
  const info = store.createRound(name, null);
  const roundId = Number(info.lastInsertRowid);
  parsed.fixtures.forEach((f, i) => store.addGame(roundId, i, f.home, f.away));
  const games = store.gamesFor(roundId);
  console.log(`round "${name}": ${games.length} fixtures`);

  let added = 0, picks = 0;
  for (const entry of parsed.entries) {
    let p = store.getPlayerByName(entry.player);
    if (!p) { store.createPlayer(entry.player); p = store.getPlayerByName(entry.player); added++; }
    const rows = [];
    entry.picks.forEach((pick, i) => { if (pick) rows.push({ game_id: games[i].id, hg: pick.hg, ag: pick.ag }); });
    if (rows.length) { store.savePredictions(p.id, rows, "whatsapp"); picks += rows.length; }
  }
  console.log(`players: ${parsed.entries.length} seen, ${added} new`);
  console.log(`picks imported: ${picks}`);
  const flagged = parsed.entries.filter(e => e.notes.length);
  if (flagged.length) {
    console.log(`\n${flagged.length} entries needed interpreting:`);
    for (const e of flagged) console.log(`  ${e.player}: ${e.notes.join("; ")}`);
  }
}
console.log("\nseed complete");
