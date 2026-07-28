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

## Deploying to Vercel

The POC's original storage model — files on disk, queue in a local array — does
not survive a serverless runtime: the filesystem is read-only and each request
may hit a different instance. So `store.js` ships two drivers and picks one from
the environment:

| Driver | When | Images | Queue |
| --- | --- | --- | --- |
| `local` | no storage env vars (i.e. `npm start`) | `uploads/` on disk | in-memory array |
| `cloud` | both env groups present | Vercel Blob | Redis |

Nothing to configure locally — the local driver stays the default. For Vercel:

1. **Import the repo.** In the Vercel dashboard: *Add New → Project*, pick
   `shikhardadhich/signagesystem`, branch `claude/cafe-selfie-wall-poc-camucx`.
   Leave the build settings alone; `vercel.json` routes every non-static request
   to the Express app in `api/index.js` and lets the CDN serve `public/`.
2. **Add storage.** On the project's *Storage* tab create a **Blob** store and a
   **Redis** store (Upstash), and connect both to the project. That injects:
   - `BLOB_READ_WRITE_TOKEN`
   - `KV_REST_API_URL` and `KV_REST_API_TOKEN`
3. **Redeploy** so the function picks up the new variables.

`GET /api/health` reports which driver is live:

```json
{ "ok": true, "storage": "cloud (Vercel Blob + Redis)", "cloud": true }
```

Until both stores are connected the deployment still renders all three pages,
and uploads fail with an explicit 503 rather than a crash or a silent loss. The
QR code encodes the request's own origin, so it points at the deployed domain
with no configuration.

## How it works

- **Storage is deliberately throwaway locally.** Submissions live in an in-memory
  array and images land in `uploads/`, so restarting the server empties the wall.
  There is no auth and no automated moderation. See *Deploying to Vercel* above
  for the Blob + Redis driver that replaces this when deployed.
- **Everything is polling, every 3 seconds.** The screen polls `/api/queue`, the
  admin page polls `/api/submissions`, and the phone polls `/api/status/:id` after
  submitting. No WebSockets to keep the moving parts down.
- **The screen rotates every 8 seconds** with a fade, and holds its place when the
  queue changes underneath it rather than jumping back to the first photo. Upcoming
  photos are preloaded so a fade never reveals a half-loaded image.
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
| GET | `/api/health` | Which storage driver is active |

Uploads are capped at 12 MB and must be images. The upload is held in memory and
only persisted once the name and file both validate, so a rejected submission
never leaves anything behind.

## Layout

```
server.js          Express app and routes (exports the app; listens only via npm start)
store.js           storage drivers: disk + memory locally, Blob + Redis deployed
api/index.js       Vercel serverless entry point
vercel.json        routes non-static requests to the Express app
public/theme.css   shared cafe palette + the branded photo template
public/screen.html display screen
public/upload.html phone upload page
public/admin.html  moderation dashboard
public/assets/     generated frame, wall and crest artwork
uploads/           uploaded images (local driver only), served at /uploads
```
