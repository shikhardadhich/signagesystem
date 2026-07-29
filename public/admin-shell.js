/**
 * Shared behaviour for the signed-in pages.
 *
 * Every admin page needs the same four things: find out who is signed in, draw
 * the header, handle signing out, and talk to the API in a way that notices
 * when the session has gone. Doing that once here keeps the three pages from
 * disagreeing about any of it.
 *
 * Expects a header shaped like:
 *   <header class="top"><div class="top__inner">
 *     <h1 class="top__brand">… <span class="top__where" id="shell-where"></span></h1>
 *     <nav class="top__nav" id="shell-nav"></nav>
 *   </div></header>
 */

const $ = (id) => document.getElementById(id);

/** Who is signed in and what they can reach. Populated before any page renders. */
export const shell = { profile: null, cafes: [], authEnabled: true, cafeId: null };

/**
 * fetch() that understands two things the pages otherwise each reinvent: a
 * dropped session, and an error body that carries a human-readable message.
 */
export async function api(url, options = {}) {
  const opts = { ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, opts);
  if (res.status === 401) {
    // Session gone — bounce to sign-in rather than letting the page sit there
    // silently failing every poll.
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Signed out');
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/** The cafe id in /admin/<cafe>/…, or null on the picker. */
export function cafeIdFromPath() {
  const m = location.pathname.match(/^\/admin\/([^/]+)/);
  return m && m[1] !== 'cafes' ? m[1] : null;
}

/**
 * Loads the session and draws the header. Returns the profile, or redirects to
 * sign-in and never resolves if there isn't one.
 */
export async function boot({ where = '', nav = [] } = {}) {
  let me;
  try {
    me = await api('/api/auth/me');
  } catch (err) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    return new Promise(() => {});
  }

  shell.profile = me.profile;
  shell.cafes = me.cafes || [];
  shell.authEnabled = me.authEnabled;
  shell.cafeId = cafeIdFromPath();

  if ($('shell-where')) $('shell-where').textContent = where;
  renderNav(nav);

  if (!me.authEnabled) {
    document.body.prepend(banner(
      'Sign-in is switched off on this deployment, so anyone who can reach this ' +
      'page can edit every cafe. Configure Supabase before putting this anywhere public.'
    ));
  }

  return shell.profile;
}

function renderNav(links) {
  const nav = $('shell-nav');
  if (!nav) return;
  nav.replaceChildren();

  for (const link of links) {
    if (link.ownerOnly && shell.profile.role !== 'owner') continue;
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.label;
    if (link.href === location.pathname) a.setAttribute('aria-current', 'page');
    if (link.blank) { a.target = '_blank'; a.rel = 'noopener'; }
    nav.append(a);
  }

  const who = document.createElement('span');
  who.className = 'top__who';
  who.textContent = shell.profile.email + (shell.profile.role === 'owner' ? ' · owner' : '');
  nav.append(who);

  const out = document.createElement('button');
  out.className = 'top__out';
  out.type = 'button';
  out.textContent = 'Sign out';
  out.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    // Back to sign-in, not the marketing page: someone signing out of a shift
    // is usually handing the tablet to the next person.
    location.href = '/login';
  });
  nav.append(out);
}

function banner(text) {
  const p = document.createElement('p');
  p.className = 'notice notice--warn';
  p.style.margin = '0';
  p.style.borderRadius = '0';
  p.textContent = text;
  return p;
}

/* ------------------------------------------------------------- feedback -- */

let flashEl = null;
let flashTimer = null;

/** A short confirmation that gets out of the way on its own. */
export function flash(message, kind = 'ok') {
  if (!flashEl) {
    flashEl = document.createElement('div');
    flashEl.className = 'flash';
    document.body.append(flashEl);
  }
  flashEl.textContent = message;
  flashEl.dataset.kind = kind;
  flashEl.classList.add('is-on');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flashEl.classList.remove('is-on'), 2600);
}

/**
 * Two-click confirmation for anything irreversible. The button arms on the
 * first click and disarms itself after 5s, so a forgotten armed button can't be
 * triggered later by a stray click.
 */
export function arm(button, { armedLabel, idleLabel, onConfirm }) {
  let armed = false;
  let timer = null;

  const disarm = () => {
    clearTimeout(timer);
    armed = false;
    button.classList.remove('is-armed');
    button.textContent = idleLabel;
  };

  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.classList.add('is-armed');
      button.textContent = armedLabel;
      timer = setTimeout(disarm, 5000);
      return;
    }
    disarm();
    await onConfirm();
  });

  return disarm;
}
