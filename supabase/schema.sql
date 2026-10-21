-- Poker Ledger schema. Run once in Supabase: SQL Editor → New query → paste → Run.
-- Anyone can read. Only users listed in public.admins can write.

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

grant select on public.players, public.games to anon, authenticated;
grant insert, update, delete on public.players, public.games to authenticated;
grant select on public.admins to authenticated;

-- players
drop policy if exists "Anyone can read players" on public.players;
drop policy if exists "Admins can add players" on public.players;
drop policy if exists "Admins can edit players" on public.players;
drop policy if exists "Admins can delete players" on public.players;
create policy "Anyone can read players"   on public.players for select to anon, authenticated using (true);
create policy "Admins can add players"    on public.players for insert to authenticated with check (public.is_admin());
create policy "Admins can edit players"   on public.players for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins can delete players" on public.players for delete to authenticated using (public.is_admin());

-- games
drop policy if exists "Anyone can read games" on public.games;
drop policy if exists "Admins can add games" on public.games;
drop policy if exists "Admins can edit games" on public.games;
drop policy if exists "Admins can delete games" on public.games;
create policy "Anyone can read games"   on public.games for select to anon, authenticated using (true);
create policy "Admins can add games"    on public.games for insert to authenticated with check (public.is_admin());
create policy "Admins can edit games"   on public.games for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "Admins can delete games" on public.games for delete to authenticated using (public.is_admin());

-- admins: a signed-in user can only see their own row. There are no write policies,
-- so the list can only be changed from the Supabase dashboard / SQL editor.
drop policy if exists "Users can see their own admin row" on public.admins;
create policy "Users can see their own admin row" on public.admins for select to authenticated using (user_id = auth.uid());

-- Push changes to open pages so friends see new results without refreshing.
do $$
begin
  alter publication supabase_realtime add table public.players, public.games;
exception when duplicate_object then null;
end $$;
