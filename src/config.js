/**
 * Central configuration for JalRakshak (Mangaluru flood-watch MVP).
 * All environment-tunable values live here so the rest of the app
 * reads plain constants. Nothing in here needs npm packages.
 */

const env = process.env;

/** TCP port the HTTP server listens on. */
const PORT = Number(env.PORT || 3000);

/** Host to bind. 0.0.0.0 so phones on the same Wi-Fi/LAN can reach it. */
const HOST = env.HOST || '0.0.0.0';

/**
 * Resolve a path relative to this module.
 *
 * In Node this behaves exactly as it always has. In runtimes where
 * `import.meta.url` is not a usable base (e.g. the bundled Cloudflare Worker)
 * these filesystem directories are meaningless — the Worker serves files from
 * the [assets] binding and stores data in D1 — so we return '' instead of
 * throwing a TypeError while the module is still being imported.
 */
function moduleRelativePath(specifier) {
  try {
    return new URL(specifier, import.meta.url).pathname
      .replace(/^\/([A-Za-z]:)/, '$1'); // strip leading slash for Windows drive paths
  } catch {
    return '';
  }
}

/** Directory that holds the built front-end (index.html, app.js, ...). */
const PUBLIC_DIR = moduleRelativePath('../public/');

/** Where uploaded photos/voice notes are written. */
const UPLOAD_DIR = env.UPLOAD_DIR || moduleRelativePath('../uploads/');

/** SQLite database file. ':memory:' is also accepted for tests. */
const DB_PATH = env.DB_PATH || moduleRelativePath('../data/jalrakshak.db');

/** Shared secret for admin endpoints. Change for any real deployment. */
const ADMIN_TOKEN = env.ADMIN_TOKEN || 'admin-dev-token';

/**
 * Geographic bounding box used to project real lat/lng onto the stylised
 * SVG map in the front-end, and as the default query window.
 * Approximate Mangaluru city + immediate outskirts.
 * TODO(verify): tighten these to the 60 MCC wards once boundary data is available.
 */
const CITY_BBOX = { minLat: 12.80, maxLat: 12.99, minLng: 74.79, maxLng: 74.91 };

/** Default city centre (Hampankatta) — used for "near me" fallbacks. */
const CITY_CENTER = { lat: 12.8720, lng: 74.8430 };

/** Report lifetime before it auto-expires off the active map. */
const REPORT_TTL_HOURS = Number(env.REPORT_TTL_HOURS || 6);

/** Each "still flooded" confirmation pushes expiry out by this much (capped). */
const CONFIRM_EXTEND_HOURS = 3;

/** Absolute cap on expiry extension, so a report can never live forever. */
const REPORT_MAX_AGE_HOURS = 24;

/** Radius (metres) used to cluster independent reports for confidence + dedupe. */
const NEARBY_RADIUS_M = Number(env.NEARBY_RADIUS_M || 300);

/** Corridor half-width (metres) for "floods near my route" checks. */
const ROUTE_BUFFER_M = Number(env.ROUTE_BUFFER_M || 150);

/** Max base64 image bytes accepted (after client-side compression). 4 MB. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Simple sliding-window rate limits. */
const RATE_LIMITS = {
  /** Reports per reporter per window. */
  reportPerMinute: 10,
  /** Confirmations per reporter per window. */
  confirmPerMinute: 30,
  /** Generic auth attempts per IP per window. */
  authPerMinute: 20,
  windowMs: 60 * 1000
};

/**
 * Water-depth selector values → base severity level.
 * green = passable, amber = caution, red = avoid.
 */
const DEPTH_TO_LEVEL = {
  'ankle': 'green',
  'knee': 'amber',
  'waist': 'amber',
  'vehicle-stalling': 'red',
  'impassable': 'red'
};

/** Human labels matching the front-end depth buttons. */
const DEPTH_LABELS = {
  'ankle': 'Ankle',
  'knee': 'Knee',
  'waist': 'Waist',
  'vehicle-stalling': 'Vehicles stall',
  'impassable': 'Impassable'
};

export {
  PORT, HOST, PUBLIC_DIR, UPLOAD_DIR, DB_PATH, ADMIN_TOKEN,
  CITY_BBOX, CITY_CENTER, REPORT_TTL_HOURS, CONFIRM_EXTEND_HOURS,
  REPORT_MAX_AGE_HOURS, NEARBY_RADIUS_M, ROUTE_BUFFER_M, MAX_IMAGE_BYTES,
  RATE_LIMITS, DEPTH_TO_LEVEL, DEPTH_LABELS
};
