/**
 * The Brew House — Selfie Wall (POC)
 *
 * Single-file Express backend. Submissions live in memory only, images live on
 * disk under uploads/. Restarting the server clears the queue.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// The URL encoded into the QR code on the display screen. Override with
// PUBLIC_URL when running on a real network so phones can actually reach it,
// e.g. PUBLIC_URL=http://192.168.1.20:3000 npm start
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const UPLOAD_URL = `${PUBLIC_URL}/upload`;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** @type {Array<{id:string,name:string,message:string,file:string,url:string,status:string,submittedAt:number,decidedAt:number|null}>} */
const submissions = [];

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, `${makeId()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype) || file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------- pages -- */

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

app.get('/', (req, res) => res.redirect('/screen'));
app.get('/screen', page('screen.html'));
app.get('/upload', page('upload.html'));
app.get('/admin', page('admin.html'));

/* ------------------------------------------------------------------ api -- */

app.post('/api/upload', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A photo is required' });

  const name = String(req.body.name || '').trim().slice(0, 40);
  const message = String(req.body.message || '').trim().slice(0, 100);

  if (!name) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'A name is required' });
  }

  const submission = {
    id: makeId(),
    name,
    message,
    file: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    status: 'pending',
    submittedAt: Date.now(),
    decidedAt: null,
  };
  submissions.push(submission);

  res.status(201).json({ ...submission, position: pendingPosition(submission.id) });
});

app.get('/api/submissions', (req, res) => {
  // Newest first — moderators care about the freshest arrivals.
  res.json([...submissions].sort((a, b) => b.submittedAt - a.submittedAt));
});

app.get('/api/queue', (req, res) => {
  res.json(approvedQueue());
});

app.get('/api/status/:id', (req, res) => {
  const submission = submissions.find((s) => s.id === req.params.id);
  if (!submission) return res.status(404).json({ error: 'Not found' });

  const queue = approvedQueue();
  const queuePosition = queue.findIndex((s) => s.id === submission.id);

  res.json({
    ...submission,
    position: submission.status === 'pending' ? pendingPosition(submission.id) : null,
    queuePosition: queuePosition === -1 ? null : queuePosition + 1,
    queueLength: queue.length,
  });
});

for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
  app.post(`/api/submissions/:id/${action}`, (req, res) => {
    const submission = submissions.find((s) => s.id === req.params.id);
    if (!submission) return res.status(404).json({ error: 'Not found' });
    submission.status = status;
    submission.decidedAt = Date.now();
    res.json(submission);
  });
}

app.get('/api/qr', async (req, res, next) => {
  try {
    const dataUrl = await QRCode.toDataURL(UPLOAD_URL, {
      width: 512,
      margin: 1,
      color: { dark: '#3B2415', light: '#FFFFFF' },
    });
    res.json({ dataUrl, target: UPLOAD_URL });
  } catch (err) {
    next(err);
  }
});

/* -------------------------------------------------------------- helpers -- */

function approvedQueue() {
  // Approval order, so the newest approved photo shows up last in the rotation.
  return submissions
    .filter((s) => s.status === 'approved')
    .sort((a, b) => a.decidedAt - b.decidedAt);
}

function pendingPosition(id) {
  const pending = submissions.filter((s) => s.status === 'pending');
  return pending.findIndex((s) => s.id === id) + 1;
}

/* --------------------------------------------------------------- errors -- */

app.use((err, req, res, next) => {
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

app.listen(PORT, () => {
  console.log(`\n  ☕  The Brew House — Selfie Wall`);
  console.log(`      Screen : ${PUBLIC_URL}/screen`);
  console.log(`      Upload : ${UPLOAD_URL}`);
  console.log(`      Admin  : ${PUBLIC_URL}/admin\n`);
});
