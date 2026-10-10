/**
 * End-to-end HTTP test against the real server module (no child process).
 * Boots the server in-process on an ephemeral port and exercises the full
 * flow over real HTTP, including static asset serving. Run: node --test tests/
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.ADMIN_TOKEN = 'e2e-admin';

const { server } = await import('../server.js');
let BASE;

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const j = async (path, opts) => {
  const res = await fetch(BASE + path, opts);
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
};
const post = (path, data, headers = {}) =>
  j(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });

test('serves the front-end index with the app scripts wired', async () => {
  const res = await fetch(BASE + '/');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /JalRakshak/);
  assert.match(html, /src="\/api.js"/);
  assert.match(html, /src="\/app.js"/);
});

test('serves api.js and app.js as JavaScript', async () => {
  for (const asset of ['/api.js', '/app.js', '/styles.css']) {
    const res = await fetch(BASE + asset);
    assert.equal(res.status, 200, `${asset} should be served`);
    assert.match(res.headers.get('content-type'), /javascript|css/);
  }
});

test('serves the admin dashboard', async () => {
  const res = await fetch(BASE + '/admin.html');
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Moderation dashboard/);
});

test('full report lifecycle over HTTP', async () => {
  const sess = await post('/api/session');
  const auth = { Authorization: `Bearer ${sess.body.token}` };

  const created = await post('/api/reports', {
    lat: 12.9505, lng: 74.8840, place: 'E2E Kottara', depth: 'impassable', roadBlocked: true
  }, auth);
  assert.equal(created.status, 201);
  assert.equal(created.body.report.level, 'red');
  const id = created.body.report.id;

  const list = await j('/api/reports');
  assert.ok(list.body.reports.some((r) => r.id === id));

  // Confirm from a second session.
  const sess2 = await post('/api/session');
  const conf = await post(`/api/reports/${id}/confirm`, { kind: 'still-flooded' }, { Authorization: `Bearer ${sess2.body.token}` });
  assert.equal(conf.body.report.confirmations, 1);

  // Admin can see it in the queue with the token.
  const queue = await j('/api/admin/queue', { headers: { 'X-Admin-Token': 'e2e-admin' } });
  assert.ok(queue.body.reports.some((r) => r.id === id));

  // Admin removes it.
  const mod = await post(`/api/admin/moderate/${id}`, { action: 'remove' }, { 'X-Admin-Token': 'e2e-admin' });
  assert.equal(mod.body.status, 'removed');

  // It no longer appears in the public list.
  const list2 = await j('/api/reports');
  assert.ok(!list2.body.reports.some((r) => r.id === id));
});

test('rejects unauthenticated report submission', async () => {
  const res = await post('/api/reports', { lat: 12.9, lng: 74.85, depth: 'knee' });
  assert.equal(res.status, 401);
});

test('rate limiting kicks in for auth bursts', async () => {
  // Fire well beyond the per-minute auth limit from the same IP.
  const results = await Promise.all(
    Array.from({ length: 25 }, () => post('/api/auth/otp', { phone: '9845000000' }))
  );
  assert.ok(results.some((r) => r.status === 429), 'should eventually return 429');
});
