import { createPlayerMap } from "./player-map.ts";
import { calculateRating } from "./rating.ts";
import { rankPlayers, personalBest } from "./leaderboard.ts";
import type { MatchData } from "../upload-csv/parser.ts";

export type ImportedMatch = MatchData & { played_at: string | null; match_id: string };
export type ImportPlayer = {
  name: string; bnet_accounts?: string[] | null; previous_names?: string[] | null;
  matches?: number; score?: number; deaths?: number; crouches?: number;
  time_in_lobby?: number; kdr?: string | number; accuracy?: string | number;
  kpm?: string | number; elo: string | number | null; rank?: number | string;
  personal_best_time?: number | string | null;
};

// Keep every participation, including players who have never signed in.
export function buildMatchImport(dbPlayers: ImportPlayer[], matches: ImportedMatch[]) {
  const playerMap = createPlayerMap(dbPlayers);
  const aggregates = new Map<string, {
    player: ImportPlayer; matches: number; score: number; deaths: number;
    crouches: number; time: number; kdrSum: number; accuracySum: number; kpmSum: number; best: number | null;
  }>();
  const matchRows = matches.map(match => {
    let player = playerMap.get(match.player_name.toLowerCase());
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
        kpmSum: (parseFloat(String(player.kpm)) || 0) * count, best: personalBest(player.personal_best_time) };
      aggregates.set(player.name, stats);
    }
    stats.matches++; stats.score += match.score; stats.deaths += match.deaths;
    stats.crouches += match.crouches; stats.time += match.time_in_lobby;
    stats.kdrSum += match.kdr; stats.accuracySum += match.accuracy; stats.kpmSum += match.kpm;
    if (match.score >= 50 && personalBest(match.time_in_lobby) !== null) {
      stats.best = Math.min(stats.best ?? Infinity, match.time_in_lobby);
    }
    return { ...match, player_name: player.name, logged_player_name: match.player_name,
      performance_score: calculateRating(match) };
  });
  const players = [...aggregates.values()].map(stats => {
    const kdr = stats.kdrSum / stats.matches;
    const accuracy = stats.accuracySum / stats.matches;
    const kpm = stats.kpmSum / stats.matches;
    const elo = calculateRating({ kdr, accuracy, kpm });
    return { name: stats.player.name, previous_names: stats.player.previous_names ?? [],
      matches: stats.matches, score: stats.score, deaths: stats.deaths, personal_best_time: stats.best,
      crouches: stats.crouches, time_in_lobby: stats.time,
      kdr: kdr.toFixed(2), accuracy: `${accuracy.toFixed(2)}%`, kpm: kpm.toFixed(2),
      elo: elo.toLocaleString("en-US"), tag: elo >= 1200 ? "PRO" : "", rank: 999999 };
  });
  const updatedNames = new Set(players.map(player => player.name));
  const rankings = rankPlayers([...dbPlayers.filter(player => !updatedNames.has(player.name)), ...players]);
  const ranks = new Map(rankings.map(player => [player.name, player.rank]));
  const rankedPlayers = players.map(player => ({ ...player, rank: ranks.get(player.name)! }));
  return {
    players: rankedPlayers,
    ranks: dbPlayers.filter(player => !updatedNames.has(player.name) && Number(player.rank) !== ranks.get(player.name))
      .map(player => ({ name: player.name, rank: ranks.get(player.name) ?? 999999 })),
    history: rankedPlayers.map(player => ({ player_name: player.name, elo: Number(player.elo.replace(/,/g, "")), rank: player.rank })),
    matches: matchRows,
    roundCount: new Set(matches.map(match => match.match_id)).size,
  };
}
