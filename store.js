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
// Blob is the only hard requirement; Redis just makes reads cheaper.
const hasVercel = hasBlob;

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

  // Probe with a real write. mkdirSync({recursive:true}) is NOT a writability
  // test: uploads/ ships in the deployment bundle, and creating a directory
  // that already exists succeeds even on a read-only filesystem — so it
  // reports success right up until the first upload fails with EROFS.
  let writable = false;
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const probe = path.join(UPLOAD_DIR, '.write-probe');
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    writable = true;
  } catch (err) {
    writable = false;
  }

  return {
    name: 'local',
    async add(name, message, file) {
      if (!writable) {
        const err = new Error(
          "This deployment has no photo storage, so uploads can't be saved. " +
          'Add a Blob store to the project and redeploy — see README.md.'
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
  const { put, list, get } = require('@vercel/blob');

  const IDS = 'selfiewall:ids';
  const key = (id) => `selfiewall:sub:${id}`;
  const META = 'meta/';

  // Redis is optional. With it, the queue is one round trip. Without it, each
  // submission's record is its own small JSON blob — so a Blob store alone is
  // enough to run the wall, at the cost of a list + one read per record.
  const redis = hasRedis ? require('@upstash/redis').Redis.fromEnv() : null;

  // A Blob store is created as either public or private and rejects the wrong
  // access value outright. Rather than make that a setup step, learn it from
  // the first write and remember it. BLOB_ACCESS skips the probe.
  let access = process.env.BLOB_ACCESS || null;
  const mismatched = (err, mode) =>
    new RegExp(`${mode} access on a`, 'i').test(err.message || '') ||
    new RegExp(`configured with ${mode === 'public' ? 'private' : 'public'} access`, 'i').test(
      err.message || ''
    );

  async function putBlob(pathname, body, opts) {
    const order = access ? [access] : ['public', 'private'];
    let lastErr;
    for (const mode of order) {
      try {
        const blob = await put(pathname, body, { ...opts, access: mode });
        access = mode;
        return blob;
      } catch (err) {
        lastErr = err;
        if (!mismatched(err, mode)) throw err;
      }
    }
    throw lastErr;
  }

  const writeMeta = (submission) =>
    putBlob(`${META}${submission.id}.json`, JSON.stringify(submission), {
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
      // The queue is polled every 3s; a cached record would show stale
      // moderation state on the wall.
      cacheControlMaxAge: 0,
    });

  // Reads go through the SDK rather than fetching the public URL, so the same
  // code works on a private store and useCache:false guarantees a moderation
  // decision is visible on the very next poll.
  async function readBlobJson(pathname) {
    try {
      const res = await get(pathname, { access: access || 'public', useCache: false });
      if (!res || res.statusCode !== 200) return null;
      return JSON.parse(await new Response(res.stream).text());
    } catch (err) {
      return null;
    }
  }

  async function readMeta(prefix) {
    const { blobs } = await list({ prefix });
    const records = await Promise.all(blobs.map((b) => readBlobJson(b.pathname)));
    return records.filter(Boolean);
  }

  return {
    name: 'vercel',
    get access() {
      return access;
    },
    async add(name, message, file) {
      const submission = newSubmission(name, message);
      submission.path = `selfies/${submission.id}${extensionFor(file)}`;
      const blob = await putBlob(submission.path, file.buffer, {
        contentType: file.mimetype,
        addRandomSuffix: false,
      });
      // A private blob's own URL needs credentials a browser doesn't have, so
      // point at our proxy route instead; public blobs are served straight
      // from the CDN.
      submission.url = access === 'private' ? `/api/photo/${submission.id}` : blob.url;

      if (redis) {
        // Record first, then index — a crash between the two leaves an orphan
        // record rather than an id pointing at nothing.
        await redis.set(key(submission.id), submission);
        await redis.rpush(IDS, submission.id);
      } else {
        await writeMeta(submission);
      }
      return submission;
    },
    async list() {
      if (!redis) return readMeta(META);
      const ids = await redis.lrange(IDS, 0, -1);
      if (!ids.length) return [];
      const records = await redis.mget(...ids.map(key));
      return records.filter(Boolean);
    },
    async get(id) {
      if (!redis) return (await readBlobJson(`${META}${id}.json`)) || null;
      return (await redis.get(key(id))) || null;
    },
    async setStatus(id, status) {
      const submission = await this.get(id);
      if (!submission) return null;
      submission.status = status;
      submission.decidedAt = Date.now();
      // Each record owns its own key/blob, so a decision never rewrites a
      // shared index and cannot clobber a concurrent upload.
      if (redis) await redis.set(key(id), submission);
      else await writeMeta(submission);
      return submission;
    },
    /** Streams a private blob back through the function. */
    async openPhoto(submission) {
      if (!submission.path) return null;
      const res = await get(submission.path, { access: access || 'private' });
      if (!res || res.statusCode !== 200) return null;
      return { stream: res.stream, contentType: res.blob.contentType, size: res.blob.size };
    },
  };
}

const DRIVERS = { local: localDriver, firebase: firebaseDriver, vercel: vercelDriver };

if (!DRIVERS[chosen]) {
  throw new Error(`Unknown STORAGE_DRIVER "${chosen}" (expected local, firebase or vercel)`);
}

const store = DRIVERS[chosen]();

/**
 * Explains the active driver, and says plainly when a serverless deployment has
 * fallen back to local storage — which cannot work there, and is the single
 * most likely reason an upload fails.
 */
store.describe = () => {
  if (store.name === 'firebase') return 'firebase (Cloud Storage + Firestore)';
  if (store.name === 'vercel') {
    return hasRedis ? 'vercel (Blob + Redis)' : 'vercel (Blob only)';
  }
  const serverless =
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.K_SERVICE;
  if (serverless) {
    return 'local (NO STORAGE CONFIGURED — uploads will fail on a read-only filesystem)';
  }
  return 'local (disk + memory)';
};

store.isCloud = store.name !== 'local';
store.UPLOAD_DIR = UPLOAD_DIR;

module.exports = store;
