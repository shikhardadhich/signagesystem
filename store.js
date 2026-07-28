/**
 * Storage for submissions, with interchangeable drivers.
 *
 *   local    — images on disk in uploads/, records in a module-level array.
 *              Zero setup: this is what `npm start` uses on a laptop.
 *   firebase — images in Cloud Storage, records in Firestore.
 *   vercel   — images in Vercel Blob, records in Redis.
 *
 * Both hosted drivers exist for the same reason: on a serverless runtime the
 * filesystem is read-only and consecutive requests may land on different
 * instances, so disk + memory silently loses data.
 *
 * The driver is picked from the environment, so the same code runs everywhere
 * without a build flag. STORAGE_DRIVER forces a specific one.
 */

const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, 'uploads');

const hasFirebase = Boolean(
  process.env.FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_CONFIG || process.env.GCLOUD_PROJECT
);
const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const hasRedis = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const hasVercel = hasBlob && hasRedis;

const forced = process.env.STORAGE_DRIVER;
const chosen = forced || (hasFirebase ? 'firebase' : hasVercel ? 'vercel' : 'local');

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extensionFor(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext) return ext;
  const fromMime = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
  return fromMime[file.mimetype] || '.jpg';
}

function newSubmission(name, message) {
  return {
    id: makeId(),
    name,
    message,
    url: null,
    status: 'pending',
    submittedAt: Date.now(),
    decidedAt: null,
  };
}

/* --------------------------------------------------------------- local -- */

function localDriver() {
  const submissions = [];
  // On a serverless host the filesystem is read-only, so this fails. Tolerate
  // it: the pages should still render and explain themselves rather than 500
  // on boot.
  let writable = true;
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  } catch (err) {
    writable = false;
  }

  return {
    name: 'local',
    async add(name, message, file) {
      if (!writable) {
        const err = new Error(
          'Photo storage is not configured on this deployment. Connect a storage backend ' +
          'and redeploy — see README.md.'
        );
        err.status = 503;
        throw err;
      }
      const submission = newSubmission(name, message);
      const filename = `${submission.id}${extensionFor(file)}`;
      await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), file.buffer);
      submission.url = `/uploads/${filename}`;
      submissions.push(submission);
      return submission;
    },
    async list() {
      return submissions.map((s) => ({ ...s }));
    },
    async get(id) {
      const found = submissions.find((s) => s.id === id);
      return found ? { ...found } : null;
    },
    async setStatus(id, status) {
      const found = submissions.find((s) => s.id === id);
      if (!found) return null;
      found.status = status;
      found.decidedAt = Date.now();
      return { ...found };
    },
  };
}

/* ------------------------------------------------------------ firebase -- */

function firebaseDriver() {
  const admin = require('firebase-admin');
  const { randomUUID } = require('crypto');

  if (!admin.apps.length) {
    admin.initializeApp(
      process.env.FIREBASE_STORAGE_BUCKET
        ? { storageBucket: process.env.FIREBASE_STORAGE_BUCKET }
        : undefined
    );
  }
  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  const COLLECTION = 'submissions';

  return {
    name: 'firebase',
    async add(name, message, file) {
      const submission = newSubmission(name, message);
      const objectPath = `selfies/${submission.id}${extensionFor(file)}`;

      // A download token gives a stable public URL without needing object ACLs,
      // which uniform bucket-level access blocks outright.
      const token = randomUUID();
      await bucket.file(objectPath).save(file.buffer, {
        resumable: false,
        contentType: file.mimetype,
        metadata: { metadata: { firebaseStorageDownloadTokens: token } },
      });
      submission.url =
        `https://firebasestorage.googleapis.com/v0/b/${bucket.name}` +
        `/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;

      await db.collection(COLLECTION).doc(submission.id).set(submission);
      return submission;
    },
    async list() {
      const snap = await db.collection(COLLECTION).get();
      return snap.docs.map((d) => d.data());
    },
    async get(id) {
      const doc = await db.collection(COLLECTION).doc(id).get();
      return doc.exists ? doc.data() : null;
    },
    async setStatus(id, status) {
      const ref = db.collection(COLLECTION).doc(id);
      const doc = await ref.get();
      if (!doc.exists) return null;
      const updated = { ...doc.data(), status, decidedAt: Date.now() };
      await ref.set(updated);
      return updated;
    },
  };
}

/* -------------------------------------------------------------- vercel -- */

function vercelDriver() {
  const { put } = require('@vercel/blob');
  const { Redis } = require('@upstash/redis');
  const redis = Redis.fromEnv();

  const IDS = 'selfiewall:ids';
  const key = (id) => `selfiewall:sub:${id}`;

  return {
    name: 'vercel',
    async add(name, message, file) {
      const submission = newSubmission(name, message);
      const blob = await put(`selfies/${submission.id}${extensionFor(file)}`, file.buffer, {
        access: 'public',
        contentType: file.mimetype,
      });
      submission.url = blob.url;
      // Record first, then index — a crash between the two leaves an orphan
      // record rather than an id pointing at nothing.
      await redis.set(key(submission.id), submission);
      await redis.rpush(IDS, submission.id);
      return submission;
    },
    async list() {
      const ids = await redis.lrange(IDS, 0, -1);
      if (!ids.length) return [];
      const records = await redis.mget(...ids.map(key));
      return records.filter(Boolean);
    },
    async get(id) {
      return (await redis.get(key(id))) || null;
    },
    async setStatus(id, status) {
      const submission = await redis.get(key(id));
      if (!submission) return null;
      submission.status = status;
      submission.decidedAt = Date.now();
      await redis.set(key(id), submission);
      return submission;
    },
  };
}

const DRIVERS = { local: localDriver, firebase: firebaseDriver, vercel: vercelDriver };

if (!DRIVERS[chosen]) {
  throw new Error(`Unknown STORAGE_DRIVER "${chosen}" (expected local, firebase or vercel)`);
}

const store = DRIVERS[chosen]();

const LABELS = {
  local: 'local (disk + memory)',
  firebase: 'firebase (Cloud Storage + Firestore)',
  vercel: 'vercel (Blob + Redis)',
};

/**
 * Explains the active driver at boot, and warns when a hosted backend is only
 * half configured — that combination falls back to local storage, which on a
 * serverless host means uploads vanish between requests.
 */
store.describe = () => {
  if (store.name !== 'local') return LABELS[store.name];
  if (hasBlob || hasRedis) {
    const missing = [
      hasBlob ? null : 'BLOB_READ_WRITE_TOKEN',
      hasRedis ? null : 'KV_REST_API_URL + KV_REST_API_TOKEN',
    ].filter(Boolean).join(' and ');
    return `local (INCOMPLETE Vercel config — missing ${missing})`;
  }
  return LABELS.local;
};

store.isCloud = store.name !== 'local';
store.UPLOAD_DIR = UPLOAD_DIR;

module.exports = store;
