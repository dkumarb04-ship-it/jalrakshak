/**
 * JalRakshak — Cloudflare Worker entry point.
 *
 * Ports the Node server.js request pipeline to the Workers runtime:
 *   - static assets are served by the [assets] binding (assets-first routing)
 *   - JSON API under /api/* backed by D1 (see store.js / api.js)
 *   - photo serving from D1 under /uploads/*
 *   - CORS, light rate limiting, and bearer-token / admin auth
 *
 * Differences from the Node server (documented for parity):
 *   - Photos live in D1 (R2 unavailable on no-login temporary deploys).
 *   - /api/events keeps EventSource alive with heartbeats; there is no
 *     cross-isolate broadcast, so live data arrives via the existing 60s poll.
 *   - Rate-limit state is per-isolate and best-effort.
 */
import { ADMIN_TOKEN, CITY_BBOX, RATE_LIMITS } from '../../src/config.js';
import { nowMs } from './store.js';
import * as api from './api.js';
import { HOTSPOTS } from '../../src/seed-hotspots.js';

import * as store from './store.js';

/* --------------------------------- helpers ----------------------------------- */

const bearer = (req) => (/^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || '') || [])[1] || null;
const clientIp = (req) => (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim();

async function currentReporter(req, env) {
  const t = bearer(req);
  return t ? store.reporterFromToken(env.DB, t) : null;
}

async function requireReporter(req, env) {
  const reporter = await currentReporter(req, env);
  if (!reporter) throw Object.assign(new Error('Sign in to continue'), { status: 401 });
  return reporter;
}

function adminOk(req, reporter, env) {
  if (reporter && reporter.is_admin === 1) return true;
  const header = req.headers.get('x-admin-token');
  return !!(header && header === (env.ADMIN_TOKEN || ADMIN_TOKEN));
}

function parseBBox(query) {
  const { minLat, maxLat, minLng, maxLng } = query;
  if ([minLat, maxLat, minLng, maxLng].every((v) => v !== undefined)) {
    const box = { minLat: +minLat, maxLat: +maxLat, minLng: +minLng, maxLng: +maxLng };
    if ([box.minLat, box.maxLat, box.minLng, box.maxLng].every(Number.isFinite)) return box;
  }
  return null;
}

/* ------------------------------ rate limiting -------------------------------- */

const hits = new Map();
function rateLimit(req, bucket, limit) {
  const now = Date.now();
  const windowMs = RATE_LIMITS.windowMs;
  const key = `${bucket}:${clientIp(req)}`;
  let entry = hits.get(key);
  if (!entry || now - entry.start >= windowMs) { entry = { start: now, count: 0 }; hits.set(key, entry); }
  entry.count += 1;
  if (hits.size > 10000) for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
  if (entry.count > limit) {
    const retryAfterSec = Math.ceil((windowMs - (now - entry.start)) / 1000);
    throw Object.assign(new Error('Too many requests — slow down'), { status: 429, retryAfterSec });
  }
}

/* ------------------------------ schema bootstrap ------------------------------ */

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  const row = await db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='reporters'`
  ).first();
  if (row) {
    const hs = await db.prepare(`SELECT COUNT(*) AS n FROM hotspots`).first();
    if ((hs?.n ?? 0) === 0) await store.seedHotspots(db, HOTSPOTS);
    schemaReady = true;
    return;
  }
  const SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, place TEXT NOT NULL,
  depth TEXT NOT NULL, level TEXT NOT NULL, road_blocked INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '', photo_path TEXT, reporter_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', confidence REAL NOT NULL DEFAULT 0.5,
  confirmations INTEGER NOT NULL DEFAULT 0, disputes INTEGER NOT NULL DEFAULT 0,
  rainfall_mm REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_expires ON reports(expires_at);
CREATE INDEX IF NOT EXISTS idx_reports_bbox ON reports(lat, lng);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL, reporter_id TEXT NOT NULL,
  kind TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_conf_report ON confirmations(report_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conf_unique ON confirmations(report_id, reporter_id, kind);
CREATE TABLE IF NOT EXISTS reporters (
  id TEXT PRIMARY KEY, phone_hash TEXT UNIQUE, display_name TEXT,
  reputation REAL NOT NULL DEFAULT 1.0, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS saved_places (
  id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, label TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_places_reporter ON saved_places(reporter_id);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sessions_reporter ON sessions(reporter_id);
CREATE TABLE IF NOT EXISTS hotspots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, area TEXT, lat REAL NOT NULL, lng REAL NOT NULL,
  cause TEXT, baseline TEXT, source TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);`;
  await db.exec(SCHEMA);
  await store.seedHotspots(db, HOTSPOTS);
  schemaReady = true;
}

/* -------------------------------- responses ---------------------------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Admin-Token'
};
const json = (status, data, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra }
  });

/* ------------------------------- helpers I/O ---------------------------------- */

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

/* ---------------------------------- routing ---------------------------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === '/api/events') return sse();

      if (path.startsWith('/api/')) {
        await ensureSchema(env.DB);
        return await handleApi(request, env, url);
      }

      if (path.startsWith('/uploads/')) return servePhoto(env, path);

      if (method === 'GET' || method === 'HEAD') {
        const res = await env.ASSETS.fetch(request);
        if (res.status !== 404) return res;
        if (!/\.[a-z0-9]+$/i.test(path)) {
          const idx = await env.ASSETS.fetch(new Request(new URL('/index.html', url)));
          return new Response(await idx.text(), {
            status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...CORS }
          });
        }
        return new Response('Not found', { status: 404, headers: CORS });
      }

      return new Response('Method not allowed', { status: 405, headers: CORS });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[worker error]', err);
      const headers = err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {};
      return json(status, { error: err.message || 'Server error' }, headers);
    }
  }
};

/* -------------------------------- API dispatch -------------------------------- */

async function handleApi(request, env, url) {
  const db = env.DB;
  const path = url.pathname;
  const method = request.method;
  const query = Object.fromEntries(url.searchParams);
  const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await readJson(request) : {};
  const reporter = await currentReporter(request, env);
  const is = (m, p) => method === m && path === p;
  const seg = path.split('/'); // ['', 'api', ...]

  // Health & config
  if (is('GET', '/api/health')) return json(200, { ok: true, ts: nowMs(), city: 'Mangaluru' });
  if (is('GET', '/api/config')) return json(200, {
    cityBBox: CITY_BBOX,
    disclaimer: 'Community-reported. Not an official warning. In an emergency, follow local authorities.'
  });

  // Auth
  if (is('POST', '/api/session')) return json(201, await api.createAnonymousSession(db));
  if (is('POST', '/api/auth/otp')) { rateLimit(request, 'auth', RATE_LIMITS.authPerMinute); return json(200, api.requestOtp(body.phone)); }
  if (is('POST', '/api/auth/verify')) { rateLimit(request, 'auth', RATE_LIMITS.authPerMinute); return json(200, await api.verifyOtp(db, body.phone, body.code)); }
  if (is('POST', '/api/auth/logout')) { const t = bearer(request); if (t) await store.endSession(db, t); return json(200, { ok: true }); }
  if (is('GET', '/api/me')) return json(200, reporter
    ? { reporterId: reporter.id, reputation: reporter.reputation, isAdmin: reporter.is_admin === 1 }
    : null);

  // Reports
  if (is('GET', '/api/reports')) return json(200, { reports: await api.listReports(db, parseBBox(query)) });
  if (is('POST', '/api/reports')) {
    rateLimit(request, 'report', RATE_LIMITS.reportPerMinute);
    const rep = await requireReporter(request, env);
    return json(201, await api.createReport(db, rep, body));
  }
  if (is('GET', '/api/reports/mine')) return json(200, { reports: await api.listMyReports(db, await requireReporter(request, env)) });
  if (method === 'GET' && seg[2] === 'reports' && seg[3] && !seg[4]) {
    return json(200, await api.getReportDetail(db, decodeURIComponent(seg[3])));
  }
  if (method === 'POST' && seg[2] === 'reports' && seg[3] && seg[4] === 'confirm') {
    rateLimit(request, 'confirm', RATE_LIMITS.confirmPerMinute);
    const rep = await requireReporter(request, env);
    return json(200, await api.confirmReport(db, rep, decodeURIComponent(seg[3]), body.kind));
  }

  // Route check
  if (is('POST', '/api/route-check')) {
    const from = { lat: Number(body.from?.lat), lng: Number(body.from?.lng) };
    const to = { lat: Number(body.to?.lat), lng: Number(body.to?.lng) };
    return json(200, await api.checkRoute(db, from, to));
  }

  // Saved places
  if (is('GET', '/api/places')) return json(200, { places: await api.listSavedPlaces(db, await requireReporter(request, env)) });
  if (is('POST', '/api/places')) return json(201, { places: await api.addSavedPlace(db, await requireReporter(request, env), body) });
  if (method === 'DELETE' && seg[2] === 'places' && seg[3]) {
    const removed = await api.removeSavedPlace(db, await requireReporter(request, env), decodeURIComponent(seg[3]));
    return json(200, { removed });
  }

  // Hotspots
  if (is('GET', '/api/hotspots')) return json(200, { hotspots: await api.listHotspots(db) });

  // Admin
  if (path.startsWith('/api/admin/')) {
    if (!adminOk(request, reporter, env)) throw Object.assign(new Error('Admin access required'), { status: 403 });
    if (is('GET', '/api/admin/queue')) return json(200, { reports: await api.moderationQueue(db) });
    if (is('GET', '/api/admin/stats')) return json(200, await api.stats(db));
    if (method === 'POST' && seg[2] === 'admin' && seg[3] === 'moderate' && seg[4]) {
      return json(200, await api.moderate(db, decodeURIComponent(seg[4]), body.action));
    }
  }

  throw Object.assign(new Error('Not found'), { status: 404 });
}

/* ------------------------------------ SSE ------------------------------------- */

/**
 * Keep-alive Server-Sent-Events stream. The Workers runtime has no cross-isolate
 * broadcast hub, so instead of a shared EventHub we emit heartbeats. The front-end
 * already refreshes every 60s (public/app.js), so live data stays current; this
 * endpoint just keeps EventSource connected without errors.
 */
function sse() {
  const encoder = new TextEncoder();
  let interval;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      interval = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')); }
        catch { clearInterval(interval); }
      }, 25000);
    },
    cancel() { clearInterval(interval); }
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}

/* --------------------------------- uploads ------------------------------------ */

async function servePhoto(env, path) {
  // path: /uploads/<id>.<ext>
  const name = path.slice('/uploads/'.length);
  const id = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
  if (!id) return new Response('Not found', { status: 404 });
  const row = await env.DB.prepare(`SELECT mime, data FROM photos WHERE id = ?`).bind(id).first();
  if (!row) return new Response('Not found', { status: 404 });
  const bytes = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'Content-Type': row.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
