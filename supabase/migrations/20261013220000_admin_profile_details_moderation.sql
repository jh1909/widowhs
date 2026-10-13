begin;

create or replace function public.update_player_profile_details(p_player_name text, p_bio text, p_setup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  target_owner uuid;
  result jsonb;
begin
  if actor is null then raise exception 'Please sign in first.' using errcode = '42501'; end if;
  select user_id into target_owner from public.players where name = p_player_name for update;
  if not found then raise exception 'This profile no longer exists. Please reload.' using errcode = '40001'; end if;
  if target_owner is distinct from actor and not exists (
    select 1 from public.players where user_id = actor and is_admin is true
  ) then
    raise exception 'You can only edit your own profile.' using errcode = '42501';
  end if;
  if target_owner is null then
    raise exception 'This player needs a Discord profile before adding bio or setup.' using errcode = '22023';
  end if;

  -- Moderators edit the target user's content, never a copy on their own account.
  -- The existing validation trigger applies equally to owners and moderators.
  insert into public.player_profile_details(user_id, bio, setup)
    values (target_owner, coalesce(p_bio, ''), coalesce(p_setup, '{}'::jsonb))
    on conflict (user_id) do update set bio = excluded.bio, setup = excluded.setup;
  result := public.get_player_profile_details(p_player_name);
  if target_owner is distinct from actor then
    -- Keep the moderation event, without retaining the removed personal content.
    insert into public.audit_logs(action, admin_user, details) values (
      'MODERATE_PROFILE_DETAILS', actor::text,
      format('%s bio/setup on %s.', case when result->>'bio' = '' and result->'setup' = '{}'::jsonb
        then 'Cleared' else 'Updated' end, p_player_name)
    );
  end if;
  return result;
end $$;
revoke all on function public.update_player_profile_details(text,text,jsonb) from public, anon;
grant execute on function public.update_player_profile_details(text,text,jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
