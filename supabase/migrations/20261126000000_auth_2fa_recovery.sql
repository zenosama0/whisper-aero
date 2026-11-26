-- Auth upgrade: OAuth-safe handle_new_user trigger, hashed single-use recovery backup codes,
-- and rate-limited zero-email password recovery lookup.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  raw_username text;
  base_name text;
  candidate text;
  display text;
begin
  raw_username := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  if raw_username ~ '^[a-z0-9_]{3,24}$' then
    candidate := raw_username;
  else
    base_name := regexp_replace(
      lower(coalesce(
        nullif(new.raw_user_meta_data->>'preferred_username', ''),
        nullif(new.raw_user_meta_data->>'full_name', ''),
        nullif(new.raw_user_meta_data->>'name', ''),
        split_part(coalesce(new.email, ''), '@', 1),
        'user'
      )),
      '[^a-z0-9_]',
      '',
      'g'
    );
    if char_length(base_name) < 3 then
      base_name := left(base_name || 'whisper', 8);
    end if;
    base_name := left(base_name, 18);
    candidate := base_name;
    while exists (select 1 from public.profiles p where p.username = candidate) loop
      candidate := left(base_name, 18) || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 5);
    end loop;
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    candidate
  );

  insert into public.profiles (id, username, display_name)
  values (new.id, candidate, left(display, 48))
  on conflict (id) do nothing;

  return new;
end;
$$;

create table if not exists public.user_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);

create index if not exists user_recovery_codes_unused_idx
  on public.user_recovery_codes(user_id)
  where used_at is null;

alter table public.user_recovery_codes enable row level security;
revoke all on public.user_recovery_codes from public, anon, authenticated;
grant all on public.user_recovery_codes to service_role;

create table if not exists public.recovery_attempts (
  identifier text primary key,
  attempts integer not null default 0,
  window_started_at timestamptz not null default now()
);

alter table public.recovery_attempts enable row level security;
revoke all on public.recovery_attempts from public, anon, authenticated;
grant all on public.recovery_attempts to service_role;

create or replace function public.find_user_id_by_identifier(p_identifier text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  clean text := lower(trim(coalesce(p_identifier, '')));
  clean_user text := trim(leading '@' from clean);
  found_id uuid;
begin
  if clean = '' then
    return null;
  end if;

  if position('@' in clean) > 1 then
    select u.id into found_id
    from auth.users u
    where lower(coalesce(u.email, '')) = clean
    limit 1;
    if found_id is not null then
      return found_id;
    end if;
  end if;

  select p.id into found_id
  from public.profiles p
  where p.username = clean_user
  limit 1;

  return found_id;
end;
$$;

revoke all on function public.find_user_id_by_identifier(text) from public, anon, authenticated;
grant execute on function public.find_user_id_by_identifier(text) to service_role;
