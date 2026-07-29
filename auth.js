/**
 * Staff accounts, backed by Supabase Auth.
 *
 * Two roles, which is as few as the product allows:
 *
 *   owner — creates cafes and staff accounts, and may edit any cafe.
 *   staff — belongs to exactly one cafe: moderates its selfies and edits its
 *           board, and cannot see another cafe at all.
 *
 * Supabase holds the passwords. This module never sees or stores one beyond
 * forwarding it to Supabase on sign-in, so password reset, rate limiting and
 * hashing are all its problem rather than ours.
 *
 * Tokens live in HttpOnly cookies rather than localStorage: the admin pages
 * never need to read them, and a token no script can reach is one an injected
 * script cannot exfiltrate.
 *
 * With no Supabase configured the whole thing switches off and every request is
 * treated as an owner — that is what keeps `npm start` working on a laptop with
 * no account, and the admin pages say so in a banner so nobody mistakes a
 * development machine for a secured one.
 */

const cafes = require('./cafes');

const ACCESS_COOKIE = 'sw_at';
const REFRESH_COOKIE = 'sw_rt';

/* Supabase access tokens are short-lived; the refresh token is what actually
   keeps someone signed in, so it carries the long expiry. */
const REFRESH_MAX_AGE = 30 * 24 * 60 * 60 * 1000;

const enabled = cafes.isCloud && Boolean(cafes.db);
const db = cafes.db;

/** Stands in for a profile when auth is switched off, so callers need no branch. */
const DEV_OWNER = { id: 'dev', email: 'dev@localhost', role: 'owner', cafeId: null, dev: true };

function bad(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* -------------------------------------------------------------- cookies -- */

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function setSession(res, session) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL;
  const base = { httpOnly: true, sameSite: 'lax', secure: Boolean(secure), path: '/' };
  res.cookie(ACCESS_COOKIE, session.access_token, { ...base, maxAge: REFRESH_MAX_AGE });
  res.cookie(REFRESH_COOKIE, session.refresh_token, { ...base, maxAge: REFRESH_MAX_AGE });
}

function clearSession(res) {
  res.clearCookie(ACCESS_COOKIE, { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/' });
}

/* ------------------------------------------------------------- profiles -- */

const fromRow = (r) => r && {
  id: r.id, email: r.email, role: r.role, cafeId: r.cafe_id || null,
};

/**
 * The profile for a signed-in Supabase user, created on first sign-in.
 *
 * The very first account to sign in becomes the owner. Someone has to be, and
 * the alternative is a chicken-and-egg where no owner exists to promote anyone
 * — so the person who set the project up gets the keys. Everyone after that
 * arrives as staff with no cafe, which grants nothing until an owner assigns
 * one.
 */
async function profileFor(user) {
  const { data, error } = await db.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (error) throw new Error(`Supabase: ${error.message}`);
  if (data) return fromRow(data);

  const { count, error: countErr } = await db
    .from('profiles').select('id', { count: 'exact', head: true });
  if (countErr) throw new Error(`Supabase: ${countErr.message}`);

  const role = count === 0 ? 'owner' : 'staff';
  const { data: created, error: insertErr } = await db
    .from('profiles').insert({ id: user.id, email: user.email, role }).select().single();
  if (insertErr) throw new Error(`Supabase: ${insertErr.message}`);
  if (role === 'owner') console.log(`[auth] ${user.email} signed in first and is now the owner.`);
  return fromRow(created);
}

/* ---------------------------------------------------------------- flows -- */

async function login(email, password) {
  if (!enabled) throw bad('Sign-in needs Supabase configured.', 503);

  const { data, error } = await db.auth.signInWithPassword({
    email: String(email || '').trim(),
    password: String(password || ''),
  });
  // Deliberately one message for a wrong password and an unknown address:
  // telling them apart tells an attacker which addresses have accounts.
  if (error || !data?.session) throw bad('That email and password did not match.', 401);

  return { session: data.session, profile: await profileFor(data.user) };
}

/**
 * Resolves the caller, refreshing an expired access token when possible so a
 * moderator working a queue is never bounced to a login screen mid-shift.
 * Returns null when there is no valid session.
 */
async function resolve(req, res) {
  if (!enabled) return DEV_OWNER;

  const cookies = readCookies(req);
  const token = cookies[ACCESS_COOKIE];

  if (token) {
    const { data, error } = await db.auth.getUser(token);
    if (!error && data?.user) return profileFor(data.user);
  }

  const refresh = cookies[REFRESH_COOKIE];
  if (!refresh) return null;

  const { data, error } = await db.auth.refreshSession({ refresh_token: refresh });
  if (error || !data?.session) {
    if (res) clearSession(res);
    return null;
  }
  if (res) setSession(res, data.session);
  return profileFor(data.user);
}

async function logout(req, res) {
  if (enabled) {
    const token = readCookies(req)[ACCESS_COOKIE];
    // Best effort: the cookies come off regardless, so a failure here cannot
    // leave someone believing they are signed out when they are not.
    if (token) await db.auth.admin.signOut(token).catch(() => {});
  }
  clearSession(res);
}

/* ------------------------------------------------------------ user admin -- */

async function listUsers() {
  if (!enabled) return [DEV_OWNER];
  const { data, error } = await db.from('profiles').select('*').order('created_at');
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data.map(fromRow);
}

async function createUser({ email, password, role, cafeId }) {
  if (!enabled) throw bad('Creating staff accounts needs Supabase configured.', 503);
  if (!email) throw bad('An email address is required.', 400);
  if (!password || password.length < 8) throw bad('Passwords must be at least 8 characters.', 400);
  if (!['owner', 'staff'].includes(role)) throw bad('Role must be owner or staff.', 400);
  if (role === 'staff' && !cafeId) throw bad('Staff must be assigned to a cafe.', 400);

  const { data, error } = await db.auth.admin.createUser({
    email: String(email).trim(),
    password,
    // No mail is configured on a POC, so an unconfirmed account could never
    // sign in. The owner setting the password is the confirmation.
    email_confirm: true,
  });
  if (error) throw bad(error.message, 400);

  const { data: profile, error: profileErr } = await db.from('profiles')
    .upsert({ id: data.user.id, email: data.user.email, role, cafe_id: role === 'owner' ? null : cafeId })
    .select().single();
  if (profileErr) {
    // Don't leave an auth user with no profile: it could sign in and would then
    // be treated as brand new, which is how someone accidentally becomes staff
    // at the wrong cafe.
    await db.auth.admin.deleteUser(data.user.id).catch(() => {});
    throw new Error(`Supabase: ${profileErr.message}`);
  }
  return fromRow(profile);
}

async function updateUser(id, { role, cafeId }) {
  if (!enabled) throw bad('Editing staff needs Supabase configured.', 503);
  const patch = {};
  if (role !== undefined) {
    if (!['owner', 'staff'].includes(role)) throw bad('Role must be owner or staff.', 400);
    patch.role = role;
    if (role === 'owner') patch.cafe_id = null;
  }
  if (cafeId !== undefined && patch.cafe_id === undefined) patch.cafe_id = cafeId || null;
  if ((patch.role || 'staff') === 'staff' && patch.cafe_id === null && cafeId !== undefined) {
    throw bad('Staff must be assigned to a cafe.', 400);
  }

  const { data, error } = await db.from('profiles').update(patch).eq('id', id).select();
  if (error) throw new Error(`Supabase: ${error.message}`);
  return data.length ? fromRow(data[0]) : null;
}

async function deleteUser(id) {
  if (!enabled) throw bad('Removing staff needs Supabase configured.', 503);
  const { error } = await db.auth.admin.deleteUser(id);
  if (error) throw bad(error.message, 400);
  // The profiles row is removed by its cascade on auth.users.
  return true;
}

/* --------------------------------------------------------------- guards -- */

/** Attaches req.profile when there is a valid session. Never rejects. */
function attach() {
  return async (req, res, next) => {
    try {
      req.profile = await resolve(req, res);
    } catch (err) {
      req.profile = null;
    }
    next();
  };
}

/** API guard: 401 rather than a redirect, so fetch() sees a status it can act on. */
function requireUser(req, res, next) {
  if (req.profile) return next();
  res.status(401).json({ error: 'Sign in to continue.', signedOut: true });
}

function requireOwner(req, res, next) {
  if (!req.profile) return res.status(401).json({ error: 'Sign in to continue.', signedOut: true });
  if (req.profile.role !== 'owner') {
    return res.status(403).json({ error: 'Only an owner can do that.' });
  }
  next();
}

/** True when this profile may moderate or edit the given cafe. */
function canAccess(profile, cafeId) {
  if (!profile) return false;
  if (profile.role === 'owner') return true;
  return Boolean(cafeId) && profile.cafeId === cafeId;
}

/**
 * Cafe guard. A staff member asking about someone else's cafe gets a 404 rather
 * than a 403: a 403 would confirm that cafe exists, which is a directory of
 * every site on the system for anyone with one account.
 */
function requireCafe(req, res, next) {
  if (!req.profile) return res.status(401).json({ error: 'Sign in to continue.', signedOut: true });
  if (!canAccess(req.profile, req.params.cafeId)) {
    return res.status(404).json({ error: 'No such cafe.' });
  }
  next();
}

/** Page guard: send people to the sign-in page and back where they were going. */
function requirePage(req, res, next) {
  if (req.profile) return next();
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function describe() {
  return enabled ? 'supabase auth' : 'off (no Supabase configured — everyone is an owner)';
}

module.exports = {
  enabled,
  describe,
  login,
  logout,
  resolve,
  setSession,
  clearSession,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  attach,
  requireUser,
  requireOwner,
  requireCafe,
  requirePage,
  canAccess,
};
