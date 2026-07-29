/**
 * Storage for submissions, with interchangeable drivers.
 *
 *   local    — images on disk in uploads/, records in a module-level array.
 *              Zero setup: this is what `npm start` uses on a laptop.
 *   supabase — images in Storage, records in Postgres. Preferred when hosted:
 *              a poll is one query rather than one read per photo.
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

const hasSupabase = Boolean(
  process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
);
const hasFirebase = Boolean(
  process.env.FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_CONFIG || process.env.GCLOUD_PROJECT
);
const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const hasRedis = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
// Blob is the only hard requirement; Redis just makes reads cheaper.
const hasVercel = hasBlob;

const forced = process.env.STORAGE_DRIVER;
const chosen =
  forced || (hasSupabase ? 'supabase' : hasFirebase ? 'firebase' : hasVercel ? 'vercel' : 'local');

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extensionFor(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext) return ext;
  const fromMime = { 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
  return fromMime[file.mimetype] || '.jpg';
}

/**
 * `moderation` records what the automatic filter managed to do:
 * { checked: true } when every part was inspected, { checked: false, skipped }
 * when it could not run. Nothing flagged ever gets this far — server.js
 * refuses those before calling add() — so this exists to tell a moderator
 * which photos arrived unverified and need a closer look.
 */
function newSubmission(cafeId, name, message, moderation) {
  return {
    id: makeId(),
    cafeId,
    name,
    message,
    url: null,
    status: 'pending',
    moderation: moderation || { checked: false },
    submittedAt: Date.now(),
    decidedAt: null,
  };
}

/**
 * How the display screen behaves. Per cafe: two sites run their own walls and
 * one switching to live must not stop the other's rotation.
 *   loop — rotate through every approved photo (the default).
 *   live — stop rotating and show only photos approved after liveSince, so the
 *          wall stands by for new arrivals instead of replaying the backlog.
 */
const DEFAULT_WALL = { mode: 'loop', liveSince: null };
const WALL_MODES = ['loop', 'live'];

function nextWall(mode) {
  return { mode, liveSince: mode === 'live' ? Date.now() : null };
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

  /** cafeId -> wall state. */
  const walls = new Map();

  return {
    name: 'local',
    async getWall(cafeId) {
      return { ...(walls.get(cafeId) || DEFAULT_WALL) };
    },
    async setWall(cafeId, mode) {
      const wall = nextWall(mode);
      walls.set(cafeId, wall);
      return { ...wall };
    },
    async add(cafeId, name, message, file, moderation) {
      if (!writable) {
        const err = new Error(
          "This deployment has no photo storage, so uploads can't be saved. " +
          'Add a Blob store to the project and redeploy — see README.md.'
        );
        err.status = 503;
        throw err;
      }
      const submission = newSubmission(cafeId, name, message, moderation);
      const filename = `${submission.id}${extensionFor(file)}`;
      await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), file.buffer);
      submission.url = `/uploads/${filename}`;
      submissions.push(submission);
      return submission;
    },
    async list(cafeId) {
      return submissions.filter((s) => s.cafeId === cafeId).map((s) => ({ ...s }));
    },
    /* Every lookup is scoped by cafe, not just filtered after the fact: an id
       guessed from another cafe must miss, or one site's staff can read
       another's queue by walking ids. */
    async get(cafeId, id) {
      const found = submissions.find((s) => s.id === id && s.cafeId === cafeId);
      return found ? { ...found } : null;
    },
    async setStatus(cafeId, id, status) {
      const found = submissions.find((s) => s.id === id && s.cafeId === cafeId);
      if (!found) return null;
      found.status = status;
      found.decidedAt = Date.now();
      return { ...found };
    },
    async clear(cafeId) {
      const mine = submissions.filter((s) => s.cafeId === cafeId);
      await Promise.all(
        mine.map((s) =>
          fs.promises.unlink(path.join(UPLOAD_DIR, path.basename(s.url))).catch(() => {})
        )
      );
      for (const s of mine) submissions.splice(submissions.indexOf(s), 1);
      return { removed: mine.length };
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

  const wallRef = (cafeId) => db.collection('settings').doc(`wall:${cafeId}`);

  return {
    name: 'firebase',
    async getWall(cafeId) {
      const doc = await wallRef(cafeId).get();
      return doc.exists ? { ...DEFAULT_WALL, ...doc.data() } : { ...DEFAULT_WALL };
    },
    async setWall(cafeId, mode) {
      const wall = nextWall(mode);
      await wallRef(cafeId).set(wall);
      return wall;
    },
    async add(cafeId, name, message, file, moderation) {
      const submission = newSubmission(cafeId, name, message, moderation);
      const objectPath = `selfies/${cafeId}/${submission.id}${extensionFor(file)}`;

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
    async list(cafeId) {
      const snap = await db.collection(COLLECTION).where('cafeId', '==', cafeId).get();
      return snap.docs.map((d) => d.data());
    },
    async get(cafeId, id) {
      const doc = await db.collection(COLLECTION).doc(id).get();
      if (!doc.exists) return null;
      // Scoped, not merely filtered: an id from another cafe must miss.
      const data = doc.data();
      return data.cafeId === cafeId ? data : null;
    },
    async setStatus(cafeId, id, status) {
      const ref = db.collection(COLLECTION).doc(id);
      const doc = await ref.get();
      if (!doc.exists || doc.data().cafeId !== cafeId) return null;
      const updated = { ...doc.data(), status, decidedAt: Date.now() };
      await ref.set(updated);
      return updated;
    },
    async clear(cafeId) {
      const snap = await db.collection(COLLECTION).where('cafeId', '==', cafeId).get();
      // Records go first: an orphaned image is invisible, an orphaned record
      // renders as a broken photo on the wall.
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      await bucket.deleteFiles({ prefix: `selfies/${cafeId}/` });
      return { removed: snap.size };
    },
  };
}

/* ------------------------------------------------------------ supabase -- */

/**
 * Postgres for the queue, Storage for the photos.
 *
 * Preferred for a wall that polls: a poll is one SELECT rather than one read
 * per photo, so cost does not scale with how many selfies are on the wall —
 * which is what made the metered object stores expensive here.
 */
function supabaseDriver() {
  const { createClient } = require('@supabase/supabase-js');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
    { auth: { persistSession: false } }
  );

  const TABLE = process.env.SUPABASE_TABLE || 'submissions';
  const BUCKET = process.env.SUPABASE_BUCKET || 'selfies';
  // One settings row per cafe, so switching one wall to live leaves every other
  // site's rotation alone.
  const wallId = (cafeId) => `wall:${cafeId}`;

  const check = ({ data, error }) => {
    if (error) throw new Error(`Supabase: ${error.message}`);
    return data;
  };

  // Postgres columns are snake_case; the rest of the app speaks camelCase.
  const toRow = (s) => ({
    id: s.id,
    cafe_id: s.cafeId,
    name: s.name,
    message: s.message,
    url: s.url,
    path: s.path || null,
    status: s.status,
    moderation: s.moderation || null,
    submitted_at: s.submittedAt,
    decided_at: s.decidedAt,
  });
  const fromRow = (r) =>
    r && {
      id: r.id,
      cafeId: r.cafe_id,
      name: r.name,
      message: r.message || '',
      url: r.url,
      path: r.path || undefined,
      status: r.status,
      // Rows written before the moderation column existed read as unchecked,
      // which is exactly what they were.
      moderation: r.moderation || { checked: false },
      submittedAt: Number(r.submitted_at),
      decidedAt: r.decided_at === null ? null : Number(r.decided_at),
    };

  /* The moderation column arrived after the first deploys. Rather than make an
     upload fail until someone runs the ALTER, drop the field and retry once —
     the wall keeps working, and the log says what to run. */
  let hasModerationColumn = true;
  async function insertRow(row) {
    if (hasModerationColumn) {
      const { error } = await db.from(TABLE).insert(row);
      if (!error) return;
      if (!/moderation/i.test(error.message) || !/column|schema cache/i.test(error.message)) {
        throw new Error(`Supabase: ${error.message}`);
      }
      hasModerationColumn = false;
      console.warn(
        '[store] submissions.moderation column is missing — storing without it. ' +
        "Run: alter table submissions add column moderation jsonb;"
      );
    }
    const { moderation, ...rest } = row;
    check(await db.from(TABLE).insert(rest));
  }

  return {
    name: 'supabase',
    async getWall(cafeId) {
      const { data, error } = await db.from('settings').select('value').eq('id', wallId(cafeId)).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return data ? { ...DEFAULT_WALL, ...data.value } : { ...DEFAULT_WALL };
    },
    async setWall(cafeId, mode) {
      const wall = nextWall(mode);
      check(await db.from('settings').upsert({ id: wallId(cafeId), value: wall }));
      return wall;
    },
    async add(cafeId, name, message, file, moderation) {
      const submission = newSubmission(cafeId, name, message, moderation);
      submission.path = `${cafeId}/${submission.id}${extensionFor(file)}`;

      check(
        await db.storage.from(BUCKET).upload(submission.path, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        })
      );
      submission.url = db.storage.from(BUCKET).getPublicUrl(submission.path).data.publicUrl;

      await insertRow(toRow(submission));
      return submission;
    },
    async list(cafeId) {
      const rows = check(
        await db.from(TABLE).select('*').eq('cafe_id', cafeId)
          .order('submitted_at', { ascending: true })
      );
      return rows.map(fromRow);
    },
    /* cafe_id is part of every lookup rather than a filter applied afterwards,
       so an id belonging to another cafe simply misses. */
    async get(cafeId, id) {
      const { data, error } = await db.from(TABLE).select('*')
        .eq('id', id).eq('cafe_id', cafeId).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return fromRow(data) || null;
    },
    async setStatus(cafeId, id, status) {
      const rows = check(
        await db.from(TABLE).update({ status, decided_at: Date.now() })
          .eq('id', id).eq('cafe_id', cafeId).select()
      );
      return rows.length ? fromRow(rows[0]) : null;
    },
    async clear(cafeId) {
      const rows = check(await db.from(TABLE).select('path').eq('cafe_id', cafeId));
      // Rows first: an orphaned image is invisible, an orphaned row renders as
      // a broken photo on the wall.
      check(await db.from(TABLE).delete().eq('cafe_id', cafeId));
      const paths = rows.map((r) => r.path).filter(Boolean);
      if (paths.length) check(await db.storage.from(BUCKET).remove(paths));
      return { removed: rows.length };
    },
  };
}

/* -------------------------------------------------------------- vercel -- */

function vercelDriver() {
  const { put, list, get, del } = require('@vercel/blob');

  // Keys and blob prefixes are namespaced by cafe, so listing one site's queue
  // never walks another's records.
  const IDS = (cafeId) => `selfiewall:${cafeId}:ids`;
  const key = (cafeId, id) => `selfiewall:${cafeId}:sub:${id}`;
  const META = (cafeId) => `meta/${cafeId}/`;

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
    putBlob(`${META(submission.cafeId)}${submission.id}.json`, JSON.stringify(submission), {
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

  /* Reading every record on every poll is what made this driver expensive: at a
     3s poll a ten-photo wall issued 1 + 10 origin reads per client per tick,
     which is hundreds of thousands of Blob operations a day and enough to get a
     store suspended. list() already reports uploadedAt and size, so a record is
     only re-read when it has actually changed. Steady state is one list call. */
  const recordCache = new Map();
  /** cafeId -> { at, value }. Cached per cafe: two sites poll independently. */
  const listCache = new Map();
  // Just under the client poll interval, so two clients polling out of phase
  // cost one list between them rather than two.
  const LIST_TTL = 5000;

  function invalidate(cafeId) {
    listCache.delete(cafeId);
  }

  async function readMeta(prefix) {
    const { blobs } = await list({ prefix });
    const records = await Promise.all(
      blobs.map(async (b) => {
        const stamp = `${new Date(b.uploadedAt).getTime()}:${b.size}`;
        const hit = recordCache.get(b.pathname);
        if (hit && hit.stamp === stamp) return hit.record;
        const record = await readBlobJson(b.pathname);
        if (record) recordCache.set(b.pathname, { stamp, record });
        return record;
      })
    );
    // Forget records whose blob has gone, so the map can't grow without bound.
    const live = new Set(blobs.map((b) => b.pathname));
    for (const k of [...recordCache.keys()]) if (!live.has(k)) recordCache.delete(k);
    return records.filter(Boolean);
  }

  const WALL_KEY = (cafeId) => `selfiewall:${cafeId}:wall`;
  const WALL_BLOB = (cafeId) => `wall/${cafeId}.json`;

  return {
    name: 'vercel',
    get access() {
      return access;
    },
    async getWall(cafeId) {
      const stored = redis
        ? await redis.get(WALL_KEY(cafeId))
        : await readBlobJson(WALL_BLOB(cafeId));
      return stored ? { ...DEFAULT_WALL, ...stored } : { ...DEFAULT_WALL };
    },
    async setWall(cafeId, mode) {
      const wall = nextWall(mode);
      if (redis) await redis.set(WALL_KEY(cafeId), wall);
      else {
        await putBlob(WALL_BLOB(cafeId), JSON.stringify(wall), {
          contentType: 'application/json',
          addRandomSuffix: false,
          allowOverwrite: true,
          cacheControlMaxAge: 0,
        });
      }
      return wall;
    },
    async add(cafeId, name, message, file, moderation) {
      const submission = newSubmission(cafeId, name, message, moderation);
      submission.path = `selfies/${cafeId}/${submission.id}${extensionFor(file)}`;
      const blob = await putBlob(submission.path, file.buffer, {
        contentType: file.mimetype,
        addRandomSuffix: false,
      });
      // A private blob's own URL needs credentials a browser doesn't have, so
      // point at our proxy route instead; public blobs are served straight
      // from the CDN.
      submission.url = access === 'private'
        ? `/api/cafes/${cafeId}/photo/${submission.id}`
        : blob.url;

      if (redis) {
        // Record first, then index — a crash between the two leaves an orphan
        // record rather than an id pointing at nothing.
        await redis.set(key(cafeId, submission.id), submission);
        await redis.rpush(IDS(cafeId), submission.id);
      } else {
        await writeMeta(submission);
        invalidate(cafeId);
      }
      return submission;
    },
    async list(cafeId) {
      if (!redis) {
        // Collapses the screen's and the admin page's polls when they land
        // together, without letting a moderation decision go stale.
        const hit = listCache.get(cafeId);
        if (hit && Date.now() - hit.at < LIST_TTL) return hit.value;
        const value = await readMeta(META(cafeId));
        listCache.set(cafeId, { at: Date.now(), value });
        return value;
      }
      const ids = await redis.lrange(IDS(cafeId), 0, -1);
      if (!ids.length) return [];
      const records = await redis.mget(...ids.map((id) => key(cafeId, id)));
      return records.filter(Boolean);
    },
    async get(cafeId, id) {
      if (!redis) return (await readBlobJson(`${META(cafeId)}${id}.json`)) || null;
      return (await redis.get(key(cafeId, id))) || null;
    },
    async setStatus(cafeId, id, status) {
      const submission = await this.get(cafeId, id);
      if (!submission) return null;
      submission.status = status;
      submission.decidedAt = Date.now();
      // Each record owns its own key/blob, so a decision never rewrites a
      // shared index and cannot clobber a concurrent upload.
      if (redis) await redis.set(key(cafeId, id), submission);
      else {
        await writeMeta(submission);
        invalidate(cafeId);
      }
      return submission;
    },
    async clear(cafeId) {
      const records = await this.list(cafeId);

      if (redis) {
        const ids = await redis.lrange(IDS(cafeId), 0, -1);
        if (ids.length) await redis.del(...ids.map((id) => key(cafeId, id)));
        await redis.del(IDS(cafeId));
      } else {
        const { blobs } = await list({ prefix: META(cafeId) });
        if (blobs.length) await del(blobs.map((b) => b.pathname));
      }

      // Images last: a record pointing at a deleted image would render broken,
      // whereas an image with no record is simply unreferenced.
      const { blobs: photos } = await list({ prefix: `selfies/${cafeId}/` });
      if (photos.length) await del(photos.map((b) => b.pathname));

      recordCache.clear();
      invalidate(cafeId);
      return { removed: records.length };
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

const DRIVERS = {
  local: localDriver,
  supabase: supabaseDriver,
  firebase: firebaseDriver,
  vercel: vercelDriver,
};

if (!DRIVERS[chosen]) {
  throw new Error(
    `Unknown STORAGE_DRIVER "${chosen}" (expected local, supabase, firebase or vercel)`
  );
}

const store = DRIVERS[chosen]();

/**
 * Explains the active driver, and says plainly when a serverless deployment has
 * fallen back to local storage — which cannot work there, and is the single
 * most likely reason an upload fails.
 */
store.describe = () => {
  if (store.name === 'supabase') return 'supabase (Postgres + Storage)';
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
store.WALL_MODES = WALL_MODES;
store.UPLOAD_DIR = UPLOAD_DIR;

module.exports = store;
