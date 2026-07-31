# Cafe Selfie Wall

Digital signage for cafes. Each site gets a menu board on its TV; customers scan
the QR code on it, upload a selfie from their phone, a staff member approves it,
and it takes over the screen for fifteen seconds.

One deployment serves many cafes. Staff sign in and see only their own site;
owners see all of them and edit the boards.

## Running it

```bash
npm install
npm start
```

| Page | URL | Runs on | Sign-in |
| --- | --- | --- | --- |
| Display screen | `/<cafe>` | The cafe TV, fullscreen kiosk mode | No |
| Upload | `/<cafe>/upload` | The customer's phone, opened via QR | No |
| Marketing site | `/` | Anyone | No |
| Sign in | `/login` | Staff laptop or tablet | — |
| Cafes and accounts | `/admin/cafes` | Owner | Yes |
| Moderation | `/admin/<cafe>` | Staff | Yes |
| Menu board editor | `/admin/<cafe>/board` | Staff | Yes |

The bare domain is the marketing page, signed in or not: whoever lands there is
far likelier to be a visitor than a barista, and staff with a session are one
click from `/admin`. A URL that isn't a known cafe lands there too, since the
usual cause is a typo in an address read off a sticky note.

The display is deliberately public. A kiosk browser that lost its session
overnight would greet a room full of customers with a login box and nobody there
to type into it, so the screen needs no account — everything behind it does.

Out of the box there is one cafe, `brew-house`, so the screen is at
http://localhost:3000/brew-house. With no Supabase configured the app runs on
local disk with sign-in switched off, which is what keeps `npm start` working on
a laptop with no accounts anywhere.

`localhost` only works if the phone is the same machine. To let real phones scan
the QR code, point `PUBLIC_URL` at an address they can reach:

```bash
PUBLIC_URL=http://192.168.1.20:3000 npm start
```

That URL is what gets encoded into the QR code and printed at startup.

## Cafes and accounts

Cafes and staff both live in Supabase, so this section needs
[Supabase configured](#supabase-recommended-when-hosted) first.

A cafe's id is the slug in its own URL, so pick something readable:
`domain.com/brew-house` is the screen and `domain.com/brew-house/upload` is the
phone page. Ids are lowercase letters, numbers and hyphens, and a handful of
words the app already uses (`admin`, `api`, `assets`, …) are refused rather than
creating a cafe nobody could reach.

There are two roles:

| | Owner | Staff |
| --- | --- | --- |
| Moderate selfies | every cafe | their own cafe |
| Edit the menu board | every cafe | their own cafe |
| Create cafes and accounts | yes | no |

**Getting the first owner in.** Create a user in the Supabase dashboard
(*Authentication → Users → Add user*, with "auto confirm" on), then sign in at
`/login`. The first account to sign in becomes the owner — somebody has to be, and
the alternative is no owner existing to promote anyone. From there, add cafes
and staff from `/admin/cafes`.

Staff created afterwards arrive with no cafe assigned, which grants nothing until
an owner picks one for them. A staff member asking for another cafe's data gets
a 404 rather than a 403: a 403 would confirm that cafe exists, which hands
anyone with one account a directory of every site on the system.

## The menu board

`/admin/<cafe>/board` edits everything the screen renders: cafe name, tagline,
established year, logo, the section heading, the items, the bottom banner, and
the QR panel's copy and steps. The screen re-reads the board once a minute, so a
save reaches the TV on its own — nobody has to walk over to it.

**Images** are uploaded through the editor and go wherever the selfies go: a
Supabase bucket or Vercel Blob when one is configured, otherwise the app's own
`public/assets/board/<cafe>/` folder. Images a board no longer refers to are
deleted after a save, so replacing a photo repeatedly doesn't accumulate junk.

> They used to be written to disk unconditionally, which cannot work on a
> serverless host — the filesystem is read-only there, and the upload failed
> with "cannot write to its own folder" while selfies kept working. If you see
> that message now, the deployment has no object store at all: set
> `BLOB_READ_WRITE_TOKEN` or the Supabase variables and redeploy.

**A rotating board.** More items than fit on the panel are dealt out a page at a
time and the page turns on a timer, the way the boards in a coffee-shop chain do.
Two settings control it: how many items show at once, and how long each page
holds. The editor spells out what they add up to — "8 items across 3 pages, full
cycle 24s" — because the two numbers on their own don't tell you whether the
whole menu gets seen. Page turns pause while a selfie has the screen, so nothing
cycles past unwatched, and a menu that fits on one page simply doesn't rotate.

Everything is trimmed and clamped server-side rather than rejected. A tagline
three times too long for the header is a layout problem on a TV nobody is
watching; refusing the save would be the worse outcome.

`public/menu.json` stays in the repo as the shipped default. A cafe nobody has
edited renders it, so a brand new cafe shows a complete board instead of a blank
screen, and *Reset to defaults* in the editor drops back to it.

## Automatic moderation

A selfie wall in a public room is a screen strangers can write on. Every upload
carries three things a customer will read off it — a name, a message and a photo
— and all three go through OpenAI's moderation endpoint before anything is
stored.

Put a key in `.env` (copy `.env.example`) and it turns itself on:

```dotenv
OPENAI_MODERATION_APIKEY=sk-...
```

`npm start` reads `.env`; on a host, set the same variable in the project's
environment instead. Leave it unset and the filter is simply off — which is what
keeps the POC runnable with no OpenAI account.

**Flagged uploads are refused at the door.** The check runs *before* `store.add`,
while the photo is still a buffer in memory, so a flagged image is never written
anywhere. The phone gets a 422 and a plain message naming the field to fix; the
moderation page never sees it. Storing it and flagging it for a human would mean
the thing you did not want on a screen is now in your database and rendered as a
thumbnail on the admin page.

**A broken filter opens, it does not close.** A missing key, a timeout or an
OpenAI outage lets the upload through as normal `pending`, recorded as
unchecked — a moderator is still the gate, so an outage degrades the wall rather
than shutting it. Those submissions get an *arrived unscreened* badge on the
admin page, and the banner at the top of that page says whether the filter is
running at all. Failing closed would mean one OpenAI incident takes the whole
wall down.

Name and message are checked in one call, the photo (inlined as a data URL) in
another, in parallel. Tuning, all optional:

| Variable | Default | Effect |
| --- | --- | --- |
| `OPENAI_MODERATION_MODEL` | `omni-moderation-latest` | Must be vision-capable; the older `text-moderation-*` models cannot see photos |
| `MODERATION_TIMEOUT_MS` | `8000` | How long to wait before letting the upload through unchecked |
| `MODERATION_THRESHOLD` | unset | `0`-`1`. Unset means the API's own verdict decides. Setting it also blocks any category scoring above it — lower is stricter, and produces more false rejections |
| `MODERATION_MAX_IMAGE_BYTES` | `6291456` | Photos above this skip the image check rather than stall the upload. The phone already downscales to ~550 KB |

The key is server-side only and belongs in `.env` (gitignored) or the host's
environment — never in the repo. If one leaks, rotate it at
[platform.openai.com/api-keys](https://platform.openai.com/api-keys).

## Deploying

The POC's original storage model — files on disk, queue in a local array — does
not survive a serverless runtime: the filesystem is read-only and each request
may hit a different instance. So `store.js` ships four interchangeable drivers
and picks one from the environment:

| Driver | Selected when | Images | Queue |
| --- | --- | --- | --- |
| `local` | no cloud env vars (i.e. `npm start`) | `uploads/` on disk | in-memory array |
| `supabase` | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` present | Storage bucket | Postgres |
| `firebase` | `FIREBASE_CONFIG` / `GCLOUD_PROJECT` present (set automatically in Cloud Functions) | Cloud Storage | Firestore |
| `vercel` | `BLOB_READ_WRITE_TOKEN` present | Vercel Blob | Redis if configured, else one JSON blob per submission |

When more than one is configured the order above wins, so adding Supabase to a
project that still has a Blob store switches it over.
`STORAGE_DRIVER=local|supabase|firebase|vercel` forces one. Nothing to configure locally —
the local driver stays the default, so `npm start` still needs no cloud account.

`GET /api/health` reports which driver is live:

```json
{
  "ok": true,
  "storage": "supabase (Postgres + Storage)",
  "cloud": true,
  "cafes": "supabase",
  "auth": { "enabled": true, "detail": "supabase auth" },
  "moderation": { "enabled": true, "detail": "omni-moderation-latest" }
}
```

### Supabase (recommended when hosted)

Object stores that bill per operation suit a polling wall badly: the screen and
the admin page ask "what's on the wall?" every few seconds forever, and with a
per-photo read that cost grows with the wall. Postgres answers the same question
in **one query no matter how many photos there are**, which is why this is the
default recommendation. It also covers both halves — queue and images — in one
service.

Supabase carries three things here: the selfie queue, the cafes and their menu
boards, and staff sign-in through Supabase Auth. Configure it and multi-cafe and
logins both switch themselves on; leave it unset and the app falls back to one
cafe on local disk with no sign-in.

1. Create a project at supabase.com.
2. Open the **SQL Editor**, paste [`supabase.sql`](supabase.sql) and run it. It
   creates the tables, a `brew-house` cafe to start with, and a public `selfies`
   storage bucket. It is safe to re-run on an existing project.
3. Set two environment variables on the host (Vercel → Settings → Environment
   Variables), from *Project Settings → API*:
   - `SUPABASE_URL` — the Project URL, `https://<ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — the **secret** key (`sb_secret_…` on newer
     projects, or the legacy `service_role` JWT). The **publishable**/anon key is
     not used by this app and won't work here.
4. Redeploy.
5. Create your first user in *Authentication → Users → Add user* (auto-confirm
   on), then sign in at `/login`. The first account to sign in becomes the owner.

The secret key must stay server-side — it bypasses row-level security, and the
browser never sees it. Keep it in the host's environment variables: never in the
repo, and never pasted into a chat or ticket. If one leaks, rotate it in
*Project Settings → API*; the old key stops working immediately.

RLS is enabled with no policies, so even the publishable key grants nothing while
the server keeps working. `SUPABASE_BUCKET` and `SUPABASE_TABLE` override the
names if you want something other than `selfies` / `submissions`.

### Firebase

Hosting serves `public/` from the CDN and rewrites everything else to a 2nd-gen
Cloud Function wrapping the same Express app (`index.js`).

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # pick your project, alias it "default"
firebase deploy
```

The project needs **Cloud Storage** and **Firestore** enabled, and Cloud
Functions requires the **Blaze** plan (the free tier still covers a POC's
traffic). Firestore should be created in Native mode.

Selfies are written with a Firebase download token, so their URLs work without
making objects publicly readable — which matters because uniform bucket-level
access blocks per-object ACLs outright. `storage.rules` and `firestore.rules`
therefore deny all direct client access: every read and write goes through the
function's Admin SDK, and browsers never talk to either service directly.

To override the bucket (for example when it isn't the project default), set
`FIREBASE_STORAGE_BUCKET`.

### Vercel Blob

Works, but bills per operation, which a polling wall burns through quickly — see
*Supabase* above. If you use it anyway, the notes below still apply; the driver
caches aggressively to keep the operation count down.

### Vercel (hosting)

Hosting serves `public/` and rewrites the rest to the Express app in
`api/index.js`.

1. **Import the repo.** In the Vercel dashboard: *Add New → Project*, pick
   `shikhardadhich/signagesystem`, branch `claude/cafe-selfie-wall-poc-camucx`.
   Leave the build settings alone; `vercel.json` routes every non-static request
   to the Express app in `api/index.js` and lets the CDN serve `public/`.
2. **Add storage.** On the project's *Storage* tab create a **Blob** store and
   connect it to the project. That injects `BLOB_READ_WRITE_TOKEN`, which is all
   the wall needs — each submission's record is kept as its own small JSON blob
   next to its photo.

   Either kind of store works. A Blob store is created as **public** or
   **private** and rejects the wrong access value outright, so the driver learns
   which it is from the first write and remembers it (`BLOB_ACCESS=public|private`
   skips the probe). On a public store browsers load photos straight from the
   CDN. On a private store they cannot, so photos are streamed through
   `/api/photo/:id` instead — correct either way, but a public store is faster
   for a wall and costs fewer function invocations.

   Optionally also connect a **Redis** store (`KV_REST_API_URL` +
   `KV_REST_API_TOKEN`). It is picked up automatically and makes reads a single
   round trip instead of a list plus one fetch per record — worth adding if the
   wall grows past a couple of dozen photos, unnecessary for a demo.
3. **Redeploy** so the function picks up the new variables.

The rewrite deliberately sends **every** path to `/api`, including `/api/*`.
Vercel's filesystem routing exposes `api/index.js` at `/api` only — there is no
implicit catch-all — so excluding `/api/*` from the rewrite (for example with a
`(?!api/)` lookahead) makes every endpoint 404 while the pages still render.
Static files under `public/` are matched before rewrites, so they keep coming
from the CDN.

### Either way

Until a backend is connected the deployment still renders all three pages, and
uploads fail with an explicit 503 rather than a crash or a silent loss. The QR
code encodes the request's own origin, so it points at the deployed domain with
no configuration.

## How it works

- **Storage is deliberately throwaway locally.** Submissions live in an in-memory
  array and images land in `uploads/`, so restarting the server empties the wall,
  and cafes live in a `data/cafes.json` the app writes for itself. Sign-in is off
  in this mode. It exists so the app boots with no accounts anywhere — multi-cafe
  and staff logins both need Supabase. See *Deploying* above.
- **One deployment, many cafes, scoped at the query.** Every per-cafe route
  carries its cafe in the path, and the store scopes each lookup by it rather
  than fetching and filtering — so a submission id guessed from another cafe
  simply misses instead of leaking. Wall mode, the queue, the board and the
  uploaded images are all per cafe.
- **The automatic filter runs before anything is stored.** Name, message and
  photo go to OpenAI's moderation endpoint while the image is still a buffer in
  memory; a flagged upload is refused and never written. It fails open, so an
  outage leaves a human moderator as the gate rather than closing the wall. See
  *Automatic moderation* above.
- **Everything is polling, every 5-6 seconds.** The screen polls its cafe's
  queue, the admin page polls its submissions, and the phone polls its own
  status after submitting. The screen also re-reads its board once a minute, so
  an edit reaches the TV without anyone touching it. No WebSockets, to keep the
  moving parts down.
- **Polling is metered when hosted, so reads are cached.** Re-reading every record
  on every tick is what makes a Blob store expensive — at a 3s poll a ten-photo
  wall cost 1 + 10 origin reads per client per tick, hundreds of thousands of
  operations a day. `list()` reports each blob's `uploadedAt` and `size`, so a
  record is only re-read once it has actually changed, and the whole list is held
  briefly so two clients polling out of phase cost one read between them. Steady
  state is about 0.5 operations per poll instead of 11. Every mutation drops the
  cache, so a decision is still visible on the very next poll.
- **The screen has two states.** It rests on a *menu board* — branding, the
  signature items and their prices, and a right-hand panel with the QR, the
  three how-it-works steps and a grid of recent selfies. A selfie then *takes
  over* the whole screen for 15 seconds before the board returns.
- **The takeover frame matches the photo.** Its aspect ratio is set from the
  image's own dimensions, so a portrait selfie and a landscape one both fill
  their frame without being cropped — no face loses its top to a fixed shape.
- **The board is edited, not coded.** `public/menu.json` holds the cafe name,
  tagline, signature items with prices, the banner and the QR panel copy. Each
  item names an `image` (the photograph) and a `fallback`, and the screen walks
  that chain: photo, then a line-art stand-in, then the crest — so a missing
  file can never leave a blank slot on the wall.

  Product shots want a **transparent** background. Photographed on white they
  sit on the cream card as a faintly visible rectangle; keying the backdrop out
  removes the edge and lets the shot's own shadow do the work. `keymenu.js` in
  the scratchpad did this by flood-filling from the borders, which cannot reach
  a cream cup in the middle of the frame.
- **A photo and its caption always appear together.** The incoming photo and text
  are staged in the hidden layer, and the crossfade only starts once the image has
  decoded — otherwise the caption lands first and the frame sits empty for a beat.
  Upcoming photos are preloaded so that wait is usually zero. A photo that fails or
  stalls past 6s is shown anyway: a wall frozen on one bad image is worse than one
  that shows it late.
- **The frame scales to fill the TV.** Its height depends on how far the name and
  message wrap, so it can't be derived from the viewport alone: the screen
  measures the laid-out frame at a known `--u` and scales from there. Every
  dimension is a multiple of `--u`, so height is linear in it and one pass lands
  exactly — the frame fills 97% of the stage at any resolution, and shrinks by
  itself when a long caption would otherwise overflow.
- **Two wall modes, switched from the admin page or the screen itself.** *Looping* cycles every approved
  photo. *Live* stops rotating and shows only photos approved after the switch, so
  the board rests and each new arrival takes over in turn — oldest first, one per
  pass, so a burst of approvals each gets its own 15 seconds instead of only the
  last being seen. Freshness is tracked by a decision-time watermark rather than
  by photo id, so rejecting and re-approving a photo correctly counts as new. The
  mode lives in the store, not the page, so the TV picks it up on its next poll
  and it survives a refresh or a cold start. The screen carries the same control,
  hidden until someone moves the mouse or presses a key (`L` toggles).
- **Photos are shrunk on the phone before upload.** A modern camera hands over
  3-6 MB while the photo occupies at most about 900px even on a 4K panel, so the
  browser downscales to a 1600px long edge and re-encodes as JPEG — a 3.2 MB shot
  becomes about 550 KB. Doing it client-side saves the upload over cafe wifi as
  well as the storage and bandwidth behind it, and EXIF orientation is honoured so
  portrait shots don't end up sideways. If the browser can't do it, the original
  is sent unchanged.
- **Clearing the wall is a two-click action.** *Clear all photos* in the admin
  sidebar arms first and deletes on the second click, disarming itself after 5s.
  It removes the stored images too, not just the records — on every driver. The
  wall mode is deliberately left alone.
- **One template, two sizes.** The branded frame in `theme.css` sizes every border,
  gap, and font off a single `--u` length, so the phone's live preview is the same
  markup as the TV — customers see exactly what will appear on the wall.

## API

| Method | Endpoint | Purpose | Sign-in |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | Email + password, sets the session cookies | — |
| POST | `/api/auth/logout` | Clears them | — |
| GET | `/api/auth/me` | Who you are and which cafes you can reach | yes |
| GET | `/api/cafes` | Every cafe | owner |
| POST | `/api/cafes` | Create one: `{ "id": "brew-house", "name": "…" }` | owner |
| PATCH | `/api/cafes/:cafe` | Rename | owner |
| DELETE | `/api/cafes/:cafe` | Delete it, its board images and every selfie sent to it | owner |
| GET · POST · PATCH · DELETE | `/api/users…` | Staff accounts | owner |
| GET | `/api/cafes/:cafe/board` | The menu board the screen renders | no |
| PUT | `/api/cafes/:cafe/board` | Save it | yes |
| POST | `/api/cafes/:cafe/board/image` | Upload a logo or item photo | yes |
| POST | `/api/cafes/:cafe/board/reset` | Back to the shipped defaults | yes |
| POST | `/api/cafes/:cafe/upload` | Multipart (`name`, `message`, `photo`) → moderates, then queues it as `pending`. `422` with `{ "moderation": "blocked", "field": … }` if the filter rejects it | no |
| GET | `/api/cafes/:cafe/queue` | Approved selfies in approval order (the screen) | no |
| GET | `/api/cafes/:cafe/status/:id` | One selfie's status and queue position (the phone) | no |
| GET | `/api/cafes/:cafe/qr` | QR code for this cafe's upload page, as a data URL | no |
| GET | `/api/cafes/:cafe/wall` | Current wall mode (`loop` or `live`) | no |
| POST | `/api/cafes/:cafe/wall` | Switch it: `{ "mode": "loop" \| "live" }` | yes |
| GET | `/api/cafes/:cafe/submissions` | Every selfie for this cafe, newest first | yes |
| POST | `/api/cafes/:cafe/submissions/:id/approve` | Mark approved | yes |
| POST | `/api/cafes/:cafe/submissions/:id/reject` | Mark rejected | yes |
| DELETE | `/api/cafes/:cafe/submissions` | Delete every selfie for this cafe and its stored image | yes |
| GET | `/api/cafes/:cafe/photo/:id` | Streams a photo from a private Blob store (unused on public stores) | no |
| GET | `/api/health` | Which drivers are active, and whether sign-in and the filter are on | no |

Every per-cafe route carries the cafe in its path, and the store scopes each
lookup by it rather than filtering afterwards — so an id belonging to another
cafe simply misses.

Uploads are capped at 12 MB and must be images. The upload is held in memory and
only persisted once the name and file both validate, so a rejected submission
never leaves anything behind.

## Layout

```
server.js          Express app and routes (exports the app; listens only via npm start)
store.js           selfie storage drivers: local disk, Supabase, Firebase, or Vercel Blob
cafes.js           cafes and their menu boards
assets.js          board image storage: Supabase, Vercel Blob, or local disk
auth.js            staff accounts and role checks, on Supabase Auth
moderate.js        OpenAI moderation for the name, message and photo
supabase.sql       Supabase schema — run once in the SQL Editor
index.js           Firebase Cloud Functions entry point
firebase.json      Firebase Hosting rewrites + functions config
storage.rules      denies direct client access to Cloud Storage
firestore.rules    denies direct client access to Firestore
api/index.js       Vercel serverless entry point
vercel.json        routes non-static requests to the Express app
public/menu.json   board content: items, prices, copy — edit this, not the HTML
public/theme.css   shared cafe palette + the branded photo frame
public/admin.css   shared chrome for the signed-in pages
public/admin-shell.js  session, header and API helper shared by those pages
public/landing.html  the marketing page served at /
public/login.html  staff sign-in
public/cafes.html  owner console: cafes and accounts
public/board.html  menu board editor
public/screen.html display screen
public/upload.html phone upload page
public/admin.html  moderation dashboard
public/assets/     generated frame, wall and crest artwork
uploads/           uploaded images (local driver only), served at /uploads
```
