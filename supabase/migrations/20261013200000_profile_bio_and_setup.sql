begin;

-- Personal content follows the Discord user, not a claimable Workshop name.
-- This table is deliberately inaccessible through the public table API.
create table if not exists public.player_profile_details (
  user_id uuid primary key references auth.users(id) on delete cascade,
  bio text not null default '',
  setup jsonb not null default '{}',
  constraint profile_bio_length check (char_length(bio) <= 500),
  constraint profile_setup_object check (jsonb_typeof(setup) = 'object')
);
alter table public.player_profile_details enable row level security;
revoke all on public.player_profile_details from public, anon, authenticated;

create or replace function public.validate_player_profile_details()
returns trigger language plpgsql set search_path = '' as $$
declare item record; max_length integer;
begin
  new.bio := btrim(new.bio);
  if char_length(new.bio) > 500 then
    raise exception 'Bio must be 500 characters or fewer.' using errcode = '22023';
  end if;
  if jsonb_typeof(new.setup) is distinct from 'object' then
    raise exception 'Setup must be an object.' using errcode = '22023';
  end if;
  for item in select key, value from jsonb_each(new.setup) loop
    max_length := case
      when item.key in ('mouse','mousepad','keyboard','monitor','dpi','sensitivity','scoped_sensitivity') then 120
      when item.key = 'crosshair' then 500
      when item.key = 'settings' then 1000
      else null end;
    if max_length is null or jsonb_typeof(item.value) <> 'string' then
      raise exception 'Invalid setup field or value.' using errcode = '22023';
    end if;
    if char_length(item.value #>> '{}') > max_length then
      raise exception 'Setup field % exceeds % characters.', item.key, max_length using errcode = '22023';
    end if;
    if btrim(item.value #>> '{}') = '' then
      new.setup := new.setup - item.key;
    else
      new.setup := jsonb_set(new.setup, array[item.key], to_jsonb(btrim(item.value #>> '{}')));
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.validate_player_profile_details() from public, anon, authenticated;
drop trigger if exists validate_player_profile_details on public.player_profile_details;
create trigger validate_player_profile_details before insert or update on public.player_profile_details
  for each row execute function public.validate_player_profile_details();

create or replace function public.get_player_profile_details(p_player_name text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('bio', coalesce(d.bio, ''), 'setup', coalesce(d.setup, '{}'::jsonb))
  from public.players p left join public.player_profile_details d on d.user_id = p.user_id
  where p.name = p_player_name;
$$;
revoke all on function public.get_player_profile_details(text) from public;
grant execute on function public.get_player_profile_details(text) to anon, authenticated;

create or replace function public.update_player_profile_details(p_player_name text, p_bio text, p_setup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Please sign in first.' using errcode = '42501'; end if;
  -- Hold the owned player row until the save completes, including during a rename/merge.
  perform 1 from public.players where name = p_player_name and user_id = actor for update;
  if not found then raise exception 'You can only edit your own profile.' using errcode = '42501'; end if;
  insert into public.player_profile_details(user_id, bio, setup)
    values (actor, coalesce(p_bio, ''), coalesce(p_setup, '{}'::jsonb))
    on conflict (user_id) do update set bio = excluded.bio, setup = excluded.setup;
  return public.get_player_profile_details(p_player_name);
end $$;
revoke all on function public.update_player_profile_details(text,text,jsonb) from public, anon;
grant execute on function public.update_player_profile_details(text,text,jsonb) to authenticated;

-- A stats reset keeps personal content. Deleting the user's last player profile
-- removes it; merging two profiles belonging to that same user keeps it.
create or replace function public.cleanup_player_profile_details()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.user_id is not null and not exists (select 1 from public.players where user_id = old.user_id) then
    delete from public.player_profile_details where user_id = old.user_id;
  end if;
  return old;
end $$;
revoke all on function public.cleanup_player_profile_details() from public, anon, authenticated;
drop trigger if exists cleanup_player_profile_details on public.players;
create trigger cleanup_player_profile_details after delete on public.players
  for each row execute function public.cleanup_player_profile_details();

notify pgrst, 'reload schema';
commit;
