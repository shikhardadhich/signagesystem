/**
 * Short-lived passes for the upload page.
 *
 * The point is that a photograph of the QR code stops working. Without this,
 * anybody who snapped the code on their way past can upload to a cafe's wall
 * from home, next week, as many times as they like — the URL never changed and
 * nothing about it said when it was handed out.
 *
 * A pass carries an expiry and a signature over it. Both halves matter:
 *
 *   - The expiry has to be *in* the code, because the screen mints a new one
 *     every minute. A code someone photographed is stale within a minute of
 *     them walking away.
 *   - The signature has to be checked by the server, because a timestamp the
 *     page validates is a timestamp the person can edit. `?t=` in a query
 *     string is a suggestion, not a lock.
 *
 * Format is `<expiry-in-seconds>.<signature>`, kept short deliberately: every
 * extra character is more modules in the QR, and a denser code is a slower
 * scan across a cafe.
 */

const crypto = require('crypto');

/** How long a pass is good for, and how often the screen mints a fresh one. */
const TTL_MS = Number(process.env.QR_PASS_TTL_MS || 6 * 60 * 1000);
/** Off is for a deployment that wants the old always-on URL back. */
const enabled = String(process.env.QR_PASSES || 'on').toLowerCase() !== 'off';

/* Any stable server-side secret will do — it never leaves the server and is
   only used to sign a two-field token. Preferring an explicit QR_SECRET keeps
   passes valid across a key rotation; falling back to the other secrets means
   a hosted deployment gets signed passes without another variable to set.

   The last resort is a random key per process, which is right for `npm start`
   and wrong on serverless: instances would not agree on what they had signed,
   so every second upload would be rejected. Hence the warning. */
const secret =
  process.env.QR_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.BLOB_READ_WRITE_TOKEN ||
  process.env.SUPABASE_KEY ||
  null;

const key = secret || crypto.randomBytes(32).toString('hex');

if (enabled && !secret) {
  console.warn(
    '[pass] No QR_SECRET (or Supabase/Blob key) set, so upload passes are signed with a ' +
    'key generated at boot. Fine on one machine; on a host that runs more than one ' +
    'instance the instances will not agree and uploads will be refused at random. ' +
    'Set QR_SECRET before deploying.'
  );
}

function sign(cafeId, exp) {
  return crypto
    .createHmac('sha256', key)
    .update(`${cafeId}.${exp}`)
    .digest('base64url')
    // Half the digest is 128 bits, which is far more than enough to stop
    // anyone guessing a pass, and 22 fewer characters in the QR code.
    .slice(0, 22);
}

/** A pass for this cafe, good for TTL_MS from now. */
function issue(cafeId) {
  const exp = Math.floor((Date.now() + TTL_MS) / 1000);
  return `${exp}.${sign(cafeId, exp)}`;
}

/**
 * Why a pass is not acceptable, or null when it is.
 *
 * Expiry is checked *after* the signature on purpose: reporting "expired" for
 * a token that was never valid would tell a forger their format was right and
 * only the clock was wrong.
 */
function check(cafeId, pass) {
  if (!enabled) return null;
  if (!pass) return 'missing';

  const [expPart, sig] = String(pass).split('.');
  const exp = Number(expPart);
  if (!expPart || !sig || !Number.isFinite(exp)) return 'malformed';

  const expected = sign(cafeId, expPart);
  // Constant-time: a byte-by-byte comparison leaks how much of a guess was
  // right, which is how a signature gets forged one character at a time.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'invalid';

  if (exp * 1000 < Date.now()) return 'expired';
  return null;
}

/** Seconds left on a pass, for the page's countdown. Never negative. */
function remaining(pass) {
  const exp = Number(String(pass || '').split('.')[0]);
  if (!Number.isFinite(exp)) return 0;
  return Math.max(0, Math.round((exp * 1000 - Date.now()) / 1000));
}

const REASONS = {
  missing: 'This upload link is missing its pass. Scan the QR code on the screen in the cafe.',
  malformed: 'This upload link is not one of ours. Scan the QR code on the screen in the cafe.',
  invalid: 'This upload link is not one of ours. Scan the QR code on the screen in the cafe.',
  expired: 'This code has expired. Scan the QR code on the screen again — codes last a few minutes so photos come from people actually in the cafe.',
};

module.exports = {
  enabled,
  TTL_MS,
  issue,
  check,
  remaining,
  reason: (why) => REASONS[why] || REASONS.invalid,
  describe: () =>
    enabled
      ? `on (${Math.round(TTL_MS / 60000)} min${secret ? '' : ', boot-generated key'})`
      : 'off (upload links never expire)',
};
