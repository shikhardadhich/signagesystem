/**
 * The jewellery screen: today's gold and silver rates, the shop's branding, the
 * local weather, and a rotating set of featured pieces.
 *
 * Rates are typed in by staff each morning rather than pulled from a feed. That
 * is not a shortcut — an Indian jeweller's counter rate is their own number,
 * set from their supplier and their making charges, and a spot price off an API
 * would be wrong on the wall by the time anyone looked at it.
 *
 * Storage follows the same two-driver shape as the rest of the app:
 *
 *   supabase — one row in the settings table, keyed "jewel:<shop>". Reusing
 *              that table rather than adding one keeps this deployable against
 *              an existing database with no migration to run.
 *   local    — data/jewel.json, so `npm start` runs the demo with no account.
 */

const fs = require('fs');
const path = require('path');

const cafes = require('./cafes');
const assets = require('./assets');

const DATA_DIR = path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'jewel.json');

/** One shop for now. The id is the image prefix and the settings key. */
const SHOP = 'jewel';
const KEY = `jewel:${SHOP}`;

const hasSupabase = Boolean(
  process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY)
);

function bad(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/* ------------------------------------------------------------- defaults -- */

/* What an unedited screen shows. A demo that opens on an empty black rectangle
   tells a prospect nothing, so the shipped config is a complete, plausible
   shop — the same role public/menu.json plays for the cafe board. */
function defaults() {
  return {
    shop: {
      name: 'Rajhans Jewellers',
      tagline: 'Trusted since 1986',
      logo: '',
    },
    weather: {
      show: true,
      // Matches the shipped rates, which are Indore's. A demo quoting one
      // city's gold beside another city's weather invites the question.
      city: 'Indore',
      region: 'Madhya Pradesh',
    },
    rates: {
      note: 'Rates are inclusive of GST',
      updatedAt: '10:00 AM',
      day: null,
      /* Gold is quoted by purity, not by movement. A customer at the counter is
         choosing between 22K for a bangle and 18K for a stone setting, and the
         three prices side by side is the comparison they came in to make —
         which is why this panel carries no "vs yesterday" the way silver does. */
      gold: [
        { karat: '24K', purity: '99.9%', perGram: 14465, per10Gram: 144650 },
        { karat: '22K', purity: '91.6%', perGram: 13260, per10Gram: 132600 },
        { karat: '18K', purity: '75.0%', perGram: 10850, per10Gram: 108500 },
      ],
      /* Yesterday's figures are deliberately equal to today's. A shipped
         default that claims silver rose ₹1.20 is inventing a movement, and
         the first real rate anybody types would then be measured against a
         demo number — "▲ +₹143.50 vs yesterday" is a lie about the market
         printed at head height in a shop. No change is the honest opening
         position; a genuine one appears the day after the first real edit. */
      silver: { purity: '999', perGram: 91.5, perKg: 73200, prevPerGram: 91.5, prevPerKg: 73200 },
    },
    featured: {
      seconds: 8,
      caption: 'Timeless beauty. Crafted for you.',
      items: [],
    },
    trust: [
      { title: '100% Hallmarked', detail: 'Jewellery' },
      { title: 'Best Exchange', detail: 'Value' },
      { title: 'Certified', detail: 'Diamonds' },
      { title: 'Trusted Legacy', detail: 'Since 1986' },
    ],
    qr: { url: '', label: 'Scan to Explore Our Collection' },
  };
}

/* ------------------------------------------------------------ normalise -- */

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/**
 * A rate as the screen will print it. Blank and unparseable both become null
 * rather than 0: a screen reading "₹0 per gram" is worse than one that quietly
 * leaves the line out while somebody fixes it.
 */
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,\s₹]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  // Two decimals is as fine as silver gets quoted; more is a typo.
  return Math.round(n * 100) / 100;
}

function normalise(input) {
  const c = input && typeof input === 'object' ? input : {};
  const base = defaults();
  const rates = c.rates || {};
  const silver = rates.silver || {};

  return {
    shop: {
      name: str(c.shop?.name, 40) || base.shop.name,
      tagline: str(c.shop?.tagline, 60),
      logo: str(c.shop?.logo, 300),
    },
    weather: {
      show: c.weather?.show === undefined ? true : Boolean(c.weather.show),
      city: str(c.weather?.city, 60),
      region: str(c.weather?.region, 60),
    },
    rates: {
      note: str(rates.note, 80),
      updatedAt: str(rates.updatedAt, 20),
      /* The calendar day the current figures were entered. It is what makes
         "vs yesterday" mean yesterday: without it, correcting a typo an hour
         later would compare today against this morning and print a change
         nobody made. */
      day: str(rates.day, 10) || null,
      /* And the day the *previous* figures are from. Null means there isn't a
         genuine earlier day yet — the first rate anybody enters has nothing
         behind it, and a screen must not manufacture a movement out of that. */
      prevDay: str(rates.prevDay, 10) || null,
      /* Four is the cap: a fourth line is 14K, and a fifth is a table nobody
         reads from across a shop floor. A row with no karat is a half-filled
         editor row, not a price, so it is dropped rather than printed blank. */
      gold: (Array.isArray(rates.gold) ? rates.gold : base.rates.gold)
        .map((g) => ({
          karat: str(g?.karat, 8),
          purity: str(g?.purity, 10),
          perGram: money(g?.perGram),
          per10Gram: money(g?.per10Gram),
        }))
        .filter((g) => g.karat)
        .slice(0, 4),
      silver: {
        purity: str(silver.purity, 8) || '999',
        perGram: money(silver.perGram),
        perKg: money(silver.perKg),
        prevPerGram: money(silver.prevPerGram),
        prevPerKg: money(silver.prevPerKg),
      },
    },
    featured: {
      // Below 4s a photograph is a flicker; above 30s the screen looks frozen.
      seconds: Math.min(30, Math.max(4, Math.round(Number(c.featured?.seconds) || 8))),
      caption: str(c.featured?.caption, 80),
      /* Four is the cap because the panel is one large photograph, not a grid:
         past four nobody standing at a counter sees the end of the rotation. */
      items: (Array.isArray(c.featured?.items) ? c.featured.items : [])
        .map((it) => ({ image: str(it?.image, 300), caption: str(it?.caption, 80) }))
        .filter((it) => it.image)
        .slice(0, 4),
    },
    trust: (Array.isArray(c.trust) ? c.trust : base.trust)
      .map((t) => ({ title: str(t?.title, 30), detail: str(t?.detail, 30) }))
      .filter((t) => t.title)
      .slice(0, 4),
    qr: {
      url: str(c.qr?.url, 300),
      label: str(c.qr?.label, 60),
    },
  };
}

/** Every image the config refers to, used to sweep up replaced uploads. */
function referencedImages(config) {
  const out = new Set();
  if (config?.shop?.logo) out.add(config.shop.logo);
  for (const item of config?.featured?.items || []) if (item.image) out.add(item.image);
  return out;
}

/* --------------------------------------------------------------- rates -- */

/** Today, in the shop's own calendar. Rates are a per-day fact, not a UTC one. */
function today(tz = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/**
 * Carries yesterday's silver figures forward so staff only ever type today's.
 *
 * The rule is per calendar day, not per save. The first save of a new day files
 * whatever was on the screen as "previous"; every later save that day is a
 * correction and leaves the comparison alone. Shifting on every save would make
 * fixing a mistyped digit look like the price moved twice.
 *
 * Gold is not in here: it is quoted by purity rather than by movement, so there
 * is nothing to carry forward.
 */
function rollRates(saved, incoming) {
  const day = today();
  const first = saved.rates.day !== day;

  /* Three states, and the middle one is the one that bit us.

     No stored day at all — nobody has ever entered a rate here, so what is on
     screen is the shipped demo. A real counter rate measured against that
     prints a movement nobody made.

     A stored day but no prevDay — a rate has been entered, but only ever on
     one day, so there is still nothing behind it. Corrections that day must
     keep filing the figure as its own yesterday rather than treating this
     morning's first attempt as history.

     Both stored — the ordinary case, and the only one where the comparison
     means what the screen says it means. */
  const seeding = !saved.rates.day;
  const grounded = Boolean(saved.rates.prevDay);

  const pick = (was, now, prev) => {
    // Blank means blank. The editor saves the whole document, so an empty box
    // is a decision to drop that line — and a dropped line has nothing to be
    // compared against, so yesterday's figure goes with it.
    if (now === null) return { now: null, prev: null };
    // Nothing behind this figure yet: it stands as its own yesterday, on the
    // day it is first entered and through any corrections that same day.
    if (seeding || (!grounded && !first)) return { now, prev: now };
    // Same day: a correction, so the comparison stays where it was.
    if (!first) return { now, prev };
    /* A new day rolls the figure back even when it hasn't moved. Skipping the
       roll on an unchanged rate would leave yesterday's "▼ −₹2" on the wall
       describing a fall that happened the day before. */
    return { now, prev: was };
  };

  const s = incoming.rates.silver;
  const ss = saved.rates.silver;

  const perGram = pick(ss.perGram, s.perGram, s.prevPerGram ?? ss.prevPerGram);
  const perKg = pick(ss.perKg, s.perKg, s.prevPerKg ?? ss.prevPerKg);
  const moved = perGram.now !== ss.perGram || perKg.now !== ss.perKg;

  /* On a fresh install only a real edit claims a day. Saving the logo against
     the shipped demo figures must not enrol them as yesterday's market, or the
     first rate anybody types tomorrow is measured against invented numbers —
     which is exactly the "▲ +₹143.50" that started this. Once a genuine figure
     is on file, any save on a new day rolls it: the rate on the wall was the
     rate yesterday, whether or not somebody retyped it today. */
  return {
    ...incoming,
    rates: {
      ...incoming.rates,
      day: seeding ? (moved ? day : null) : day,
      // The seed day leaves this unset: the day after it is the first day the
      // screen has anything true to say about the market.
      prevDay: first && !seeding ? saved.rates.day : saved.rates.prevDay,
      silver: {
        ...incoming.rates.silver,
        perGram: perGram.now, prevPerGram: perGram.prev,
        perKg: perKg.now, prevPerKg: perKg.prev,
      },
    },
  };
}

/* ------------------------------------------------------------- drivers -- */

function localDriver() {
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (err) {
      cache = defaults();
    }
    return cache;
  }

  return {
    name: 'local',
    async get() {
      return normalise(load());
    },
    async put(config) {
      cache = config;
      try {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
        await fs.promises.writeFile(FILE, JSON.stringify(config, null, 2));
      } catch (err) {
        /* A read-only disk loses this on restart, which is the local driver's
           standing bargain everywhere else in the app too. The screen still
           shows what was just saved for as long as the process lives. */
      }
      return config;
    },
  };
}

function supabaseDriver() {
  const db = cafes.db;

  return {
    name: 'supabase',
    async get() {
      const { data, error } = await db
        .from('settings').select('value').eq('id', KEY).maybeSingle();
      if (error) throw new Error(`Supabase: ${error.message}`);
      return normalise(data ? data.value : defaults());
    },
    async put(config) {
      const { error } = await db.from('settings').upsert({ id: KEY, value: config });
      if (error) throw new Error(`Supabase: ${error.message}`);
      return config;
    },
  };
}

const driver = hasSupabase && cafes.db ? supabaseDriver() : localDriver();

/* ------------------------------------------------------------- weather -- */

/* Open-Meteo needs no key and no account, which is the whole reason it is here:
   a demo that cannot be run without someone first signing up for a weather API
   is a demo that does not get run. Two calls — a name to coordinates, then
   coordinates to a forecast — and both are cached, because the weather does not
   change between two screens polling four seconds apart. */

const GEO_TTL = 24 * 60 * 60 * 1000;
const WEATHER_TTL = 15 * 60 * 1000;
const geoCache = new Map();
let weatherCache = { key: null, at: 0, value: null };

async function geocode(city, region) {
  const key = `${city}|${region}`.toLowerCase();
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL) return hit.value;

  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(city)}&count=10&language=en&format=json`;

  let results;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`the lookup service answered ${res.status}`);
    ({ results } = await res.json());
  } catch (err) {
    // Distinguishable from "no such city", because the fixes are different:
    // one is a spelling, the other is a firewall or an outage.
    throw bad(`Couldn't reach the weather service (${err.message}).`, 503);
  }
  if (!results || !results.length) throw bad(`Couldn't find a place called "${city}".`, 404);

  /* Prefer a match in the named region — "Springfield" alone is a coin toss —
     but never let a mismatched region veto the city entirely. Open-Meteo names
     Indian states as it pleases, and a screen showing no weather because
     somebody wrote "MP" instead of "Madhya Pradesh" is the worse outcome. */
  const wanted = region.trim().toLowerCase();
  const match = (wanted && results.find((r) => {
    const admin = String(r.admin1 || '').toLowerCase();
    return admin === wanted || admin.includes(wanted) || wanted.includes(admin);
  })) || results[0];

  const value = {
    lat: match.latitude,
    lon: match.longitude,
    city: match.name,
    region: match.admin1 || '',
    timezone: match.timezone || 'auto',
  };
  geoCache.set(key, { at: Date.now(), value });
  return value;
}

/* Open-Meteo reports conditions as WMO codes. Grouped rather than mapped
   one-to-one: a screen across a shop floor wants "Rain", not "moderate drizzle,
   freezing". */
const CONDITIONS = [
  [[0], 'Clear', 'clear'],
  [[1, 2], 'Partly Cloudy', 'partly'],
  [[3], 'Cloudy', 'cloudy'],
  [[45, 48], 'Fog', 'fog'],
  [[51, 53, 55, 56, 57], 'Drizzle', 'rain'],
  [[61, 63, 65, 66, 67, 80, 81, 82], 'Rain', 'rain'],
  [[71, 73, 75, 77, 85, 86], 'Snow', 'snow'],
  [[95, 96, 99], 'Thunderstorm', 'storm'],
];

function describeCode(code) {
  for (const [codes, label, icon] of CONDITIONS) {
    if (codes.includes(code)) return { label, icon };
  }
  return { label: 'Weather', icon: 'cloudy' };
}

/**
 * @param {object} [where] a city to look up instead of the saved one, so the
 *   editor can test what has been typed before anyone commits it to a wall.
 *   A typo is otherwise invisible: the panel just quietly never appears.
 */
async function weather(where) {
  const config = await driver.get();
  const city = where ? String(where.city || '').trim() : config.weather.city;
  const region = where ? String(where.region || '').trim() : config.weather.region;
  if (!city) return null;
  if (!where && !config.weather.show) return null;

  const key = `${city}|${region}`;
  // A probe from the editor skips the cache: "check this city" that answers
  // from fifteen minutes ago is not a check.
  if (!where && weatherCache.key === key && Date.now() - weatherCache.at < WEATHER_TTL) {
    return weatherCache.value;
  }

  const place = await geocode(city, region);
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${place.lat}&longitude=${place.lon}`
    + '&current=temperature_2m,weather_code'
    + '&daily=temperature_2m_max,temperature_2m_min'
    + `&timezone=${encodeURIComponent(place.timezone)}&forecast_days=1`;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`the forecast service answered ${res.status}`);
    data = await res.json();
  } catch (err) {
    // Wrapped like the geocode call above: a cached place means this is the
    // only request that runs, so it has to explain itself just as clearly.
    throw bad(`Couldn't reach the weather service (${err.message}).`, 503);
  }

  const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  const value = {
    now: round(data.current?.temperature_2m),
    high: round(data.daily?.temperature_2m_max?.[0]),
    low: round(data.daily?.temperature_2m_min?.[0]),
    ...describeCode(data.current?.weather_code),
    place: [place.city, place.region].filter(Boolean).join(', '),
    at: Date.now(),
  };

  // A probe must not seed the cache the screen reads: someone typing a city
  // they then decide against would leave it on the wall for a quarter hour.
  if (!where) weatherCache = { key, at: Date.now(), value };
  return value;
}

/* ----------------------------------------------------------------- api -- */

module.exports = {
  SHOP,
  defaults,
  describe: () => driver.name,

  async get() {
    return driver.get();
  },

  /** Saves an edited config, rolling yesterday's rates forward on the way. */
  async save(input) {
    const saved = await driver.get();
    const clean = rollRates(saved, normalise(input));
    const stored = await driver.put(clean);
    // After the save, never before: dropping an image while the write fails
    // would leave the screen pointing at a photo that is no longer there.
    await assets.prune(SHOP, referencedImages(stored)).catch(() => {});
    return stored;
  },

  async reset() {
    const stored = await driver.put(normalise(defaults()));
    await assets.prune(SHOP, referencedImages(stored)).catch(() => {});
    return stored;
  },

  /** Stores an uploaded photo and hands back the URL to put in the config. */
  async saveImage(file) {
    const EXT = {
      'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
      'image/webp': '.webp', 'image/gif': '.gif',
    };
    const ext = EXT[file.mimetype];
    if (!ext) throw bad('Images must be JPEG, PNG, WEBP or GIF.');
    try {
      return await assets.save(SHOP, file, ext);
    } catch (err) {
      if (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM') {
        throw bad(
          'This deployment cannot write to its own folder, so images cannot be ' +
          'saved here. Configure a Supabase bucket or a Vercel Blob store and redeploy.',
          503
        );
      }
      throw bad(`The image could not be saved (${err.code || err.message}).`, 503);
    }
  },

  weather,
};
