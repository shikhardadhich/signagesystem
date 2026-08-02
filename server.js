/**
 * The Brew House — Selfie Wall
 *
 * Express app for every page. One deployment serves many cafes:
 *
 *   /<cafe>              the display screen, public, no login — a kiosk browser
 *                        that hit a login wall at 6am would show a sign-in box
 *                        to an empty room instead of a menu board.
 *   /<cafe>/upload       the phone page the QR code points at.
 *   /admin               staff sign in here; owners pick a cafe, staff go
 *                        straight to their own.
 *   /admin/<cafe>        moderation.
 *   /admin/<cafe>/board  the menu board editor.
 *
 * Persistence is behind store.js (selfies) and cafes.js (cafes and boards);
 * accounts are behind auth.js. Exports the app so api/index.js can mount it as
 * a Vercel function; only listens when run directly (`npm start`).
 */

const path = require('path');
const { Readable } = require('stream');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');

const store = require('./store');
const cafes = require('./cafes');
const jewel = require('./jewel');
const pass = require('./pass');
const auth = require('./auth');
const moderation = require('./moderate');

const app = express();
const PORT = process.env.PORT || 3000;

/* Uploads are held in memory and handed on, so a photo can be refused by the
   moderation filter before anything touches disk or an object store.
   The 12 MB cap is shared with moderate.js's MAX_IMAGE_BYTES on purpose —
   see the note there before changing either. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

/* Board artwork is a logo or a product shot, not a phone camera dump. The
   smaller cap keeps a mis-drop from filling the server's disk, and SVG is
   allowed here because logos usually are one. */
const boardImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

app.use(express.json());
app.use('/uploads', express.static(store.UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(auth.attach());

const page = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

/* ----------------------------------------------------------------- auth -- */

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const { session, profile } = await auth.login(email, password);
    auth.setSession(res, session);
    res.json({ profile, next: await landingFor(profile) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    await auth.logout(req, res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Everything the admin shell needs to draw itself: who you are, what you can reach. */
app.get('/api/auth/me', async (req, res, next) => {
  try {
    if (!req.profile) return res.status(401).json({ error: 'Sign in to continue.', signedOut: true });
    res.json({
      profile: req.profile,
      authEnabled: auth.enabled,
      cafes: await visibleCafes(req.profile),
    });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------------------------------------------- owner -- */

app.get('/api/cafes', auth.requireOwner, async (req, res, next) => {
  try {
    res.json(await cafes.list());
  } catch (err) {
    next(err);
  }
});

app.post('/api/cafes', auth.requireOwner, async (req, res, next) => {
  try {
    const { id, name } = req.body || {};
    res.status(201).json(await cafes.create({ id, name }));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/cafes/:cafeId', auth.requireOwner, async (req, res, next) => {
  try {
    const updated = await cafes.update(req.params.cafeId, { name: req.body?.name });
    if (!updated) return res.status(404).json({ error: 'No such cafe.' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

/**
 * Removes a cafe, its board images and every selfie ever sent to it. The owner
 * console asks twice before calling this.
 */
app.delete('/api/cafes/:cafeId', auth.requireOwner, async (req, res, next) => {
  try {
    const { cafeId } = req.params;
    if (!(await cafes.get(cafeId))) return res.status(404).json({ error: 'No such cafe.' });
    // Selfies first, while the cafe row is still there to scope the delete by.
    const { removed } = await store.clear(cafeId);
    await cafes.remove(cafeId);
    res.json({ ok: true, removedSubmissions: removed });
  } catch (err) {
    next(err);
  }
});

app.get('/api/users', auth.requireOwner, async (req, res, next) => {
  try {
    res.json(await auth.listUsers());
  } catch (err) {
    next(err);
  }
});

app.post('/api/users', auth.requireOwner, async (req, res, next) => {
  try {
    const { email, password, role, cafeId } = req.body || {};
    res.status(201).json(await auth.createUser({ email, password, role, cafeId }));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/users/:id', auth.requireOwner, async (req, res, next) => {
  try {
    if (req.params.id === req.profile.id && req.body?.role && req.body.role !== 'owner') {
      // Demoting the last owner would leave nobody able to create cafes or
      // staff, with no way back in short of editing the database by hand.
      return res.status(400).json({ error: 'You cannot remove your own owner role.' });
    }
    const updated = await auth.updateUser(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'No such user.' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/users/:id', auth.requireOwner, async (req, res, next) => {
  try {
    if (req.params.id === req.profile.id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    await auth.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------- public per cafe -- */

/** 404s an unknown cafe once, so every route below can assume it exists. */
async function loadCafe(req, res, next) {
  try {
    const cafe = await cafes.get(req.params.cafeId);
    if (!cafe) return res.status(404).json({ error: 'No such cafe.' });
    req.cafe = cafe;
    next();
  } catch (err) {
    next(err);
  }
}

app.get('/api/cafes/:cafeId/board', loadCafe, async (req, res, next) => {
  try {
    res.json(await cafes.getBoard(req.params.cafeId));
  } catch (err) {
    next(err);
  }
});

app.post('/api/cafes/:cafeId/upload', loadCafe, upload.single('photo'), async (req, res, next) => {
  try {
    /* Checked before anything else is looked at, including the photo: an
       expired pass means this upload should not be happening at all, and
       there is no sense moderating a picture that is going to be refused. */
    const why = pass.check(req.params.cafeId, req.body.pass);
    if (why) return res.status(403).json({ error: pass.reason(why), pass: why });

    if (!req.file) return res.status(400).json({ error: 'A photo is required' });

    const name = String(req.body.name || '').trim().slice(0, 40);
    const message = String(req.body.message || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'A name is required' });

    /* Enforced here and not only by the checkbox. A ticked box in a form is a
       claim the page makes; anything that skips the page — a script, a replayed
       request — would otherwise put someone's face on a public screen with no
       agreement behind it at all. */
    if (String(req.body.consent) !== 'yes') {
      return res.status(400).json({
        error: 'Please agree to the terms before sending your selfie.',
        field: 'consent',
      });
    }

    /* Before store.add, not after: a flagged photo is refused while it is
       still only a buffer in memory, so it is never written anywhere. */
    const verdict = await moderation.moderate({ name, message, file: req.file });
    if (!verdict.allowed) {
      console.warn(
        `[moderation] blocked ${verdict.blocked.field} from "${name}" at ${req.params.cafeId} — ` +
        `${verdict.blocked.categories.join(', ')}`
      );
      return res.status(422).json({
        error: verdict.blocked.message,
        field: verdict.blocked.field,
        moderation: 'blocked',
      });
    }

    const submission = await store.add(req.params.cafeId, name, message, req.file, {
      checked: verdict.checked,
      skipped: verdict.skipped.length ? verdict.skipped : undefined,
      at: Date.now(),
    });
    const all = await store.list(req.params.cafeId);
    res.status(201).json({ ...submission, position: pendingPosition(all, submission.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/cafes/:cafeId/queue', loadCafe, async (req, res, next) => {
  try {
    res.json(approvedQueue(await store.list(req.params.cafeId)));
  } catch (err) {
    next(err);
  }
});

app.get('/api/cafes/:cafeId/wall', loadCafe, async (req, res, next) => {
  try {
    res.json(await store.getWall(req.params.cafeId));
  } catch (err) {
    next(err);
  }
});

app.get('/api/cafes/:cafeId/status/:id', loadCafe, async (req, res, next) => {
  try {
    const { cafeId, id } = req.params;
    const submission = await store.get(cafeId, id);
    if (!submission) return res.status(404).json({ error: 'Not found' });

    const all = await store.list(cafeId);
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

/* The QR carries a pass that expires, so the screen has to be asked for a new
   code every minute or so — see pass.js. `ttl` comes back with it so the screen
   knows how often to ask without the interval being written down twice. */
app.get('/api/cafes/:cafeId/qr', loadCafe, async (req, res, next) => {
  try {
    const query = pass.enabled ? `?p=${encodeURIComponent(pass.issue(req.params.cafeId))}` : '';
    const target = `${publicBase(req)}/${req.params.cafeId}/upload${query}`;
    const dataUrl = await QRCode.toDataURL(target, {
      width: 512,
      margin: 1,
      color: { dark: '#3B2415', light: '#FFFFFF' },
    });
    res.json({ dataUrl, target, ttlMs: pass.enabled ? pass.TTL_MS : null });
  } catch (err) {
    next(err);
  }
});

/**
 * Serves a photo held in a private Blob store, which a browser cannot fetch
 * directly. Public stores never reach this route — their records already point
 * at the CDN URL.
 */
app.get('/api/cafes/:cafeId/photo/:id', loadCafe, async (req, res, next) => {
  try {
    if (typeof store.openPhoto !== 'function') return res.status(404).end();

    const submission = await store.get(req.params.cafeId, req.params.id);
    if (!submission) return res.status(404).json({ error: 'Not found' });

    const photo = await store.openPhoto(submission);
    if (!photo) return res.status(404).json({ error: 'Photo unavailable' });

    res.setHeader('Content-Type', photo.contentType || 'image/jpeg');
    // A given id's bytes never change, so this is safe to cache hard.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    Readable.fromWeb(photo.stream).pipe(res);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------ guarded per cafe -- */

app.get('/api/cafes/:cafeId/submissions', auth.requireCafe, loadCafe, async (req, res, next) => {
  try {
    // Newest first — moderators care about the freshest arrivals.
    const all = await store.list(req.params.cafeId);
    res.json(all.sort((a, b) => b.submittedAt - a.submittedAt));
  } catch (err) {
    next(err);
  }
});

for (const [action, status] of [['approve', 'approved'], ['reject', 'rejected']]) {
  app.post(
    `/api/cafes/:cafeId/submissions/:id/${action}`,
    auth.requireCafe, loadCafe,
    async (req, res, next) => {
      try {
        const updated = await store.setStatus(req.params.cafeId, req.params.id, status);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    }
  );
}

/** Wipes this cafe's submissions and their images. The admin page double-clicks. */
app.delete('/api/cafes/:cafeId/submissions', auth.requireCafe, loadCafe, async (req, res, next) => {
  try {
    res.json(await store.clear(req.params.cafeId));
  } catch (err) {
    next(err);
  }
});

app.post('/api/cafes/:cafeId/wall', auth.requireCafe, loadCafe, async (req, res, next) => {
  try {
    const { mode } = req.body || {};
    if (!store.WALL_MODES.includes(mode)) {
      return res.status(400).json({ error: `mode must be one of ${store.WALL_MODES.join(', ')}` });
    }
    res.json(await store.setWall(req.params.cafeId, mode));
  } catch (err) {
    next(err);
  }
});

app.put('/api/cafes/:cafeId/board', auth.requireCafe, loadCafe, async (req, res, next) => {
  try {
    const saved = await cafes.setBoard(req.params.cafeId, req.body);
    if (!saved) return res.status(404).json({ error: 'No such cafe.' });
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

app.post('/api/cafes/:cafeId/board/reset', auth.requireCafe, loadCafe, async (req, res, next) => {
  try {
    res.json(await cafes.resetBoard(req.params.cafeId));
  } catch (err) {
    next(err);
  }
});

app.post(
  '/api/cafes/:cafeId/board/image',
  auth.requireCafe, loadCafe, boardImage.single('image'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'An image is required' });
      res.status(201).json({ url: await cafes.saveImage(req.params.cafeId, req.file) });
    } catch (err) {
      next(err);
    }
  }
);

/* --------------------------------------------------------------- jewel -- */

/* A second kind of screen, for a jewellery counter: today's gold and silver
   rates, the shop's branding, the local weather, and a rotating window of
   featured pieces. One shop for now — it exists to be shown from the landing
   page — so these routes carry no id, unlike the cafe's. */

app.get('/api/jewel', async (req, res, next) => {
  try {
    res.json(await jewel.get());
  } catch (err) {
    next(err);
  }
});

/* Weather is fetched here rather than in the browser: the screen is a kiosk
   that may sit behind a filtered network, and one server-side call every
   fifteen minutes serves every screen in the shop.

   For the screen, a failure is a 200 with a null body — the panel disappears
   and the rates stay up, which is the right trade when the weather is the
   least important thing on the wall. For the editor's "check this city", the
   same silence would be useless, so ?city= reports what actually went wrong
   and tests what has been typed rather than what was last saved. */
app.get('/api/jewel/weather', async (req, res, next) => {
  const probe = req.query.city ? { city: req.query.city, region: req.query.region || '' } : null;
  try {
    const wx = await jewel.weather(probe);
    if (probe && !wx) return res.status(404).json({ error: 'Name a city to look up.' });
    res.json(wx);
  } catch (err) {
    if (probe) return next(err);
    res.json(null);
  }
});

/* The code the strip along the bottom carries. Rendered here rather than in
   the browser so the screen needs no QR library of its own, and returned as a
   data URL so it survives a kiosk with no outbound access. */
app.get('/api/jewel/qr', async (req, res, next) => {
  try {
    const { qr } = await jewel.get();
    if (!qr.url) return res.json({ dataUrl: null });
    res.json({
      dataUrl: await QRCode.toDataURL(qr.url, {
        margin: 1,
        width: 480,
        color: { dark: '#1a1408', light: '#ffffff' },
      }),
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/jewel', auth.requireUser, async (req, res, next) => {
  try {
    res.json(await jewel.save(req.body));
  } catch (err) {
    next(err);
  }
});

app.post('/api/jewel/reset', auth.requireUser, async (req, res, next) => {
  try {
    res.json(await jewel.reset());
  } catch (err) {
    next(err);
  }
});

app.post(
  '/api/jewel/image',
  auth.requireUser, boardImage.single('image'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'An image is required' });
      res.status(201).json({ url: await jewel.saveImage(req.file) });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------------------------------------------------------------- pages -- */

/* The front door is the marketing page, signed in or not. Someone who arrives
   at the bare domain is far more likely to be a visitor than a barista, and a
   staff member with a session is one click from /admin anyway. */
app.get('/', page('landing.html'));

app.get('/login', (req, res, next) => {
  if (!req.profile) return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  // Already signed in: skip the form and go where signing in would have sent them.
  landingFor(req.profile).then((target) => res.redirect(target)).catch(next);
});

/** Owners choose a cafe; staff only ever have one, so skip the choosing. */
app.get('/admin', auth.requirePage, async (req, res, next) => {
  try {
    const target = await landingFor(req.profile);
    if (target !== '/admin') return res.redirect(target);
    res.sendFile(path.join(__dirname, 'public', 'cafes.html'));
  } catch (err) {
    next(err);
  }
});

app.get('/admin/cafes', auth.requirePage, (req, res) => {
  if (req.profile.role !== 'owner') return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'cafes.html'));
});

/* Ahead of /admin/:cafeId, or "jewel" would be read as a cafe id and 404 on a
   cafe that does not exist. Same reason /jewel sits above /:cafeId below. */
app.get('/admin/jewel', auth.requirePage, page('jewel-admin.html'));

app.get('/admin/:cafeId', auth.requirePage, guardCafePage, page('admin.html'));
app.get('/admin/:cafeId/board', auth.requirePage, guardCafePage, page('board.html'));

app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    storage: store.describe(),
    cloud: store.isCloud,
    cafes: cafes.driver,
    auth: { enabled: auth.enabled, detail: auth.describe() },
    moderation: { enabled: moderation.enabled, detail: moderation.describe() },
    uploadPasses: { enabled: pass.enabled, detail: pass.describe() },
  });
});

/* The kiosk URLs from before cafes existed. Sending them to the only cafe
   keeps a TV that was already pointed at /screen working after the upgrade. */
for (const [legacy, suffix] of [['/screen', ''], ['/upload', '/upload']]) {
  app.get(legacy, async (req, res, next) => {
    try {
      const all = await cafes.list();
      if (all.length === 1) return res.redirect(`/${all[0].id}${suffix}`);
      res.redirect('/');
    } catch (err) {
      next(err);
    }
  });
}

/**
 * The public screen and phone page, last so they cannot shadow anything above.
 * An unknown cafe gets the marketing page rather than a bare 404: the usual
 * cause is a typo in a URL somebody read off a sticky note.
 */
/* The jewellery demo. Public like the cafe screen and for the same reason: a
   kiosk browser that lost its session overnight must still come up showing the
   shop, not a login box with nobody there to type into it. */
app.get('/jewel', page('jewel.html'));

app.get('/:cafeId', publicCafePage('screen.html'));
app.get('/:cafeId/upload', publicCafePage('upload.html'));

function publicCafePage(file) {
  return async (req, res, next) => {
    const { cafeId } = req.params;
    if (cafes.RESERVED.has(cafeId)) return next();
    try {
      if (!(await cafes.get(cafeId))) {
        return res.status(404).sendFile(path.join(__dirname, 'public', 'landing.html'));
      }
      res.sendFile(path.join(__dirname, 'public', file));
    } catch (err) {
      next(err);
    }
  };
}

/** Page-level cafe guard: a redirect rather than the API's JSON 404. */
async function guardCafePage(req, res, next) {
  if (!auth.canAccess(req.profile, req.params.cafeId)) return res.redirect('/admin');
  try {
    if (!(await cafes.get(req.params.cafeId))) return res.redirect('/admin');
    next();
  } catch (err) {
    next(err);
  }
}

/* -------------------------------------------------------------- helpers -- */

async function visibleCafes(profile) {
  if (profile.role === 'owner') return cafes.list();
  if (!profile.cafeId) return [];
  const cafe = await cafes.get(profile.cafeId);
  return cafe ? [{ id: cafe.id, name: cafe.name }] : [];
}

/** Where signing in should drop you. */
async function landingFor(profile) {
  if (profile.role === 'owner') return '/admin/cafes';
  const mine = await visibleCafes(profile);
  // Staff with no cafe assigned yet: the picker explains that rather than
  // bouncing them to a cafe they cannot see.
  return mine.length === 1 ? `/admin/${mine[0].id}` : '/admin';
}

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
  const message = err.message || 'Something went wrong';

  // A suspended or over-quota store surfaces as a provider error that means
  // nothing to a customer holding a phone. Say what actually happened, and
  // name the active driver — without it "the photo store is unavailable" gives
  // an operator nothing to act on.
  if (/suspend|quota|limit exceeded|payment/i.test(message)) {
    return res.status(503).json({
      error: 'The photo store is unavailable right now, so this photo could not be saved. ' +
        'Please try again later.',
      storage: store.describe(),
      detail: message,
    });
  }

  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
  res.status(status).json({ error: message, storage: store.describe() });
});

if (require.main === module) {
  const base = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  app.listen(PORT, async () => {
    console.log(`\n  ☕  Selfie Wall`);
    console.log(`      Storage: ${store.describe()}`);
    console.log(`      Cafes  : ${cafes.driver}`);
    console.log(`      Sign-in: ${auth.describe()}`);
    console.log(`      Filter : ${moderation.describe()}`);
    console.log(`      Admin  : ${base}/admin`);
    try {
      for (const cafe of await cafes.list()) {
        console.log(`      Screen : ${base}/${cafe.id}   (${cafe.name})`);
      }
    } catch (err) {
      console.log(`      Screen : could not list cafes — ${err.message}`);
    }
    console.log('');
  });
}

module.exports = app;
