/**
 * Small, dependency-free utilities: geospatial maths, id/time helpers and
 * input validation used across the backend.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { CITY_BBOX } from './config.js';

/** Earth's radius in metres (mean). */
const EARTH_RADIUS_M = 6371000;

/** Convert degrees → radians. */
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two points, in metres (haversine formula).
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number}
 */
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True if a point lies inside the city bounding box. */
export function withinBBox(point, bbox = CITY_BBOX) {
  return (
    point.lat >= bbox.minLat &&
    point.lat <= bbox.maxLat &&
    point.lng >= bbox.minLng &&
    point.lng <= bbox.maxLng
  );
}

/**
 * Expand a bbox by a buffer in metres (rough: 1° lat ≈ 111 km, 1° lng scales
 * with latitude). Good enough for pre-filtering candidate reports.
 */
export function bboxByRadius(center, radiusM, bbox = CITY_BBOX) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos(toRad(center.lat)) || 1);
  return {
    minLat: Math.max(bbox.minLat, center.lat - dLat),
    maxLat: Math.min(bbox.maxLat, center.lat + dLat),
    minLng: Math.max(bbox.minLng, center.lng - dLng),
    maxLng: Math.min(bbox.maxLng, center.lng + dLng)
  };
}

/**
 * Project a real lat/lng to fractional (0..1) coordinates on the front-end's
 * stylised map canvas, so SVG pins line up with their real neighbourhoods.
 * @returns {{x:number,y:number}} where y=0 is the TOP of the map (north).
 */
export function projectToMap(lat, lng, bbox = CITY_BBOX) {
  const x = (lng - bbox.minLng) / (bbox.maxLng - bbox.minLng);
  const y = 1 - (lat - bbox.minLat) / (bbox.maxLat - bbox.minLat);
  return { x: clamp01(x), y: clamp01(y) };
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Shortest distance (metres) from a point to a line segment a→b on a plane
 * approximation. Used for "is this flood near my route" checks.
 */
export function distanceToSegmentMeters(p, a, b) {
  // Equirectangular projection around the segment's mid-latitude.
  const midLat = (a.lat + b.lat) / 2;
  const kx = 111320 * Math.cos(toRad(midLat)); // metres per degree lng
  const ky = 110540; // metres per degree lat
  const px = p.lng * kx, py = p.lat * ky;
  const ax = a.lng * kx, ay = a.lat * ky;
  const bx = b.lng * kx, by = b.lat * ky;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = clamp(t, 0, 1);
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** New random id (url-safe, 22 chars). */
export const newId = () => randomUUID();

/** Cryptographically-strong short token for sessions. */
export const newToken = () => randomBytes(24).toString('base64url');

/** Current time as epoch milliseconds. */
export const nowMs = () => Date.now();

/** "3 min ago" style relative time from an epoch-ms timestamp. */
export function timeAgo(epochMs, from = Date.now()) {
  const s = Math.max(0, Math.floor((from - epochMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ago`;
}

/** Truncate + trim a string to a max length. */
export function clampStr(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

/** Validate lat/lng are finite numbers within valid ranges. */
export function isValidLatLng(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}
