/**
 * JalRakshak — local server entry point.
 *
 * A dependency-free Node HTTP server that:
 *   - serves the built front-end from /public (and uploaded images from /uploads)
 *   - exposes the JSON API under /api/*
 *   - streams live updates via Server-Sent Events at /api/events
 *   - enforces light rate limiting and bearer-token auth
 *
 * Run:  node server.js    (uses built-in node:sqlite, so Node 22+ recommended)
 */
import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORT, HOST, UPLOAD_DIR, ADMIN_TOKEN, CITY_BBOX, RATE_LIMITS } from './src/config.js';
import * as store from './src/db.js';
import { Router, sendJson, readJson, RateLimiter, EventHub } from './src/http.js';
import * as api from './src/api.js';
import { HOTSPOTS } from './src/seed-hotspots.js';
import { nowMs } from './src/util.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const router = new Router();
const limiter = new RateLimiter();
const hub = new EventHub();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.webm': 'audio/webm'
};

// Seed reference hotspots once on first boot.
if (store.allHotspots().length === 0) store.seedHotspots(HOTSPOTS);

/* --------------------------------- helpers ------------------------------------ */

const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
const bearer = (req) => (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1] || null;
const currentReporter = (req) => { const t = bearer(req); return t ? store.reporterFromToken(t) : null; };
function requireReporter(req) {
  const reporter = currentReporter(req);
  if (!reporter) throw Object.assign(new Error('Sign in to continue'), { status: 401 });
  return reporter;
}
function rateLimit(req, bucket, limit) {
  const reporter = currentReporter(req);
  const { ok, retryAfterSec } = limiter.check(`${bucket}:${reporter ? reporter.id : clientIp(req)}`, limit);
  if (!ok) throw Object.assign(new Error('Too many requests — slow down'), { status: 429, retryAfterSec });
}
function parseBBox(query) {
  const { minLat, maxLat, minLng, maxLng } = query;
  if ([minLat, maxLat, minLng, maxLng].every((v) => v !== undefined)) {
    const box = { minLat: +minLat, maxLat: +maxLat, minLng: +minLng, maxLng: +maxLng };
    if ([box.minLat, box.maxLat, box.minLng, box.maxLng].every(Number.isFinite)) return box;
  }
  return null;
}
const adminOk = (req) => {
  const reporter = currentReporter(req);
  if (reporter && reporter.is_admin === 1) return true;
  const header = req.headers['x-admin-token'];
  return !!(header && header === ADMIN_TOKEN);
};

/* ---------------------------------- routes ------------------------------------ */

router.get('/api/health', () => ({ status: 200, body: { ok: true, ts: nowMs(), city: 'Mangaluru' } }));
router.get('/api/config', () => ({
  status: 200,
  body: { cityBBox: CITY_BBOX, disclaimer: 'Community-reported. Not an official warning. In an emergency, follow local authorities.' }
}));

// Auth
router.post('/api/session', () => ({ status: 201, body: api.createAnonymousSession() }));
router.post('/api/auth/otp', async (req, body) => {
  rateLimit(req, 'auth', RATE_LIMITS.authPerMinute);
  return { status: 200, body: api.requestOtp(body.phone) };
});
router.post('/api/auth/verify', async (req, body) => {
  rateLimit(req, 'auth', RATE_LIMITS.authPerMinute);
  return { status: 200, body: api.verifyOtp(body.phone, body.code) };
});
router.post('/api/auth/logout', (req) => { const t = bearer(req); if (t) store.endSession(t); return { status: 200, body: { ok: true } }; });
router.get('/api/me', (req) => {
  const reporter = currentReporter(req);
  return { status: 200, body: reporter ? { reporterId: reporter.id, reputation: reporter.reputation, isAdmin: reporter.is_admin === 1 } : null };
});

// Reports
router.get('/api/reports', (req, body, query) => ({ status: 200, body: { reports: api.listReports(parseBBox(query)) } }));
router.post('/api/reports', async (req, body) => {
  rateLimit(req, 'report', RATE_LIMITS.reportPerMinute);
  const reporter = requireReporter(req);
  const result = await api.createReport(reporter, body);
  hub.broadcast({ type: 'report:new', data: result.report });
  return { status: 201, body: result };
});
router.get('/api/reports/mine', (req) => ({ status: 200, body: { reports: api.listMyReports(requireReporter(req)) } }));
router.get('/api/reports/:id', (req, body, query, params) => ({ status: 200, body: api.getReportDetail(params.id) }));
router.post('/api/reports/:id/confirm', (req, body, query, params) => {
  rateLimit(req, 'confirm', RATE_LIMITS.confirmPerMinute);
  const reporter = requireReporter(req);
  const result = api.confirmReport(reporter, params.id, body.kind);
  hub.broadcast({ type: 'report:update', data: result.report });
  return { status: 200, body: result };
});

// Route check
router.post('/api/route-check', (req, body) => {
  const from = { lat: Number(body.from?.lat), lng: Number(body.from?.lng) };
  const to = { lat: Number(body.to?.lat), lng: Number(body.to?.lng) };
  return { status: 200, body: api.checkRoute(from, to) };
});

// Saved places
router.get('/api/places', (req) => ({ status: 200, body: { places: api.listSavedPlaces(requireReporter(req)) } }));
router.post('/api/places', (req, body) => ({ status: 201, body: { places: api.addSavedPlace(requireReporter(req), body) } }));
router.delete('/api/places/:id', (req, body, query, params) => ({ status: 200, body: { removed: api.removeSavedPlace(requireReporter(req), params.id) } }));

// Hotspots (reference seed data)
router.get('/api/hotspots', () => ({ status: 200, body: { hotspots: api.listHotspots() } }));

// Admin
router.get('/api/admin/queue', (req) => {
  if (!adminOk(req)) throw Object.assign(new Error('Admin access required'), { status: 403 });
  return { status: 200, body: { reports: api.moderationQueue() } };
});
router.post('/api/admin/moderate/:id', (req, body, query, params) => {
  if (!adminOk(req)) throw Object.assign(new Error('Admin access required'), { status: 403 });
  return { status: 200, body: api.moderate(params.id, body.action) };
});
router.get('/api/admin/stats', (req) => {
  if (!adminOk(req)) throw Object.assign(new Error('Admin access required'), { status: 403 });
  return { status: 200, body: api.stats() };
});


/* ------------------------------ static serving -------------------------------- */

async function serveStatic(pathname, res) {
  const asset = pathname === '/' ? '/index.html' : pathname;
  let base = join(root, 'public');
  let rel = asset;
  if (asset.startsWith('/uploads/')) { base = normalize(UPLOAD_DIR); rel = asset.slice('/uploads'.length); }
  const filePath = normalize(join(base, rel));
  if (!filePath.startsWith(base)) { res.writeHead(403); return res.end('Forbidden'); }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error('is dir');
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': asset.startsWith('/uploads/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    return res.end(content);
  } catch {
    if (extname(asset)) { res.writeHead(404); return res.end('Not found'); }
    try {
      const html = await readFile(join(root, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(html);
    } catch { res.writeHead(500); return res.end('Front-end not found'); }
  }
}

/* --------------------------------- server ------------------------------------- */

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Token');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (url.pathname === '/api/events') return hub.addClient(res);

    const match = router.match(req.method, url.pathname);
    if (match) {
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readJson(req) : {};
      const result = await match.handler(req, body, Object.fromEntries(url.searchParams), match.params);
      return sendJson(res, result.status ?? 200, result.body ?? {});
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(url.pathname, res);
    res.writeHead(405); res.end('Method not allowed');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[server error]', err);
    if (!res.headersSent) {
      const headers = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {};
      return sendJson(res, status, { error: err.message || 'Server error' }, headers);
    }
    res.end();
  }
});

// Periodic expiry sweep so the live map self-cleans during storms.
setInterval(() => { try { store.runExpirySweep(); } catch {} }, 60 * 1000).unref?.();
mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});

// Auto-listen only when run directly (not when imported by tests).
const invokedDirectly = process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  JalRakshak — Mangaluru flood watch`);
    console.log(`  ➜  Local:   http://localhost:${PORT}`);
    console.log(`  ➜  Network: http://<your-ip>:${PORT}   (open on phones on same Wi-Fi)`);
    console.log(`  ➜  Admin:   http://localhost:${PORT}/admin.html  (token: ${ADMIN_TOKEN})`);
    console.log(`  ➜  Storage: zero-dependency node:sqlite (WAL)\n`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { try { store.db.close(); } catch {} server.close(() => process.exit(0)); });
  }
}

