/**
 * League scoring: 40 for a correct score, 10 for the correct result.
 * Both values come from settings so the group can change them.
 */
const outcome = (h, a) => (h > a ? 1 : h < a ? -1 : 0);

/** One prediction against one finished game. */
export function scorePick(pick, game, { points_exact, points_result }, resultOnly = false) {
  if (game.hg === null || game.ag === null) return { points: 0, kind: "pending" };
  if (!pick) return { points: 0, kind: "none" };
  if (!resultOnly && pick.hg === game.hg && pick.ag === game.ag)
    return { points: points_exact, kind: "exact" };
  if (outcome(pick.hg, pick.ag) === outcome(game.hg, game.ag))
    return { points: points_result, kind: "result" };
  return { points: 0, kind: "miss" };
}

/**
 * Table for one round.
 * `predictions` is the flat row set from the DB; `players` scopes the table so
 * that someone who submitted nothing still appears, on nil.
 */
export function roundTable(games, predictions, players, settings) {
  const byPlayer = new Map();
  for (const p of players)
    byPlayer.set(p.id, { playerId: p.id, player: p.name, isFallback: !!p.is_fallback, picks: new Map() });
  for (const pr of predictions) {
    if (!byPlayer.has(pr.player_id))
      byPlayer.set(pr.player_id, { playerId: pr.player_id, player: pr.player_name, isFallback: false, picks: new Map() });
    byPlayer.get(pr.player_id).picks.set(pr.game_id, { hg: pr.hg, ag: pr.ag, source: pr.source });
  }

  // House rule: miss a round entirely and you are credited with the pundit's
  // picks, but on the result only — no 40s for a scoreline you never sent.
  const pundit = [...byPlayer.values()].find(r => r.isFallback);

  const rows = [...byPlayer.values()].map(row => {
    const missedRound = !row.isFallback && row.picks.size === 0 && !!pundit && pundit.picks.size > 0;
    const cells = games.map(g => {
      const own = row.picks.get(g.id) || null;
      const pick = own || (missedRound ? pundit.picks.get(g.id) || null : null);
      const credited = !own && !!pick;
      const resultOnly = credited || pick?.source === "fallback";
      return { game_id: g.id, pick, credited, ...scorePick(pick, g, settings, resultOnly) };
    });
    return {
      playerId: row.playerId, player: row.player, isFallback: row.isFallback,
      creditedFromPundit: missedRound, cells,
      points: cells.reduce((s, c) => s + c.points, 0),
      exact: cells.filter(c => c.kind === "exact").length,
      results: cells.filter(c => c.kind === "result").length,
      submitted: row.picks.size,
    };
  });

  rows.sort((a, b) => b.points - a.points || b.exact - a.exact || a.player.localeCompare(b.player));
  return withRanks(rows);
}

/** Shared ranks: equal points share a position, and the next rank skips. */
function withRanks(rows) {
  let lastPoints = null, lastRank = 0;
  return rows.map((r, i) => {
    const rank = r.points === lastPoints ? lastRank : i + 1;
    lastPoints = r.points; lastRank = rank;
    return { ...r, rank };
  });
}

/**
 * Season table across every round that has at least one result in.
 * Also returns each player's best single round, which decides the 20% prize.
 */
export function seasonTable(rounds, gamesByRound, predsByRound, players, settings) {
  const totals = new Map(
    players.map(p => [p.id, { playerId: p.id, player: p.name, isFallback: !!p.is_fallback,
                              points: 0, exact: 0, results: 0, best: 0,
                              bestRound: null, played: 0 }])
  );

  for (const round of rounds) {
    const games = gamesByRound.get(round.id) || [];
    if (!games.some(g => g.hg !== null && g.ag !== null)) continue;   // nothing settled yet
    const table = roundTable(games, predsByRound.get(round.id) || [], players, settings);
    for (const row of table) {
      const t = totals.get(row.playerId);
      if (!t) continue;
      t.points += row.points; t.exact += row.exact; t.results += row.results;
      t.played += 1;
      if (row.points > t.best) { t.best = row.points; t.bestRound = round.name; }
    }
  }

  const rows = [...totals.values()]
    .sort((a, b) => b.points - a.points || b.exact - a.exact || a.player.localeCompare(b.player));
  return withRanks(rows);
}

/**
 * Pot split: 80% to the season leader, 20% to the best single round.
 * The pundit pays no entry and wins nothing, so he is left out of both.
 */
export function prizePot(players, season, settings) {
  const paying = (Array.isArray(players) ? players.filter(p => !p.is_fallback).length : players);
  const contenders = season.filter(r => !r.isFallback);
  const pot = paying * settings.entry_fee;
  const seasonPrize = Math.round(pot * settings.share_season) / 100;
  const bestPrize = Math.round(pot * settings.share_best_week) / 100;
  const leader = contenders[0]?.points ? contenders[0] : null;
  const bestRow = contenders.reduce((acc, r) => (!acc || r.best > acc.best ? r : acc), null);
  return {
    pot, seasonPrize, bestPrize, currency: settings.currency, paying,
    leader: leader ? { player: leader.player, points: leader.points } : null,
    best: bestRow?.best ? { player: bestRow.player, points: bestRow.best, round: bestRow.bestRound } : null,
  };
}
