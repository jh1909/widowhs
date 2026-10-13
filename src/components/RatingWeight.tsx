import { scoreWeight, type Participation } from "../../supabase/functions/_shared/elo-weight";

export default function RatingWeight({ match }: { match: Participation }) {
  const weight = scoreWeight(match);
  if (weight === 1) return null;
  return <span className={`block text-[10px] font-normal whitespace-nowrap mt-1 ${weight === 0 ? "text-zinc-500" : "text-amber-300/80"}`}
    title="Participation weight affects profile ELO and placements. The round rating stays unchanged.">
    {weight === 0 ? "Ineligible" : `Reduced weighting · ${(weight * 100).toFixed(1)}%`}
  </span>;
}
