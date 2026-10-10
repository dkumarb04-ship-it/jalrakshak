/**
 * Unit tests for geospatial + utility helpers (no HTTP, no DB).
 * Run with: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  haversineMeters, withinBBox, projectToMap, distanceToSegmentMeters,
  isValidLatLng, timeAgo, clampStr, bboxByRadius
} from '../src/util.js';

test('haversine: Hampankatta to Kottara is a few km', () => {
  const d = haversineMeters({ lat: 12.8720, lng: 74.8430 }, { lat: 12.9505, lng: 74.8840 });
  assert.ok(d > 7000 && d < 11000, `expected ~9km, got ${d}`);
});

test('haversine: same point is zero', () => {
  assert.equal(haversineMeters({ lat: 12.9, lng: 74.85 }, { lat: 12.9, lng: 74.85 }), 0);
});

test('isValidLatLng accepts real coords, rejects junk', () => {
  assert.ok(isValidLatLng(12.95, 74.88));
  assert.ok(!isValidLatLng(999, 999));
  assert.ok(!isValidLatLng(NaN, 74));
  assert.ok(!isValidLatLng('12', 74));
});

test('withinBBox true inside city, false far away', () => {
  assert.ok(withinBBox({ lat: 12.95, lng: 74.88 }));
  assert.ok(!withinBBox({ lat: 20, lng: 80 }));
});

test('projectToMap maps city bbox to 0..1, north on top', () => {
  const sw = projectToMap(12.80, 74.79); // min corner → (0,1) bottom-left
  const ne = projectToMap(12.99, 74.91); // max corner → (1,0) top-right
  assert.ok(Math.abs(sw.x - 0) < 1e-6 && Math.abs(sw.y - 1) < 1e-6);
  assert.ok(Math.abs(ne.x - 1) < 1e-6 && Math.abs(ne.y - 0) < 1e-6);
  const center = projectToMap(12.895, 74.85);
  assert.ok(center.x > 0 && center.x < 1 && center.y > 0 && center.y < 1);
});

test('projectToMap clamps out-of-range coords', () => {
  const p = projectToMap(15, 80);
  assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
});

test('distanceToSegment: point on the segment is ~0', () => {
  const a = { lat: 12.85, lng: 74.80 };
  const b = { lat: 12.95, lng: 74.90 };
  const mid = { lat: 12.90, lng: 74.85 };
  const d = distanceToSegmentMeters(mid, a, b);
  assert.ok(d < 60, `midpoint should be on the line, got ${d}`);
});

test('distanceToSegment: off-route point is measured to nearest end', () => {
  const a = { lat: 12.85, lng: 74.80 };
  const b = { lat: 12.85, lng: 74.85 };
  const far = { lat: 12.90, lng: 74.825 };
  const d = distanceToSegmentMeters(far, a, b);
  // ~0.05 deg lat ≈ 5.5 km
  assert.ok(d > 4000 && d < 7000, `got ${d}`);
});

test('timeAgo produces human strings', () => {
  const now = Date.now();
  assert.equal(timeAgo(now - 5 * 1000, now), 'just now');
  assert.match(timeAgo(now - 8 * 60 * 1000, now), /min ago/);
  assert.match(timeAgo(now - 3 * 3600 * 1000, now), /hr ago/);
  assert.match(timeAgo(now - 2 * 24 * 3600 * 1000, now), /day/);
});

test('clampStr trims and caps length', () => {
  assert.equal(clampStr('  hello  ', 50), 'hello');
  assert.equal(clampStr('abcdefghij', 4), 'abcd');
  assert.equal(clampStr(null, 10), '');
});

test('bboxByRadius grows the box but stays within city bounds', () => {
  const box = bboxByRadius({ lat: 12.95, lng: 74.88 }, 1000);
  assert.ok(box.minLat < 12.95 && box.maxLat > 12.95);
  assert.ok(box.minLat >= 12.80 && box.maxLat <= 12.99);
});
