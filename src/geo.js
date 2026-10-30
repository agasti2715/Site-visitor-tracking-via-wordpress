// Turns an IP address into a location and the organisation that owns it.
// Uses ip-api.com; every answer is cached in SQLite for 30 days so a returning
// visitor never costs a second lookup.
import { all, get, run, batch, stmt } from './db.js';
import { refreshAllAutomated } from './automated.js';

const CACHE_DAYS = 30;
const FIELDS = 'status,message,country,countryCode,regionName,city,timezone,isp,org,as,mobile,proxy,hosting,query';

const getCached = (ip) => get('SELECT data, fetched_at FROM ip_cache WHERE ip = ?', [ip]);
const PUT_CACHED = `INSERT INTO ip_cache (ip, data, fetched_at) VALUES (?, ?, ?)
                    ON CONFLICT(ip) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`;

// Words that mark a network as a consumer ISP / carrier rather than a business.
const ISP_WORDS = /\b(telecom|telekom|telecommunications?|broadband|communications?|cable|wireless|mobile|cellular|fiber|fibre|internet|isp|dsl|jio|airtel|bsnl|vodafone|idea|act fibernet|hathway|comcast|verizon|at&t|charter|spectrum|cox|t-mobile|sprint|telstra|optus|orange|telefonica|movistar|vivo|claro|virgin|sky|bt |talktalk|rogers|bell canada|shaw|deutsche telekom|swisscom|ntt|kddi|softbank|chinanet|china (telecom|unicom|mobile)|singtel|starhub|etisalat|du |ooredoo|mtn|safaricom)\b/i;

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

// Networks that sell servers or VPN exits. Many VPN addresses carry no proxy flag,
// so the operator's name (org, ISP or AS) is checked too — e.g. Datacamp runs exits
// for several large VPN brands while the address is registered to a reseller.
const HOSTING_WORDS = /\b(host|hosting|server|servers|cloud|data ?cent(er|re)|datacamp|vps|colo|colocation|ovh|hetzner|digitalocean|linode|akamai|vultr|choopa|leaseweb|m247|contabo|psychz|zenlayer|cdn77|clouvider|tzulo|packethub|hostroyale|quadranet|frantech|buyvm|servers ?com|g-core|gcore|hostinger|google cloud|azure|oracle cloud|alibaba cloud|tencent cloud|nordvpn|expressvpn|surfshark|proton|mullvad|private internet access|ipvanish|cyberghost|hide\.me|windscribe|tunnelbear)\b|\bgthost\b/i;

function classify(d) {
  if (d.hosting || d.proxy) return 'hosting';
  if (HOSTING_WORDS.test([d.org, d.isp, d.as].filter(Boolean).join(' '))) return 'hosting';
  if (d.mobile) return 'mobile';
  const org = (d.org || '').trim();
  if (!org) return 'isp';
  if (org.toLowerCase() === (d.isp || '').trim().toLowerCase() && ISP_WORDS.test(org)) return 'isp';
  return ISP_WORDS.test(org) ? 'isp' : 'company';
}

async function fetchIpApi(ip) {
  const key = process.env.IPAPI_KEY;
  const target = ip === 'self' ? '' : encodeURIComponent(ip);
  const url = key
    ? `https://pro.ip-api.com/json/${target}?fields=${FIELDS}&key=${encodeURIComponent(key)}`
    : `http://ip-api.com/json/${target}?fields=${FIELDS}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  // Free tier: X-Rl = requests left in this minute, X-Ttl = seconds until reset.
  if (res.status === 429 || res.headers.get('x-rl') === '0') {
    rateLimitedUntil = Date.now() + (Number(res.headers.get('x-ttl')) || 60) * 1000;
  }
  if (!res.ok) return null;
  const d = await res.json();
  return d.status === 'success' ? d : null;
}

/**
 * Returns { country, country_code, region, city, timezone, org, isp, network_type }.
 * Never throws: when the lookup fails the fields are simply null.
 */
const EMPTY = { country: null, country_code: null, region: null, city: null,
                timezone: null, org: null, isp: null, network_type: null };

// The cache key: loopback visits are looked up as this machine's own address (local testing).
function cacheKey(ip) {
  if (!isPrivateIp(ip)) return ip;
  return isLoopback(ip) && process.env.RESOLVE_LOCALHOST_AS_SELF === 'true' ? 'self' : null;
}

/**
 * `cached` lets a caller that already read the cache row pass it in (null = known absent),
 * which saves a database round trip per IP. `allowFetch` false = never call ip-api.
 */
export async function lookupIp(ip, cached, { allowFetch = true } = {}) {
  const target = cacheKey(ip);
  if (!target) return { ...EMPTY, network_type: 'local', org: 'Local network' };

  // The raw flags are cached alongside the answer and the label is worked out on every
  // read, so a better rule applies to old lookups at once. Entries saved before the raw
  // flags were kept count as stale and are fetched again.
  if (cached === undefined) cached = await getCached(target);
  const saved = cached ? JSON.parse(cached.data) : null;
  const fromCache = () => (saved ? { ...saved, network_type: saved.raw ? classify(saved.raw) : saved.network_type } : EMPTY);
  if (saved?.raw && Date.now() - Date.parse(cached.fetched_at) < CACHE_DAYS * 864e5) return fromCache();
  if (!allowFetch || Date.now() < rateLimitedUntil) return fromCache();

  try {
    const d = await fetchIpApi(target);
    if (!d) return fromCache();
    const raw = { org: d.org || null, isp: d.isp || null, as: d.as || null,
                  mobile: !!d.mobile, proxy: !!d.proxy, hosting: !!d.hosting };
    const result = {
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
    await run(PUT_CACHED, [target, JSON.stringify(result), new Date().toISOString()]);
    return result;
  } catch {
    return fromCache();
  }
}

/**
 * Looks up many IPs, reading the whole cache for them in one query.
 * Returns Map(ip → place). At most `maxFetches` new lookups go to ip-api.
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
  const out = new Map();
  let fetches = 0;
  for (const ip of unique) {
    const key = cacheKey(ip);
    const row = key ? rows.get(key) ?? null : null;
    const fresh = row && JSON.parse(row.data).raw && Date.now() - Date.parse(row.fetched_at) < CACHE_DAYS * 864e5;
    const allowFetch = Boolean(fresh) || fetches < maxFetches;
    if (key && !fresh && allowFetch) fetches++;
    out.set(ip, await lookupIp(ip, row, { allowFetch }));
  }
  return out;
}

/**
 * Re-labels stored visits whose network label is out of date (an older rule, or a
 * lookup saved before the raw flags were kept). Reads everything in two queries and
 * writes the changes in one batch; at most 30 new lookups per run, so the free tier's
 * 45 a minute is never used up in one go.
 */
export async function relabelStoredVisits(maxFetches = 30) {
  const stored = await all(`SELECT ip, network_type, org FROM pageviews
                            WHERE ip IS NOT NULL GROUP BY ip, network_type, org`);
  const places = await lookupMany(stored.map((s) => s.ip), { maxFetches });
  const updates = [];
  for (const s of stored) {
    const geo = places.get(s.ip);
    if (!geo?.network_type || (geo.network_type === s.network_type && geo.org === s.org)) continue;
    updates.push(stmt(`UPDATE pageviews SET network_type = ?, org = ?, isp = ?
                       WHERE ip = ? AND network_type IS ? AND org IS ?`,
      [geo.network_type, geo.org, geo.isp, s.ip, s.network_type, s.org]));
  }
  // A network relabelled as cloud/VPN (or back) can change who counts as likely automated.
  if (updates.length) updates.push(refreshAllAutomated());
  await batch(updates);
  return updates.length;
}
