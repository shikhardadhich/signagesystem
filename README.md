# The Brew House — Cafe Selfie Wall (POC)

A three-screen proof of concept: customers scan a QR code on the cafe TV, upload a
selfie from their phone, a staff member approves it, and it joins the rotation on
the big screen.

## Running it

```bash
npm install
npm start
```

Then open:

| Page | URL | Runs on |
| --- | --- | --- |
| Display screen | http://localhost:3000/screen | The cafe TV, fullscreen kiosk mode |
| Upload | http://localhost:3000/upload | The customer's phone (opened via QR) |
| Moderation | http://localhost:3000/admin | Staff laptop or tablet |

`localhost` only works if the phone is the same machine. To let real phones scan
the QR code, point `PUBLIC_URL` at an address they can reach:

```bash
PUBLIC_URL=http://192.168.1.20:3000 npm start
```

That URL is what gets encoded into the QR code and printed at startup.

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
{ "ok": true, "storage": "firebase (Cloud Storage + Firestore)", "cloud": true }
```

### Supabase (recommended when hosted)

Object stores that bill per operation suit a polling wall badly: the screen and
the admin page ask "what's on the wall?" every few seconds forever, and with a
per-photo read that cost grows with the wall. Postgres answers the same question
in **one query no matter how many photos there are**, which is why this is the
default recommendation. It also covers both halves — queue and images — in one
service.

1. Create a project at supabase.com.
2. Open the **SQL Editor**, paste [`supabase.sql`](supabase.sql) and run it. That
   creates the two tables and a public `selfies` storage bucket.
3. Set two environment variables on the host (Vercel → Settings → Environment
   Variables), from *Project Settings → API*:
   - `SUPABASE_URL` — the Project URL, `https://<ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — the **secret** key (`sb_secret_…` on newer
     projects, or the legacy `service_role` JWT). The **publishable**/anon key is
     not used by this app and won't work here.
4. Redeploy.

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
  array and images land in `uploads/`, so restarting the server empties the wall.
  There is no auth and no automated moderation. See *Deploying* above for the
  hosted drivers that replace this.
- **Everything is polling, every 5-6 seconds.** The screen polls `/api/queue`, the
  admin page polls `/api/submissions`, and the phone polls `/api/status/:id` after
  submitting. No WebSockets to keep the moving parts down.
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
  tagline, signature items with prices, the banner and the QR panel copy. Drop
  photos at the paths named there (`public/assets/menu/…`); anything missing
  falls back to the crest, so the board never looks broken.
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

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/upload` | Multipart (`name`, `message`, `photo`) → saves the image, queues it as `pending` |
| GET | `/api/submissions` | Every submission, newest first (admin) |
| GET | `/api/queue` | Approved submissions in approval order (display screen) |
| GET | `/api/status/:id` | One submission's status and queue position (phone) |
| POST | `/api/submissions/:id/approve` | Mark approved |
| POST | `/api/submissions/:id/reject` | Mark rejected |
| GET | `/api/qr` | QR code for the upload page, as a data URL |
| DELETE | `/api/submissions` | Deletes every submission and its stored image |
| GET | `/api/wall` | Current wall mode (`loop` or `live`) |
| POST | `/api/wall` | Switch wall mode: `{ "mode": "loop" \| "live" }` |
| GET | `/api/health` | Which storage driver is active |
| GET | `/api/photo/:id` | Streams a photo from a private Blob store (unused on public stores) |

Uploads are capped at 12 MB and must be images. The upload is held in memory and
only persisted once the name and file both validate, so a rejected submission
never leaves anything behind.

## Layout

```
server.js          Express app and routes (exports the app; listens only via npm start)
store.js           storage drivers: local disk, Supabase, Firebase, or Vercel Blob
supabase.sql       Supabase schema — run once in the SQL Editor
index.js           Firebase Cloud Functions entry point
firebase.json      Firebase Hosting rewrites + functions config
storage.rules      denies direct client access to Cloud Storage
firestore.rules    denies direct client access to Firestore
api/index.js       Vercel serverless entry point
vercel.json        routes non-static requests to the Express app
public/menu.json   board content: items, prices, copy — edit this, not the HTML
public/theme.css   shared cafe palette + the branded photo frame
public/screen.html display screen
public/upload.html phone upload page
public/admin.html  moderation dashboard
public/assets/     generated frame, wall and crest artwork
uploads/           uploaded images (local driver only), served at /uploads
```
