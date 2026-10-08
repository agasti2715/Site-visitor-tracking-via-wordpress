// One-off: copies the local database (data/tracker.db) into the Turso database named in .env.
//   npm run copy-to-turso
// Refuses to run if Turso already has sites, so it can't create duplicates.
import { createClient } from '@libsql/client';
import { db as dest, ready, isRemote, all } from '../src/db.js';

if (!isRemote) {
  console.error('TURSO_DATABASE_URL is not set in .env — nothing to copy to.');
  process.exit(1);
}
await ready; // creates the tables in Turso

const sourcePath = (process.env.DB_PATH || './data/tracker.db').replace(/\\/g, '/');
const source = createClient({ url: 'file:' + sourcePath });

const [{ n: existing }] = await all('SELECT COUNT(*) AS n FROM sites');
if (existing > 0 && !process.argv.includes('--force')) {
  console.error(`Turso already has ${existing} site(s). Not copying, to avoid duplicates.`);
  process.exit(1);
}

// Parents before children, so every visitor and visit finds its site.
for (const table of ['sites', 'visitors', 'pageviews', 'ip_cache']) {
  const destColumns = new Set((await all(`PRAGMA table_info(${table})`)).map((c) => c.name));
  const sourceColumns = (await source.execute(`PRAGMA table_info(${table})`)).rows.map((c) => c.name);
  const columns = sourceColumns.filter((c) => destColumns.has(c));
  const rows = (await source.execute(`SELECT ${columns.join(', ')} FROM ${table}`)).rows;

  const insert = `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  for (let i = 0; i < rows.length; i += 200) {
    await dest.batch(rows.slice(i, i + 200).map((row) => ({ sql: insert, args: columns.map((c) => row[c]) })), 'write');
  }
  const [{ n }] = await all(`SELECT COUNT(*) AS n FROM ${table}`);
  console.log(`${table.padEnd(10)} ${String(rows.length).padStart(6)} copied, ${n} now in Turso`);
}
console.log('Done.');
