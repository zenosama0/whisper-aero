-- Apply in the Supabase SQL editor or via `supabase db push` before enabling public sign-up.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 48),
  about text not null default '' check (char_length(about) <= 160),
  avatar_path text,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(),
  unique (sender_id, receiver_id),
  check (sender_id <> receiver_id)
);

create table if not exists public.blocked_users (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  dm_key text,
  created_at timestamptz not null default now()
);
create unique index if not exists conversations_dm_key_uidx on public.conversations(dm_key) where dm_key is not null;

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  is_favorite boolean not null default false,
  is_muted boolean not null default false,
  primary key (conversation_id,user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 12000),
  attachment_id uuid,
  reply_to_id uuid references public.messages(id) on delete set null,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint messages_content_or_deleted_check check (body <> '' or attachment_id is not null or deleted_at is not null)
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id,created_at);

create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  primary key (message_id,user_id,emoji)
);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  uploader_id uuid not null references public.profiles(id) on delete cascade,
  object_path text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes integer not null constraint attachments_size_bytes_check check (size_bytes between 1 and 10485760),
  is_view_once boolean not null default false,
  created_at timestamptz not null default now(),
  downloaded_at timestamptz
);
alter table public.messages drop constraint if exists messages_attachment_id_fkey;
alter table public.messages add constraint messages_attachment_id_fkey foreign key (attachment_id) references public.attachments(id) on delete set null;

create table if not exists public.call_invites (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  caller_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.vapid_keyring (
  id smallint primary key check (id=1),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);

create or replace function public.check_username_available(candidate text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select (
    lower(trim(leading '@' from coalesce(candidate, ''))) ~ '^[a-z0-9_]{3,24}$'
    and not exists (select 1 from public.profiles p where p.username = lower(trim(leading '@' from coalesce(candidate, ''))))
  );
$$;

create or replace function public.create_contact_request(target_username text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare target_id uuid; request_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select id into target_id from public.profiles where username = lower(trim(leading '@' from target_username));
  if target_id is null then raise exception 'Username not found'; end if;
  if target_id = auth.uid() then raise exception 'You cannot add yourself'; end if;
  if exists(select 1 from public.contact_requests r where r.status='accepted' and ((r.sender_id=auth.uid() and r.receiver_id=target_id) or (r.sender_id=target_id and r.receiver_id=auth.uid()))) then raise exception 'Already connected'; end if;
  insert into public.contact_requests(sender_id,receiver_id) values(auth.uid(),target_id)
    on conflict(sender_id,receiver_id) do update set status='pending',created_at=now()
    returning id into request_id;
  return request_id;
end $$;

create or replace function public.search_people(search_text text)
returns table(id uuid, username text, display_name text, about text, avatar_path text, relationship_status text, request_id uuid, conversation_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  with query_text as (
    select lower(trim(leading '@' from trim(coalesce(search_text, '')))) as value
  )
  select p.id, p.username, p.display_name, p.about, p.avatar_path,
    case
      when exists (
        select 1 from public.contact_requests r
        where r.status='accepted'
          and ((r.sender_id=auth.uid() and r.receiver_id=p.id) or (r.sender_id=p.id and r.receiver_id=auth.uid()))
      ) then 'friend'
      when exists (select 1 from public.contact_requests r where r.sender_id=auth.uid() and r.receiver_id=p.id and r.status='pending') then 'outgoing'
      when exists (select 1 from public.contact_requests r where r.sender_id=p.id and r.receiver_id=auth.uid() and r.status='pending') then 'incoming'
      when exists (select 1 from public.contact_requests r where r.sender_id=auth.uid() and r.receiver_id=p.id and r.status='declined') then 'declined'
      else 'available'
    end as relationship_status,
    coalesce(
      (select r.id from public.contact_requests r where r.sender_id=p.id and r.receiver_id=auth.uid() and r.status='pending' order by r.created_at desc limit 1),
      (select r.id from public.contact_requests r where r.sender_id=auth.uid() and r.receiver_id=p.id and r.status='pending' order by r.created_at desc limit 1)
    ) as request_id,
    case
      when exists (
        select 1 from public.contact_requests r
        where r.status='accepted'
          and ((r.sender_id=auth.uid() and r.receiver_id=p.id) or (r.sender_id=p.id and r.receiver_id=auth.uid()))
      ) then coalesce(
        (select c.id from public.conversations c where c.dm_key = least(auth.uid()::text, p.id::text) || ':' || greatest(auth.uid()::text, p.id::text) limit 1),
        (select cm1.conversation_id from public.conversation_members cm1 join public.conversation_members cm2 on cm1.conversation_id=cm2.conversation_id where cm1.user_id=auth.uid() and cm2.user_id=p.id limit 1)
      )
      else null
    end as conversation_id
  from public.profiles p cross join query_text q
  where auth.uid() is not null and p.id<>auth.uid() and char_length(q.value)>=2
    and (strpos(lower(p.username),q.value)>0 or strpos(lower(p.display_name),q.value)>0)
    and not exists (select 1 from public.blocked_users b where (b.blocker_id=auth.uid() and b.blocked_id=p.id) or (b.blocker_id=p.id and b.blocked_id=auth.uid()))
  order by (lower(p.username)=q.value) desc, p.username
  limit 25;
$$;

create or replace function public.send_friend_request(target_user uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare actor_id uuid := auth.uid(); v_dm_key text; v_conv_id uuid; v_req_id uuid;
begin
  if actor_id is null then raise exception 'Sign in required'; end if;
  if target_user is null or not exists(select 1 from public.profiles p where p.id=target_user) then raise exception 'Person not found'; end if;
  if target_user=actor_id then raise exception 'You cannot add yourself'; end if;
  if exists(select 1 from public.blocked_users b where (b.blocker_id=actor_id and b.blocked_id=target_user) or (b.blocker_id=target_user and b.blocked_id=actor_id)) then raise exception 'Unable to send friend request to this user'; end if;
  v_dm_key := least(actor_id::text, target_user::text) || ':' || greatest(actor_id::text, target_user::text);
  if exists(select 1 from public.contact_requests r where r.status='accepted' and ((r.sender_id=actor_id and r.receiver_id=target_user) or (r.sender_id=target_user and r.receiver_id=actor_id))) then
    insert into public.conversations(dm_key) values (v_dm_key) on conflict (dm_key) do nothing;
    select id into v_conv_id from public.conversations where dm_key = v_dm_key;
    insert into public.conversation_members(conversation_id,user_id) values (v_conv_id,actor_id),(v_conv_id,target_user) on conflict do nothing;
    return jsonb_build_object('status','already_friends','conversation_id',v_conv_id);
  end if;
  select r.id into v_req_id from public.contact_requests r where r.sender_id=target_user and r.receiver_id=actor_id and r.status='pending' for update;
  if v_req_id is not null then
    insert into public.conversations(dm_key) values (v_dm_key) on conflict (dm_key) do nothing;
    select id into v_conv_id from public.conversations where dm_key = v_dm_key;
    insert into public.conversation_members(conversation_id,user_id) values (v_conv_id,actor_id),(v_conv_id,target_user) on conflict do nothing;
    update public.contact_requests set status='accepted' where id=v_req_id;
    return jsonb_build_object('status','accepted','request_id',v_req_id,'conversation_id',v_conv_id);
  end if;
  insert into public.contact_requests(sender_id,receiver_id,status) values(actor_id,target_user,'pending')
    on conflict(sender_id,receiver_id) do update set status='pending',created_at=now()
    returning id into v_req_id;
  return jsonb_build_object('status','sent','request_id',v_req_id);
end $$;

create or replace function public.accept_contact_request(request_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare req public.contact_requests; conv_id uuid; v_dm_key text;
begin
  select * into req from public.contact_requests where id=request_id for update;
  if req.id is null or req.receiver_id<>auth.uid() or req.status<>'pending' then raise exception 'Request is unavailable'; end if;
  v_dm_key := least(req.sender_id::text, req.receiver_id::text) || ':' || greatest(req.sender_id::text, req.receiver_id::text);
  select id into conv_id from public.conversations where dm_key = v_dm_key;
  if conv_id is null then
    select cm1.conversation_id into conv_id from public.conversation_members cm1 join public.conversation_members cm2 on cm1.conversation_id=cm2.conversation_id where cm1.user_id=req.sender_id and cm2.user_id=req.receiver_id limit 1;
    if conv_id is not null then update public.conversations set dm_key=v_dm_key where id=conv_id and dm_key is null; end if;
  end if;
  if conv_id is null then
    insert into public.conversations(dm_key) values (v_dm_key) on conflict (dm_key) do nothing;
    select id into conv_id from public.conversations where dm_key = v_dm_key;
  end if;
  insert into public.conversation_members(conversation_id,user_id) values (conv_id,req.sender_id),(conv_id,req.receiver_id) on conflict do nothing;
  update public.contact_requests set status='accepted' where id=request_id;
  delete from public.contact_requests where sender_id=req.receiver_id and receiver_id=req.sender_id and status='pending';
  return conv_id;
end $$;

create or replace function public.decline_contact_request(request_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.contact_requests set status='declined'
    where id=request_id and receiver_id=auth.uid() and status='pending';
  if not found then raise exception 'Request is unavailable'; end if;
end $$;

create or replace function public.cancel_friend_request(request_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.contact_requests where id=request_id and sender_id=auth.uid() and status='pending';
  if not found then raise exception 'Request is unavailable'; end if;
end $$;

create or replace function public.remove_friend(peer_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  delete from public.contact_requests where status='accepted' and ((sender_id=auth.uid() and receiver_id=peer_id) or (sender_id=peer_id and receiver_id=auth.uid()));
end $$;

create or replace function public.block_user(peer_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if peer_id is null or peer_id=auth.uid() then raise exception 'Invalid user'; end if;
  insert into public.blocked_users(blocker_id,blocked_id) values (auth.uid(),peer_id) on conflict do nothing;
  delete from public.contact_requests where (sender_id=auth.uid() and receiver_id=peer_id) or (sender_id=peer_id and receiver_id=auth.uid());
end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare clean_name text;
begin
  clean_name := lower(coalesce(new.raw_user_meta_data->>'username',''));
  if clean_name !~ '^[a-z0-9_]{3,24}$' then raise exception 'Username must be 3–24 lowercase letters, numbers, or underscores'; end if;
  insert into public.profiles(id,username,display_name)
  values(new.id,clean_name,coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'),''),clean_name));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create or replace function private.is_conversation_member(target_conversation uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.conversation_members where conversation_id=target_conversation and user_id=auth.uid());
$$;
revoke all on function public.check_username_available(text) from public;
revoke all on function public.create_contact_request(text) from public, anon;
revoke all on function public.search_people(text) from public, anon;
revoke all on function public.send_friend_request(uuid) from public, anon;
revoke all on function public.accept_contact_request(uuid) from public, anon;
revoke all on function public.decline_contact_request(uuid) from public, anon;
revoke all on function public.cancel_friend_request(uuid) from public, anon;
revoke all on function public.remove_friend(uuid) from public, anon;
revoke all on function public.block_user(uuid) from public, anon;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function private.is_conversation_member(uuid) from public, anon;
grant execute on function public.check_username_available(text) to anon, authenticated;
grant execute on function public.create_contact_request(text) to authenticated;
grant execute on function public.search_people(text) to authenticated;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.accept_contact_request(uuid) to authenticated;
grant execute on function public.decline_contact_request(uuid) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function private.is_conversation_member(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.contact_requests enable row level security;
alter table public.blocked_users enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reactions enable row level security;
alter table public.attachments enable row level security;
alter table public.call_invites enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.vapid_keyring enable row level security;

create policy "Authenticated users can find usernames" on public.profiles for select to authenticated using (true);
create policy "Users update own profile" on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid());
create policy "Participants view requests" on public.contact_requests for select to authenticated using (auth.uid() in (sender_id,receiver_id));
create policy "Sender creates own request" on public.contact_requests for insert to authenticated with check (sender_id=auth.uid() and status='pending');
create policy "Users view own blocks" on public.blocked_users for select to authenticated using (blocker_id=auth.uid());
create policy "Users insert own blocks" on public.blocked_users for insert to authenticated with check (blocker_id=auth.uid());
create policy "Users delete own blocks" on public.blocked_users for delete to authenticated using (blocker_id=auth.uid());
create policy "Members view conversations" on public.conversations for select to authenticated using (private.is_conversation_member(id));
create policy "Members view membership" on public.conversation_members for select to authenticated using (private.is_conversation_member(conversation_id));
create policy "Members update own membership settings" on public.conversation_members for update to authenticated using (user_id=auth.uid()) with check (user_id=auth.uid());
create policy "Members read messages" on public.messages for select to authenticated using (private.is_conversation_member(conversation_id));
create policy "Members send messages as self" on public.messages for insert to authenticated with check (sender_id=auth.uid() and private.is_conversation_member(conversation_id));
create policy "Members edit own messages" on public.messages for update to authenticated using (sender_id=auth.uid() and private.is_conversation_member(conversation_id)) with check (sender_id=auth.uid() and private.is_conversation_member(conversation_id));
create policy "Members read reactions" on public.message_reactions for select to authenticated using (exists(select 1 from public.messages x where x.id=message_id and private.is_conversation_member(x.conversation_id)));
create policy "Users add own reactions" on public.message_reactions for insert to authenticated with check (user_id=auth.uid() and exists(select 1 from public.messages x where x.id=message_id and private.is_conversation_member(x.conversation_id)));
create policy "Users remove own reactions" on public.message_reactions for delete to authenticated using (user_id=auth.uid());
create policy "Members view attachment metadata" on public.attachments for select to authenticated using (private.is_conversation_member(conversation_id));
create policy "Members add attachment metadata as self" on public.attachments for insert to authenticated with check (uploader_id=auth.uid() and private.is_conversation_member(conversation_id));
create policy "Members view call invites" on public.call_invites for select to authenticated using (private.is_conversation_member(conversation_id));
create policy "Members start calls as self" on public.call_invites for insert to authenticated with check (caller_id=auth.uid() and private.is_conversation_member(conversation_id));
create policy "Users view own push subscriptions" on public.push_subscriptions for select to authenticated using (user_id=auth.uid());
create policy "Users add own push subscriptions" on public.push_subscriptions for insert to authenticated with check (user_id=auth.uid());
create policy "Users remove own push subscriptions" on public.push_subscriptions for delete to authenticated using (user_id=auth.uid());

grant select,update on public.profiles to authenticated;
grant select,insert on public.contact_requests to authenticated;
grant select,insert,delete on public.blocked_users to authenticated;
grant select on public.conversations,public.conversation_members to authenticated;
grant update (last_read_at,is_favorite,is_muted) on public.conversation_members to authenticated;
grant select,insert on public.messages to authenticated;
grant update (body,edited_at,deleted_at) on public.messages to authenticated;
grant select,insert,delete on public.message_reactions to authenticated;
grant select,insert on public.attachments to authenticated;
grant select,insert on public.call_invites to authenticated;
grant select,insert,delete on public.push_subscriptions to authenticated;
revoke all on public.vapid_keyring from public, anon, authenticated;
grant select,insert,update on public.vapid_keyring to service_role;

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

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('profile-avatars','profile-avatars',false,524288,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update set file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('message-files','message-files',false,10485760,array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','video/quicktime','audio/mpeg','audio/webm','audio/ogg','application/pdf','text/plain'])
on conflict(id) do update set file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "Authenticated users view avatars" on storage.objects for select to authenticated using (bucket_id='profile-avatars');
create policy "Avatar owners upload their avatar" on storage.objects for insert to authenticated with check (bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "Avatar owners update their avatar" on storage.objects for update to authenticated using (bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text) with check (bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "Avatar owners delete their avatar" on storage.objects for delete to authenticated using (bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text);
