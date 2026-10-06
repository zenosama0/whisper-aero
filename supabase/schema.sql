-- Apply in the Supabase SQL editor before enabling public sign-up.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_]{3,24}$'),
  display_name text not null check (char_length(display_name) between 1 and 48),
  about text not null default '' check (char_length(about) <= 160),
  avatar_path text,
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

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id,user_id)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 12000),
  attachment_id uuid,
  created_at timestamptz not null default now(),
  check (body <> '' or attachment_id is not null)
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
  size_bytes integer not null check (size_bytes between 1 and 3145728),
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

create or replace function public.accept_contact_request(request_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare req public.contact_requests; conv_id uuid;
begin
  select * into req from public.contact_requests where id=request_id for update;
  if req.id is null or req.receiver_id<>auth.uid() or req.status<>'pending' then raise exception 'Request is unavailable'; end if;
  insert into public.conversations default values returning id into conv_id;
  insert into public.conversation_members(conversation_id,user_id) values (conv_id,req.sender_id),(conv_id,req.receiver_id);
  update public.contact_requests set status='accepted' where id=request_id;
  return conv_id;
end $$;

create or replace function public.decline_contact_request(request_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.contact_requests set status='declined'
    where id=request_id and receiver_id=auth.uid() and status='pending';
  if not found then raise exception 'Request is unavailable'; end if;
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
revoke all on function public.create_contact_request(text) from public, anon;
revoke all on function public.accept_contact_request(uuid) from public, anon;
revoke all on function public.decline_contact_request(uuid) from public, anon;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function private.is_conversation_member(uuid) from public, anon;
grant execute on function public.create_contact_request(text) to authenticated;
grant execute on function public.accept_contact_request(uuid) to authenticated;
grant execute on function public.decline_contact_request(uuid) to authenticated;
grant execute on function private.is_conversation_member(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.contact_requests enable row level security;
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
create policy "Members view conversations" on public.conversations for select to authenticated using (private.is_conversation_member(id));
create policy "Members view membership" on public.conversation_members for select to authenticated using (private.is_conversation_member(conversation_id));
create policy "Members read messages" on public.messages for select to authenticated using (private.is_conversation_member(conversation_id));
create policy "Members send messages as self" on public.messages for insert to authenticated with check (sender_id=auth.uid() and private.is_conversation_member(conversation_id));
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
grant select on public.conversations,public.conversation_members to authenticated;
grant select,insert on public.messages to authenticated;
grant select,insert,delete on public.message_reactions to authenticated;
grant select,insert on public.attachments to authenticated;
grant select,insert on public.call_invites to authenticated;
grant select,insert,delete on public.push_subscriptions to authenticated;
revoke all on public.vapid_keyring from public, anon, authenticated;
grant select,insert,update on public.vapid_keyring to service_role;

do $$ begin
  begin alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.contact_requests;
  exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.attachments;
  exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.call_invites;
  exception when duplicate_object then null; when undefined_object then null; end;
end $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('profile-avatars','profile-avatars',false,524288,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update set file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('message-files','message-files',false,3145728,array['image/jpeg','image/png','image/webp','image/gif','application/pdf','text/plain'])
on conflict(id) do update set file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "Avatar owners upload their avatar" on storage.objects for insert to authenticated with check (bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "Avatar owners update their avatar" on storage.objects for update to authenticated using (bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text) with check (bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "Avatar owners delete their avatar" on storage.objects for delete to authenticated using (bucket_id='profile-avatars' and (storage.foldername(name))[1]=auth.uid()::text);

