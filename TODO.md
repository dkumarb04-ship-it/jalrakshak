# JalRakshak — implementation status

## Done (backend + front-end wiring)
- [x] Zero-dependency Node backend (`node:http` + built-in `node:sqlite`), runs with `node server.js`.
- [x] REST API: reports CRUD, confirmations (still-flooded/cleared/dispute), saved places, route check, hotspots, admin moderation, stats.
- [x] Anonymous + phone-OTP login (OTP is a dev simulation — replace with a real SMS provider before launch).
- [x] Live map driven by real lat/lng → SVG projection (`mapX/mapY`); colour-coded severity.
- [x] Confidence scoring + report expiry + community de-escalation (`src/confidence.js`).
- [x] Offline-first reporting: client queue in localStorage + auto-retry on reconnect (`public/api.js`).
- [x] Real GPS capture + on-device photo compression; EXIF/GPS stripped server-side (`src/images.js`).
- [x] Route/destination flood check via corridor buffer (`/api/route-check`).
- [x] Realtime updates via Server-Sent Events (`/api/events`).
- [x] Admin moderation dashboard (`public/admin.html`) with queue, stats, approve/remove.
- [x] Seed data: 18 real Mangaluru flood hotspots with causes + sources (`src/seed-hotspots.js`).
- [x] Rate limiting, input validation, upload hardening, CORS.
- [x] Tests: 33 unit + integration + E2E (`npm test`); spike load test (`npm run loadtest`).
- [x] README with setup, architecture, API, security, ops checklist, decisions log.

## Next (V2 / pre-launch)
- [ ] Verify seed hotspot coordinates against MCC ward maps.
- [ ] Real SMS provider for OTP + push/SMS/WhatsApp-style alerts for saved places & routes.
- [ ] Localisation: Kannada first, then Tulu/Konkani/Hindi; plain wording pass.
- [ ] Rainfall / tide / river-level overlays from open data (IMD, CWC gauges).
- [ ] Historical flood heatmap + volunteer badges + ward-level reports.
- [ ] Emergency contacts & shelters map; official-agency data sharing MoU.
- [ ] Migrate to PostgreSQL + PostGIS, S3 + CDN, Redis at scale (see README §8).
- [ ] Legal: DPDP Act 2023 review, privacy policy, terms, liability wording.

