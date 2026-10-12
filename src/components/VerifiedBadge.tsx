import { BadgeCheck } from "lucide-react";

export default function VerifiedBadge({ verified, compact = false }: { verified?: boolean; compact?: boolean }) {
  if (!verified) return null;
  return (
    <span className="verified-badge" title="Discord account with a linked Battle.net name" aria-label="Verified: Discord account with a linked Battle.net name">
      <BadgeCheck size={compact ? 15 : 17} aria-hidden="true" />
      {!compact && <span>Verified</span>}
    </span>
  );
}
