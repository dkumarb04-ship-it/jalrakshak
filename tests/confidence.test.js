/**
 * Unit tests for the trust/confidence scoring (Phase 5) + expiry logic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeConfidence, deriveLevel, initialExpiry, extendExpiry, countNearbyReports
} from '../src/confidence.js';
import { REPORT_TTL_HOURS, REPORT_MAX_AGE_HOURS } from '../src/config.js';

const HOUR = 3600 * 1000;
const baseReport = { created_at: Date.now() };

test('computeConfidence stays within [0,1]', () => {
  const lo = computeConfidence(baseReport, { reputation: 0.2 });
  const hi = computeConfidence(baseReport, {
    reputation: 5, stillFlooded: 10, hasPhoto: true, nearbyCount: 10
  });
  assert.ok(lo >= 0 && lo <= 1);
  assert.ok(hi >= 0 && hi <= 1);
});

test('more confirmations raise confidence', () => {
  const a = computeConfidence(baseReport, { reputation: 1, stillFlooded: 0 });
  const b = computeConfidence(baseReport, { reputation: 1, stillFlooded: 3 });
  assert.ok(b > a, `3 confirms (${b}) should beat 0 (${a})`);
});

test('disputes lower confidence', () => {
  const a = computeConfidence(baseReport, { reputation: 1, stillFlooded: 0, disputes: 0 });
  const b = computeConfidence(baseReport, { reputation: 1, stillFlooded: 0, disputes: 3 });
  assert.ok(b < a, `disputes (${b}) should lower confidence vs none (${a})`);
});

test('a photo adds a little confidence', () => {
  const a = computeConfidence(baseReport, { reputation: 1, hasPhoto: false });
  const b = computeConfidence(baseReport, { reputation: 1, hasPhoto: true });
  assert.ok(b > a);
});

test('old reports decay in confidence', () => {
  const fresh = computeConfidence({ created_at: Date.now() }, { reputation: 1 });
  const stale = computeConfidence(
    { created_at: Date.now() - (REPORT_TTL_HOURS + 6) * HOUR }, { reputation: 1 });
  assert.ok(stale < fresh, `stale (${stale}) should be below fresh (${fresh})`);
});

test('deriveLevel maps depth to severity', () => {
  assert.equal(deriveLevel('ankle', 0.5, 0), 'green');
  assert.equal(deriveLevel('knee', 0.5, 0), 'amber');
  assert.equal(deriveLevel('impassable', 0.5, 0), 'red');
  assert.equal(deriveLevel('vehicle-stalling', 0.5, 0), 'red');
});

test('heavy disputes can de-escalate a red report', () => {
  const level = deriveLevel('impassable', 0.2, 5);
  assert.equal(level, 'amber');
});

test('initialExpiry is TTL hours in the future', () => {
  const now = Date.now();
  const exp = initialExpiry(now);
  assert.equal(exp - now, REPORT_TTL_HOURS * HOUR);
});

test('extendExpiry pushes out by confirm window but respects max age', () => {
  const created = Date.now() - 1 * HOUR;
  const report = { created_at: created, expires_at: Date.now() };
  const extended = extendExpiry(report);
  assert.ok(extended > report.expires_at, 'should extend');
  const cap = created + REPORT_MAX_AGE_HOURS * HOUR;
  assert.ok(extended <= cap, 'never beyond max age cap');
});

test('countNearbyReports counts only within radius, excluding self', () => {
  const active = [
    { id: 'a', lat: 12.9500, lng: 74.8840 },
    { id: 'b', lat: 12.9505, lng: 74.8842 }, // ~60m from a
    { id: 'c', lat: 12.9000, lng: 74.8000 }  // far
  ];
  const n = countNearbyReports({ lat: 12.9500, lng: 74.8840 }, active, 'a');
  assert.equal(n, 1, 'only b is within 300m of a (excluding a itself)');
});
