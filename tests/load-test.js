/**
 * Load test: simulates a heavy-rain traffic spike.
 * Imports the real server, listens on an ephemeral port, fires concurrent
 * requests, prints latency/throughput, and writes load-report.txt.
 *
 * Usage:  node tests/load-test.js
 * Env:    LOAD_CONCURRENCY (50), LOAD_TOTAL (500)
 */
import { writeFileSync } from 'node:fs';

process.env.DB_PATH = ':memory:'; // in-memory DB before importing the data layer
const { server } = await import('../server.js');

const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 50);
const TOTAL = Number(process.env.LOAD_TOTAL || 500);

const SEEDS = [
  { lat: 12.9505, lng: 74.8840 }, { lat: 12.8920, lng: 74.8730 },
  { lat: 12.8720, lng: 74.8430 }, { lat: 12.8420, lng: 74.8610 }
];
const DEPTHS = ['ankle', 'knee', 'waist', 'vehicle-stalling', 'impassable'];
const jitter = (n) => n + (Math.random() - 0.5) * 0.01;
const out = [];
const log = (s) => { out.push(s); console.log(s); };

async function post(token, path, data) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data)
  });
  return res.json();
}
async function get(path) { return (await fetch(`${BASE}${path}`)).json(); }

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

// Listen on an ephemeral port (0) and discover the assigned port.
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
await get('/api/health'); // warm up

log(`Load test -> ${BASE}`);
log(`Concurrency=${CONCURRENCY}  TotalRequests=${TOTAL}`);

const writeLat = [], readLat = [];
let errors = 0;
const perWorker = Math.ceil(TOTAL / CONCURRENCY);
const t0 = Date.now();

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  try {
    const { token } = await post('', '/api/session', {});
    for (let i = 0; i < perWorker; i++) {
      if (Math.random() < 0.5) {
        const seed = SEEDS[i % SEEDS.length];
        const t = process.hrtime.bigint();
        await post(token, '/api/reports', {
          lat: jitter(seed.lat), lng: jitter(seed.lng),
          place: `Load spot ${i}`, depth: DEPTHS[i % DEPTHS.length],
          roadBlocked: i % 3 === 0, note: 'load test'
        });
        writeLat.push(Number(process.hrtime.bigint() - t) / 1e6);
      } else {
        const t = process.hrtime.bigint();
        await get('/api/reports');
        readLat.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    }
  } catch (e) { errors++; }
}));

const secs = (Date.now() - t0) / 1000;
server.close();

writeLat.sort((a, b) => a - b);
readLat.sort((a, b) => a - b);
const all = [...writeLat, ...readLat].sort((a, b) => a - b);

log(`\nCompleted in ${secs.toFixed(2)}s - ${(TOTAL / secs).toFixed(0)} req/s`);
log(`Errors: ${errors}`);
const row = (label, arr) => arr.length
  ? log(`${label.padEnd(6)} n=${String(arr.length).padEnd(5)} p50=${pct(arr, 0.5).toFixed(1)}ms  p95=${pct(arr, 0.95).toFixed(1)}ms  max=${arr[arr.length - 1].toFixed(1)}ms`)
  : log(`${label.padEnd(6)} (none)`);
row('WRITE', writeLat); row('READ', readLat); row('ALL', all);
const p95 = pct(all, 0.95);
log(`\n${p95 < 500 ? 'PASS' : 'WARN'}: p95 latency ${p95.toFixed(1)}ms (target < 500ms under spike)`);

writeFileSync(new URL('../load-report.txt', import.meta.url), out.join('\n'));
process.exit(errors > 0 || p95 >= 500 ? 1 : 0);
