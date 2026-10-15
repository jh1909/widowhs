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
