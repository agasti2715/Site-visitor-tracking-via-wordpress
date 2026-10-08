import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { db, q } from './db.js';
import { lookupIp, relabelStoredVisits } from './geo.js';
import { isBot, parseUa } from './ua.js';
import { makeZip } from './zip.js';
import { ping, syncSite, syncAll } from './services/wpSync.js';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', true);

const now = () => new Date().toISOString();
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

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
  let h;
  try { h = new URL(candidate).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  return h === siteHost || h.endsWith('.' + siteHost);
}

// ───────────────────────── Public: tracker script + collector ─────────────────────────

app.get('/t.js', (req, res) => {
  // Short cache so tracker updates reach every site within minutes (ETag makes re-checks cheap).
  res.set('Cache-Control', 'public, max-age=300');
  res.sendFile(join(PUBLIC_DIR, 't.js'));
});

const findSite = q('SELECT * FROM sites WHERE id = ?');
const upsertVisitor = q(`
  INSERT INTO visitors (site_id, visitor_key, first_seen, last_seen) VALUES (?, ?, ?, ?)
  ON CONFLICT(site_id, visitor_key) DO UPDATE SET last_seen = excluded.last_seen
  RETURNING id`);
const insertPageview = q(`
  INSERT INTO pageviews (site_id, visitor_id, session_key, url, path, title, referrer, ip,
    country, country_code, region, city, timezone, org, isp, network_type,
    browser, os, device, user_agent, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const identifyVisitor = q(`
  UPDATE visitors SET name = COALESCE(?, name), email = COALESCE(?, email), company = COALESCE(?, company)
  WHERE site_id = ? AND visitor_key = ?`);

// The tracker posts text/plain JSON (a "simple" request, so no CORS preflight).
app.post('/collect', express.text({ type: '*/*', limit: '8kb' }), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.status(204).end(); // Answer right away; the visitor's browser never waits on us.

  let body;
  try { body = JSON.parse(req.body); } catch { return; }
  const site = typeof body?.site === 'string' && findSite.get(body.site);
  if (!site) return;

  const pageUrl = clip(body.url, 2000);
  if (!hostMatches(site.host, req.get('origin') || pageUrl)) return;

  const ua = req.get('user-agent') || '';
  if (isBot(ua)) return;

  const visitorKey = clip(body.vid, 64);
  if (!visitorKey) return;
  const ts = now();

  if (body.type === 'identify') {
    upsertVisitor.get(site.id, visitorKey, ts, ts);
    identifyVisitor.run(clip(body.name, 200) || null, clip(body.email, 200) || null,
      clip(body.company, 200) || null, site.id, visitorKey);
    return;
  }

  let path = '/';
  try { path = new URL(pageUrl).pathname; } catch { return; }

  const ip = req.ip;
  const geo = await lookupIp(ip);
  const { browser, os, device } = parseUa(ua);
  const { id: visitorId } = upsertVisitor.get(site.id, visitorKey, ts, ts);
  insertPageview.run(site.id, visitorId, clip(body.sid, 64) || 'none', pageUrl, path,
    clip(body.title, 300), clip(body.ref, 2000) || null, ip,
    geo.country, geo.country_code, geo.region, geo.city, geo.timezone, geo.org, geo.isp, geo.network_type,
    browser, os, device, ua.slice(0, 500), ts);
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

app.get('/api/sites', (req, res) => {
  // Site keys stay on the server; the dashboard never needs them.
  res.json(q(`
    SELECT s.id, s.url, s.host, s.name, s.created_at, s.wp_url, s.last_sync, s.last_error,
      (s.wp_key IS NOT NULL) AS connected,
      (SELECT COUNT(*) FROM visitors v WHERE v.site_id = s.id) AS visitors,
      (SELECT COUNT(*) FROM pageviews p WHERE p.site_id = s.id) AS pageviews,
      (SELECT MAX(created_at) FROM pageviews p WHERE p.site_id = s.id) AS last_hit
    FROM sites s ORDER BY s.created_at`).all());
});

app.post('/api/sites', (req, res) => {
  const parsed = normaliseUrl(req.body?.url);
  if (!parsed) return res.status(400).json({ error: 'That does not look like a website address.' });
  const existing = q('SELECT * FROM sites WHERE host = ?').get(parsed.host);
  if (existing) return res.json({ site: existing, existed: true });
  const name = clip(req.body?.name, 100)?.trim() || parsed.host;
  const id = randomBytes(6).toString('base64url');
  q('INSERT INTO sites (id, url, host, name, created_at) VALUES (?, ?, ?, ?, ?)').run(id, parsed.url, parsed.host, name, now());
  res.status(201).json({ site: findSite.get(id), existed: false });
});

app.delete('/api/sites/:id', (req, res) => {
  const r = q('DELETE FROM sites WHERE id = ?').run(req.params.id);
  res.status(r.changes ? 204 : 404).end();
});

app.get('/api/sites/:id/summary', (req, res) => {
  const site = findSite.get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const since = sinceFor(req.query.days);
  const args = [site.id, since];
  const top = (col, limit = 8) => q(`
    SELECT ${col} AS label, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews
    FROM pageviews WHERE site_id = ? AND created_at >= ? AND ${col} IS NOT NULL AND ${col} != ''
    GROUP BY ${col} ORDER BY visitors DESC, pageviews DESC LIMIT ${limit}`).all(...args);

  res.json({
    site,
    totals: q(`
      SELECT COUNT(DISTINCT visitor_id) AS visitors,
             COUNT(DISTINCT session_key) AS visits,
             COUNT(*) AS pageviews
      FROM pageviews WHERE site_id = ? AND created_at >= ?`).get(...args),
    identified: q(`
      SELECT COUNT(*) AS n FROM visitors
      WHERE site_id = ? AND last_seen >= ? AND (name IS NOT NULL OR email IS NOT NULL OR company IS NOT NULL)`).get(...args).n,
    companies: q(`
      SELECT org AS label, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews
      FROM pageviews WHERE site_id = ? AND created_at >= ? AND network_type = 'company'
      GROUP BY org ORDER BY visitors DESC, pageviews DESC LIMIT 8`).all(...args),
    countries: top('country'),
    regions: top(`region || ', ' || country`),
    pages: top('path'),
    referrers: q(`
      SELECT referrer AS label, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews
      FROM pageviews WHERE site_id = ? AND created_at >= ? AND referrer IS NOT NULL
      GROUP BY referrer ORDER BY visitors DESC LIMIT 8`).all(...args),
    // Bucket by the viewer's local day; tz = minutes east of UTC (IST = 330).
    daily: q(`
      SELECT substr(datetime(created_at, ? || ' minutes'), 1, 10) AS day, COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS pageviews
      FROM pageviews WHERE site_id = ? AND created_at >= ?
      GROUP BY day ORDER BY day`).all(Math.trunc(Number(req.query.tz)) || 0, ...args),
  });
});

// Each visitor with their latest known location / network, plus how many different
// places they have come from (people switch VPN locations, or visit from home and office).
const VISITOR_SELECT = `
  SELECT v.id, v.visitor_key, v.name, v.email, v.company, v.first_seen, v.last_seen,
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

app.get('/api/sites/:id/visitors', (req, res) => {
  const site = findSite.get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const search = `%${String(req.query.q || '').trim()}%`;
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  // Search covers every place and network a visitor has used, not only the latest one,
  // so "Madrid" still finds someone whose last visit came from Amsterdam.
  res.json(q(`${VISITOR_SELECT}
    WHERE v.site_id = ? AND v.last_seen >= ?
      AND (? = '%%' OR v.name LIKE ? OR v.email LIKE ? OR v.company LIKE ?
           OR EXISTS (SELECT 1 FROM pageviews s WHERE s.visitor_id = v.id
                      AND (s.org LIKE ? OR s.country LIKE ? OR s.region LIKE ? OR s.city LIKE ? OR s.ip LIKE ?)))
    ORDER BY v.last_seen DESC LIMIT ?`)
    .all(site.id, sinceFor(req.query.days), search, search, search, search, search, search, search, search, search, limit));
});

app.get('/api/visitors/:id', (req, res) => {
  const visitor = q(`${VISITOR_SELECT} WHERE v.id = ?`).get(Number(req.params.id));
  if (!visitor) return res.status(404).json({ error: 'Visitor not found' });
  const hits = q(`
    SELECT session_key, url, path, title, referrer, ip, country, country_code, region, city, org, network_type,
           browser, os, device, created_at
    FROM pageviews WHERE visitor_id = ? ORDER BY created_at DESC LIMIT 1000`).all(visitor.id);

  // Every IP address this visitor has come from, newest first.
  const places = q(`
    SELECT ip, country, country_code, region, city, org, network_type,
           COUNT(DISTINCT session_key) AS visits, COUNT(*) AS pageviews,
           MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
    FROM pageviews WHERE visitor_id = ?
    GROUP BY ip ORDER BY last_seen DESC`).all(visitor.id);

  // Group page views into visits (sessions), newest first.
  const sessions = new Map();
  for (const h of hits) {
    if (!sessions.has(h.session_key)) {
      sessions.set(h.session_key, { started: h.created_at, ended: h.created_at, pages: [],
        referrer: null, ip: h.ip, country: h.country, country_code: h.country_code, region: h.region,
        city: h.city, org: h.org, network_type: h.network_type, browser: h.browser, os: h.os, device: h.device });
    }
    const s = sessions.get(h.session_key);
    s.started = h.created_at;
    s.referrer = h.referrer || s.referrer;
    s.pages.unshift({ path: h.path, title: h.title, url: h.url, at: h.created_at, ip: h.ip });
  }
  res.json({ visitor, places, visits: [...sessions.values()] });
});

// The WordPress plugin. Visits are stored on the client's own site; this dashboard
// pulls them in. The key is generated here and baked in, so nothing has to be typed.
const PLUGIN_DIR = join(PUBLIC_DIR, '..', 'wordpress', 'site-visit-tracker');
const PLUGIN_FILES = [
  'site-visit-tracker.php',
  'includes/db.php',
  'includes/rest.php',
  'includes/admin.php',
];
app.get('/api/sites/:id/wordpress-plugin.zip', (req, res) => {
  const site = findSite.get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });

  // One key per site, kept so the dashboard can read that site straight away.
  const key = site.wp_key || randomBytes(30).toString('base64url').slice(0, 40);
  q('UPDATE sites SET wp_key = ?, wp_url = COALESCE(wp_url, ?) WHERE id = ?').run(key, site.url, site.id);

  const files = PLUGIN_FILES.map((name) => {
    let text = readFileSync(join(PLUGIN_DIR, name), 'utf8');
    if (name.endsWith('site-visit-tracker.php')) text = text.replace("'__SVT_API_KEY__'", `'${key}'`);
    return { name: `site-visit-tracker/${name}`, data: text };
  });
  files.push({ name: 'site-visit-tracker/assets/t.js', data: readFileSync(join(PUBLIC_DIR, 't.js'), 'utf8') });

  const zip = makeZip(files);
  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="site-visit-tracker-${site.host.replace(/[^a-z0-9.-]/g, '')}.zip"`,
  }).send(zip);
});

// Connect (or re-connect) a WordPress site: checks the key works before saving it.
app.post('/api/sites/:id/connect', async (req, res) => {
  const site = findSite.get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const wpUrl = (req.body?.wp_url || site.wp_url || site.url || '').replace(/\/+$/, '');
  const wpKey = String(req.body?.wp_key || site.wp_key || '').trim();
  if (!/^https?:\/\//.test(wpUrl) || !wpKey) {
    return res.status(400).json({ error: 'A site address and a site key are both needed.' });
  }
  try {
    const info = await ping({ ...site, wp_url: wpUrl, wp_key: wpKey });
    q('UPDATE sites SET wp_url = ?, wp_key = ?, last_error = NULL WHERE id = ?').run(wpUrl, wpKey, site.id);
    const { added } = await syncSite(findSite.get(site.id));
    res.json({ connected: true, site: findSite.get(site.id), remote: info, added });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.post('/api/sites/:id/sync', async (req, res) => {
  const site = findSite.get(req.params.id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (!site.wp_url || !site.wp_key) return res.status(400).json({ error: 'This site is not connected to a WordPress plugin.' });
  try {
    res.json({ ...(await syncSite(site)), site: findSite.get(site.id) });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get('/api/sites/:id/activity', (req, res) => {
  res.json(q(`
    SELECT p.id, p.visitor_id, p.path, p.title, p.referrer, p.country, p.region, p.city, p.org,
           p.network_type, p.device, p.created_at, v.name, v.company, v.email
    FROM pageviews p JOIN visitors v ON v.id = p.visitor_id
    WHERE p.site_id = ? ORDER BY p.created_at DESC LIMIT ?`)
    .all(req.params.id, Math.min(Number(req.query.limit) || 50, 500)));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Connected WordPress sites are pulled in on a timer, so the dashboard is current
// whenever it is opened.
const SYNC_EVERY_MS = Math.max(30, Number(process.env.SYNC_SECONDS) || 60) * 1000;
const syncAndRelabel = () => syncAll().then(() => relabelStoredVisits()).catch(() => {});
setInterval(syncAndRelabel, SYNC_EVERY_MS).unref();
syncAndRelabel();

app.listen(PORT, () => {
  console.log(`Site Visit Tracker running at http://localhost:${PORT}`);
  if (!process.env.DASHBOARD_PASSWORD) console.log('  (dashboard has no password — set DASHBOARD_PASSWORD before deploying)');
});

process.on('SIGINT', () => { db.close(); process.exit(0); });
