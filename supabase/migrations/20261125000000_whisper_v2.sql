-- Whisper Aero v2 Migration: friend fixes, deduplicated DMs, read/favorite metadata,
-- message replies/edits/deletes, persistent & view-once attachments, blocks, and realtime.

create extension if not exists pgcrypto;

-- 1. Profiles & Username availability + Avatar SELECT policy
alter table public.profiles
  add column if not exists last_seen_at timestamptz not null default now();

create or replace function public.check_username_available(candidate text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    lower(trim(leading '@' from coalesce(candidate, ''))) ~ '^[a-z0-9_]{3,24}$'
    and not exists (
      select 1
      from public.profiles p
      where p.username = lower(trim(leading '@' from coalesce(candidate, '')))
    )
  );
$$;

revoke all on function public.check_username_available(text) from public;
grant execute on function public.check_username_available(text) to anon, authenticated;

drop policy if exists "Authenticated users view avatars" on storage.objects;
create policy "Authenticated users view avatars"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'profile-avatars');

-- 2. Deduplicated 1-on-1 conversations & member metadata
alter table public.conversations
  add column if not exists dm_key text;

with pairs as (
  select
    c.id,
    min(cm.user_id::text) || ':' || max(cm.user_id::text) as computed_key,
    row_number() over (
      partition by min(cm.user_id::text), max(cm.user_id::text)
      order by c.created_at asc, c.id asc
    ) as rn
  from public.conversations c
  join public.conversation_members cm on cm.conversation_id = c.id
  group by c.id, c.created_at
  having count(*) = 2
)
update public.conversations c
set dm_key = p.computed_key
from pairs p
where c.id = p.id
  and p.rn = 1
  and c.dm_key is null
  and not exists (
    select 1 from public.conversations c2 where c2.dm_key = p.computed_key
  );

create unique index if not exists conversations_dm_key_uidx
  on public.conversations(dm_key)
  where dm_key is not null;

alter table public.conversation_members
  add column if not exists last_read_at timestamptz not null default now(),
  add column if not exists is_favorite boolean not null default false,
  add column if not exists is_muted boolean not null default false;

drop policy if exists "Members update own membership settings" on public.conversation_members;
create policy "Members update own membership settings"
  on public.conversation_members for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant update (last_read_at, is_favorite, is_muted) on public.conversation_members to authenticated;

-- 3. Blocked users & Friend-adding fixes
create table if not exists public.blocked_users (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

alter table public.blocked_users enable row level security;

drop policy if exists "Users view own blocks" on public.blocked_users;
create policy "Users view own blocks"
  on public.blocked_users for select
  to authenticated
  using (blocker_id = auth.uid());

drop policy if exists "Users insert own blocks" on public.blocked_users;
create policy "Users insert own blocks"
  on public.blocked_users for insert
  to authenticated
  with check (blocker_id = auth.uid());

drop policy if exists "Users delete own blocks" on public.blocked_users;
create policy "Users delete own blocks"
  on public.blocked_users for delete
  to authenticated
  using (blocker_id = auth.uid());

grant select, insert, delete on public.blocked_users to authenticated;

drop function if exists public.search_people(text);
create or replace function public.search_people(search_text text)
returns table(
  id uuid,
  username text,
  display_name text,
  about text,
  avatar_path text,
  relationship_status text,
  request_id uuid,
  conversation_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with query_text as (
    select lower(trim(leading '@' from trim(coalesce(search_text, '')))) as value
  )
  select
    p.id,
    p.username,
    p.display_name,
    p.about,
    p.avatar_path,
    case
      when exists (
        select 1 from public.contact_requests r
        where r.status = 'accepted'
          and ((r.sender_id = auth.uid() and r.receiver_id = p.id) or (r.sender_id = p.id and r.receiver_id = auth.uid()))
      ) then 'friend'
      when exists (
        select 1 from public.contact_requests r
        where r.sender_id = auth.uid() and r.receiver_id = p.id and r.status = 'pending'
      ) then 'outgoing'
      when exists (
        select 1 from public.contact_requests r
        where r.sender_id = p.id and r.receiver_id = auth.uid() and r.status = 'pending'
      ) then 'incoming'
      when exists (
        select 1 from public.contact_requests r
        where r.sender_id = auth.uid() and r.receiver_id = p.id and r.status = 'declined'
      ) then 'declined'
      else 'available'
    end as relationship_status,
    coalesce(
      (
        select r.id from public.contact_requests r
        where r.sender_id = p.id and r.receiver_id = auth.uid() and r.status = 'pending'
        order by r.created_at desc limit 1
      ),
      (
        select r.id from public.contact_requests r
        where r.sender_id = auth.uid() and r.receiver_id = p.id and r.status = 'pending'
        order by r.created_at desc limit 1
      )
    ) as request_id,
    case
      when exists (
        select 1 from public.contact_requests r
        where r.status = 'accepted'
          and ((r.sender_id = auth.uid() and r.receiver_id = p.id) or (r.sender_id = p.id and r.receiver_id = auth.uid()))
      ) then coalesce(
        (
          select c.id from public.conversations c
          where c.dm_key = least(auth.uid()::text, p.id::text) || ':' || greatest(auth.uid()::text, p.id::text)
          limit 1
        ),
        (
          select cm1.conversation_id
          from public.conversation_members cm1
          join public.conversation_members cm2 on cm1.conversation_id = cm2.conversation_id
          where cm1.user_id = auth.uid() and cm2.user_id = p.id
          limit 1
        )
      )
      else null
    end as conversation_id
  from public.profiles p
  cross join query_text q
  where auth.uid() is not null
    and p.id <> auth.uid()
    and char_length(q.value) >= 2
    and (strpos(lower(p.username), q.value) > 0 or strpos(lower(p.display_name), q.value) > 0)
    and not exists (
      select 1 from public.blocked_users b
      where (b.blocker_id = auth.uid() and b.blocked_id = p.id)
         or (b.blocker_id = p.id and b.blocked_id = auth.uid())
    )
  order by (lower(p.username) = q.value) desc, p.username
  limit 25;
$$;

drop function if exists public.send_friend_request(uuid);
create or replace function public.send_friend_request(target_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  v_dm_key text;
  v_conv_id uuid;
  v_req_id uuid;
begin
  if actor_id is null then
    raise exception 'Sign in required';
  end if;
  if target_user is null or not exists (select 1 from public.profiles p where p.id = target_user) then
    raise exception 'Person not found';
  end if;
  if target_user = actor_id then
    raise exception 'You cannot add yourself';
  end if;
  if exists (
    select 1 from public.blocked_users b
    where (b.blocker_id = actor_id and b.blocked_id = target_user)
       or (b.blocker_id = target_user and b.blocked_id = actor_id)
  ) then
    raise exception 'Unable to send friend request to this user';
  end if;

  v_dm_key := least(actor_id::text, target_user::text) || ':' || greatest(actor_id::text, target_user::text);

  if exists (
    select 1 from public.contact_requests r
    where r.status = 'accepted'
      and ((r.sender_id = actor_id and r.receiver_id = target_user)
        or (r.sender_id = target_user and r.receiver_id = actor_id))
  ) then
    insert into public.conversations(dm_key) values (v_dm_key) on conflict (dm_key) do nothing;
    select id into v_conv_id from public.conversations where dm_key = v_dm_key;
    insert into public.conversation_members(conversation_id, user_id)
    values (v_conv_id, actor_id), (v_conv_id, target_user)
    on conflict do nothing;
    return jsonb_build_object('status', 'already_friends', 'conversation_id', v_conv_id);
  end if;

  select r.id into v_req_id
  from public.contact_requests r
  where r.sender_id = target_user and r.receiver_id = actor_id and r.status = 'pending'
  for update;

  if v_req_id is not null then
    insert into public.conversations(dm_key) values (v_dm_key) on conflict (dm_key) do nothing;
    select id into v_conv_id from public.conversations where dm_key = v_dm_key;
    insert into public.conversation_members(conversation_id, user_id)
    values (v_conv_id, actor_id), (v_conv_id, target_user)
    on conflict do nothing;
    update public.contact_requests set status = 'accepted' where id = v_req_id;
    return jsonb_build_object('status', 'accepted', 'request_id', v_req_id, 'conversation_id', v_conv_id);
  end if;

  insert into public.contact_requests(sender_id, receiver_id, status)
  values (actor_id, target_user, 'pending')
  on conflict (sender_id, receiver_id)
  do update set status = 'pending', created_at = now()
  returning id into v_req_id;

  return jsonb_build_object('status', 'sent', 'request_id', v_req_id);
end;
$$;

create or replace function public.accept_contact_request(request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  req public.contact_requests;
  conv_id uuid;
  v_dm_key text;
begin
  select * into req from public.contact_requests where id = request_id for update;
  if req.id is null or req.receiver_id <> auth.uid() or req.status <> 'pending' then
    raise exception 'Request is unavailable';
  end if;

  v_dm_key := least(req.sender_id::text, req.receiver_id::text) || ':' || greatest(req.sender_id::text, req.receiver_id::text);

  select id into conv_id from public.conversations where dm_key = v_dm_key;
  if conv_id is null then
    select cm1.conversation_id into conv_id
    from public.conversation_members cm1
    join public.conversation_members cm2 on cm1.conversation_id = cm2.conversation_id
    where cm1.user_id = req.sender_id and cm2.user_id = req.receiver_id
    limit 1;
    if conv_id is not null then
      update public.conversations set dm_key = v_dm_key where id = conv_id and dm_key is null;
    end if;
  end if;

  if conv_id is null then
    insert into public.conversations(dm_key) values (v_dm_key) on conflict (dm_key) do nothing;
    select id into conv_id from public.conversations where dm_key = v_dm_key;
  end if;

  insert into public.conversation_members(conversation_id, user_id)
  values (conv_id, req.sender_id), (conv_id, req.receiver_id)
  on conflict do nothing;

  update public.contact_requests set status = 'accepted' where id = request_id;
  delete from public.contact_requests
  where sender_id = req.receiver_id and receiver_id = req.sender_id and status = 'pending';

  return conv_id;
end;
$$;

create or replace function public.cancel_friend_request(request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.contact_requests
  where id = request_id and sender_id = auth.uid() and status = 'pending';
  if not found then
    raise exception 'Request is unavailable';
  end if;
end;
$$;

create or replace function public.remove_friend(peer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  delete from public.contact_requests
  where status = 'accepted'
    and ((sender_id = auth.uid() and receiver_id = peer_id)
      or (sender_id = peer_id and receiver_id = auth.uid()));
end;
$$;

create or replace function public.block_user(peer_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  if peer_id is null or peer_id = auth.uid() then
    raise exception 'Invalid user';
  end if;
  insert into public.blocked_users(blocker_id, blocked_id)
  values (auth.uid(), peer_id)
  on conflict do nothing;

  delete from public.contact_requests
  where (sender_id = auth.uid() and receiver_id = peer_id)
     or (sender_id = peer_id and receiver_id = auth.uid());
end;
$$;

revoke all on function public.search_people(text) from public, anon;
revoke all on function public.send_friend_request(uuid) from public, anon;
revoke all on function public.accept_contact_request(uuid) from public, anon;
revoke all on function public.cancel_friend_request(uuid) from public, anon;
revoke all on function public.remove_friend(uuid) from public, anon;
revoke all on function public.block_user(uuid) from public, anon;

grant execute on function public.search_people(text) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.accept_contact_request(uuid) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;

-- 4. Messages (replies, edits, soft-deletes) & Attachments (persistent + view-once, 10 MB)
alter table public.messages
  add column if not exists reply_to_id uuid references public.messages(id) on delete set null,
  add column if not exists edited_at timestamptz,
  add column if not exists deleted_at timestamptz;

alter table public.messages drop constraint if exists messages_check;
alter table public.messages drop constraint if exists messages_content_or_deleted_check;
alter table public.messages
  add constraint messages_content_or_deleted_check
  check (body <> '' or attachment_id is not null or deleted_at is not null);

drop policy if exists "Members edit own messages" on public.messages;
create policy "Members edit own messages"
  on public.messages for update
  to authenticated
  using (sender_id = auth.uid() and private.is_conversation_member(conversation_id))
  with check (sender_id = auth.uid() and private.is_conversation_member(conversation_id));

grant update (body, edited_at, deleted_at) on public.messages to authenticated;

alter table public.attachments
  add column if not exists is_view_once boolean not null default false;

alter table public.attachments drop constraint if exists attachments_size_bytes_check;
alter table public.attachments
  add constraint attachments_size_bytes_check check (size_bytes between 1 and 10485760);

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-files',
  'message-files',
  false,
  10485760,
  array[
    'image/jpeg','image/png','image/webp','image/gif',
    'video/mp4','video/webm','video/quicktime',
    'audio/mpeg','audio/webm','audio/ogg',
    'application/pdf','text/plain'
  ]
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 5. Realtime publication & replica identity
alter table public.contact_requests replica identity full;
alter table public.message_reactions replica identity full;

do $$ begin
  begin alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.contact_requests;
  exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.attachments;
  exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.call_invites;
  exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.message_reactions;
  exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.conversation_members;
  exception when duplicate_object then null; when undefined_object then null; end;
end $$;
