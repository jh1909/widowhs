import { useId } from 'react';
import { medalLabels, type MedalCategory, type MedalTier } from '../lib/stat-medals';

const tiers = {
  gold: { label: 'Gold', place: 1, light: '#ffe3a2', dark: '#ad7831' },
  silver: { label: 'Silver', place: 2, light: '#e5edf4', dark: '#78899e' },
  bronze: { label: 'Bronze', place: 3, light: '#e8b898', dark: '#955d3f' },
};

export default function StatMedal({ tier, category, value }: {
  tier?: MedalTier; category: MedalCategory; value: string;
}) {
  const gradient = useId();
  if (!tier) return null;
  const medal = tiers[tier];
  const description = `${medal.label} medal · Global ${medalLabels[category]}: ${value}`;
  return <span className={`stat-medal stat-medal--${tier}`} role="img" aria-label={description} title={description}>
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
        <stop stopColor={medal.light} /><stop offset=".5" stopColor={medal.dark} /><stop offset="1" stopColor={medal.light} />
      </linearGradient></defs>
      <circle cx="12" cy="12" r="10" fill={medal.dark} fillOpacity=".2" stroke={`url(#${gradient})`} strokeWidth="1.3" />
      <circle cx="12" cy="12" r="7.6" fill="#15151e" stroke={medal.light} strokeOpacity=".25" strokeWidth=".7" />
      <path d="M4 10a8.3 8.3 0 0 1 7-6" fill="none" stroke={medal.light} strokeOpacity=".7" strokeWidth=".6" />
      <text x="12" y="15.4" textAnchor="middle" fill={medal.light} fontSize="10" fontWeight="700" fontFamily="Segoe UI, sans-serif">{medal.place}</text>
    </svg>
  </span>;
}
