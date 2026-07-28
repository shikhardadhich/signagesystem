/**
 * Storage for submissions, with two interchangeable drivers.
 *
 *   local  — images on disk in uploads/, records in a module-level array.
 *            Zero setup: this is what `npm start` uses on a laptop.
 *   cloud  — images in Vercel Blob, records in Redis. Required on Vercel,
 *            where the filesystem is read-only and every request may land on
 *            a different instance.
 *
 * The driver is chosen from the environment, so the same code runs in both
 * places and neither one needs a flag.
 */

const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, 'uploads');

const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const hasRedis = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
const useCloud = hasBlob && hasRedis;

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
  // On Vercel the filesystem is read-only, so this fails. Tolerate it: the
  // pages should still render and explain themselves rather than 500 on boot.
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
          'Photo storage is not configured on this deployment. Add a Blob store and a Redis store, ' +
          'then redeploy — see README.md.'
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

/* --------------------------------------------------------------- cloud -- */

function cloudDriver() {
  const { put } = require('@vercel/blob');
  const { Redis } = require('@upstash/redis');
  const redis = Redis.fromEnv();

  const IDS = 'selfiewall:ids';
  const key = (id) => `selfiewall:sub:${id}`;

  return {
    name: 'cloud',
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

const store = useCloud ? cloudDriver() : localDriver();

/**
 * Explains the active driver at boot, and warns when only half the cloud
 * configuration is present — that combination silently falls back to local
 * storage, which on Vercel means uploads vanish between requests.
 */
store.describe = () => {
  if (useCloud) return 'cloud (Vercel Blob + Redis)';
  if (hasBlob || hasRedis) {
    const missing = [
      hasBlob ? null : 'BLOB_READ_WRITE_TOKEN',
      hasRedis ? null : 'KV_REST_API_URL + KV_REST_API_TOKEN',
    ].filter(Boolean).join(' and ');
    return `local (INCOMPLETE cloud config — missing ${missing})`;
  }
  return 'local (disk + memory)';
};

store.isCloud = useCloud;
store.UPLOAD_DIR = UPLOAD_DIR;

module.exports = store;
