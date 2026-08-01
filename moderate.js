/**
 * Automatic content moderation via the OpenAI Moderation API.
 *
 * Every upload carries three things a stranger will read off a cafe wall: a
 * name, a message and a photo. All three go through omni-moderation-latest
 * before anything is written to the store, so flagged content never reaches
 * the moderation dashboard, let alone the screen.
 *
 * Two design decisions worth knowing:
 *
 *   Reject at the door. A flagged upload is refused with a 422 and never
 *   stored. The alternative — store it and flag it for a human — means the
 *   thing you did not want on a screen is now sitting in a database and
 *   rendered as a thumbnail on the moderation page.
 *
 *   Fail open. A missing key, a timeout, or an OpenAI outage lets the upload
 *   through as normal `pending`, marked as unchecked. A human moderator is
 *   still the gate, so an API outage degrades the wall rather than closing it.
 *   The unchecked flag is what tells that moderator to look harder.
 *
 * No key set means moderation is simply off, which is what keeps `npm start`
 * working on a laptop with no OpenAI account.
 */

const ENDPOINT = process.env.OPENAI_MODERATION_URL || 'https://api.openai.com/v1/moderations';
const MODEL = process.env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest';
const API_KEY = process.env.OPENAI_MODERATION_APIKEY || process.env.OPENAI_API_KEY || '';

const TIMEOUT_MS = Number(process.env.MODERATION_TIMEOUT_MS || 8000);

/* Matches the upload limit in server.js, deliberately: a photo that can be
   uploaded is a photo that gets screened. This used to sit at 6 MB, below the
   limit, on the assumption that the phone had already downscaled everything —
   so when the upload page stopped doing that, full-size photos would have
   sailed past the filter unchecked and landed on a wall.

   OpenAI's ceiling is 20 MB per image, and base64 inflates by a third, so
   12 MB of JPEG is a ~16 MB request: comfortably inside it either way the
   limit is measured. Raise both together or not at all.

   The photo is sent whole rather than downscaled for the check, which is worth
   explaining because the opposite looks obviously cheaper. It isn't: the
   moderation endpoint is free, and the model downsamples internally anyway, so
   a smaller copy would buy a second or two of latency and nothing else. What
   it would cost is either a native image dependency on the server, or trusting
   the phone to make the copy — and a client that supplies both the copy and
   the original can send a clean thumbnail with anything at all behind it,
   which is not a filter, it is a formality. */
const MAX_IMAGE_BYTES = Number(process.env.MODERATION_MAX_IMAGE_BYTES || 12 * 1024 * 1024);

/* OpenAI's own `flagged` verdict is the trigger. MODERATION_THRESHOLD (0-1)
   optionally tightens that: any category scoring above it is blocked too,
   which is how a cafe dials in something stricter than the API default. */
const THRESHOLD = process.env.MODERATION_THRESHOLD
  ? Number(process.env.MODERATION_THRESHOLD)
  : null;

const enabled = Boolean(API_KEY);

/* What the customer is told. Deliberately vague about the category — telling
   someone their selfie tripped "sexual/minors" is worse than useless on a
   phone screen in a cafe. The categories go to the server log instead. */
const FIELD_COPY = {
  name: 'That name did not pass our automatic check. Try the name you actually go by.',
  message: 'That message did not pass our automatic check. Try rewording it.',
  photo: 'That photo did not pass our automatic check. Try a different one.',
};

/**
 * Runs the check.
 *
 * Returns { allowed, checked, blocked, skipped }:
 *   allowed  — false only when something was positively flagged.
 *   checked  — true when every part was actually inspected. False means the
 *              upload is going through unverified and needs a human eye.
 *   blocked  — { field, categories, message } when allowed is false.
 *   skipped  — [{ part, reason }] for anything that could not be checked.
 */
async function moderate({ name, message, file }) {
  if (!enabled) {
    return pass([{ part: 'all', reason: 'no-api-key' }]);
  }

  const texts = [
    ['name', name],
    ['message', message],
  ].filter(([, value]) => value && value.trim());

  const image = imageInput(file);
  const skipped = image.skipped ? [image.skipped] : [];

  const [textRes, imageRes] = await Promise.all([
    texts.length ? request(texts.map(([, value]) => value)) : null,
    image.input ? request([image.input]) : null,
  ]);

  /* The photo is judged first. When a submission trips on both its caption and
     its picture, the picture is the thing that would have been on the wall. */
  if (imageRes) {
    if (!imageRes.ok) skipped.push({ part: 'image', reason: imageRes.reason });
    else {
      const hit = firstHit(imageRes.results);
      if (hit) return block('photo', hit);
    }
  }

  if (textRes) {
    if (!textRes.ok) skipped.push({ part: 'text', reason: textRes.reason });
    else {
      /* One result per input string, in order — so a hit maps back to the
         field that caused it. If that ever stops holding, fall back to
         blaming the whole caption rather than the wrong field. */
      const aligned = textRes.results.length === texts.length;
      for (let i = 0; i < textRes.results.length; i += 1) {
        const hit = hitFor(textRes.results[i]);
        if (hit) return block(aligned ? texts[i][0] : 'message', hit);
      }
    }
  }

  return pass(skipped);
}

/* ------------------------------------------------------------- internals -- */

function pass(skipped) {
  return { allowed: true, checked: skipped.length === 0, blocked: null, skipped };
}

function block(field, hit) {
  return {
    allowed: false,
    checked: true,
    blocked: { field, categories: hit.categories, message: FIELD_COPY[field] || FIELD_COPY.message },
    skipped: [],
  };
}

/**
 * POSTs one input array. Never throws: a failure is a reason string, because
 * every caller here treats "could not check" as "let it through, unchecked".
 */
async function request(input) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ model: MODEL, input }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[moderation] ${res.status} from OpenAI — allowing unchecked. ${body.slice(0, 300)}`);
      return { ok: false, reason: `http-${res.status}` };
    }

    const data = await res.json();
    if (!Array.isArray(data.results)) return { ok: false, reason: 'bad-response' };
    return { ok: true, results: data.results };
  } catch (err) {
    const reason = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network';
    console.warn(`[moderation] ${reason} calling OpenAI — allowing unchecked. ${err.message}`);
    return { ok: false, reason };
  }
}

/** The categories a single result tripped, or null if it is clean. */
function hitFor(result) {
  if (!result) return null;

  const categories = Object.entries(result.categories || {})
    .filter(([, on]) => on === true)
    .map(([name]) => name);

  if (THRESHOLD !== null) {
    for (const [name, score] of Object.entries(result.category_scores || {})) {
      if (Number(score) >= THRESHOLD && !categories.includes(name)) categories.push(name);
    }
  }

  if (!result.flagged && !categories.length) return null;
  // flagged with no named category shouldn't happen, but don't drop the verdict.
  return { categories: categories.length ? categories : ['flagged'] };
}

function firstHit(results) {
  for (const result of results) {
    const hit = hitFor(result);
    if (hit) return hit;
  }
  return null;
}

/**
 * The image as a data URL. The API takes a URL, but at this point the photo is
 * still a buffer in memory and has deliberately not been stored yet — inlining
 * it is what keeps a flagged photo from ever being written.
 */
function imageInput(file) {
  if (!file || !file.buffer) return { input: null, skipped: null };

  if (file.buffer.length > MAX_IMAGE_BYTES) {
    return { input: null, skipped: { part: 'image', reason: 'too-large' } };
  }

  const type = SUPPORTED_IMAGE.has(file.mimetype) ? file.mimetype : null;
  if (!type) return { input: null, skipped: { part: 'image', reason: 'unsupported-type' } };

  return {
    input: {
      type: 'image_url',
      image_url: { url: `data:${type};base64,${file.buffer.toString('base64')}` },
    },
    skipped: null,
  };
}

const SUPPORTED_IMAGE = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

/** One line for /api/health and the startup banner. */
function describe() {
  if (!enabled) return 'off (no OPENAI_MODERATION_APIKEY)';
  return THRESHOLD !== null ? `${MODEL} (threshold ${THRESHOLD})` : MODEL;
}

module.exports = { moderate, describe, enabled, MODEL };
