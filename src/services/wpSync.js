// Pulls visits from a WordPress site running the plugin, and works out each
// visitor's location and company here — so the client's site never waits on a lookup.
import { all, run, batch, stmt } from '../db.js';
import { lookupMany } from '../geo.js';
import { parseUa } from '../ua.js';

const UPSERT_VISITOR = `
  INSERT INTO visitors (site_id, visitor_key, first_seen, last_seen) VALUES (?, ?, ?, ?)
  ON CONFLICT(site_id, visitor_key) DO UPDATE SET last_seen = MAX(visitors.last_seen, excluded.last_seen)`;
// The visitor id is looked up inside the statement, so a whole page of visits can be
// written in one batch without a round trip per visitor.
const INSERT_PAGEVIEW = `
  INSERT INTO pageviews (site_id, visitor_id, session_key, url, path, title, referrer, ip,
    country, country_code, region, city, timezone, org, isp, network_type,
    browser, os, device, user_agent, created_at, remote_id)
  VALUES (?, (SELECT id FROM visitors WHERE site_id = ? AND visitor_key = ?),
    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (site_id, remote_id) WHERE remote_id IS NOT NULL DO NOTHING`;
const APPLY_IDENTITY = `
  UPDATE visitors SET name = COALESCE(?, name), email = COALESCE(?, email), company = COALESCE(?, company)
  WHERE site_id = ? AND visitor_key = ?`;
const SAVE_CURSOR = 'UPDATE sites SET cursor_id = ?, cursor_time = ?, last_sync = ?, last_error = NULL WHERE id = ?';
const SAVE_ERROR = 'UPDATE sites SET last_error = ?, last_sync = ? WHERE id = ?';

const utc = (mysqlTime) => (mysqlTime ? mysqlTime.replace(' ', 'T') + 'Z' : new Date().toISOString());

async function callSite(site, path, params = {}) {
  const url = new URL(`${site.wp_url.replace(/\/+$/, '')}/wp-json/svt/v1/${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'X-SVT-Key': site.wp_key, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 403) throw new Error('The site rejected the key. Check the key in WordPress → Settings → Site Visit Tracker.');
  if (res.status === 404) throw new Error('The plugin did not answer. Is it installed and active on this site?');
  if (!res.ok) throw new Error(`The site answered ${res.status}.`);
  return res.json();
}

export function ping(site) {
  return callSite(site, 'ping');
}

/** Fetches everything new, in pages, and returns how many visits arrived. */
export async function syncSite(site) {
  let added = 0;
  try {
    for (let page = 0; page < 20; page++) {
      const data = await callSite(site, 'export', {
        since_id: site.cursor_id || 0,
        since_time: site.cursor_time,
        limit: 500,
      });

      // One cache read for the whole page; only new IPs go to ip-api.
      const places = await lookupMany(data.events.map((e) => e.ip));

      const writes = [];
      for (const e of data.events) {
        const geo = (e.ip && places.get(e.ip)) || {};
        const { browser, os, device } = parseUa(e.user_agent || '');
        writes.push(stmt(UPSERT_VISITOR, [site.id, e.visitor_key, utc(e.first_seen), utc(e.last_seen)]));
        writes.push(stmt(INSERT_PAGEVIEW, [site.id, site.id, e.visitor_key,
          e.session_key || 'none', e.url, e.path || '/', e.title, e.referrer, e.ip,
          geo.country ?? null, geo.country_code ?? null, geo.region ?? null, geo.city ?? null,
          geo.timezone ?? null, geo.org ?? null, geo.isp ?? null, geo.network_type ?? null,
          browser, os, device, (e.user_agent || '').slice(0, 500), utc(e.created_at), Number(e.id)]));
      }
      for (const person of data.identities) {
        writes.push(stmt(UPSERT_VISITOR, [site.id, person.visitor_key, utc(person.first_seen), utc(person.last_seen)]));
        writes.push(stmt(APPLY_IDENTITY, [person.name || null, person.email || null, person.company || null,
          site.id, person.visitor_key]));
      }

      // The cursor moves in the same transaction as the rows, so a failure can't skip or
      // half-apply a page.
      site = { ...site, cursor_id: data.cursor.since_id, cursor_time: data.cursor.since_time };
      writes.push(stmt(SAVE_CURSOR, [site.cursor_id, site.cursor_time, new Date().toISOString(), site.id]));
      await batch(writes);
      added += data.events.length;
      if (!data.more) break;
    }
    return { added };
  } catch (err) {
    await run(SAVE_ERROR, [String(err.message || err), new Date().toISOString(), site.id]).catch(() => {});
    throw err;
  }
}

/** Every connected site, quietly, on a timer. */
export async function syncAll() {
  const sites = await all('SELECT * FROM sites WHERE wp_url IS NOT NULL AND wp_key IS NOT NULL');
  for (const site of sites) {
    try { await syncSite(site); } catch { /* the error is stored on the site row for the dashboard */ }
  }
}
