// Turns an IP address into a location and the organisation that owns it.
// Uses ip-api.com; every answer is cached in SQLite for 30 days so a returning
// visitor never costs a second lookup. New addresses are looked up in bulk
// (100 per request), which keeps well inside the free tier's limits.
import { all, get, run, batch, stmt } from './db.js';
import { refreshAllAutomated } from './automated.js';

const CACHE_DAYS = 30;
const FIELDS = 'status,message,country,countryCode,regionName,city,timezone,isp,org,as,mobile,proxy,hosting,query';
const BATCH_SIZE = 100; // ip-api's maximum per bulk request

const getCached = (ip) => get('SELECT data, fetched_at FROM ip_cache WHERE ip = ?', [ip]);
const PUT_CACHED = `INSERT INTO ip_cache (ip, data, fetched_at) VALUES (?, ?, ?)
                    ON CONFLICT(ip) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`;

let rateLimitedUntil = 0;

export function isPrivateIp(ip) {
  if (!ip) return true;
  const v4 = ip.replace(/^::ffff:/, '');
  return (
    v4 === '127.0.0.1' || ip === '::1' ||
    /^10\./.test(v4) || /^192\.168\./.test(v4) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(v4) || /^169\.254\./.test(v4) ||
    /^f[cd]/i.test(ip) || /^fe80:/i.test(ip)
  );
}

export function isLoopback(ip) {
  return ip === '::1' || ip?.replace(/^::ffff:/, '') === '127.0.0.1';
}

// ───────────────────────── Is this network a company, an ISP, mobile or a server? ─────────────────────────
//
// An IP lookup names the organisation registered for the address (org), the provider (isp) and
// the network operator (AS). Most visitors are on home internet from one of thousands of small
// regional providers, so "doesn't sound like an ISP" is not evidence of a company. A network is
// only called a company when there is positive evidence; anything uncertain is treated as an ISP.

// Servers, clouds and VPN exits. Many VPN addresses carry no proxy flag, so names are checked
// too — e.g. Datacamp runs exits for several large VPN brands under resellers' names.
const HOSTING_WORDS = /\b(host|hosting|server|servers|cloud|data ?cent(er|re)|datacamp|vps|colo|colocation|ovh|hetzner|digitalocean|linode|akamai|vultr|choopa|leaseweb|m247|contabo|psychz|zenlayer|cdn77|clouvider|tzulo|packethub|hostroyale|quadranet|frantech|buyvm|servers ?com|g-core|gcore|hostinger|google cloud|azure|oracle cloud|alibaba cloud|tencent cloud|latitude\.sh|webshare|whitelabelcolo|servermania|egihosting|web2objects|logicweb|b2 net|code200|nordvpn|expressvpn|surfshark|proton|mullvad|private internet access|ipvanish|cyberghost|hide\.me|windscribe|tunnelbear)\b|\bgthost\b/i;

// Internet providers and carriers, including regional ones seen in real traffic.
const ISP_WORDS = /\b(telecom|telekom|telecommunications?|telephone|broadband|communications?|cable|cablevision|cable one|wireless|mobile|cellular|fiber|fibre|internet|isp|wisp|dsl|cooperative|co-op|jio|airtel|bsnl|vodafone|idea|act fibernet|hathway|comcast|xfinity|verizon|fios|ftr\d*|frontier|at&t|charter|spectrum|road runner|cox|t-mobile|sprint|suddenlink|optimum|altice|sparklight|rcn|gtt|wave broadband|grande|mediacom|windstream|centurylink|lumen|consolidated|networks?|knology|socket|plant board|utilit(?:y|ies)|municipal|transmission|fastway|starlink|spacex|space exploration|xplore|telus|rogers|bell canada|shaw|videotron|cogeco|teksavvy|vmedia|northwestel|eastlink|sonic|hotwire|telstra|optus|exetel|superloop|tpg|orange|telefonica|movistar|vivo|claro|virgin|sky|bt|talktalk|plusnet|deutsche telekom|swisscom|ntt|kddi|softbank|chinanet|china (telecom|unicom|mobile)|singtel|starhub|etisalat|ooredoo|mtn|safaricom)\b/i;

// Labels providers give to their home customers, rather than a business name.
const RESIDENTIAL = /\b(private customer|customers?\d*|residential|residence|subscriber|dynamic|dhcp|pool)\b/i;

// A registered business name.
const BUSINESS_SUFFIX = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|company|co|plc|llp|lp|gmbh|ag|sa|s\.a|srl|s\.r\.l|spa|bv|b\.v|nv|pty|pvt|oy|ab|kk|sas|sarl|sl)\b\.?/i;

// Kinds of organisation that run their own network rather than sell internet access.
// (Big corporations often run their own network, which otherwise looks just like a regional ISP.)
const INSTITUTION = /\b(university|college|school|academy|institute|hospital|health|medical|clinic|bank|bancorp|insurance|government|county|city of|state of|ministry|department|council|police|federal|library|museum|pharma\w*|manufactur\w*|logistics|warehous\w*|airport|technologies|software|systems|consulting|industries|holdings|group|enterprises|laborator\w*|research|motors?|automotive|airlines?|aerospace|stores|retail|foods|chemicals?|steel|petroleum|oil)\b/i;

// The first meaningful word of a name, to tell whether two names are the same organisation
// ("Sonic.net, Inc." and "Sonic Telecom LLC" → "sonic").
const firstWord = (name) => (String(name || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [])
  .find((w) => !['the', 'inc', 'llc', 'ltd'].includes(w)) || '';

export function classify(d) {
  if (d.hosting || d.proxy) return 'hosting';
  if (HOSTING_WORDS.test([d.org, d.isp, d.as].filter(Boolean).join(' '))) return 'hosting';
  if (d.mobile) return 'mobile';

  const org = String(d.org || '').trim();
  const operator = String(d.as || '').replace(/^AS\d+\s*/i, '');  // who runs the network
  if (!org) return 'isp';
  if (RESIDENTIAL.test(org) || ISP_WORDS.test(org)) return 'isp';
  // A person's name ("Jane Smith") is a home customer, not a company ("Walmart Inc" is not a person).
  if (/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(org) && !BUSINESS_SUFFIX.test(org)) return 'isp';
  if (INSTITUTION.test(org)) return 'company';
  // The organisation runs this network itself: almost always a regional provider.
  if (firstWord(org) && firstWord(org) === firstWord(operator)) return 'isp';
  // A named business with its own address block on someone else's network.
  if (BUSINESS_SUFFIX.test(org)) return 'company';
  return 'isp';
}

// ───────────────────────── Looking addresses up ─────────────────────────

const EMPTY = { country: null, country_code: null, region: null, city: null,
                timezone: null, org: null, isp: null, network_type: null };

function toResult(d) {
  const raw = { org: d.org || null, isp: d.isp || null, as: d.as || null,
                mobile: !!d.mobile, proxy: !!d.proxy, hosting: !!d.hosting };
  return {
    country: d.country || null,
    country_code: d.countryCode || null,
    region: d.regionName || null,
    city: d.city || null,
    timezone: d.timezone || null,
    org: d.org || d.isp || null,
    isp: d.isp || null,
    network_type: classify(raw),
    raw,
  };
}

// Free tier: X-Rl = requests left in this minute, X-Ttl = seconds until it resets.
function noteRateLimit(res) {
  if (res.status === 429 || res.headers.get('x-rl') === '0') {
    rateLimitedUntil = Date.now() + (Number(res.headers.get('x-ttl')) || 60) * 1000;
  }
}

const apiBase = () => (process.env.IPAPI_KEY ? 'https://pro.ip-api.com' : 'http://ip-api.com');
const keyParam = () => (process.env.IPAPI_KEY ? `&key=${encodeURIComponent(process.env.IPAPI_KEY)}` : '');

async function fetchOne(target) {
  const res = await fetch(`${apiBase()}/json/${target === 'self' ? '' : encodeURIComponent(target)}?fields=${FIELDS}${keyParam()}`,
    { signal: AbortSignal.timeout(3000) });
  noteRateLimit(res);
  if (!res.ok) return null;
  const d = await res.json();
  return d.status === 'success' ? d : null;
}

/** Up to 100 addresses in one request. Returns Map(ip → raw answer) for those that succeeded. */
async function fetchBatch(ips) {
  const res = await fetch(`${apiBase()}/batch?fields=${FIELDS}${keyParam()}`, {
    method: 'POST', body: JSON.stringify(ips), signal: AbortSignal.timeout(10000),
  });
  noteRateLimit(res);
  if (!res.ok) return new Map();
  const answers = await res.json();
  return new Map(answers.filter((d) => d.status === 'success').map((d) => [d.query, d]));
}

// The cache key: loopback visits are looked up as this machine's own address (local testing).
function cacheKey(ip) {
  if (!isPrivateIp(ip)) return ip;
  return isLoopback(ip) && process.env.RESOLVE_LOCALHOST_AS_SELF === 'true' ? 'self' : null;
}

const isFresh = (row) => row && JSON.parse(row.data).raw && Date.now() - Date.parse(row.fetched_at) < CACHE_DAYS * 864e5;
// The label is recomputed from the raw flags on every read, so rule fixes apply to old lookups.
const fromRow = (row) => {
  if (!row) return EMPTY;
  const saved = JSON.parse(row.data);
  return { ...saved, network_type: saved.raw ? classify(saved.raw) : saved.network_type };
};

/** One address (used by the hosted-script collector). Never throws. */
export async function lookupIp(ip) {
  return (await lookupMany([ip])).get(ip) || EMPTY;
}

/**
 * Many addresses: reads the cache for all of them in one query, then looks up the missing or
 * stale ones in bulk. Returns Map(ip → place). At most `maxFetches` addresses go to ip-api.
 */
export async function lookupMany(ips, { maxFetches = Infinity } = {}) {
  const unique = [...new Set(ips.filter(Boolean))];
  const keys = [...new Set(unique.map(cacheKey).filter(Boolean))];

  const rows = new Map();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const found = await all(`SELECT ip, data, fetched_at FROM ip_cache WHERE ip IN (${chunk.map(() => '?').join(',')})`, chunk);
    for (const row of found) rows.set(row.ip, row);
  }

  const toFetch = keys.filter((k) => !isFresh(rows.get(k))).slice(0, Number.isFinite(maxFetches) ? maxFetches : undefined);
  const fetched = new Map();
  try {
    if (toFetch.includes('self') && Date.now() >= rateLimitedUntil) {
      const d = await fetchOne('self');
      if (d) fetched.set('self', d);
    }
    const real = toFetch.filter((k) => k !== 'self');
    for (let i = 0; i < real.length && Date.now() >= rateLimitedUntil; i += BATCH_SIZE) {
      for (const [ip, d] of await fetchBatch(real.slice(i, i + BATCH_SIZE))) fetched.set(ip, d);
    }
  } catch { /* network trouble: fall back to whatever the cache has */ }

  if (fetched.size) {
    const now = new Date().toISOString();
    const writes = [];
    for (const [key, d] of fetched) {
      const result = toResult(d);
      writes.push(stmt(PUT_CACHED, [key, JSON.stringify(result), now]));
      rows.set(key, { ip: key, data: JSON.stringify(result), fetched_at: now });
    }
    await batch(writes);
  }

  const out = new Map();
  for (const ip of unique) {
    const key = cacheKey(ip);
    out.set(ip, key ? fromRow(rows.get(key)) : { ...EMPTY, network_type: 'local', org: 'Local network' });
  }
  return out;
}

/**
 * Brings stored visits up to date: fills in locations that were never looked up (for example
 * when the free tier's limit was hit during a big sync) and re-labels networks under the current
 * rules. Reads in two queries and writes in one batch; at most `maxFetches` new addresses per
 * run (12 bulk requests, inside the free tier's 15 a minute).
 */
export async function relabelStoredVisits(maxFetches = 1200) {
  const stored = await all(`SELECT ip, network_type, org, country FROM pageviews
                            WHERE ip IS NOT NULL GROUP BY ip, network_type, org, country`);
  const places = await lookupMany(stored.map((s) => s.ip), { maxFetches });
  const updates = [];
  for (const s of stored) {
    const geo = places.get(s.ip);
    if (!geo?.network_type) continue;
    const missingPlace = !s.country && geo.country;
    if (!missingPlace && geo.network_type === s.network_type && geo.org === s.org) continue;
    updates.push(stmt(`UPDATE pageviews SET country = ?, country_code = ?, region = ?, city = ?, timezone = ?,
                         network_type = ?, org = ?, isp = ?
                       WHERE ip = ? AND network_type IS ? AND org IS ? AND country IS ?`,
      [geo.country, geo.country_code, geo.region, geo.city, geo.timezone,
        geo.network_type, geo.org, geo.isp, s.ip, s.network_type, s.org, s.country]));
  }
  // A network relabelled as cloud/VPN (or back) can change who counts as likely automated.
  if (updates.length) updates.push(refreshAllAutomated());
  await batch(updates);
  return updates.length;
}
