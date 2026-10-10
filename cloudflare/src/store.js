/**
 * D1 (SQLite) data layer for Cloudflare Workers.
 *
 * Async port of src/db.js. Every function takes the D1 binding (`db`) as its
 * first argument and returns a Promise. Parameter binding uses positional `?`
 * placeholders (universally supported by D1).
 *
 * The public surface mirrors src/db.js so the API logic ports 1:1. Two extra
 * helpers replace raw `store.db.prepare(...)` calls in the original:
 *   - reporterByPhoneHash(db, hash)
 *   - countReportsSince(db, cutoff)
 */

export const nowMs = () => Date.now();
export const newId = () => crypto.randomUUID();

/* --------------------------------- reporters --------------------------------- */

export async function ensureReporter(db, id, { phoneHash = null, displayName = null } = {}) {
  await db.prepare(
    `INSERT INTO reporters (id, phone_hash, display_name, reputation, is_admin, created_at)
     VALUES (?, ?, ?, 1.0, 0, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(id, phoneHash, displayName, nowMs()).run();
  return getReporter(db, id);
}

export async function getReporter(db, id) {
  return db.prepare(`SELECT * FROM reporters WHERE id = ?`).bind(id).first();
}

export async function reporterByPhoneHash(db, hash) {
  return db.prepare(`SELECT * FROM reporters WHERE phone_hash = ?`).bind(hash).first();
}

export async function bumpReputation(db, id, rep) {
  await db.prepare(`UPDATE reporters SET reputation = ? WHERE id = ?`).bind(rep, id).run();
}

/* --------------------------------- sessions ---------------------------------- */

export async function createSession(db, reporterId, ttlMs = 30 * 24 * 3600 * 1000) {
  const token = newId() + newId().slice(0, 8);
  const now = nowMs();
  await db.prepare(
    `INSERT INTO sessions (token, reporter_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).bind(token, reporterId, now, now + ttlMs).run();
  return { token, expires_at: now + ttlMs };
}

export async function sessionByToken(db, token) {
  return db.prepare(`SELECT * FROM sessions WHERE token = ?`).bind(token).first();
}

export async function reporterFromToken(db, token) {
  if (!token) return null;
  const s = await sessionByToken(db, token);
  if (!s || s.expires_at < nowMs()) return null;
  return getReporter(db, s.reporter_id);
}

export async function endSession(db, token) {
  const res = await db.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
  return (res.meta?.changes ?? 0) > 0;
}

/* ---------------------------------- places ----------------------------------- */

export async function listPlaces(db, reporterId) {
  const res = await db.prepare(
    `SELECT * FROM saved_places WHERE reporter_id = ? ORDER BY created_at DESC`
  ).bind(reporterId).all();
  return res.results ?? [];
}

export async function addPlace(db, reporterId, label, lat, lng) {
  await db.prepare(
    `INSERT INTO saved_places (id, reporter_id, label, lat, lng, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(newId(), reporterId, label, lat, lng, nowMs()).run();
  return listPlaces(db, reporterId);
}

export async function removePlace(db, reporterId, placeId) {
  const res = await db.prepare(
    `DELETE FROM saved_places WHERE id = ? AND reporter_id = ?`
  ).bind(placeId, reporterId).run();
  return (res.meta?.changes ?? 0) > 0;
}

/* --------------------------------- reports ----------------------------------- */

export async function insertReport(db, report) {
  await db.prepare(
    `INSERT INTO reports
       (id, lat, lng, place, depth, level, road_blocked, note, photo_path,
        reporter_id, status, confidence, confirmations, disputes, rainfall_mm,
        created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, 0, ?, ?, ?, ?)`
  ).bind(
    report.id, report.lat, report.lng, report.place, report.depth, report.level,
    report.road_blocked, report.note, report.photo_path, report.reporter_id,
    report.confidence, report.rainfall_mm, report.created_at, report.updated_at,
    report.expires_at
  ).run();
  return getReport(db, report.id);
}

export async function getReport(db, id) {
  return db.prepare(`SELECT * FROM reports WHERE id = ?`).bind(id).first();
}


export async function updateReport(db, r) {
  await db.prepare(
    `UPDATE reports SET status = ?, level = ?, confidence = ?, confirmations = ?,
       disputes = ?, expires_at = ?, updated_at = ? WHERE id = ?`
  ).bind(r.status, r.level, r.confidence, r.confirmations, r.disputes,
         r.expires_at, nowMs(), r.id).run();
  return getReport(db, r.id);
}

export async function reportsInBox(db, bbox) {
  const res = await db.prepare(
    `SELECT * FROM reports
     WHERE status = 'active' AND expires_at > ?
       AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
     ORDER BY created_at DESC LIMIT 500`
  ).bind(nowMs(), bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng).all();
  return res.results ?? [];
}

export async function listActiveReports(db) {
  const res = await db.prepare(
    `SELECT * FROM reports WHERE status = 'active' AND expires_at > ?
     ORDER BY created_at DESC LIMIT 500`
  ).bind(nowMs()).all();
  return res.results ?? [];
}

export async function getModerationQueue(db) {
  const res = await db.prepare(
    `SELECT * FROM reports WHERE status IN ('active','removed')
     ORDER BY disputes DESC, confidence ASC, created_at DESC LIMIT 200`
  ).all();
  return res.results ?? [];
}

export async function listReportsByReporter(db, reporterId) {
  const res = await db.prepare(
    `SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(reporterId).all();
  return res.results ?? [];
}

export async function countReportsSince(db, cutoff) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM reports WHERE created_at >= ?`
  ).bind(cutoff).first();
  return row?.n ?? 0;
}

/* ------------------------------ confirmations -------------------------------- */

export async function addConfirmation(db, reportId, reporterId, kind) {
  const res = await db.prepare(
    `INSERT OR IGNORE INTO confirmations (id, report_id, reporter_id, kind, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(newId(), reportId, reporterId, kind, nowMs()).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function confirmationCounts(db, reportId) {
  const res = await db.prepare(
    `SELECT kind, COUNT(*) AS n FROM confirmations WHERE report_id = ? GROUP BY kind`
  ).bind(reportId).all();
  const out = { 'still-flooded': 0, cleared: 0, dispute: 0 };
  for (const r of res.results ?? []) out[r.kind] = r.n;
  return out;
}

/* -------------------------------- reputation --------------------------------- */

export async function adjustReputation(db, reporterId, delta) {
  const rep = await getReporter(db, reporterId);
  if (!rep) return;
  const next = Math.min(5, Math.max(0.2, rep.reputation + delta));
  await bumpReputation(db, reporterId, next);
}

/* ---------------------------------- expiry ----------------------------------- */

export async function runExpirySweep(db) {
  const res = await db.prepare(
    `UPDATE reports SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`
  ).bind(nowMs()).run();
  return res.meta?.changes ?? 0;
}

/* --------------------------------- hotspots ---------------------------------- */

export async function allHotspots(db) {
  const res = await db.prepare(`SELECT * FROM hotspots`).all();
  return res.results ?? [];
}

export async function seedHotspots(db, hotspots) {
  for (const h of hotspots) {
    await db.prepare(
      `INSERT OR IGNORE INTO hotspots (id, name, area, lat, lng, cause, baseline, source, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(h.id, h.name, h.area, h.lat, h.lng, h.cause, h.baseline, h.source, h.note).run();
  }
}

/* ---------------------------------- photos ----------------------------------- */

export async function savePhoto(db, mime, base64Data, bytes) {
  const id = newId();
  await db.prepare(
    `INSERT INTO photos (id, mime, data, created_at) VALUES (?, ?, ?, ?)`
  ).bind(id, mime, base64Data, nowMs()).run();
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  return { path: `/uploads/${id}${ext}`, id, bytes, mime };
}

export async function getPhoto(db, photoId) {
  return db.prepare(`SELECT mime, data FROM photos WHERE id = ?`).bind(photoId).first();
}
