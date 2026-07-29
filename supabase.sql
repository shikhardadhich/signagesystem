-- The Brew House — Selfie Wall: Supabase schema.
-- Paste into the SQL Editor of a new project and run once.

create table if not exists submissions (
  id           text primary key,
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

-- Existing projects: adds the column above without touching anything else.
alter table submissions add column if not exists moderation jsonb;

-- The wall reads approved photos in approval order on every poll.
create index if not exists submissions_status_decided_idx
  on submissions (status, decided_at);

-- Display-screen settings (currently just the wall mode), one row keyed by id.
create table if not exists settings (
  id    text primary key,
  value jsonb not null
);

-- Every read and write goes through the server using the service-role key,
-- which bypasses RLS. Enabling RLS with no policies therefore leaves the app
-- working while denying browsers direct access with the anon key.
alter table submissions enable row level security;
alter table settings    enable row level security;

-- Storage: create a bucket named "selfies" and make it public, either in the
-- dashboard (Storage -> New bucket -> Public) or with the line below. Photos
-- need public read so the TV and phones can load them straight from the CDN;
-- writes still require the service-role key.
insert into storage.buckets (id, name, public)
values ('selfies', 'selfies', true)
on conflict (id) do update set public = true;
