/**
 * SQLite data layer for JalRakshak using Node's built-in node:sqlite.
 * Exposes prepared-statement-backed helpers used by the route handlers.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from './config.js';
import { PRAGMAS_SQL, SCHEMA_SQL } from './schema.js';
import { newId, nowMs } from './util.js';

// Ensure the parent directory exists so first-run doesn't fail to open the DB.
if (DB_PATH !== ':memory:') {
  try { mkdirSync(dirname(DB_PATH), { recursive: true }); } catch {}
}

/** @type {DatabaseSync} */
export const db = new DatabaseSync(DB_PATH);
db.exec(PRAGMAS_SQL);
db.exec(SCHEMA_SQL);

const stmts = {
  insertReport: db.prepare(`
    INSERT INTO reports
      (id, lat, lng, place, depth, level, road_blocked, note, photo_path,
       reporter_id, status, confidence, confirmations, disputes, rainfall_mm,
       created_at, updated_at, expires_at)
    VALUES
      (@id, @lat, @lng, @place, @depth, @level, @road_blocked, @note, @photo_path,
       @reporter_id, 'active', @confidence, 0, 0, @rainfall_mm,
       @created_at, @updated_at, @expires_at)`),

  getReport: db.prepare(`SELECT * FROM reports WHERE id = ?`),

  updateReportFields: db.prepare(`
    UPDATE reports SET status = @status, level = @level, confidence = @confidence,
      confirmations = @confirmations, disputes = @disputes,
      expires_at = @expires_at, updated_at = @updated_at WHERE id = @id`),

  reportsInBox: db.prepare(`
    SELECT * FROM reports
    WHERE status = 'active' AND expires_at > @now
      AND lat BETWEEN @minLat AND @maxLat AND lng BETWEEN @minLng AND @maxLng
    ORDER BY created_at DESC LIMIT 500`),

  allActiveReports: db.prepare(`
    SELECT * FROM reports WHERE status = 'active' AND expires_at > @now
    ORDER BY created_at DESC LIMIT 500`),

  moderationQueue: db.prepare(`
    SELECT * FROM reports WHERE status IN ('active','removed')
    ORDER BY disputes DESC, confidence ASC, created_at DESC LIMIT 200`),

  reportsByReporter: db.prepare(`
    SELECT * FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 100`),

  expireOld: db.prepare(
    `UPDATE reports SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`),

  insertConfirmation: db.prepare(`
    INSERT OR IGNORE INTO confirmations (id, report_id, reporter_id, kind, created_at)
    VALUES (?, ?, ?, ?, ?)`),
  confirmCounts: db.prepare(
    `SELECT kind, COUNT(*) AS n FROM confirmations WHERE report_id = ? GROUP BY kind`),

  upsertReporter: db.prepare(`
    INSERT INTO reporters (id, phone_hash, display_name, reputation, is_admin, created_at)
    VALUES (@id, @phone_hash, @display_name, 1.0, 0, @now)
    ON CONFLICT(id) DO NOTHING`),
  reporterById: db.prepare(`SELECT * FROM reporters WHERE id = ?`),
  bumpReputation: db.prepare(`UPDATE reporters SET reputation = @rep WHERE id = @id`),

  insertSession: db.prepare(`
    INSERT INTO sessions (token, reporter_id, created_at, expires_at) VALUES (?, ?, ?, ?)`),
  sessionByToken: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),

  insertPlace: db.prepare(`
    INSERT INTO saved_places (id, reporter_id, label, lat, lng, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  placesByReporter: db.prepare(`SELECT * FROM saved_places WHERE reporter_id = ?`),
  deletePlace: db.prepare(`DELETE FROM saved_places WHERE id = ? AND reporter_id = ?`),

  insertHotspot: db.prepare(`
    INSERT OR IGNORE INTO hotspots (id, name, area, lat, lng, cause, baseline, source, note)
    VALUES (@id, @name, @area, @lat, @lng, @cause, @baseline, @source, @note)`),
  allHotspots: db.prepare(`SELECT * FROM hotspots`)
};

/* --------------------------------- reporters --------------------------------- */
export function ensureReporter(id, { phoneHash = null, displayName = null } = {}) {
  stmts.upsertReporter.run({ id, phone_hash: phoneHash, display_name: displayName, now: nowMs() });
  return getReporter(id);
}
export const getReporter = (id) => stmts.reporterById.get(id);

export function createSession(reporterId, ttlMs = 30 * 24 * 3600 * 1000) {
  const token = newId() + newId().slice(0, 8);
  const now = nowMs();
  stmts.insertSession.run(token, reporterId, now, now + ttlMs);
  return { token, expires_at: now + ttlMs };
}
export function reporterFromToken(token) {
  if (!token) return null;
  const s = stmts.sessionByToken.get(token);
  if (!s || s.expires_at < nowMs()) return null;
  return getReporter(s.reporter_id);
}
export const endSession = (token) => stmts.deleteSession.run(token).changes > 0;

/* ---------------------------------- places ----------------------------------- */
export const listPlaces = (reporterId) => stmts.placesByReporter.all(reporterId);
export function addPlace(reporterId, label, lat, lng) {
  stmts.insertPlace.run(newId(), reporterId, label, lat, lng, nowMs());
  return listPlaces(reporterId);
}
export const removePlace = (reporterId, placeId) =>
  stmts.deletePlace.run(placeId, reporterId).changes > 0;

/* --------------------------------- reports ----------------------------------- */
export function insertReport(report) { stmts.insertReport.run(report); return getReport(report.id); }
export const getReport = (id) => stmts.getReport.get(id);
export function updateReport(r) {
  stmts.updateReportFields.run({
    id: r.id, status: r.status, level: r.level, confidence: r.confidence,
    confirmations: r.confirmations, disputes: r.disputes,
    expires_at: r.expires_at, updated_at: nowMs()
  });
  return getReport(r.id);
}
export const reportsInBox = (bbox) => stmts.reportsInBox.all({ now: nowMs(), ...bbox });
export const listActiveReports = () => stmts.allActiveReports.all({ now: nowMs() });
export const listReportsByReporter = (reporterId) => stmts.reportsByReporter.all(reporterId);
export const getModerationQueue = () => stmts.moderationQueue.all();

/* ------------------------------- confirmations ------------------------------- */
export function addConfirmation(reportId, reporterId, kind) {
  return stmts.insertConfirmation.run(newId(), reportId, reporterId, kind, nowMs()).changes > 0;
}
export const confirmationCounts = (reportId) => {
  const out = { 'still-flooded': 0, cleared: 0, dispute: 0 };
  for (const r of stmts.confirmCounts.all(reportId)) out[r.kind] = r.n;
  return out;
};

/* -------------------------------- reputation --------------------------------- */
export function adjustReputation(reporterId, delta) {
  const rep = getReporter(reporterId);
  if (!rep) return;
  const next = Math.min(5, Math.max(0.2, rep.reputation + delta));
  stmts.bumpReputation.run({ id: reporterId, rep: next });
}

/* ---------------------------------- expiry ----------------------------------- */
export const runExpirySweep = () => stmts.expireOld.run(nowMs()).changes;

/* --------------------------------- hotspots ---------------------------------- */
export const allHotspots = () => stmts.allHotspots.all();
export function seedHotspots(hotspots) { for (const h of hotspots) stmts.insertHotspot.run(h); }

