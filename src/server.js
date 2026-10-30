import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { all, get, run, batch, stmt, ready, isRemote } from './db.js';
import { lookupIp, relabelStoredVisits } from './geo.js';
import { isBot, parseUa } from './ua.js';
import { makeZip } from './zip.js';
import { ping, syncSite, syncAll } from './services/wpSync.js';
import { refreshAutomated, refreshAllAutomated } from './automated.js';

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', true);

const now = () => new Date().toISOString();
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
// Express 4 does not catch errors thrown by async handlers; this passes them on.
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function normaliseUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try {
    const u = new URL(raw);
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return { url: u.origin, host: u.hostname.replace(/^www\./, '').toLowerCase() };
  } catch {
    return null;
  }
}

// A hit counts for a site when it comes from the site's host, www.host, or a subdomain.
function hostMatches(siteHost, candidate) {
  if (!candidate) return false;
  let host;
  try { host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  return host === siteHost || host.endsWith('.' + siteHost);
}

const findSite = (id) => get('SELECT * FROM sites WHERE id = ?', [id]);
// Site keys stay on the server; nothing sent to the browser includes them.
const publicSite = (site) => {
  if (!site) return site;
  const { wp_key, ...rest } = site;
  return { ...rest, connected: wp_key ? 1 : 0 };
};

// ───────────────────────── Public: health check, tracker script, collector ─────────────────────────

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/t.js', (req, res) => {
  // Short cache so tracker updates reach every site within minutes (ETag makes re-checks cheap).
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(join(PUBLIC_DIR, 't.js'));
});

const UPSERT_VISITOR = `
  INSERT INTO visitors (site_id, visitor_key, first_seen, last_seen) VALUES (?, ?, ?, ?)
  ON CONFLICT(site_id, visitor_key) DO UPDATE SET last_seen = excluded.last_seen`;

// For sites using the hosted script (not the WordPress plugin). It posts text/plain JSON
// (a "simple" request, so no CORS preflight).
app.post('/collect', express.text({ type: '*/*', limit: '8kb' }), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.status(204).end(); // Answer right away; the visitor's browser never waits on us.

  try {
    let body;
    try { body = JSON.parse(req.body); } catch { return; }
    const site = typeof body?.site === 'string' && await findSite(body.site);
    if (!site) return;

    const pageUrl = clip(body.url, 2000);
    if (!hostMatches(site.host, req.get('origin') || pageUrl)) return;

    const ua = req.get('user-agent') || '';
    if (isBot(ua)) return;

    const visitorKey = clip(body.vid, 64);
    if (!visitorKey) return;
    const ts = now();

    if (body.type === 'engage') {
      await batch([
        stmt('UPDATE visitors SET engaged = 1 WHERE site_id = ? AND visitor_key = ?', [site.id, visitorKey]),
        ...refreshAutomated(site.id, [visitorKey]),
      ]);
      return;
    }

    if (body.type === 'identify') {
      await batch([
        stmt(UPSERT_VISITOR, [site.id, visitorKey, ts, ts]),
        stmt(`UPDATE visitors SET name = COALESCE(?, name), email = COALESCE(?, email), company = COALESCE(?, company)
              WHERE site_id = ? AND visitor_key = ?`,
          [clip(body.name, 200) || null, clip(body.email, 200) || null, clip(body.company, 200) || null, site.id, visitorKey]),
        ...refreshAutomated(site.id, [visitorKey]),
      ]);
      return;
    }

    let path;
    try { path = new URL(pageUrl).pathname; } catch { return; }

    const ip = req.ip;
    const geo = await lookupIp(ip);
    const { browser, os, device } = parseUa(ua);
    await batch([
      stmt(UPSERT_VISITOR, [site.id, visitorKey, ts, ts]),
      stmt(`INSERT INTO pageviews (site_id, visitor_id, session_key, url, path, title, referrer, ip,
              country, country_code, region, city, timezone, org, isp, network_type,
              browser, os, device, user_agent, created_at)
            VALUES (?, (SELECT id FROM visitors WHERE site_id = ? AND visitor_key = ?),
              ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [site.id, site.id, visitorKey, clip(body.sid, 64) || 'none', pageUrl, path,
          clip(body.title, 300), clip(body.ref, 2000) || null, ip,
          geo.country, geo.country_code, geo.region, geo.city, geo.timezone, geo.org, geo.isp, geo.network_type,
          browser, os, device, ua.slice(0, 500), ts]),
      ...refreshAutomated(site.id, [visitorKey]),
    ]);
  } catch (err) {
    console.error('collect failed:', err.message);
  }
});

app.options('/collect', (req, res) => {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
  res.status(204).end();
});

// ───────────────────────── Private: dashboard + API ─────────────────────────

function requireAuth(req, res, next) {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return next();
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  const supplied = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(supplied), b = Buffer.from(password);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Site Visit Tracker"').status(401).send('Login required');
}

app.use(requireAuth);
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));
app.use('/api', express.json({ limit: '16kb' }));

const sinceFor = (days) => new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 3650) * 864e5).toISOString();

// Likely-automated visitors (src/automated.js) are left out unless ?bots=1.
const showBots = (req) => req.query.bots === '1';
const WITHOUT_BOTS = 'AND visitor_id NOT IN (SELECT id FROM visitors WHERE site_id = ? AND automated = 1)';

app.get('/api/sites', h(async (req, res) => {
  res.json(await all(`
    SELECT s.id, s.url, s.host, s.name, s.created_at, s.wp_url, s.last_sync, s.last_error,
      (s.wp_key IS NOT NULL) AS connected,
      (SELECT COUNT(*) FROM visitors v WHERE v.site_id = s.id AND v.automated = 0) AS visitors,
      (SELECT COUNT(*) FROM pageviews p WHERE p.site_id = s.id) AS pageviews,
      (SELECT MAX(created_at) FROM pageviews p WHERE p.site_id = s.id) AS last_hit
    FROM sites s ORDER BY s.created_at`));
}));

app.post('/api/sites', h(async (req, res) => {
  const parsed = normaliseUrl(req.body?.url);
  if (!parsed) return res.status(400).json({ error: 'That does not look like a website address.' });
  const existing = await get('SELECT * FROM sites WHERE host = ?', [parsed.host]);
  if (existing) return res.json({ site: publicSite(existing), existed: true });
  const name = clip(req.body?.name, 100)?.trim() || parsed.host;
  const id = randomBytes(6).toString('base64url');
  await run('INSERT INTO sites (id, url, host, name, created_at) VALUES (?, ?, ?, ?, ?)', [id, parsed.url, parsed.host, name, now()]);
  res.status(201).json({ site: publicSite(await findSite(id)), existed: false });
}));

// Explicit deletes rather than ON DELETE CASCADE: a remote connection may not keep
// SQLite's foreign_keys setting between requests.
app.delete('/api/sites/:id', h(async (req, res) => {
  const id = req.params.id;
  const results = await batch([
    stmt('DELETE FROM pageviews WHERE site_id = ?', [id]),
    stmt('DELETE FROM visitors WHERE site_id = ?', [id]),
    stmt('DELETE FROM sites WHERE id = ?', [id]),
  ]);
  res.status(results[2].rowsAffected ? 204 : 404).end();
}));

app.get('/api/sites/:id/summary', h(async (req, res) => {
  const site = await findSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const since = sinceFor(req.query.days);
  // Every page-view query below shares this filter.
  const where = `site_id = ? AND created_at >= ? ${showBots(req) ? '' : WITHOUT_BOTS}`;
  const args = showBots(req) ? [site.id, since] : [site.id, since, site.id];
  const top = (col, limit = 8) => all(`
    SELECT ${col} AS label, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews
    FROM pageviews WHERE ${where} AND ${col} IS NOT NULL AND ${col} != ''
    GROUP BY ${col} ORDER BY visitors DESC, pageviews DESC LIMIT ${limit}`, args);

  // In parallel: with a hosted database each query is a network round trip.
  const [totals, identified, automated, companies, countries, regions, pages, referrers, daily] = await Promise.all([
    get(`SELECT COUNT(DISTINCT visitor_id) AS visitors, COUNT(DISTINCT session_key) AS visits, COUNT(*) AS pageviews
         FROM pageviews WHERE ${where}`, args),
    get(`SELECT COUNT(*) AS n FROM visitors
         WHERE site_id = ? AND last_seen >= ? AND (name IS NOT NULL OR email IS NOT NULL OR company IS NOT NULL)`, [site.id, since]),
    // How much is being hidden, so the dashboard can say so.
    get(`SELECT COUNT(DISTINCT p.visitor_id) AS visitors, COUNT(*) AS pageviews
         FROM pageviews p JOIN visitors v ON v.id = p.visitor_id
         WHERE p.site_id = ? AND p.created_at >= ? AND v.automated = 1`, [site.id, since]),
    all(`SELECT org AS label, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews
         FROM pageviews WHERE ${where} AND network_type = 'company'
         GROUP BY org ORDER BY visitors DESC, pageviews DESC LIMIT 8`, args),
    top('country'),
    top(`region || ', ' || country`),
    top('path'),
    all(`SELECT referrer AS label, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews
         FROM pageviews WHERE ${where} AND referrer IS NOT NULL
         GROUP BY referrer ORDER BY visitors DESC LIMIT 8`, args),
    // Bucket by the viewer's local day; tz = minutes east of UTC (IST = 330).
    all(`SELECT substr(datetime(created_at, ? || ' minutes'), 1, 10) AS day,
                COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews
         FROM pageviews WHERE ${where}
         GROUP BY day ORDER BY day`, [Math.trunc(Number(req.query.tz)) || 0, ...args]),
  ]);
  res.json({ site: publicSite(site), totals, identified: identified.n, automated, companies, countries, regions,
    pages, referrers, daily, showing_automated: showBots(req) });
}));

// Each visitor with their latest known location / network, plus how many different
// places they have come from (people switch VPN locations, or visit from home and office).
const VISITOR_SELECT = `
  SELECT v.id, v.visitor_key, v.name, v.email, v.company, v.first_seen, v.last_seen, v.engaged, v.automated,
         (SELECT COUNT(DISTINCT session_key) FROM pageviews p WHERE p.visitor_id = v.id) AS visits,
         (SELECT COUNT(*) FROM pageviews p WHERE p.visitor_id = v.id) AS pageviews,
         (SELECT COUNT(DISTINCT ip) FROM pageviews p WHERE p.visitor_id = v.id) AS ip_count,
         (SELECT COUNT(DISTINCT COALESCE(city, '') || '|' || country) FROM pageviews p
           WHERE p.visitor_id = v.id AND p.country IS NOT NULL) AS place_count,
         EXISTS (SELECT 1 FROM pageviews p WHERE p.visitor_id = v.id AND p.network_type = 'hosting') AS uses_vpn,
         (SELECT org FROM pageviews p WHERE p.visitor_id = v.id AND p.network_type = 'company'
           ORDER BY created_at DESC LIMIT 1) AS company_network,
         l.country, l.country_code, l.region, l.city, l.org, l.isp, l.network_type,
         l.browser, l.os, l.device, l.path AS last_path, l.ip
  FROM visitors v
  LEFT JOIN pageviews l ON l.id = (SELECT id FROM pageviews WHERE visitor_id = v.id ORDER BY created_at DESC LIMIT 1)`;

app.get('/api/sites/:id/visitors', h(async (req, res) => {
  const site = await findSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const search = `%${String(req.query.q || '').trim()}%`;
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  // Search covers every place and network a visitor has used, not only the latest one,
  // so "Madrid" still finds someone whose last visit came from Amsterdam.
  res.json(await all(`${VISITOR_SELECT}
    WHERE v.site_id = ? AND v.last_seen >= ? ${showBots(req) ? '' : 'AND v.automated = 0'}
      AND (? = '%%' OR v.name LIKE ? OR v.email LIKE ? OR v.company LIKE ?
           OR EXISTS (SELECT 1 FROM pageviews s WHERE s.visitor_id = v.id
                      AND (s.org LIKE ? OR s.country LIKE ? OR s.region LIKE ? OR s.city LIKE ? OR s.ip LIKE ?)))
    ORDER BY v.last_seen DESC LIMIT ?`,
    [site.id, sinceFor(req.query.days), search, search, search, search, search, search, search, search, search, limit]));
}));

app.get('/api/visitors/:id', h(async (req, res) => {
  const id = Number(req.params.id);
  const [visitor, hits, places] = await Promise.all([
    get(`${VISITOR_SELECT} WHERE v.id = ?`, [id]),
    all(`SELECT session_key, url, path, title, referrer, ip, country, country_code, region, city, org, network_type,
                browser, os, device, created_at
         FROM pageviews WHERE visitor_id = ? ORDER BY created_at DESC LIMIT 1000`, [id]),
    // Every IP address this visitor has come from, newest first.
    all(`SELECT ip, country, country_code, region, city, org, network_type,
                COUNT(DISTINCT session_key) AS visits, COUNT(*) AS pageviews,
                MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
         FROM pageviews WHERE visitor_id = ?
         GROUP BY ip ORDER BY last_seen DESC`, [id]),
  ]);
  if (!visitor) return res.status(404).json({ error: 'Visitor not found' });

  // Group page views into visits (sessions), newest first.
  const sessions = new Map();
  for (const hit of hits) {
    if (!sessions.has(hit.session_key)) {
      sessions.set(hit.session_key, { started: hit.created_at, ended: hit.created_at, pages: [],
        referrer: null, ip: hit.ip, country: hit.country, country_code: hit.country_code, region: hit.region,
        city: hit.city, org: hit.org, network_type: hit.network_type, browser: hit.browser, os: hit.os, device: hit.device });
    }
    const s = sessions.get(hit.session_key);
    s.started = hit.created_at;
    s.referrer = hit.referrer || s.referrer;
    s.pages.unshift({ path: hit.path, title: hit.title, url: hit.url, at: hit.created_at, ip: hit.ip });
  }
  res.json({ visitor, places, visits: [...sessions.values()] });
}));

// The WordPress plugin. Visits are stored on the client's own site; this dashboard
// pulls them in. The key is generated here and baked in, so nothing has to be typed.
const PLUGIN_DIR = join(PUBLIC_DIR, '..', 'wordpress', 'site-visit-tracker');
const PLUGIN_FILES = [
  'site-visit-tracker.php',
  'includes/db.php',
  'includes/rest.php',
  'includes/admin.php',
];
app.get('/api/sites/:id/wordpress-plugin.zip', h(async (req, res) => {
  const site = await findSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  // One key per site, kept so the dashboard can read that site straight away.
  const key = site.wp_key || randomBytes(30).toString('base64url').slice(0, 40);
  await run('UPDATE sites SET wp_key = ?, wp_url = COALESCE(wp_url, ?) WHERE id = ?', [key, site.url, site.id]);

  // Optional ?apollo=<24 hex> turns on Apollo.io's visitor tracker in this site's plugin.
  const apollo = /^[a-f0-9]{24}$/i.test(String(req.query.apollo || '')) ? String(req.query.apollo).toLowerCase() : '';

  const files = PLUGIN_FILES.map((name) => {
    let text = readFileSync(join(PLUGIN_DIR, name), 'utf8');
    if (name.endsWith('site-visit-tracker.php')) {
      text = text.replace("'__SVT_API_KEY__'", `'${key}'`);
      if (apollo) text = text.replace("'__SVT_APOLLO_ID__'", `'${apollo}'`);
    }
    return { name: `site-visit-tracker/${name}`, data: text };
  });
  files.push({ name: 'site-visit-tracker/assets/t.js', data: readFileSync(join(PUBLIC_DIR, 't.js'), 'utf8') });

  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="site-visit-tracker-${site.host.replace(/[^a-z0-9.-]/g, '')}.zip"`,
  }).send(makeZip(files));
}));

// Connect (or re-connect) a WordPress site: checks the key works before saving it.
app.post('/api/sites/:id/connect', h(async (req, res) => {
  const site = await findSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const wpUrl = (req.body?.wp_url || site.wp_url || site.url || '').replace(/\/+$/, '');
  const wpKey = String(req.body?.wp_key || site.wp_key || '').trim();
  if (!/^https?:\/\//.test(wpUrl) || !wpKey) {
    return res.status(400).json({ error: 'A site address and a site key are both needed.' });
  }
  try {
    const info = await ping({ ...site, wp_url: wpUrl, wp_key: wpKey });
    await run('UPDATE sites SET wp_url = ?, wp_key = ?, last_error = NULL WHERE id = ?', [wpUrl, wpKey, site.id]);
    const { added } = await syncSite(await findSite(site.id));
    res.json({ connected: true, site: publicSite(await findSite(site.id)), remote: info, added });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}));

app.post('/api/sites/:id/sync', h(async (req, res) => {
  const site = await findSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!site.wp_url || !site.wp_key) return res.status(400).json({ error: 'This site is not connected to a WordPress plugin.' });
  try {
    const result = await syncSite(site);
    res.json({ ...result, site: publicSite(await findSite(site.id)) });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
}));

app.get('/api/sites/:id/activity', h(async (req, res) => {
  res.json(await all(`
    SELECT p.id, p.visitor_id, p.path, p.title, p.referrer, p.country, p.region, p.city, p.org,
           p.network_type, p.device, p.created_at, v.name, v.company, v.email
    FROM pageviews p JOIN visitors v ON v.id = p.visitor_id
    WHERE p.site_id = ? ${showBots(req) ? '' : 'AND v.automated = 0'} ORDER BY p.created_at DESC LIMIT ?`,
    [req.params.id, Math.min(Number(req.query.limit) || 50, 500)]));
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again in a moment.' });
});

// Start listening straight away (a sleeping free host must answer quickly when woken),
// then catch up on every connected WordPress site in the background.
await ready;
// Judge every existing visitor once, so data from before this rule existed is covered too.
await batch([refreshAllAutomated()]);
app.listen(PORT, () => {
  console.log(`Site Visit Tracker running at http://localhost:${PORT} (${isRemote ? 'Turso database' : 'local database file'})`);
  if (!process.env.DASHBOARD_PASSWORD) console.log('  (dashboard has no password — set DASHBOARD_PASSWORD before deploying)');
});

const SYNC_EVERY_MS = Math.max(30, Number(process.env.SYNC_SECONDS) || 60) * 1000;
const RELABEL_EVERY = 10; // syncs between relabel passes
let syncs = 0;
const syncTick = () => syncAll()
  .then(() => (syncs++ % RELABEL_EVERY === 0 ? relabelStoredVisits() : 0))
  .catch((err) => console.error('sync failed:', err.message));
setInterval(syncTick, SYNC_EVERY_MS).unref();
syncTick();
