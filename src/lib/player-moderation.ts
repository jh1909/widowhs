export type ModerationAction = 'ban' | 'unban' | 'delete';

// A successful HTTP response can still mean zero rows changed under RLS.
// Require the authenticated RPC's explicit acknowledgement before updating UI.
export function confirmPlayerModeration(
  data: unknown, error: { message: string; code?: string } | null,
  name: string, action: ModerationAction,
): void {
  if (error) {
    if (error.code === 'PGRST202') throw new Error('Admin moderation is not installed yet. Apply 20261015120000_admin_player_moderation.sql in Supabase first.');
    throw new Error(error.message);
  }
  const reply = data as Record<string, unknown> | null;
  if (!reply || reply.name !== name || reply.action !== action || reply.deleted !== (action === 'delete') ||
    (action !== 'delete' && reply.is_banned !== (action === 'ban'))) {
    throw new Error('The database did not confirm this action. Reload and try again.');
  }
}

export function confirmPlayerMerge(
  data: unknown,
  error: { message: string; code?: string } | null,
  targetName: string,
  sourceName: string,
): { target_name: string; source_name: string; transferred_matches: number; matches: number; elo: string; rank: number } {
  if (error) {
    if (error.code === 'PGRST202') {
      throw new Error('Admin merge is not installed yet. Apply 20261108190000_admin_merge_unverified_players.sql in Supabase first.');
    }
    throw new Error(error.message);
  }
  const reply = data as Record<string, any> | null;
  if (
    !reply ||
    reply.target_name?.toLowerCase() !== targetName.trim().toLowerCase() ||
    reply.source_name?.toLowerCase() !== sourceName.trim().toLowerCase()
  ) {
    throw new Error('The database did not confirm this merge. Reload and try again.');
  }
  return reply as any;
}
