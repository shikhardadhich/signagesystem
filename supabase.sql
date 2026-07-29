-- Selfie Wall: Supabase schema.
-- Paste into the SQL Editor of a new project and run once. Safe to re-run.

-- One deployment serves many cafes. A cafe's id is the slug in its public URL
-- (domain.com/brew-house), so it is text rather than a uuid: somebody types it
-- into a kiosk browser once, and an opaque uuid there would be unreadable.
create table if not exists cafes (
  id         text primary key
               check (id ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
  name       text not null,
  -- The whole menu board: branding, logo, items, banner, QR panel copy and
  -- the rotation settings. One document because the editor reads and writes it
  -- as a unit and the screen wants it in a single request. An empty board means
  -- "use the defaults shipped in public/menu.json".
  board      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Roles and cafe membership for Supabase Auth users.
--   owner — creates cafes and staff, may edit any cafe. cafe_id is null.
--   staff — belongs to one cafe: moderates its selfies and edits its board.
-- The first account to sign in becomes the owner; everyone after arrives as
-- staff with no cafe, which grants nothing until an owner assigns one.
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  cafe_id    text references cafes(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table profiles drop constraint if exists profiles_cafe_for_staff;
alter table profiles add constraint profiles_cafe_for_staff
  check (role <> 'owner' or cafe_id is null);

create index if not exists profiles_cafe_idx on profiles (cafe_id);

create table if not exists submissions (
  id           text primary key,
  cafe_id      text references cafes(id) on delete cascade,
  name         text not null,
  message      text default '',
  url          text not null,
  path         text,
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected')),
  -- What the automatic filter managed to check, e.g. {"checked": true}.
  -- Flagged uploads are refused before they reach this table, so this only
  -- ever says whether the check ran — null on rows that predate it.
  moderation   jsonb,
  submitted_at bigint not null,
  decided_at   bigint
);

-- Existing projects: adds the columns above without touching anything else.
alter table submissions add column if not exists moderation jsonb;
alter table submissions add column if not exists cafe_id text references cafes(id) on delete cascade;

-- The wall and the moderation page both ask "what is on this cafe's wall?" on
-- every poll, so that lookup gets its own index.
create index if not exists submissions_cafe_status_idx
  on submissions (cafe_id, status, decided_at);
create index if not exists submissions_status_decided_idx
  on submissions (status, decided_at);

-- Display-screen settings, one row per key. Wall mode is keyed "wall:<cafe_id>"
-- so switching one site to live leaves every other site's rotation alone.
create table if not exists settings (
  id    text primary key,
  value jsonb not null
);

-- Every read and write goes through the server using the service-role key,
-- which bypasses RLS. Enabling RLS with no policies therefore leaves the app
-- working while denying browsers direct access with the anon key.
alter table cafes       enable row level security;
alter table profiles    enable row level security;
alter table submissions enable row level security;
alter table settings    enable row level security;

-- A cafe to start with. Its board is empty, so the screen renders the defaults
-- from public/menu.json until someone saves the board editor.
insert into cafes (id, name) values ('brew-house', 'The Brew House')
on conflict (id) do nothing;

-- Upgrading a single-cafe install: adopt any pre-tenancy selfies.
update submissions set cafe_id = 'brew-house' where cafe_id is null;

-- Storage: create a bucket named "selfies" and make it public, either in the
-- dashboard (Storage -> New bucket -> Public) or with the line below. Photos
-- need public read so the TV and phones can load them straight from the CDN;
-- writes still require the service-role key.
insert into storage.buckets (id, name, public)
values ('selfies', 'selfies', true)
on conflict (id) do update set public = true;
