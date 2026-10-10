/**
 * SQLite schema + index DDL for JalRakshak.
 * Kept separate so it can be run idempotently on boot and inspected easily.
 *
 * Timestamps are epoch milliseconds (INTEGER). Geospatial lookups use a
 * lat/lng bbox pre-filter in SQL + precise haversine in JS (city-scale MVP).
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reports (
  id            TEXT PRIMARY KEY,
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  place         TEXT NOT NULL,
  depth         TEXT NOT NULL,
  level         TEXT NOT NULL,
  road_blocked  INTEGER NOT NULL DEFAULT 0,
  note          TEXT NOT NULL DEFAULT '',
  photo_path    TEXT,
  reporter_id   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  confidence    REAL NOT NULL DEFAULT 0.5,
  confirmations INTEGER NOT NULL DEFAULT 0,
  disputes      INTEGER NOT NULL DEFAULT 0,
  rainfall_mm   REAL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status   ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_expires  ON reports(expires_at);
CREATE INDEX IF NOT EXISTS idx_reports_bbox     ON reports(lat, lng);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);

CREATE TABLE IF NOT EXISTS confirmations (
  id          TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conf_report ON confirmations(report_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conf_unique
  ON confirmations(report_id, reporter_id, kind);

CREATE TABLE IF NOT EXISTS reporters (
  id            TEXT PRIMARY KEY,
  phone_hash    TEXT UNIQUE,
  display_name  TEXT,
  reputation    REAL NOT NULL DEFAULT 1.0,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_places (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  label       TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_places_reporter ON saved_places(reporter_id);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_reporter ON sessions(reporter_id);

CREATE TABLE IF NOT EXISTS hotspots (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  area     TEXT,
  lat      REAL NOT NULL,
  lng      REAL NOT NULL,
  cause    TEXT,
  baseline TEXT,
  source   TEXT,
  note     TEXT
);
`;

export const PRAGMAS_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
`;

export default SCHEMA_SQL;
