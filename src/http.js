/**
 * Minimal HTTP helpers: a tiny router, JSON body reader, in-memory rate
 * limiter, and a Server-Sent-Events hub for live map updates.
 * No external dependencies — just node:http building blocks.
 */
import { randomUUID } from 'node:crypto';
import { RATE_LIMITS } from './config.js';

/* -------------------------------- router ------------------------------------- */

/**
 * A tiny method+path router. Path patterns may include ":param" segments.
 * Example: route('GET', '/api/reports/:id', handler)
 */
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' + pattern.replace(/\/$/, '').replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) + '$'
    );
    this.routes.push({ method, regex, keys, handler, pattern });
    return this;
  }
  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }
  put(p, h) { return this.add('PUT', p, h); }

  /** Resolve a request; returns { handler, params } or null. */
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname.replace(/\/$/, '') || '/');
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { handler: r.handler, params, pattern: r.pattern };
      }
    }
    return null;
  }
}

/* ------------------------------- JSON helpers -------------------------------- */

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

/** Read and JSON-parse a request body with a size cap. */
export function readJson(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------ rate limiting -------------------------------- */

/**
 * Simple fixed-window in-memory limiter keyed by an arbitrary string.
 * Adequate for a single-node MVP; swap for Redis at cloud scale.
 */
export class RateLimiter {
  constructor() { this.hits = new Map(); }

  /**
   * @returns {{ok:boolean, retryAfterSec:number}}
   */
  check(key, limit, windowMs = RATE_LIMITS.windowMs) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > limit) {
      return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - entry.start)) / 1000) };
    }
    // Opportunistic cleanup to bound memory.
    if (this.hits.size > 10000) this.sweep(now, windowMs);
    return { ok: true, retryAfterSec: 0 };
  }

  sweep(now, windowMs) {
    for (const [k, v] of this.hits) if (now - v.start >= windowMs) this.hits.delete(k);
  }
}

/* ---------------------------- SSE (realtime) hub ----------------------------- */

/**
 * Broadcast channel for live updates (new reports, confirmations).
 * Clients connect via EventSource to /api/events.
 */
export class EventHub {
  constructor() { this.clients = new Set(); }

  addClient(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    res.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }

  /** Broadcast an event object to all connected clients. */
  broadcast(event) {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data || {})}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch { this.clients.delete(res); }
    }
  }
}

export const rid = () => randomUUID();
