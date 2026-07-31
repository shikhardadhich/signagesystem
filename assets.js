/**
 * Storage for menu-board images, with the same interchangeable-driver shape as
 * store.js — and for the same reason.
 *
 * Board images used to be written straight into public/assets/board/. That
 * works on an ordinary webserver and fails on every serverless host, where the
 * filesystem is read-only: the admin screen's image upload returned "this
 * deployment cannot write to its own folder" while selfie uploads, which go
 * through store.js, kept working. This module closes that gap by sending board
 * images wherever the selfies already go.
 *
 *   supabase — Storage bucket, under board/<cafeId>/.
 *   vercel   — Blob store, same prefix.
 *   local    — public/assets/board/<cafeId>/ on disk, as before.
 *
 * A driver is picked from the environment. STORAGE_DRIVER forces one, so the
 * two modules never disagree about where a deployment keeps its files.
 */

const fs = require('fs');
const path = require('path');

const BOARD_IMAGE_DIR = path.join(__dirname, 'public', 'assets', 'board');
/** Shared with the selfie bucket; the prefix is what keeps the two apart. */
const PREFIX = 'board';

const hasSupabase = Boolean(
  process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
);
const hasBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const forced = process.env.STORAGE_DRIVER;
const chosen = forced || (hasSupabase ? 'supabase' : hasBlob ? 'vercel' : 'local');

function filenameFor(ext) {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

/* --------------------------------------------------------------- local -- */

function localDriver() {
  return {
    name: 'local',
    async save(cafeId, file, ext) {
      const dir = path.join(BOARD_IMAGE_DIR, cafeId);
      // mkdir is not a writability test on its own — the directory ships in the
      // bundle, so creating it "succeeds" on a read-only disk. The write below
      // is what actually decides, and its error is the one worth reporting.
      await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
      const filename = filenameFor(ext);
      await fs.promises.writeFile(path.join(dir, filename), file.buffer);
      return `/assets/board/${cafeId}/${filename}`;
    },
    async prune(cafeId, keep) {
      const dir = path.join(BOARD_IMAGE_DIR, cafeId);
      let files;
      try {
        files = await fs.promises.readdir(dir);
      } catch (err) {
        return;
      }
      await Promise.all(
        files
          .filter((f) => !keep.has(`/assets/board/${cafeId}/${f}`))
          .map((f) => fs.promises.unlink(path.join(dir, f)).catch(() => {}))
      );
    },
    async removeAll(cafeId) {
      await fs.promises
        .rm(path.join(BOARD_IMAGE_DIR, cafeId), { recursive: true, force: true })
        .catch(() => {});
    },
  };
}

/* ------------------------------------------------------------ supabase -- */

function supabaseDriver() {
  const { createClient } = require('@supabase/supabase-js');
  const BUCKET = process.env.SUPABASE_BUCKET || 'selfies';

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
    { auth: { persistSession: false } }
  );

  const publicUrl = (key) => db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;

  async function listKeys(cafeId) {
    const { data, error } = await db.storage.from(BUCKET).list(`${PREFIX}/${cafeId}`, { limit: 1000 });
    if (error || !data) return [];
    return data.map((o) => `${PREFIX}/${cafeId}/${o.name}`);
  }

  return {
    name: 'supabase',
    async save(cafeId, file, ext) {
      const key = `${PREFIX}/${cafeId}/${filenameFor(ext)}`;
      const { error } = await db.storage.from(BUCKET).upload(key, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });
      if (error) throw new Error(`Supabase: ${error.message}`);
      return publicUrl(key);
    },
    async prune(cafeId, keep) {
      const stale = (await listKeys(cafeId)).filter((k) => !keep.has(publicUrl(k)));
      if (stale.length) await db.storage.from(BUCKET).remove(stale);
    },
    async removeAll(cafeId) {
      const keys = await listKeys(cafeId);
      if (keys.length) await db.storage.from(BUCKET).remove(keys);
    },
  };
}

/* -------------------------------------------------------------- vercel -- */

function vercelDriver() {
  const { put, list, del } = require('@vercel/blob');

  // A Blob store is created public or private and rejects the wrong access
  // value outright. Learn it from the first write rather than making it a
  // setup step; BLOB_ACCESS skips the probe. Same trick as store.js.
  let access = process.env.BLOB_ACCESS || null;
  const mismatched = (err, mode) =>
    new RegExp(`${mode} access on a`, 'i').test(err.message || '') ||
    new RegExp(`configured with ${mode === 'public' ? 'private' : 'public'} access`, 'i').test(
      err.message || ''
    );

  return {
    name: 'vercel',
    async save(cafeId, file, ext) {
      const key = `${PREFIX}/${cafeId}/${filenameFor(ext)}`;
      const order = access ? [access] : ['public', 'private'];
      let lastErr;
      for (const mode of order) {
        try {
          const blob = await put(key, file.buffer, {
            access: mode,
            contentType: file.mimetype,
            addRandomSuffix: false,
          });
          access = mode;
          return blob.url;
        } catch (err) {
          lastErr = err;
          if (!mismatched(err, mode)) throw err;
        }
      }
      throw lastErr;
    },
    async prune(cafeId, keep) {
      const { blobs } = await list({ prefix: `${PREFIX}/${cafeId}/` });
      const stale = blobs.filter((b) => !keep.has(b.url)).map((b) => b.url);
      if (stale.length) await del(stale);
    },
    async removeAll(cafeId) {
      const { blobs } = await list({ prefix: `${PREFIX}/${cafeId}/` });
      if (blobs.length) await del(blobs.map((b) => b.url));
    },
  };
}

const drivers = { local: localDriver, supabase: supabaseDriver, vercel: vercelDriver };
const driver = (drivers[chosen] || localDriver)();

module.exports = {
  name: driver.name,
  BOARD_IMAGE_DIR,
  save: (cafeId, file, ext) => driver.save(cafeId, file, ext),
  /** Deletes this cafe's images that the saved board no longer refers to. */
  prune: (cafeId, keep) => driver.prune(cafeId, keep),
  removeAll: (cafeId) => driver.removeAll(cafeId),
};
