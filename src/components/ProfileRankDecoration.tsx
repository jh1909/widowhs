import { useId } from "react";

type PodiumRank = 1 | 2 | 3;

export function getPodiumRank(value: unknown): PodiumRank | null {
  const rank = Number(value);
  return rank === 1 || rank === 2 || rank === 3 ? rank : null;
}

export const podiumThemes: Record<PodiumRank, string> = {
  1: "sapphire", 2: "ruby", 3: "emerald",
};

function RankCrest({ rank }: { rank: PodiumRank }) {
  const id = useId();
  const gold = `${id}-gold`;
  const jewel = `${id}-jewel`;
  const shade = `${id}-shade`;
  const wings = (
    <g>
      <path d="M94 79 48 68 26 49 37 100 64 127 94 143 102 112Z" fill={`url(#${gold})`} stroke="#705325" strokeWidth="1.5" />
      <path d="m39 72 15 14 38 12 3-11-44-13Z" fill="#fff0c3" opacity=".55" />
      <path d="m41 90 23 19 29 15 1-17-31-12Z" fill={`url(#${shade})`} stroke="#d4b779" strokeWidth="1" />
      <path d="m57 117 12 13 24 15 3-11Z" fill={`url(#${gold})`} />
    </g>
  );

  return (
    <svg className="profile-rank-crest" viewBox="0 0 240 210" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gold} x1="55" y1="35" x2="169" y2="174" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff2c4" /><stop offset=".25" stopColor="#d8b46b" />
          <stop offset=".53" stopColor="#8c642c" /><stop offset=".72" stopColor="#eed59a" /><stop offset="1" stopColor="#9b7436" />
        </linearGradient>
        <linearGradient id={jewel} x1="95" y1="60" x2="149" y2="159" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--podium-light)" /><stop offset=".48" stopColor="var(--podium-accent)" /><stop offset="1" stopColor="var(--podium-dark)" />
        </linearGradient>
        <linearGradient id={shade} x1="80" y1="55" x2="131" y2="164" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--podium-dark)" /><stop offset="1" stopColor="#090c13" />
        </linearGradient>
      </defs>
      {wings}
      <g transform="translate(240 0) scale(-1 1)">{wings}</g>
      <path d="m120 28 12 17-12 16-12-16Z" fill={`url(#${jewel})`} stroke={`url(#${gold})`} strokeWidth="3" />
      <path d="m120 46 38 20 5 60-43 48-43-48 5-60Z" fill={`url(#${gold})`} stroke="#f2d99e" strokeWidth="1" />
      <path d="m120 57 28 17 4 47-32 38-32-38 4-47Z" fill={`url(#${shade})`} stroke="#6d5029" strokeWidth="1.5" />
      <path d="m120 67 21 15 3 35-24 29-24-29 3-35Z" fill={`url(#${jewel})`} stroke="#e4c780" strokeWidth="1" />
      <path d="m120 68 21 14 3 35-24-13Z" fill="#fff" opacity=".09" />
      <path d="m120 68-21 14-3 35 24-13Z" fill="#fff" opacity=".2" />
      <path d="m80 144 12 21 28 20 28-20 12-21-11 9-29 22-29-22Z" fill={`url(#${gold})`} stroke="#674d27" strokeWidth="1" />
      <path d="m120 178 8 9-8 12-8-12Z" fill={`url(#${jewel})`} stroke="#d4b779" strokeWidth="1.5" />
      <text x="120" y="122" textAnchor="middle" fill="#fff0c6" fontFamily="Georgia, serif" fontSize="36">{["", "I", "II", "III"][rank]}</text>
    </svg>
  );
}

function FrameCorner({ rank, position }: { rank: PodiumRank; position: string }) {
  return (
    <svg className={`profile-rank-corner profile-rank-corner--${position}`} viewBox="0 0 120 72" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 61V23L23 7H109" />
        {rank === 3 ? (
          <path d="m7 35 9-9V16h10l9-9M17 22l5-5 5 5-5 5Z" />
        ) : (
          <>
            <path d="M7 51c0-17 15-17 15-28 0-8 7-13 15-13h58M19 33c12-3 5-20 22-17 11 2 5 14-1 8M37 10c12-12 25 5 39 0" />
            <path d="m10 20 10-10 5 5-10 10Z" fill="var(--podium-dark)" />
            {rank === 1 && (
              <>
                <path d="M7 61c7-4 13-12 9-19-3-6-10-2-6 2M53 16c13 8 23-12 36-5 8 4 1 13-4 8M76 7c14-6 21 8 34 1M22 23c6 1 10-2 11-7" />
                <path d="m24 8 4-6 4 6-4 6ZM97 8l5-4 5 4-5 4Z" fill="currentColor" stroke="none" />
                <path d="M7 53c-2-6-3-11-1-16M52 7c-5-3-10-5-16-3" opacity=".6" />
              </>
            )}
          </>
        )}
      </g>
    </svg>
  );
}

function FrameCenter({ rank, position }: { rank: 1 | 2; position: string }) {
  return (
    <svg className={`profile-rank-center profile-rank-center--${position}`} viewBox="0 0 240 30" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1" strokeLinecap="round">
        <path d="M12 8h53c24 0 29 16 46 8M228 8h-53c-24 0-29 16-46 8" />
        {rank === 1 && <path d="M40 8c19-11 35 16 55 7 7-3 4-9-2-7M200 8c-19-11-35 16-55 7-7-3-4-9 2-7M82 7l11-4 12 8M158 7l-11-4-12 8" />}
        <path d="m120 3 9 9-9 12-9-12Z" fill="var(--podium-dark)" strokeWidth="1.5" />
        <path d="m120 7 5 5-5 7-5-7Z" fill="var(--podium-accent)" stroke="none" />
      </g>
    </svg>
  );
}

export function ProfileRankFrame({ rank }: { rank: PodiumRank }) {
  return (
    <>
      <svg className="profile-rank-frame" viewBox="0 0 1000 180" preserveAspectRatio="none" fill="none" aria-hidden="true">
        <path d="M20 1H980L999 20V160L980 179H20L1 160V20Z" stroke="currentColor" vectorEffect="non-scaling-stroke" />
        {rank === 1 && <path d="M24 5H976L995 24V156L976 175H24L5 156V24Z" stroke="currentColor" opacity=".35" vectorEffect="non-scaling-stroke" />}
      </svg>
      {["top-left", "top-right", "bottom-left", "bottom-right"].map(position => <FrameCorner key={position} rank={rank} position={position} />)}
      {rank !== 3 && <><FrameCenter rank={rank} position="top" /><FrameCenter rank={rank} position="bottom" /></>}
    </>
  );
}

export default function ProfileRankBadge({ rank }: { rank: PodiumRank }) {
  const place = { 1: "1st place", 2: "2nd place", 3: "3rd place" }[rank];

  return (
    <div className="profile-rank-badge" aria-label={`Global leaderboard: ${place}`}>
      <RankCrest rank={rank} />
      <div>
        <p className="profile-rank-label">Global rank</p>
        <p className="profile-rank-title">{place}</p>
      </div>
    </div>
  );
}
