/**
 * Cafes and their menu boards.
 *
 * A cafe's id is the slug in its public URL — `domain.com/brew-house` is the
 * display, `domain.com/brew-house/upload` is the phone page. That is why the id
 * is a hand-chosen slug rather than a uuid: someone types it into a kiosk
 * browser once and it has to be readable off a sticky note.
 *
 * Two drivers, chosen the same way store.js chooses its own:
 *
 *   supabase — the real one. Cafes live in Postgres, the whole board is one
 *              jsonb document because the editor reads and writes it as a unit
 *              and the screen wants it in a single request.
 *   local    — one cafe in data/cafes.json, so `npm start` still runs the whole
 *              app on a laptop with no Supabase account. Multi-cafe needs the
 *              real driver; this exists so the POC never stops booting.
 *
 * `public/menu.json` stays in the repo as the shipped default board. A cafe
 * with an empty board renders that until someone saves the editor, so a brand
 * new cafe shows a complete screen instead of a blank one.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CAFES_FILE = path.join(DATA_DIR, 'cafes.json');
const DEFAULT_BOARD_FILE = path.join(__dirname, 'public', 'menu.json');

/* Board images go through their own storage module, which picks a backend the
   same way the selfie storage does. Per-cafe prefixes so deleting a cafe is one
   sweep and two cafes can both have a "logo.png" without collision. */
const assets = require('./assets');

const hasSupabase = Boolean(
  process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
);

/** The id that appears in a URL. Kept to what reads well in a browser bar. */
const ID_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/* Paths the screen and admin routes already own. A cafe called "admin" would
   make /admin ambiguous, so the name is refused at creation rather than
   producing a cafe that can never be reached. */
const RESERVED = new Set([
  'admin', 'api', 'assets', 'uploads', 'login', 'logout', 'screen', 'upload',
  'favicon.ico', 'theme.css', 'menu.json', 'robots.txt', 'health', 'static',
]);

function validateId(id) {
  const value = String(id || '').trim().toLowerCase();
  if (!ID_RE.test(value)) {
    throw bad(
      'A cafe address must be 1-40 characters of lowercase letters, numbers and ' +
      'hyphens, starting and ending with a letter or number — for example "brew-house".'
    );
  }
  if (RESERVED.has(value)) throw bad(`"${value}" is reserved and can't be used as a cafe address.`);
  return value;
}

function bad(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* ------------------------------------------------------------- defaults -- */

let defaultBoard = null;

/** The board shipped in the repo, used by any cafe that has not been edited. */
function defaults() {
  if (!defaultBoard) {
    try {
      defaultBoard = JSON.parse(fs.readFileSync(DEFAULT_BOARD_FILE, 'utf8'));
    } catch (err) {
      defaultBoard = {};
    }
  }
  return JSON.parse(JSON.stringify(defaultBoard));
}

/**
 * Trims a board down to the shape the screen actually renders.
 *
 * Everything is length-capped rather than rejected: a name three times too long
 * for the header is a layout bug on a TV nobody is watching, and silently
 * clipping it is kinder than refusing a save. The caps are generous enough that
 * ordinary copy never notices them.
 */
function normalise(input, cafeName) {
  const board = input && typeof input === 'object' ? input : {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  /* A number the screen will divide by or set a timer from. Anything outside
     the range is clamped rather than refused: a board that stopped rotating
     because someone typed 0 would look like the app had crashed. */
  const num = (v, min, max, fallback) => {
    // Absent means "use the default", not "use the minimum". Without this,
    // Number(null) is 0 and a missing dwell time would clamp to the fastest
    // setting there is — a board flickering every 3 seconds.
    if (v === null || v === undefined || v === '') return fallback;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const clean = {
    name: str(board.name, 60) || cafeName || '',
    tagline: str(board.tagline, 120),
    established: str(board.established, 12),
    logo: str(board.logo, 300),
    sectionTitle: str(board.sectionTitle, 60) || 'Our Signatures',
    /* How the menu cycles. More items than fit on the board at once are dealt
       out a page at a time, so a cafe can show a dozen things on a panel drawn
       for four. perPage at or above the item count means no rotation at all. */
    rotation: {
      perPage: num(board.rotation?.perPage, 1, 8, 4),
      seconds: num(board.rotation?.seconds, 3, 60, 8),
    },
    /* Blank rows are dropped before the cap, not after: the editor leaves an
       empty row behind whenever someone adds one and changes their mind, and
       counting it against the limit would silently cost a real item its slot. */
    items: (Array.isArray(board.items) ? board.items : []).map((it) => ({
      name: str(it?.name, 60),
      description: str(it?.description, 140),
      price: str(it?.price, 20),
      image: str(it?.image, 300),
      // Kept so the shipped line-art stand-ins keep working: the screen walks
      // image -> fallback -> crest, which is what stops a missing file leaving
      // a blank slot on the board.
      fallback: str(it?.fallback, 300),
    })).filter((it) => it.name).slice(0, 8),
    banner: {
      title: str(board.banner?.title, 90),
      subtitle: str(board.banner?.subtitle, 140),
    },
    wall: {
      kicker: str(board.wall?.kicker, 40),
      title: str(board.wall?.title, 40),
      subtitle: str(board.wall?.subtitle, 90),
      steps: (Array.isArray(board.wall?.steps) ? board.wall.steps : []).map((s) => ({
        title: str(s?.title, 30),
        detail: str(s?.detail, 60),
      })).filter((s) => s.title).slice(0, 4),
    },
  };

  return clean;
}

/** Every image path a board refers to, used to find orphaned uploads. */
function referencedImages(board) {
  const out = new Set();
  if (board?.logo) out.add(board.logo);
  for (const item of board?.items || []) {
    if (item.image) out.add(item.image);
    if (item.fallback) out.add(item.fallback);
  }
  return out;
}

/* --------------------------------------------------------------- images -- */

const EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg',
};

/**
 * Stores an uploaded image and returns the URL the board should keep.
 *
 * Where it goes is assets.js's decision, and it follows the same environment as
 * the selfie storage: a Supabase bucket or Vercel Blob when hosted, the app's
 * own public/assets/board/ folder when running on an ordinary server. Writing
 * to disk unconditionally is what used to break this on serverless, where the
 * filesystem is read-only.
 */
async function saveImage(cafeId, file) {
  const ext = EXT[file.mimetype];
  if (!ext) throw bad('Images must be JPEG, PNG, WEBP, GIF or SVG.');

  try {
    return await assets.save(cafeId, file, ext);
  } catch (err) {
    if (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM') {
      throw bad(
        'This deployment cannot write to its own folder, so board images cannot be ' +
        'saved here. Configure a Supabase bucket or a Vercel Blob store (see ' +
        'README.md) and redeploy.',
        503
      );
    }
    throw bad(`The image could not be saved (${err.code || err.message}).`, 503);
  }
}

/**
 * Removes uploads this cafe no longer refers to. Runs after a successful save,
 * never before: losing the old image while the new board fails to write would
 * leave the board pointing at nothing.
 */
async function pruneImages(cafeId, board) {
  // Never let tidying up fail a board save that has already succeeded — a
  // leftover file is cheaper than a rejected edit.
  await assets.prune(cafeId, referencedImages(board)).catch(() => {});
}

async function removeImages(cafeId) {
  await assets.removeAll(cafeId).catch(() => {});
}

/* --------------------------------------------------------------- local -- */

function localDriver() {
  /** { [id]: { id, name, board, createdAt } } */
  let cafes = null;

  function load() {
    if (cafes) return cafes;
    try {
      cafes = JSON.parse(fs.readFileSync(CAFES_FILE, 'utf8'));
    } catch (err) {
      // First run: adopt the board shipped in the repo as the one cafe, so the
      // app comes up already showing something rather than an empty screen.
      const board = defaults();
      cafes = {
        'brew-house': {
          id: 'brew-house',
          name: board.name || 'The Brew House',
          board: {},
          createdAt: Date.now(),
        },
      };
    }
    return cafes;
  }

  async function persist() {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    // Write then rename: a torn write here would leave every cafe unreachable.
    const tmp = `${CAFES_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(cafes, null, 2));
    await fs.promises.rename(tmp, CAFES_FILE);
  }

  return {
    name: 'local',
    async list() {
      return Object.values(load())
        .map(({ id, name, createdAt }) => ({ id, name, createdAt }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async get(id) {
      const found = load()[id];
      return found ? { ...found } : null;
    },
    async create({ id, name }) {
      const all = load();
      if (all[id]) throw bad(`A cafe already lives at /${id}.`, 409);
      all[id] = { id, name, board: {}, createdAt: Date.now() };
      await persist();
      return { ...all[id] };
    },
    async update(id, { name }) {
      const found = load()[id];
      if (!found) return null;
      if (name !== undefined) found.name = name;
      await persist();
      return { ...found };
    },
    async remove(id) {
      const all = load();
      if (!all[id]) return false;
      delete all[id];
      await persist();
      return true;
    },
    async setBoard(id, board) {
      const found = load()[id];
      if (!found) return null;
      found.board = board;
      await persist();
      return board;
    },
  };
}

/* ------------------------------------------------------------ supabase -- */

function supabaseDriver() {
  const { createClient } = require('@supabase/supabase-js');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
    { auth: { persistSession: false } }
  );

  const check = ({ data, error }) => {
    if (error) throw new Error(`Supabase: ${error.message}`);
    return data;
  };

  const fromRow = (r) => r && {
    id: r.id,
    name: r.name,
    board: r.board || {},
    createdAt: r.created_at ? Date.parse(r.created_at) : null,
  };

  return {
    name: 'supabase',
    db,
    async list() {
      const rows = check(await db.from('cafes').select('id, name, created_at').order('name'));
      return rows.map((r) => ({ id: r.id, name: r.name, createdAt: Date.parse(r.created_at) }));
    },
    async get(id) {
      const { data, error } = await db.from('cafes').select('*').eq('id', id).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return fromRow(data) || null;
    },
    async create({ id, name }) {
      const { data, error } = await db.from('cafes').insert({ id, name }).select().single();
      // 23505 is a duplicate primary key: the address is taken, which is a
      // sentence a person can act on rather than a Postgres error code.
      if (error && error.code === '23505') throw bad(`A cafe already lives at /${id}.`, 409);
      if (error) throw new Error(`Supabase: ${error.message}`);
      return fromRow(data);
    },
    async update(id, { name }) {
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (!Object.keys(patch).length) return this.get(id);
      const rows = check(await db.from('cafes').update(patch).eq('id', id).select());
      return rows.length ? fromRow(rows[0]) : null;
    },
    async remove(id) {
      const rows = check(await db.from('cafes').delete().eq('id', id).select('id'));
      return rows.length > 0;
    },
    async setBoard(id, board) {
      const rows = check(await db.from('cafes').update({ board }).eq('id', id).select('board'));
      return rows.length ? rows[0].board : null;
    },
  };
}

const driver = hasSupabase ? supabaseDriver() : localDriver();

/* ---------------------------------------------------------------- api -- */

module.exports = {
  driver: driver.name,
  isCloud: driver.name === 'supabase',
  db: driver.db || null,
  validateId,
  defaults,
  normalise,
  saveImage,
  RESERVED,

  list: () => driver.list(),
  get: (id) => driver.get(id),

  async create({ id, name }) {
    const slug = validateId(id);
    const label = String(name || '').trim().slice(0, 60);
    if (!label) throw bad('A cafe needs a name.');
    return driver.create({ id: slug, name: label });
  },

  async update(id, patch) {
    const label = patch.name === undefined ? undefined : String(patch.name).trim().slice(0, 60);
    if (label !== undefined && !label) throw bad('A cafe needs a name.');
    return driver.update(id, { name: label });
  },

  async remove(id) {
    const gone = await driver.remove(id);
    if (gone) await removeImages(id);
    return gone;
  },

  /**
   * The board the screen should render: what was saved, or the shipped default
   * for a cafe nobody has edited yet — so a new cafe is never a blank TV.
   */
  async getBoard(id) {
    const cafe = await driver.get(id);
    if (!cafe) return null;
    const stored = cafe.board && Object.keys(cafe.board).length ? cafe.board : defaults();
    return normalise(stored, cafe.name);
  },

  async setBoard(id, input) {
    const cafe = await driver.get(id);
    if (!cafe) return null;
    const board = normalise(input, cafe.name);
    const saved = await driver.setBoard(id, board);
    // Only once the board is safely stored: an image deleted before a failed
    // save would leave the live board pointing at a file that no longer exists.
    await pruneImages(id, board);
    return saved;
  },

  /** Drops a cafe's board back to the one shipped in the repo. */
  async resetBoard(id) {
    const cafe = await driver.get(id);
    if (!cafe) return null;
    await driver.setBoard(id, {});
    await pruneImages(id, {});
    return normalise(defaults(), cafe.name);
  },
};
