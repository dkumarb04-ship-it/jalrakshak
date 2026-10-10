/**
 * JalRakshak front-end API client.
 *
 * Responsibilities:
 *   - hold the anonymous/phone session token (localStorage)
 *   - thin fetch wrappers for every /api endpoint
 *   - an OFFLINE QUEUE: reports made without signal are stored locally and
 *     retried automatically when connectivity returns (core product promise)
 *   - a live SSE subscription for real-time map updates
 *
 * Exposed as window.JalApi. No build step, no dependencies.
 */
(function () {
  'use strict';

  const TOKEN_KEY = 'jalrakshak.token';
  const QUEUE_KEY = 'jalrakshak.queue';
  const BASE = ''; // same origin

  const store = {
    getToken() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    setToken(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} },
    getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } },
    setQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {} }
  };

  let online = navigator.onLine;
  const listeners = {};

  async function request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = store.getToken();
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* --------------------------------- session ---------------------------------- */

  async function ensureSession() {
    if (store.getToken()) return store.getToken();
    const { token } = await request('/api/session', { method: 'POST', auth: false });
    store.setToken(token);
    return token;
  }

  /* ------------------------------ offline queue -------------------------------- */

  function enqueue(report) {
    const q = store.getQueue();
    q.push(report);
    store.setQueue(q);
    emit('queue', q.length);
    return q.length;
  }

  async function flushQueue() {
    const q = store.getQueue();
    if (!q.length || !navigator.onLine) return 0;
    await ensureSession();
    const remaining = [];
    let sent = 0;
    for (const item of q) {
      try {
        await request('/api/reports', { method: 'POST', body: item });
        sent++;
      } catch (e) {
        // Drop 4xx (bad payload); keep network/5xx for retry.
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) continue;
        remaining.push(item);
      }
    }
    store.setQueue(remaining);
    emit('queue', remaining.length);
    return sent;
  }

  /* --------------------------------- events ----------------------------------- */

  function on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); return () => off(event, fn); }
  function off(event, fn) { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); }
  function emit(event, payload) { (listeners[event] || []).forEach((fn) => fn(payload)); }

  function watchConnectivity() {
    const update = () => {
      const wasOffline = !online;
      online = navigator.onLine;
      emit('online', online);
      if (wasOffline && online) flushQueue().then((n) => n && emit('synced', n));
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
  }

  function subscribeLive(onNew, onUpdate) {
    try {
      const es = new EventSource(BASE + '/api/events');
      es.addEventListener('report:new', (e) => onNew && onNew(JSON.parse(e.data)));
      es.addEventListener('report:update', (e) => onUpdate && onUpdate(JSON.parse(e.data)));
      return () => es.close();
    } catch { return () => {}; }
  }

  /* ---------------------------------- API ------------------------------------- */

  const JalApi = {
    on, offlineQueueCount: () => store.getQueue().length, flushQueue, ensureSession,
    isOnline: () => online,

    getConfig: () => request('/api/config', { auth: false }),
    async listReports(bbox) {
      const q = bbox ? `?minLat=${bbox.minLat}&maxLat=${bbox.maxLat}&minLng=${bbox.minLng}&maxLng=${bbox.maxLng}` : '';
      return request('/api/reports' + q, { auth: false });
    },
    getReport: (id) => request('/api/reports/' + id, { auth: false }),
    listHotspots: () => request('/api/hotspots', { auth: false }),

    /** Submit a report; if offline, queue it locally and resolve with {queued:true}. */
    async submitReport(report) {
      if (!navigator.onLine) { enqueue(report); return { queued: true }; }
      try {
        await ensureSession();
        return await request('/api/reports', { method: 'POST', body: report });
      } catch (e) {
        if (!e.status || e.status >= 500 || e.status === 0) { enqueue(report); return { queued: true }; }
        throw e;
      }
    },

    async confirm(reportId, kind) { await ensureSession(); return request(`/api/reports/${reportId}/confirm`, { method: 'POST', body: { kind } }); },
    routeCheck: (from, to) => request('/api/route-check', { method: 'POST', body: { from, to }, auth: false }),

    async listPlaces() { await ensureSession(); return request('/api/places'); },
    async addPlace(label, lat, lng) { await ensureSession(); return request('/api/places', { method: 'POST', body: { label, lat, lng } }); },
    async removePlace(id) { await ensureSession(); return request('/api/places/' + id, { method: 'DELETE' }); },

    requestOtp: (phone) => request('/api/auth/otp', { method: 'POST', body: { phone }, auth: false }),
    async verifyOtp(phone, code) { const r = await request('/api/auth/verify', { method: 'POST', body: { phone, code }, auth: false }); store.setToken(r.token); return r; },

    watchConnectivity, subscribeLive
  };

  watchConnectivity();
  if (navigator.onLine) setTimeout(() => flushQueue().then((n) => n && emit('synced', n)), 800);

  window.JalApi = JalApi;
})();

