/**
 * API route handlers for the Cloudflare Worker (async port of src/api.js).
 *
 * Every function takes the D1 binding `db` as its first argument and awaits the
 * store, otherwise the logic is identical to the Node original. Pure helpers
 * (confidence, geospatial maths, config) are imported directly from ../src so
 * the two back-ends share one tested implementation.
 */
import { createHash } from 'node:crypto';
import * as store from './store.js';
import { savePhotoFromDataUrl } from './images.js';
import {
  DEPTH_TO_LEVEL, DEPTH_LABELS, ROUTE_BUFFER_M, REPORT_TTL_HOURS, CITY_BBOX
} from '../../src/config.js';
import {
  computeConfidence, deriveLevel, initialExpiry, extendExpiry,
  countNearbyReports
} from '../../src/confidence.js';
import {
  newId, nowMs, haversineMeters, withinBBox, isValidLatLng,
  distanceToSegmentMeters, clampStr, projectToMap, timeAgo
} from '../../src/util.js';

const VALID_DEPTHS = new Set(Object.keys(DEPTH_TO_LEVEL));
const round2 = (n) => Math.round(n * 100) / 100;
const round3 = (n) => Math.round(n * 1000) / 1000;

/** Error carrying an HTTP status for the worker layer to translate. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/* ------------------------------- serializers --------------------------------- */

/** Shape a report row for the API/front-end (adds derived + human fields). */
export async function serializeReport(db, r) {
  const counts = await store.confirmationCounts(db, r.id);
  const pos = projectToMap(r.lat, r.lng);
  return {
    id: r.id,
    place: r.place,
    lat: r.lat,
    lng: r.lng,
    depth: r.depth,
    depthLabel: DEPTH_LABELS[r.depth] || r.depth,
    level: r.level,
    roadBlocked: !!r.road_blocked,
    note: r.note,
    photoPath: r.photo_path,
    status: r.status,
    confidence: round2(r.confidence),
    confirmations: r.confirmations,
    disputes: r.disputes,
    rainfallMm: r.rainfall_mm ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    age: timeAgo(r.created_at),
    mapX: round3(pos.x),
    mapY: round3(pos.y),
    counts
  };
}

/* --------------------------------- auth -------------------------------------- */

/** Create an anonymous session (no phone required). */
export async function createAnonymousSession(db) {
  const id = newId();
  await store.ensureReporter(db, id);
  const session = await store.createSession(db, id);
  return { token: session.token, reporterId: id, mode: 'anonymous', expiresAt: session.expires_at };
}

/**
 * Phone-OTP login (MVP simulation — NOT for production).
 * Deterministically derives a dev code from the phone number so the demo works
 * without an SMS gateway. Replace with a real provider before launch.
 */
export function requestOtp(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw httpError(400, 'A valid Indian mobile number is required');
  return { phone: normalized, devCode: deriveOtp(normalized), expiresInSec: 300 };
}

export async function verifyOtp(db, phone, code) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw httpError(400, 'A valid Indian mobile number is required');
  if (String(code) !== deriveOtp(normalized)) throw httpError(401, 'Incorrect code');
  const phoneHash = hashPhone(normalized);
  const existing = await store.reporterByPhoneHash(db, phoneHash);
  const id = existing ? existing.id : newId();
  await store.ensureReporter(db, id, { phoneHash, displayName: null });
  const session = await store.createSession(db, id);
  return { token: session.token, reporterId: id, mode: 'phone', expiresAt: session.expires_at };
}

function normalizePhone(phone) {
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/[^\d]/g, '');
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (!/^[6-9]\d{9}$/.test(local)) return null;
  return '+91' + local;
}

/* --------------------------------- reports ----------------------------------- */

/**
 * Create a flood report.
 * @param {object} db D1 binding
 * @param {object} reporter authenticated reporter row
 * @param {object} input { lat, lng, place, depth, roadBlocked, note, photo, rainfallMm }
 */
export async function createReport(db, reporter, input) {
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!isValidLatLng(lat, lng)) throw httpError(400, 'A valid location is required');
  const inCity = withinBBox({ lat, lng });
  const depth = VALID_DEPTHS.has(input.depth) ? input.depth : 'knee';
  const place = clampStr(input.place, 120) || 'Reported location';

  let photoPath = null;
  let hasPhoto = false;
  if (input.photo) {
    const saved = await savePhotoFromDataUrl(db, input.photo);
    photoPath = saved.path;
    hasPhoto = true;
  }

  const active = await store.listActiveReports(db);
  const nearbyCount = countNearbyReports({ lat, lng }, active, null);

  const id = newId();
  const created = nowMs();
  const draft = {
    id, lat, lng, place, depth,
    level: deriveLevel(depth, 0.5, 0),
    road_blocked: input.roadBlocked ? 1 : 0,
    note: clampStr(input.note, 500),
    photo_path: photoPath,
    reporter_id: reporter.id,
    rainfall_mm: Number.isFinite(input.rainfallMm) ? Number(input.rainfallMm) : null,
    created_at: created,
    updated_at: created,
    expires_at: initialExpiry(created)
  };
  const ctx = {
    reputation: reporter.reputation ?? 1, stillFlooded: 0, cleared: 0, disputes: 0,
    hasPhoto, nearbyCount
  };
  draft.confidence = computeConfidence(draft, ctx);
  draft.level = deriveLevel(depth, draft.confidence, 0);

  const row = await store.insertReport(db, draft);
  return { report: await serializeReport(db, row), inCity };
}


/**
 * Record a community confirmation/dispute. kind: still-flooded|cleared|dispute.
 */
export async function confirmReport(db, reporter, reportId, kind) {
  if (!['still-flooded', 'cleared', 'dispute'].includes(kind)) {
    throw httpError(400, 'Invalid confirmation type');
  }
  const report = await store.getReport(db, reportId);
  if (!report) throw httpError(404, 'Report not found');

  const inserted = await store.addConfirmation(db, reportId, reporter.id, kind);
  const counts = await store.confirmationCounts(db, reportId);
  const active = await store.listActiveReports(db);
  const nearbyCount = countNearbyReports(
    { lat: report.lat, lng: report.lng }, active, report.id);

  const confidence = computeConfidence(report, {
    reputation: reporter.reputation ?? 1,
    stillFlooded: counts['still-flooded'], cleared: counts.cleared, disputes: counts.dispute,
    hasPhoto: !!report.photo_path, nearbyCount
  });

  let status = report.status;
  let expires = report.expires_at;
  let confirmations = report.confirmations;
  let disputes = report.disputes;

  if (kind === 'still-flooded' && inserted) {
    confirmations += 1;
    expires = extendExpiry({ ...report, expires_at: expires });
    await store.adjustReputation(db, reporter.id, +0.05);
  } else if (kind === 'dispute' && inserted) {
    disputes += 1;
    await store.adjustReputation(db, reporter.id, -0.02);
  } else if (kind === 'cleared') {
    if (counts.cleared >= 2) status = 'cleared';
    expires = Math.min(expires, nowMs() + 60 * 60 * 1000); // 1h grace on the map
  }

  const level = status === 'cleared' ? 'green' : deriveLevel(report.depth, confidence, disputes);
  const updated = await store.updateReport(db, {
    id: report.id, status, level, confidence, confirmations, disputes, expires_at: expires
  });
  return { report: await serializeReport(db, updated), inserted, counts };
}

export async function listMyReports(db, reporter) {
  const rows = await store.listReportsByReporter(db, reporter.id);
  return Promise.all(rows.map((r) => serializeReport(db, r)));
}

/* ------------------------------- route check --------------------------------- */

/**
 * Check floods along a route. `from`/`to` are { lat, lng }. Flags active
 * reports within ROUTE_BUFFER_M of the straight segment, ranked by distance.
 */
export async function checkRoute(db, from, to) {
  if (!isValidLatLng(from.lat, from.lng) || !isValidLatLng(to.lat, to.lng)) {
    throw httpError(400, 'Valid start and destination are required');
  }
  const active = await store.listActiveReports(db);
  const routeLenM = haversineMeters(from, to);

  const hits = [];
  for (const r of active) {
    const d = distanceToSegmentMeters({ lat: r.lat, lng: r.lng }, from, to);
    if (d <= ROUTE_BUFFER_M) {
      hits.push({ report: await serializeReport(db, r), distanceToRouteM: Math.round(d) });
    }
  }
  hits.sort((a, b) => a.distanceToRouteM - b.distanceToRouteM);

  const worstLevel = hits.reduce((w, h) => rank(h.report.level) > rank(w) ? h.report.level : w, 'green');
  return {
    from, to, routeLengthM: Math.round(routeLenM), bufferM: ROUTE_BUFFER_M,
    worstLevel, affectedCount: hits.length, affected: hits.slice(0, 20),
    advisory: buildAdvisory(worstLevel, hits)
  };
}

const rank = (lvl) => ({ green: 0, amber: 1, red: 2 }[lvl] ?? 1);

function buildAdvisory(worstLevel, hits) {
  if (worstLevel === 'red') {
    const names = hits.filter(h => h.report.level === 'red').slice(0, 3)
      .map(h => h.report.place).join(', ');
    return `Avoid this route — reported flooding${names ? ` near ${names}` : ''}. Consider delaying travel or taking an alternate.`;
  }
  if (worstLevel === 'amber') {
    return 'Use caution — waterlogging reported along the way. Allow extra time and avoid low stretches.';
  }
  return 'No flooding reported along this route right now. Conditions can change quickly.';
}

/* ------------------------------- saved places -------------------------------- */

export async function addSavedPlace(db, reporter, input) {
  const lat = Number(input.lat), lng = Number(input.lng);
  if (!isValidLatLng(lat, lng)) throw httpError(400, 'A valid location is required');
  const label = clampStr(input.label, 40) || 'Saved place';
  if ((await store.listPlaces(db, reporter.id)).length >= 10) {
    throw httpError(400, 'You can save up to 10 places');
  }
  await store.addPlace(db, reporter.id, label, lat, lng);
  return listSavedPlaces(db, reporter);
}

export async function listSavedPlaces(db, reporter) {
  const places = await store.listPlaces(db, reporter.id);
  const active = await store.listActiveReports(db);
  return places.map((p) => {
    let nearest = null, nearestDist = Infinity;
    for (const r of active) {
      const d = haversineMeters({ lat: p.lat, lng: p.lng }, { lat: r.lat, lng: r.lng });
      if (d < nearestDist) { nearestDist = d; nearest = r; }
    }
    let status = 'clear';
    if (nearest && nearestDist <= 800) {
      status = nearest.level === 'red' ? 'danger' : nearest.level === 'amber' ? 'watch' : 'clear';
    }
    return {
      id: p.id, label: p.label, lat: p.lat, lng: p.lng, status,
      nearest: nearest ? {
        place: nearest.place, level: nearest.level,
        distanceM: Math.round(nearestDist), age: timeAgo(nearest.created_at)
      } : null
    };
  });
}

export const removeSavedPlace = (db, reporter, placeId) => store.removePlace(db, reporter.id, placeId);

/* --------------------------------- hotspots ---------------------------------- */

export async function listHotspots(db) {
  const rows = await store.allHotspots(db);
  return rows.map((h) => {
    const pos = projectToMap(h.lat, h.lng);
    return {
      id: h.id, name: h.name, area: h.area, lat: h.lat, lng: h.lng,
      cause: h.cause, baseline: h.baseline, source: h.source, note: h.note,
      mapX: round3(pos.x), mapY: round3(pos.y)
    };
  });
}

/* ---------------------------------- admin ------------------------------------ */

export function requireAdmin(reporter) {
  if (!reporter || reporter.is_admin !== 1) throw httpError(403, 'Admin access required');
}

export async function moderationQueue(db) {
  const rows = await store.getModerationQueue(db);
  return Promise.all(rows.map((r) => serializeReport(db, r)));
}

export async function moderate(db, reportId, action) {
  const report = await store.getReport(db, reportId);
  if (!report) throw httpError(404, 'Report not found');
  if (action === 'approve') {
    await store.updateReport(db, { ...report, status: 'active', level: deriveLevel(report.depth, Math.max(report.confidence, 0.5), 0) });
  } else if (action === 'remove') {
    await store.updateReport(db, { ...report, status: 'removed' });
  } else if (action === 'expire') {
    await store.updateReport(db, { ...report, status: 'expired', expires_at: nowMs() });
  } else {
    throw httpError(400, 'Invalid moderation action');
  }
  return serializeReport(db, await store.getReport(db, reportId));
}

export async function stats(db) {
  const active = await store.listActiveReports(db);
  const byLevel = { green: 0, amber: 0, red: 0 };
  const byDepth = {};
  for (const r of active) {
    byLevel[r.level] = (byLevel[r.level] || 0) + 1;
    byDepth[r.depth] = (byDepth[r.depth] || 0) + 1;
  }
  const cutoff = nowMs() - 24 * 3600 * 1000;
  const last24h = await store.countReportsSince(db, cutoff);
  return {
    activeReports: active.length, byLevel, byDepth,
    reportsLast24h: last24h, hotspots: (await store.allHotspots(db)).length,
    ttlHours: REPORT_TTL_HOURS, cityBBox: CITY_BBOX
  };
}

export async function listReports(db, bbox) {
  const rows = bbox ? await store.reportsInBox(db, bbox) : await store.listActiveReports(db);
  return Promise.all(rows.map((r) => serializeReport(db, r)));
}

export async function getReportDetail(db, id) {
  const r = await store.getReport(db, id);
  if (!r) throw httpError(404, 'Report not found');
  return {
    report: await serializeReport(db, r),
    confirmations: await store.confirmationCounts(db, id)
  };
}

function hashPhone(phone) { return createHash('sha256').update(phone).digest('hex'); }
function deriveOtp(normalizedPhone) {
  const h = createHash('sha256').update('jalrakshak-otp:' + normalizedPhone).digest();
  return String(((h.readUInt32BE(0)) % 900000) + 100000);
}
