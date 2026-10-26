-- Poker Ledger schema. Run once in Supabase: SQL Editor → New query → paste → Run.
-- Reading needs the viewer keyword (or the admin login). Only users listed in public.admins can write.

create table if not exists public.players (
  id         text primary key,
  name       text not null check (length(trim(name)) > 0),
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint
);

create table if not exists public.games (
  id         text primary key,
  date       date not null default current_date,
  title      text not null default '',
  buy_in     numeric(10,2) not null default 20 check (buy_in > 0),
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  -- { "<player id>": { "buyIns": [50, 50], "cashOut": 93.5 | null }, ... }
  entries    jsonb not null default '{}'::jsonb
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.players enable row level security;
alter table public.games   enable row level security;
alter table public.admins  enable row level security;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Viewer keyword: friends send it in the x-ledger-pass header. Only its hash is stored,
-- in a schema the API can't reach. To change it, re-run the insert with the new word.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.settings (
  key   text primary key,
  value text not null
);
insert into private.settings (key, value)
values ('viewer_keyword_sha256', encode(extensions.digest('rug', 'sha256'), 'hex'))
on conflict (key) do update set value = excluded.value;

create or replace function public.has_viewer_pass()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    encode(extensions.digest(lower(coalesce(current_setting('request.headers', true)::json->>'x-ledger-pass', '')), 'sha256'), 'hex')
      = (select value from private.settings where key = 'viewer_keyword_sha256'),
    false);
$$;
revoke execute on function public.has_viewer_pass() from public;
grant execute on function public.has_viewer_pass() to anon, authenticated;

grant select on public.players, public.games to anon, authenticated;
grant insert, update, delete on public.players, public.games to authenticated;
grant select on public.admins to authenticated;

-- players
drop policy if exists "Anyone can read players" on public.players;
drop policy if exists "Friends with the keyword can read players" on public.players;
drop policy if exists "Signed-in readers need the keyword or admin" on public.players;
drop policy if exists "Admins can add players" on public.players;
drop policy if exists "Admins can edit players" on public.players;
drop policy if exists "Admins can delete players" on public.players;
create policy "Friends with the keyword can read players" on public.players for select to anon using (public.has_viewer_pass());
create policy "Signed-in readers need the keyword or admin" on public.players for select to authenticated using (public.has_viewer_pass() or public.is_admin());
create policy "Admins can add players"    on public.players for insert to authenticated with check (public.is_admin());
create policy "Admins can edit players"   on public.players for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins can delete players" on public.players for delete to authenticated using (public.is_admin());

-- games
drop policy if exists "Anyone can read games" on public.games;
drop policy if exists "Friends with the keyword can read games" on public.games;
drop policy if exists "Signed-in readers need the keyword or admin" on public.games;
drop policy if exists "Admins can add games" on public.games;
drop policy if exists "Admins can edit games" on public.games;
drop policy if exists "Admins can delete games" on public.games;
create policy "Friends with the keyword can read games" on public.games for select to anon using (public.has_viewer_pass());
create policy "Signed-in readers need the keyword or admin" on public.games for select to authenticated using (public.has_viewer_pass() or public.is_admin());
create policy "Admins can add games"    on public.games for insert to authenticated with check (public.is_admin());
create policy "Admins can edit games"   on public.games for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins can delete games" on public.games for delete to authenticated using (public.is_admin());

-- admins: a signed-in user can only see their own row. There are no write policies,
-- so the list can only be changed from the Supabase dashboard / SQL editor.
drop policy if exists "Users can see their own admin row" on public.admins;
create policy "Users can see their own admin row" on public.admins for select to authenticated using (user_id = auth.uid());

-- Online poker tables (Play tab). The state holds the deck and everyone's hole cards, so only the
-- "poker" edge function (supabase/functions/poker) may touch it: RLS on, no policies, no grants.
create table if not exists public.poker_tables (
  id         text primary key,
  state      jsonb not null,
  version    integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.poker_tables enable row level security;
revoke all on public.poker_tables from anon, authenticated;

-- Push changes to open pages so friends see new results without refreshing.
do $$
begin
  alter publication supabase_realtime add table public.players, public.games;
exception when duplicate_object then null;
end $$;
