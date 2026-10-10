/**
 * Trust & moderation scoring (Phase 5).
 *
 * A report's `confidence` (0..1) blends several signals. Nothing here is a
 * hard "true/false" — it is a triage aid. The app always shows the
 * "community-reported, not official" disclaimer.
 *
 * Signals:
 *   - reporter reputation        (higher = more trusted)
 *   - independent confirmations   ("still flooded" adds, disputes subtract)
 *   - photo sanity               (has a photo + captured within time/loc bounds)
 *   - proximity of other reports (corroboration within NEARBY_RADIUS_M)
 *   - recency                    (older reports decay until re-confirmed)
 */

import {
  REPORT_TTL_HOURS, CONFIRM_EXTEND_HOURS, REPORT_MAX_AGE_HOURS,
  NEARBY_RADIUS_M, DEPTH_TO_LEVEL
} from './config.js';
import { haversineMeters, nowMs } from './util.js';

const HOUR_MS = 3600 * 1000;

/**
 * Compute confidence for a report.
 * @param {object} report  the report row
 * @param {object} ctx     { reputation, stillFlooded, cleared, disputes, nearbyCount, hasPhoto }
 * @returns {number} 0..1
 */
export function computeConfidence(report, ctx) {
  let score = 0.30; // base: an anonymous, lone report still deserves some weight

  // Reporter reputation (0.2..5) → 0..0.25
  const rep = clamp(ctx.reputation ?? 1, 0.2, 5);
  score += ((rep - 0.2) / 4.8) * 0.25;

  // Independent "still flooded" confirmations → up to +0.30 (diminishing)
  const confirms = ctx.stillFlooded || 0;
  score += Math.min(0.30, confirms * 0.10);

  // Disputes subtract (someone says it's wrong/cleared) → up to -0.35
  const disputes = (ctx.disputes || 0) + (ctx.cleared || 0);
  score -= Math.min(0.35, disputes * 0.15);

  // Photo sanity +0.15 (real photo taken near the report location/time)
  if (ctx.hasPhoto) score += 0.15;

  // Corroboration: other independent reports nearby → up to +0.20
  const nearby = Math.min(4, ctx.nearbyCount || 0);
  score += nearby * 0.05;

  // Recency decay: fresh reports are more trustworthy to display as "live"
  const ageH = (nowMs() - report.created_at) / HOUR_MS;
  if (ageH > REPORT_TTL_HOURS) {
    const over = (ageH - REPORT_TTL_HOURS) / REPORT_TTL_HOURS;
    score -= Math.min(0.20, over * 0.10);
  }

  return clamp(score, 0, 1);
}

/**
 * Derive the display severity level (green/amber/red) from depth, then let
 * confidence + confirmations nudge it (many disputes can de-escalate a pin).
 */
export function deriveLevel(depth, confidence, disputes = 0) {
  let level = DEPTH_TO_LEVEL[depth] || 'amber';
  // Strong community corroboration can't escalate beyond what depth implies,
  // but heavy dispute can soften a pin one step at a time.
  if (level === 'red' && disputes >= 3 && confidence < 0.35) {
    level = 'amber';
  } else if (level === 'amber' && disputes >= 4 && confidence < 0.25) {
    level = 'green';
  }
  return level;
}

/** Initial expiry timestamp for a brand-new report. */
export function initialExpiry(from = nowMs()) {
  return from + REPORT_TTL_HOURS * HOUR_MS;
}

/**
 * New expiry after a "still flooded" confirmation: extend by CONFIRM_EXTEND,
 * but never beyond created_at + REPORT_MAX_AGE.
 */
export function extendExpiry(report, from = nowMs()) {
  const cap = report.created_at + REPORT_MAX_AGE_HOURS * HOUR_MS;
  return Math.min(cap, Math.max(from, report.expires_at) + CONFIRM_EXTEND_HOURS * HOUR_MS);
}

/**
 * Count corroborating active reports within NEARBY_RADIUS_M of this point,
 * excluding a given report id. Used for confidence + duplicate detection.
 * @param {{lat:number,lng:number}} point
 * @param {Array} activeReports  pre-fetched active report rows
 * @param {string} excludeId
 */
export function countNearbyReports(point, activeReports, excludeId) {
  let n = 0;
  for (const r of activeReports) {
    if (r.id === excludeId) continue;
    if (haversineMeters(point, { lat: r.lat, lng: r.lng }) <= NEARBY_RADIUS_M) n++;
  }
  return n;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
