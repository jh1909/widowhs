import { createPlayerMap } from "./player-map.ts";
import { calculateRating } from "./rating.ts";
import { scoreWeight, placementMatches } from "./elo-weight.ts";
import { rankPlayers, personalBest } from "./leaderboard.ts";
import type { MatchData } from "../upload-csv/parser.ts";

export type ImportedMatch = MatchData & { played_at: string | null; match_id: string };
export type ImportPlayer = {
  name: string; bnet_accounts?: string[] | null; previous_names?: string[] | null;
  matches?: number; score?: number; deaths?: number; crouches?: number;
  time_in_lobby?: number; kdr?: string | number; accuracy?: string | number;
  kpm?: string | number; elo: string | number | null; rank?: number | string;
  personal_best_time?: number | string | null;
  is_banned?: boolean | null;
  placement_matches?: number | string | null;
  elo_weight_sum?: number | string | null;
  elo_kpm_sum?: number | string | null; elo_accuracy_sum?: number | string | null; elo_kdr_sum?: number | string | null;
};

// Keep unregistered players, but never track a banned profile's participations.
export function buildMatchImport(dbPlayers: ImportPlayer[], matches: ImportedMatch[]) {
  const playerMap = createPlayerMap(dbPlayers);
  const aggregates = new Map<string, {
    player: ImportPlayer; matches: number; score: number; deaths: number;
    crouches: number; time: number; kdrSum: number; accuracySum: number; kpmSum: number; best: number | null;
    weight: number; weightedKdr: number; weightedAccuracy: number; weightedKpm: number; addedWeight: number;
    placements: number;
  }>();
  const matchRows = matches.flatMap(match => {
    let player = playerMap.get(match.player_name.toLowerCase());
    if (player?.is_banned === true) return [];
    if (!player) {
      // "me" is reserved by the profile route; retain the log name as an alias.
      player = { name: match.player_name.toLowerCase() === "me" ? "me (player)" : match.player_name, elo: "-",
        previous_names: match.player_name.toLowerCase() === "me" ? [match.player_name] : [] };
      playerMap.set(match.player_name.toLowerCase(), player);
    }
    let stats = aggregates.get(player.name);
    if (!stats) {
      const count = Number(player.matches) || 0;
      stats = { player, matches: count, score: Number(player.score) || 0,
        deaths: Number(player.deaths) || 0, crouches: Number(player.crouches) || 0,
        time: Number(player.time_in_lobby) || 0,
        kdrSum: (parseFloat(String(player.kdr)) || 0) * count,
        accuracySum: (parseFloat(String(player.accuracy)) || 0) * count,
        kpmSum: (parseFloat(String(player.kpm)) || 0) * count, best: personalBest(player.personal_best_time),
        placements: placementMatches(player), weight: Number(player.elo_weight_sum ?? count),
        weightedKdr: Number(player.elo_kdr_sum ?? ((parseFloat(String(player.kdr)) || 0) * count)),
        weightedAccuracy: Number(player.elo_accuracy_sum ?? ((parseFloat(String(player.accuracy)) || 0) * count)),
        weightedKpm: Number(player.elo_kpm_sum ?? ((parseFloat(String(player.kpm)) || 0) * count)), addedWeight: 0 };
      aggregates.set(player.name, stats);
    }
    stats.matches++; stats.score += match.score; stats.deaths += match.deaths;
    stats.crouches += match.crouches; stats.time += match.time_in_lobby;
    stats.kdrSum += match.kdr; stats.accuracySum += match.accuracy; stats.kpmSum += match.kpm;
    const weight = scoreWeight(match);
    if (weight === 1) stats.placements++;
    stats.weight += weight; stats.addedWeight += weight;
    stats.weightedKdr += match.kdr * weight; stats.weightedAccuracy += match.accuracy * weight;
    stats.weightedKpm += match.kpm * weight;
    if (match.score >= 50 && personalBest(match.time_in_lobby) !== null) {
      stats.best = Math.min(stats.best ?? Infinity, match.time_in_lobby);
    }
    return [{ ...match, player_name: player.name, logged_player_name: match.player_name,
      performance_score: calculateRating(match), elo_weight: weight }];
  });
  const players = [...aggregates.values()].map(stats => {
    const kdr = stats.kdrSum / stats.matches;
    const accuracy = stats.accuracySum / stats.matches;
    const kpm = stats.kpmSum / stats.matches;
    const elo = stats.weight > 0 ? calculateRating({ kdr: stats.weightedKdr / stats.weight,
      accuracy: stats.weightedAccuracy / stats.weight, kpm: stats.weightedKpm / stats.weight }) : null;
    return { name: stats.player.name, previous_names: stats.player.previous_names ?? [],
      matches: stats.matches, score: stats.score, deaths: stats.deaths, personal_best_time: stats.best,
      crouches: stats.crouches, time_in_lobby: stats.time,
      kdr: kdr.toFixed(2), accuracy: `${accuracy.toFixed(2)}%`, kpm: kpm.toFixed(2),
      placement_matches: stats.placements, elo_weight_sum: stats.weight, elo_kpm_sum: stats.weightedKpm,
      elo_accuracy_sum: stats.weightedAccuracy, elo_kdr_sum: stats.weightedKdr,
      elo: elo?.toLocaleString("en-US") ?? "-", tag: elo != null && elo >= 1200 ? "PRO" : "", rank: 999999 };
  });
  const updatedNames = new Set(players.map(player => player.name));
  const bannedNames = new Set(dbPlayers.filter(player => player.is_banned === true).map(player => player.name));
  const rankings = rankPlayers([...dbPlayers.filter(player => !updatedNames.has(player.name)),
    ...players.filter(player => !bannedNames.has(player.name))]);
  const ranks = new Map(rankings.map(player => [player.name, player.rank]));
  const rankedPlayers = players.map(player => ({ ...player, rank: ranks.get(player.name) ?? 999999 }));
  return {
    players: rankedPlayers,
    ranks: dbPlayers.filter(player => !updatedNames.has(player.name) && Number(player.rank) !== ranks.get(player.name))
      .map(player => ({ name: player.name, rank: ranks.get(player.name) ?? 999999 })),
    history: rankedPlayers.filter(player => aggregates.get(player.name)!.addedWeight > 0)
      .map(player => ({ player_name: player.name, elo: Number(player.elo.replace(/,/g, "")), rank: player.rank })),
    matches: matchRows,
    roundCount: new Set(matchRows.map(match => match.match_id)).size,
    skippedBanned: matches.length - matchRows.length,
  };
}
