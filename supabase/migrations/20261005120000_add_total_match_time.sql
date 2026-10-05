-- Old eight-column imports have no known total duration and remain NULL.
alter table public.player_matches
  add column if not exists total_match_time integer;

comment on column public.player_matches.total_match_time is
  'Total match duration in seconds from the CSV/TXT export; NULL for legacy imports.';
