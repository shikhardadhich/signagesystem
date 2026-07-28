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

## How it works

- **Storage is deliberately throwaway.** Submissions live in an in-memory array and
  images land in `uploads/`. Restarting the server empties the wall but leaves the
  files on disk. There is no database, no auth, and no automated moderation.
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

Uploads are capped at 12 MB and must be images; a submission missing a name is
rejected and its uploaded file deleted.

## Layout

```
server.js          all backend logic
public/theme.css   shared cafe palette + the branded photo template
public/screen.html display screen
public/upload.html phone upload page
public/admin.html  moderation dashboard
uploads/           uploaded images, served at /uploads
```
