/**
 * Integration tests for the data layer + API handlers using an in-memory DB.
 * We import db.js AFTER pointing DB_PATH at :memory: via a child-free approach:
 * node:test runs each file in its own process, so setting process.env here
 * (before the dynamic import) is safe.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';

let store;
let api;

before(async () => {
  store = await import('../src/db.js');
  api = await import('../src/api.js');
});

test('seedHotspots + listHotspots round-trips', async () => {
  const { HOTSPOTS } = await import('../src/seed-hotspots.js');
  store.seedHotspots(HOTSPOTS);
  const list = api.listHotspots();
  assert.ok(list.length >= 18, `expected >=18 hotspots, got ${list.length}`);
  const kottara = list.find((h) => h.name === 'Kottara Chowki');
  assert.ok(kottara, 'Kottara Chowki should be seeded');
  assert.ok(kottara.mapX >= 0 && kottara.mapX <= 1);
});

test('createReport → list → confirm → cleared lifecycle', async () => {
  const reporter = { id: 'rep-1', reputation: 1 };
  store.ensureReporter(reporter.id);

  const { report } = await api.createReport(reporter, {
    lat: 12.9505, lng: 74.8840, place: 'Kottara Chowki',
    depth: 'vehicle-stalling', roadBlocked: true, note: 'stalled bikes'
  });
  assert.equal(report.level, 'red');
  assert.equal(report.roadBlocked, true);
  assert.ok(report.id);

  const list = api.listReports();
  assert.ok(list.some((r) => r.id === report.id), 'new report appears in the active list');

  // A second reporter confirms "still flooded"
  const reporter2 = { id: 'rep-2', reputation: 1 };
  store.ensureReporter(reporter2.id);
  const confirmed = api.confirmReport(reporter2, report.id, 'still-flooded');
  assert.equal(confirmed.report.confirmations, 1);
  assert.ok(confirmed.report.expiresAt > report.expiresAt - 1, 'expiry extended');

  // Same reporter can't double-confirm (idempotent)
  const dup = api.confirmReport(reporter2, report.id, 'still-flooded');
  assert.equal(dup.inserted, false);

  // Two independent "cleared" retire it
  api.confirmReport(reporter2, report.id, 'cleared');
  const reporter3 = { id: 'rep-3', reputation: 1 };
  store.ensureReporter(reporter3.id);
  const retired = api.confirmReport(reporter3, report.id, 'cleared');
  assert.equal(retired.report.status, 'cleared');
  assert.equal(retired.report.level, 'green');
});

test('createReport rejects invalid coordinates', async () => {
  const reporter = { id: 'rep-bad', reputation: 1 };
  store.ensureReporter(reporter.id);
  await assert.rejects(
    () => api.createReport(reporter, { lat: 999, lng: 999, depth: 'knee' }),
    (e) => e.status === 400
  );
});

test('checkRoute flags a report along the path', async () => {
  const reporter = { id: 'rep-route', reputation: 1 };
  store.ensureReporter(reporter.id);
  await api.createReport(reporter, {
    lat: 12.9500, lng: 74.8840, place: 'Route test spot', depth: 'impassable'
  });
  const result = api.checkRoute(
    { lat: 12.9400, lng: 74.8700 },
    { lat: 12.9600, lng: 74.8950 }
  );
  assert.ok(result.affectedCount >= 1, 'should find the report along the route');
  assert.equal(result.worstLevel, 'red');
  assert.match(result.advisory, /Avoid|caution|No flooding/);
});

test('saved places get a flood status from nearby reports', async () => {
  const reporter = { id: 'rep-place', reputation: 1 };
  store.ensureReporter(reporter.id);
  await api.createReport(reporter, {
    lat: 12.9505, lng: 74.8840, place: 'Near home', depth: 'impassable'
  });
  const places = api.addSavedPlace(reporter, { label: 'Home', lat: 12.9506, lng: 74.8841 });
  const home = places.find((p) => p.label === 'Home');
  assert.ok(home, 'place saved');
  assert.equal(home.status, 'danger', 'home is within 800m of a red report');
  assert.ok(home.nearest, 'nearest report attached');
});

test('expiry sweep retires old active reports', async () => {
  const reporter = { id: 'rep-exp', reputation: 1 };
  store.ensureReporter(reporter.id);
  const { report } = await api.createReport(reporter, {
    lat: 12.8700, lng: 74.8430, place: 'Expiry test', depth: 'ankle'
  });
  // Force expiry by rewriting expires_at into the past via updateReport.
  const row = store.getReport(report.id);
  store.updateReport({ ...row, expires_at: Date.now() - 1000 });
  const removed = store.runExpirySweep();
  assert.ok(removed >= 1, 'sweep should retire at least one expired report');
  assert.equal(store.getReport(report.id).status, 'expired');
});
