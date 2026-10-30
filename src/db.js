// Storage. Turso (hosted, SQLite-compatible) when TURSO_DATABASE_URL is set,
// otherwise a local SQLite file — same SQL either way.
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const remoteUrl = process.env.TURSO_DATABASE_URL;
export const isRemote = Boolean(remoteUrl);

function localUrl() {
  const path = resolve(process.env.DB_PATH || './data/tracker.db');
  mkdirSync(dirname(path), { recursive: true });
  // A relative path keeps spaces and drive letters out of the URL.
  return 'file:' + relative(process.cwd(), path).replace(/\\/g, '/');
}

export const db = createClient(isRemote
  ? { url: remoteUrl, authToken: process.env.TURSO_AUTH_TOKEN }
  : { url: localUrl() });

// libsql rejects undefined and booleans; SQLite stores both as integers anyway.
const clean = (args = []) => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a));
const plain = (rs) => rs.rows.map((row) => ({ ...row }));

export const stmt = (sql, args = []) => ({ sql, args: clean(args) });
export async function all(sql, args) { return plain(await db.execute(stmt(sql, args))); }
export async function get(sql, args) { return (await all(sql, args))[0]; }
export async function run(sql, args) {
  const rs = await db.execute(stmt(sql, args));
  return { changes: rs.rowsAffected, lastId: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) };
}
/** Several statements in one round trip and one transaction. */
export async function batch(statements, mode = 'write') {
  if (!statements.length) return [];
  return db.batch(statements, mode);
}

const SCHEMA = `
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
`;

// Columns added after the first release. Adding them here keeps existing databases working.
const LATER_COLUMNS = [
  // A site whose visits come from the WordPress plugin instead of the hosted tracker script.
  ['sites', 'wp_url', 'TEXT'],
  ['sites', 'wp_key', 'TEXT'],
  ['sites', 'cursor_id', 'INTEGER NOT NULL DEFAULT 0'],
  ['sites', 'cursor_time', 'TEXT'],
  ['sites', 'last_sync', 'TEXT'],
  ['sites', 'last_error', 'TEXT'],
  // The id the row had on the WordPress site, so re-syncing can't duplicate visits.
  ['pageviews', 'remote_id', 'INTEGER'],
  // 1 once the visitor moved the mouse, tapped or typed (plugin 1.0.3+): a person, not a scanner.
  ['visitors', 'engaged', 'INTEGER NOT NULL DEFAULT 0'],
  // 1 = "likely automated"; see src/automated.js for the rule.
  ['visitors', 'automated', 'INTEGER NOT NULL DEFAULT 0'],
];

async function init() {
  if (!isRemote) await db.execute('PRAGMA journal_mode = WAL');
  await db.executeMultiple(SCHEMA);
  for (const [table, column, type] of LATER_COLUMNS) {
    const existing = (await all(`PRAGMA table_info(${table})`)).map((c) => c.name);
    if (!existing.includes(column)) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS pageviews_remote
                    ON pageviews (site_id, remote_id) WHERE remote_id IS NOT NULL`);
  await db.execute('CREATE INDEX IF NOT EXISTS visitors_site_automated ON visitors (site_id, automated)');
}

/** Resolves once the tables exist. Await it before serving requests. */
export const ready = init();
