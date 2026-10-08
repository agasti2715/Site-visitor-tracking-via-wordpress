import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const dbPath = resolve(process.env.DB_PATH || './data/tracker.db');
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sites (
    id          TEXT PRIMARY KEY,
    url         TEXT NOT NULL,
    host        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- One row per browser per site. visitor_key is a random id the tracker
  -- keeps in the visitor's localStorage.
  CREATE TABLE IF NOT EXISTS visitors (
    id           INTEGER PRIMARY KEY,
    site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    visitor_key  TEXT NOT NULL,
    name         TEXT,
    email        TEXT,
    company      TEXT,
    first_seen   TEXT NOT NULL,
    last_seen    TEXT NOT NULL,
    UNIQUE (site_id, visitor_key)
  );

  CREATE TABLE IF NOT EXISTS pageviews (
    id           INTEGER PRIMARY KEY,
    site_id      TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    visitor_id   INTEGER NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
    session_key  TEXT NOT NULL,
    url          TEXT NOT NULL,
    path         TEXT NOT NULL,
    title        TEXT,
    referrer     TEXT,
    ip           TEXT,
    country      TEXT,
    country_code TEXT,
    region       TEXT,
    city         TEXT,
    timezone     TEXT,
    org          TEXT,
    isp          TEXT,
    network_type TEXT,   -- 'company' | 'isp' | 'mobile' | 'hosting' | 'local' | null
    browser      TEXT,
    os           TEXT,
    device       TEXT,
    user_agent   TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS pageviews_site_time    ON pageviews (site_id, created_at);
  CREATE INDEX IF NOT EXISTS pageviews_visitor_time ON pageviews (visitor_id, created_at);
  CREATE INDEX IF NOT EXISTS visitors_site_seen     ON visitors (site_id, last_seen);

  CREATE TABLE IF NOT EXISTS ip_cache (
    ip          TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    fetched_at  TEXT NOT NULL
  );
`);

// Columns added after the first release. Adding them here keeps existing databases working.
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const addColumn = (table, name, type) => {
  if (!columns(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
};

// A site whose visits come from the WordPress plugin instead of the hosted tracker script.
addColumn('sites', 'wp_url', 'TEXT');
addColumn('sites', 'wp_key', 'TEXT');
addColumn('sites', 'cursor_id', 'INTEGER NOT NULL DEFAULT 0');
addColumn('sites', 'cursor_time', 'TEXT');
addColumn('sites', 'last_sync', 'TEXT');
addColumn('sites', 'last_error', 'TEXT');

// The id the row had on the WordPress site, so re-syncing can't duplicate visits.
addColumn('pageviews', 'remote_id', 'INTEGER');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS pageviews_remote
         ON pageviews (site_id, remote_id) WHERE remote_id IS NOT NULL`);

export const q = (sql) => db.prepare(sql);
