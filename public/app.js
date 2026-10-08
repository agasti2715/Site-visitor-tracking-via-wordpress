// Dashboard. Everything a visitor sends (names, page titles, URLs) is untrusted,
// so it only ever reaches the page through esc().
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString();

let sites = [];
let current = null;
let visitorsCache = [];
let refreshTimer = null;

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

function ago(iso) {
  if (!iso) return '–';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
const when = (iso) => new Date(iso).toLocaleString();

function flag(cc) {
  if (!cc || cc.length !== 2) return '';
  return `<span class="flag">${String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)))}</span>`;
}
function place(r) {
  const parts = [r.city, r.region, r.country].filter(Boolean);
  // Drop the region when it just repeats the city ("Delhi, Delhi, India").
  if (parts.length === 3 && parts[0] === parts[1]) parts.splice(1, 1);
  if (!parts.length) return '<span class="muted">Unknown</span>';
  return flag(r.country_code) + esc(parts.join(', ')) + accuracy(r.network_type);
}
// IP locations point at where the visitor's internet provider joins the internet,
// not at the visitor. Say so wherever a location is shown.
function accuracy(type) {
  if (type === 'hosting') {
    return '<span class="approx bad" title="This visitor came through a VPN or cloud server. The location is that server\'s, not the person\'s.">VPN — unreliable</span>';
  }
  return '<span class="approx" title="Worked out from the IP address. Country and state are usually right; the city is often the nearest big city where the visitor\'s internet provider connects (e.g. Mumbai for much of Maharashtra).">approx.</span>';
}
const NETWORK_LABEL = { company: 'Company', isp: 'ISP', mobile: 'Mobile', hosting: 'Cloud / VPN', local: 'Local' };
function network(r) {
  if (!r.org) return '<span class="muted">Unknown</span>';
  const t = r.network_type;
  return esc(r.org) + (t ? `<span class="pill ${t}">${NETWORK_LABEL[t] || t}</span>` : '');
}
// The best name for a visitor: what they told us, else any company network they have
// used (not only the latest — the last visit may have come through a VPN).
function title(v) {
  if (v.name || v.email) return v.name || v.email;
  if (v.company) return v.company;
  if (v.company_network) return `Someone at ${v.company_network}`;
  return 'Anonymous visitor';
}
function who(v) {
  const vpn = v.uses_vpn ? '<span class="pill hosting">Uses VPN</span>' : '';
  if (v.name || v.email) {
    return `<div class="who"><strong>${esc(title(v))}<span class="pill person">Identified</span>${vpn}</strong>
      <span class="sub">${esc([v.name && v.email, v.company].filter(Boolean).join(' · '))}</span></div>`;
  }
  const sub = v.company || v.company_network ? 'Anonymous visitor' : `#${v.visitor_key.slice(0, 8)}`;
  return `<div class="who"><strong>${esc(title(v))}${vpn}</strong><span class="sub">${esc(sub)}</span></div>`;
}
// "Also from 2 other places" under the latest location.
function otherPlaces(v) {
  const extra = Math.max(v.place_count, v.ip_count) - 1;
  return extra > 0 ? `<div class="sub">+ ${extra} other location${extra === 1 ? '' : 's'}</div>` : '';
}

// ───────────────────────── Sites ─────────────────────────

async function loadSites() {
  sites = await api('/sites');
  $('no-sites').hidden = sites.length > 0;
  $('site-list').innerHTML = sites.map((s) => `
    <li data-id="${esc(s.id)}" class="${current?.id === s.id ? 'active' : ''}" title="${esc(s.url)}">
      <span class="name">${esc(s.name)}</span><span class="count">${fmt(s.visitors)}</span>
    </li>`).join('');
}

$('site-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) openSite(li.dataset.id);
});

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { site, existed } = await api('/sites', { method: 'POST', body: { url: $('add-url').value } });
    $('add-url').value = '';
    await loadSites();
    await openSite(site.id, !existed);
    toast(existed ? `${site.host} is already tracked — showing its visitors.` : `${site.host} added. Install the code below.`);
  } catch (err) {
    toast(err.message);
  }
});

$('delete-site').addEventListener('click', async () => {
  if (!current) return;
  if (!confirm(`Remove ${current.host} and ALL of its visitor history? This cannot be undone.`)) return;
  await api(`/sites/${current.id}`, { method: 'DELETE' });
  current = null;
  location.hash = '';
  $('site-view').hidden = true;
  $('empty').hidden = false;
  await loadSites();
});

function snippetFor(site) {
  return `<script async src="${location.origin}/t.js" data-site="${site.id}"></script>`;
}

$('toggle-snippet').addEventListener('click', () => { $('snippet').hidden = !$('snippet').hidden; });
$('copy-snippet').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('snippet-code').textContent); toast('Copied'); }
  catch { toast('Select the code and copy it manually'); }
});

async function openSite(id, showSnippet = false) {
  current = sites.find((s) => s.id === id);
  if (!current) return;
  location.hash = 'site=' + id;
  document.querySelectorAll('#site-list li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  $('empty').hidden = true;
  $('site-view').hidden = false;
  $('site-name').textContent = current.name;
  $('site-url').textContent = current.url;
  $('site-url').href = current.url;
  $('snippet-host').textContent = current.host;
  $('snippet-code').textContent = snippetFor(current);
  $('wp-download').href = `/api/sites/${encodeURIComponent(current.id)}/wordpress-plugin.zip`;
  showConnection();
  // The hosted line of code on localhost can only be reached by sites on this same machine.
  $('local-warning').hidden = !(/^(localhost|127\.|\[::1\])/.test(location.hostname) && current.host !== 'localhost');
  $('search').value = '';
  $('snippet').hidden = !(showSnippet || !current.pageviews);
  await refresh();
  // A hosted dashboard may have been asleep: catch this site up now rather than in a minute.
  if (current.connected) {
    api(`/sites/${current.id}/sync`, { method: 'POST' }).then(refresh).catch(() => {});
  }
  clearInterval(refreshTimer);
  // Once a minute, and only while the tab is on screen: every refresh reads the database.
  refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, 60000);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && current) refresh(); });

// ───────────────────────── WordPress connection ─────────────────────────

function showConnection(message) {
  const el = $('conn-status');
  if (message) { el.innerHTML = message; return; }
  if (!current.connected) {
    el.innerHTML = '<span class="muted">Not connected yet — download and activate the plugin, then check.</span>';
  } else if (current.last_error) {
    el.innerHTML = `<span class="err-text">${esc(current.last_error)}</span>`;
  } else if (current.last_sync) {
    el.innerHTML = `<span class="ok-text">Connected</span> <span class="muted">· last checked ${esc(ago(current.last_sync))}</span>`;
  } else {
    el.innerHTML = '<span class="muted">Plugin downloaded. Activate it in WordPress, then check.</span>';
  }
}

async function connect(key) {
  showConnection('<span class="muted">Checking…</span>');
  try {
    const out = await api(`/sites/${current.id}/connect`, { method: 'POST', body: key ? { wp_key: key } : {} });
    await loadSites();
    current = sites.find((s) => s.id === out.site.id) || current;
    showConnection();
    toast(out.added ? `Connected. ${out.added} visits pulled in.` : 'Connected. No visits recorded on the site yet.');
    await refresh();
  } catch (err) {
    showConnection(`<span class="err-text">${esc(err.message)}</span>`);
  }
}

$('conn-check').addEventListener('click', () => connect());
$('conn-save').addEventListener('click', () => {
  const key = $('conn-key').value.trim();
  if (key) connect(key);
});

// ───────────────────────── Data ─────────────────────────

async function refresh() {
  if (!current) return;
  const days = $('range').value;
  const [summary, visitors, activity] = await Promise.all([
    api(`/sites/${current.id}/summary?days=${days}&tz=${-new Date().getTimezoneOffset()}`),
    api(`/sites/${current.id}/visitors?days=${days}&q=${encodeURIComponent($('search').value)}`),
    api(`/sites/${current.id}/activity?limit=30`),
  ]);
  renderSummary(summary, Number(days));
  renderVisitors(visitors);
  renderActivity(activity);
  $('waiting').hidden = activity.length > 0;
}

$('range').addEventListener('change', refresh);
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(refresh, 250); });

function renderSummary(s, days) {
  $('k-visitors').textContent = fmt(s.totals.visitors);
  $('k-visits').textContent = fmt(s.totals.visits);
  $('k-pageviews').textContent = fmt(s.totals.pageviews);
  $('k-identified').textContent = fmt(s.identified);

  // Fill in days with no traffic so gaps show as gaps.
  const byDay = Object.fromEntries(s.daily.map((d) => [d.day, d]));
  const span = Math.max(days, 1);
  const cols = [];
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    cols.push({ day, visitors: byDay[day]?.visitors || 0, pageviews: byDay[day]?.pageviews || 0 });
  }
  const max = Math.max(1, ...cols.map((c) => c.visitors));
  $('chart').innerHTML = cols.map((c) => `
    <div class="col" data-tip="${c.day}: ${c.visitors} visitors, ${c.pageviews} views">
      <div class="bar" style="height:${(c.visitors / max) * 100}%"></div>
    </div>`).join('');
  $('chart-axis').innerHTML = `<span>${cols[0].day}</span><span>${cols[cols.length - 1].day}</span>`;

  bars('t-companies', s.companies, 'No company networks yet — most visitors are on home or mobile internet.');
  bars('t-countries', s.countries);
  bars('t-regions', s.regions);
  bars('t-pages', s.pages);
  bars('t-referrers', s.referrers.map((r) => ({ ...r, label: shortRef(r.label) })), 'Direct visits only so far.');
}

function shortRef(ref) {
  try { const u = new URL(ref); return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : ''); }
  catch { return ref; }
}

function bars(id, rows, emptyText = 'No data yet.') {
  if (!rows.length) { $(id).innerHTML = `<li class="none">${esc(emptyText)}</li>`; return; }
  const max = Math.max(...rows.map((r) => r.visitors));
  $(id).innerHTML = rows.map((r) => `
    <li title="${esc(r.label)} — ${r.visitors} visitors, ${r.pageviews} views">
      <div class="fill" style="width:${(r.visitors / max) * 100}%"></div>
      <span class="label">${esc(r.label)}</span><span class="n">${fmt(r.visitors)}</span>
    </li>`).join('');
}

function renderVisitors(rows) {
  visitorsCache = rows;
  $('no-visitors').hidden = rows.length > 0;
  $('visitors').innerHTML = rows.map((v) => `
    <tr data-id="${v.id}">
      <td>${who(v)}</td>
      <td>${network(v)}</td>
      <td>${place(v)}${otherPlaces(v)}</td>
      <td class="num">${fmt(v.visits)}</td>
      <td class="num">${fmt(v.pageviews)}</td>
      <td><span class="sub">${esc([v.device, v.browser, v.os].filter(Boolean).join(' · '))}</span></td>
      <td title="${esc(when(v.last_seen))}">${ago(v.last_seen)}</td>
    </tr>`).join('');
}

function renderActivity(rows) {
  if (!rows.length) { $('activity').innerHTML = '<li class="none">No visits yet.</li>'; return; }
  $('activity').innerHTML = rows.map((a) => {
    const name = a.name || a.company || (a.network_type === 'company' ? a.org : null) || [a.city, a.country].filter(Boolean).join(', ') || 'A visitor';
    return `<li><strong>${esc(name)}</strong> viewed <a href="#" data-visitor="${a.visitor_id}">${esc(a.path)}</a>
      <div class="when">${ago(a.created_at)}${a.city ? ' · ' + esc(a.city) : ''}</div></li>`;
  }).join('');
}

$('activity').addEventListener('click', (e) => {
  const a = e.target.closest('[data-visitor]');
  if (a) { e.preventDefault(); openVisitor(a.dataset.visitor); }
});
$('visitors').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openVisitor(tr.dataset.id);
});

// ───────────────────────── Visitor history ─────────────────────────

async function openVisitor(id) {
  const { visitor: v, places, visits } = await api(`/visitors/${id}`);
  const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
  const vpnNote = v.uses_vpn
    ? '<p class="note">This visitor used a VPN for at least one visit. Locations marked <em>VPN</em> are the VPN server\'s, not where the person is.</p>'
    : '';
  $('drawer-body').innerHTML = `
    <h1>${esc(title(v))}</h1>
    <div class="muted">Visitor #${esc(v.visitor_key.slice(0, 8))} · same browser on every visit below</div>
    <dl class="facts">
      ${v.name ? `<dt>Name</dt><dd>${esc(v.name)}</dd>` : ''}
      ${v.email ? `<dt>Email</dt><dd>${esc(v.email)}</dd>` : ''}
      ${v.company ? `<dt>Company</dt><dd>${esc(v.company)}</dd>` : ''}
      <dt>Device</dt><dd>${esc([v.device, v.browser, v.os].filter(Boolean).join(' · '))}</dd>
      <dt>First seen</dt><dd>${esc(when(v.first_seen))}</dd>
      <dt>Last seen</dt><dd>${esc(when(v.last_seen))}</dd>
      <dt>Visits</dt><dd>${plural(v.visits, 'visit')} · ${plural(v.pageviews, 'page')}</dd>
    </dl>

    <h3>Locations used <span class="muted small">(${places.length})</span></h3>
    ${vpnNote}
    <div class="places">
      ${places.map((p, i) => `
        <div class="place-row${p.network_type === 'hosting' ? ' vpn' : ''}">
          <div class="place-main">
            <div>${place(p)}${i === 0 ? ' <span class="pill isp">Latest</span>' : ''}</div>
            <div class="sub">${network(p)}</div>
          </div>
          <div class="place-meta sub">
            <div><code>${esc(p.ip || 'IP removed')}</code></div>
            <div>${plural(p.visits, 'visit')} · ${plural(p.pageviews, 'page')}</div>
            <div>${esc(when(p.first_seen))}${p.first_seen !== p.last_seen ? ` – ${esc(new Date(p.last_seen).toLocaleTimeString())}` : ''}</div>
          </div>
        </div>`).join('')}
    </div>
    <p class="sub">From the IP address: country and state are usually right; the city is often where the visitor's internet provider connects.</p>

    <h3>Visit history</h3>
    ${visits.map((s) => `
      <div class="visit">
        <div class="visit-head">
          <strong>${esc(when(s.started))}</strong>
          <span class="sub">${plural(s.pages.length, 'page')}</span>
        </div>
        <div class="sub">${place(s)} · ${esc(s.org || '')} · <code>${esc(s.ip || '–')}</code>${s.referrer ? ` · from ${esc(shortRef(s.referrer))}` : ''}</div>
        <ol>${s.pages.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title || p.path)}</a>
          <span class="t">${esc(new Date(p.at).toLocaleTimeString())}</span>
          ${p.ip && p.ip !== s.ip ? `<span class="t">· switched to <code>${esc(p.ip)}</code></span>` : ''}</li>`).join('')}</ol>
      </div>`).join('')}`;
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer-bg').hidden = false;
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  $('drawer-bg').hidden = true;
}
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-bg').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ───────────────────────── CSV export ─────────────────────────

$('export').addEventListener('click', () => {
  const cols = ['name', 'email', 'company', 'company_network', 'org', 'network_type', 'city', 'region', 'country',
                'place_count', 'ip_count', 'uses_vpn', 'visits', 'pageviews', 'device', 'browser', 'os', 'first_seen', 'last_seen'];
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...visitorsCache.map((v) => cols.map((c) => cell(v[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${current.host}-visitors.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ───────────────────────── Start ─────────────────────────

(async () => {
  await loadSites();
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('site');
  const start = sites.find((s) => s.id === fromHash) || sites[0];
  if (start) openSite(start.id);
})();
