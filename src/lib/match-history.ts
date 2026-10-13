export type MatchSummary = {
  match_id: string;
  played_at: string;
  total_match_time: number | null;
  player_count?: number;
};

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Berlin",
});
export function formatMatchDate(date: string) { return dateFormat.format(new Date(date)); }
