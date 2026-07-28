/**
 * The Brew House — Selfie Wall (POC)
 *
 * Express app for all three pages. Persistence lives behind store.js, which
 * uses disk + memory locally and Vercel Blob + Redis when deployed.
 *
 * Exports the app so api/index.js can mount it as a Vercel function; only
 * starts a listener when run directly (`npm start`).
 */

const path = require('path');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

/* Uploads are held in memory and handed to the store, which decides whether
   they land on disk or in Blob. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

app.use(express.json());
app.use('/uploads', express.static(store.UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------- pages -- */

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

app.get('/', (req, res) => res.redirect('/screen'));
app.get('/screen', page('screen.html'));
app.get('/upload', page('upload.html'));
app.get('/admin', page('admin.html'));

/* ------------------------------------------------------------------ api -- */

app.post('/api/upload', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'A photo is required' });

    const name = String(req.body.name || '').trim().slice(0, 40);
    const message = String(req.body.message || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'A name is required' });

    const submission = await store.add(name, message, req.file);
    const all = await store.list();
    res.status(201).json({ ...submission, position: pendingPosition(all, submission.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/submissions', async (req, res, next) => {
  try {
    // Newest first — moderators care about the freshest arrivals.
    const all = await store.list();
    res.json(all.sort((a, b) => b.submittedAt - a.submittedAt));
  } catch (err) {
    next(err);
  }
});

app.get('/api/queue', async (req, res, next) => {
  try {
    res.json(approvedQueue(await store.list()));
  } catch (err) {
    next(err);
  }
});

app.get('/api/status/:id', async (req, res, next) => {
  try {
    const submission = await store.get(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Not found' });

    const all = await store.list();
    const queue = approvedQueue(all);
    const queueIndex = queue.findIndex((s) => s.id === submission.id);

    res.json({
      ...submission,
      position: submission.status === 'pending' ? pendingPosition(all, submission.id) : null,
      queuePosition: queueIndex === -1 ? null : queueIndex + 1,
      queueLength: queue.length,
    });
  } catch (err) {
    next(err);
  }
});

for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
  app.post(`/api/submissions/:id/${action}`, async (req, res, next) => {
    try {
      const updated = await store.setStatus(req.params.id, status);
      if (!updated) return res.status(404).json({ error: 'Not found' });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });
}

app.get('/api/qr', async (req, res, next) => {
  try {
    const target = `${publicBase(req)}/upload`;
    const dataUrl = await QRCode.toDataURL(target, {
      width: 512,
      margin: 1,
      color: { dark: '#3B2415', light: '#FFFFFF' },
    });
    res.json({ dataUrl, target });
  } catch (err) {
    next(err);
  }
});

app.get('/api/health', async (req, res) => {
  res.json({ ok: true, storage: store.describe(), cloud: store.isCloud });
});

/* -------------------------------------------------------------- helpers -- */

function approvedQueue(all) {
  // Approval order, so the newest approved photo shows up last in the rotation.
  return all.filter((s) => s.status === 'approved').sort((a, b) => a.decidedAt - b.decidedAt);
}

function pendingPosition(all, id) {
  const pending = all
    .filter((s) => s.status === 'pending')
    .sort((a, b) => a.submittedAt - b.submittedAt);
  return pending.findIndex((s) => s.id === id) + 1;
}

/**
 * The origin to encode into the QR code. Derived from the request so the
 * deployed domain works automatically; PUBLIC_URL overrides it for LAN demos
 * (PUBLIC_URL=http://192.168.1.20:3000 npm start).
 */
function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/* --------------------------------------------------------------- errors -- */

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

if (require.main === module) {
  const base = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  app.listen(PORT, () => {
    console.log(`\n  ☕  The Brew House — Selfie Wall`);
    console.log(`      Storage: ${store.describe()}`);
    console.log(`      Screen : ${base}/screen`);
    console.log(`      Upload : ${base}/upload`);
    console.log(`      Admin  : ${base}/admin\n`);
  });
}

module.exports = app;
