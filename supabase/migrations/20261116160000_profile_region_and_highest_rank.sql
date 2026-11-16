-- Validate structured Overwatch region and highest rank fields on player profiles.
begin;

create or replace function public.validate_player_profile_details()
returns trigger language plpgsql set search_path = '' as $$
declare
  item record;
  max_length integer;
  trimmed text;
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
      when item.key in ('region','highest_rank','highest_rank_division','highest_rank_role','highest_rank_season') then 40
      else null end;
    if max_length is null or jsonb_typeof(item.value) <> 'string' then
      raise exception 'Invalid setup field or value.' using errcode = '22023';
    end if;
    if char_length(item.value #>> '{}') > max_length then
      raise exception 'Setup field % exceeds % characters.', item.key, max_length using errcode = '22023';
    end if;
    trimmed := btrim(item.value #>> '{}');
    if trimmed = '' then
      new.setup := new.setup - item.key;
    else
      if item.key = 'region' and trimmed not in ('EU', 'NA', 'ASIA', 'SA', 'OCE', 'MENA') then
        raise exception 'Invalid region value.' using errcode = '22023';
      elsif item.key = 'highest_rank' and trimmed not in ('Top 500', 'Champion', 'Grandmaster', 'Master', 'Diamond', 'Platinum', 'Gold', 'Silver', 'Bronze') then
        raise exception 'Invalid highest rank tier.' using errcode = '22023';
      elsif item.key = 'highest_rank_division' and trimmed not in ('1', '2', '3', '4', '5') then
        raise exception 'Invalid highest rank division.' using errcode = '22023';
      elsif item.key = 'highest_rank_role' and trimmed not in ('DPS', 'Tank', 'Support') then
        raise exception 'Invalid highest rank role.' using errcode = '22023';
      elsif item.key = 'highest_rank_season' and trimmed !~ '^(OW2 S([1-9]|1[0-9]|2[0-5])|OW1 S([1-9]|[12][0-9]|3[0-6]))$' then
        raise exception 'Invalid highest rank season.' using errcode = '22023';
      end if;
      new.setup := jsonb_set(new.setup, array[item.key], to_jsonb(trimmed));
    end if;
  end loop;

  if not (new.setup ? 'highest_rank') and (
    new.setup ? 'highest_rank_division'
    or new.setup ? 'highest_rank_role'
    or new.setup ? 'highest_rank_season'
  ) then
    raise exception 'Highest rank division, role, or season requires a rank tier.' using errcode = '22023';
  end if;
  if (new.setup ->> 'highest_rank') = 'Top 500' and new.setup ? 'highest_rank_division' then
    raise exception 'Top 500 does not have a rank division.' using errcode = '22023';
  end if;

  return new;
end $$;
revoke all on function public.validate_player_profile_details() from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
