-- Postgres ON CONFLICT (dm_key) requires a non-partial unique index or constraint.
-- Multiple NULL values are still allowed in a standard unique index.
drop index if exists public.conversations_dm_key_uidx;
create unique index conversations_dm_key_uidx on public.conversations(dm_key);
