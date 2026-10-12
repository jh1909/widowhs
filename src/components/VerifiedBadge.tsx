import { BadgeCheck } from "lucide-react";

export default function VerifiedBadge({ verified, compact = false }: { verified?: boolean; compact?: boolean }) {
  if (!verified) return null;
  return (
    <span className="verified-badge" title="Battle.net account ownership verified through Blizzard" aria-label="Verified: Battle.net account ownership verified through Blizzard">
      <BadgeCheck size={compact ? 15 : 17} aria-hidden="true" />
      {!compact && <span>Verified</span>}
    </span>
  );
}
