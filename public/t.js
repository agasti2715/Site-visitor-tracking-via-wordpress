/*! Site Visit Tracker — add to any page:
 *  <script async src="https://YOUR-TRACKER/t.js" data-site="SITE_ID"></script>
 *
 *  Tell the tracker who a visitor is (after login or a form submit):
 *    svt.identify({ name: 'Jane Doe', email: 'jane@acme.com', company: 'Acme Inc' })
 */
(function () {
  // Speed plugins (Perfmatters, WP Rocket, Autoptimize…) re-insert scripts, which can
  // leave document.currentScript empty. Fall back to finding our own tag.
  // (A minifier may also rename the file, so match the WordPress handle or endpoint too.)
  var script = document.currentScript ||
    document.getElementById('svt-tracker-js') ||
    document.querySelector('script[data-endpoint][data-site]') ||
    document.querySelector('script[data-site][src*="/t.js"]');
  if (!script) return;
  var site = script.getAttribute('data-site');
  if (!site) return;
  // WordPress plugin: posts to this site's own REST route. Everyone else: the tracker server.
  var endpoint = script.getAttribute('data-endpoint') || new URL('/collect', script.src).href;
  var SESSION_IDLE_MS = 30 * 60 * 1000;

  // With a consent manager (Complianz, CookieYes… via the WordPress Consent API),
  // nothing is stored or sent until the visitor accepts statistics cookies.
  var needsConsent = script.getAttribute('data-consent') === 'wp';
  var waiting = [];
  function consentGiven() {
    return !needsConsent || (typeof window.wp_has_consent === 'function' && window.wp_has_consent('statistics') === true);
  }
  function flushIfAllowed() {
    if (!waiting.length || !consentGiven()) return;
    var queued = waiting;
    waiting = [];
    for (var i = 0; i < queued.length; i++) queued[i]();
  }
  // Fires when the visitor clicks Accept on the banner.
  document.addEventListener('wp_listen_for_consent_change', flushIfAllowed);
  // Both scripts load async, so the Consent API may arrive after this one. A visitor who
  // accepted on an earlier visit never clicks again, so check again once it has loaded.
  if (needsConsent) {
    window.addEventListener('load', flushIfAllowed);
    setTimeout(flushIfAllowed, 1500);
    setTimeout(flushIfAllowed, 5000);
  }

  function rid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function store(kind, key, make) {
    try {
      var s = window[kind], v = s.getItem(key);
      if (!v) { v = make(); s.setItem(key, v); }
      return v;
    } catch (e) { return make(); }
  }

  // Created on first use, never before consent.
  var vidCache = null;
  function vid() {
    if (!vidCache) vidCache = store('localStorage', 'svt_vid', rid);
    return vidCache;
  }

  // A visit (session) ends after 30 minutes without activity.
  function sessionId() {
    try {
      var now = Date.now();
      var raw = sessionStorage.getItem('svt_sid');
      var parts = raw ? raw.split('|') : null;
      var sid = parts && now - Number(parts[1]) < SESSION_IDLE_MS ? parts[0] : rid();
      sessionStorage.setItem('svt_sid', sid + '|' + now);
      return sid;
    } catch (e) { return vid(); }
  }

  function send(payload) {
    if (!consentGiven()) {
      waiting.push(function () { send(payload); });
      return;
    }
    payload.site = site;
    payload.vid = vid();
    if (payload.type === 'pageview') payload.sid = sessionId();
    var body = JSON.stringify(payload);
    if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return;
    try { fetch(endpoint, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' }); } catch (e) {}
  }

  var lastUrl = null;
  function pageview() {
    var url = location.href;
    if (url === lastUrl) return;
    var ref = lastUrl === null ? document.referrer : '';
    lastUrl = url;
    // Only keep referrers from other sites.
    try { if (ref && new URL(ref).hostname === location.hostname) ref = ''; } catch (e) { ref = ''; }
    send({ type: 'pageview', url: url, title: document.title, ref: ref });
  }

  function identify(info) {
    if (!info || typeof info !== 'object') return;
    send({ type: 'identify', name: info.name, email: info.email, company: info.company });
  }

  // Optional (data-forms="true"): when a visitor submits any form that has an
  // email or name field, remember who they are. Only these three kinds of
  // field are read — never passwords or anything else.
  function fieldText(el) {
    var label = '';
    if (el.id) {
      var l = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (l) label = l.textContent;
    }
    if (!label && el.closest) { var wrap = el.closest('label'); if (wrap) label = wrap.textContent; }
    return [el.name, el.id, el.placeholder, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), label, el.className]
      .join(' ').toLowerCase();
  }
  function fromForm(form) {
    var found = {}, first = '', last = '';
    var inputs = form.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i], type = (el.type || '').toLowerCase(), v = (el.value || '').trim();
      if (!v || type === 'password' || type === 'hidden' || type === 'checkbox' || type === 'radio') continue;
      var t = fieldText(el);
      if (type === 'email' || /e-?mail/.test(t)) { if (!found.email && /.+@.+\..+/.test(v)) found.email = v; }
      else if (/company|organi[sz]ation|business|firm|employer/.test(t)) { found.company = found.company || v; }
      else if (/user_?name|login|nickname/.test(t)) { continue; }
      else if (/given-name|first/.test(t)) { first = first || v; }
      else if (/family-name|last|surname/.test(t)) { last = last || v; }
      else if (/(^|[^a-z])(full-?)?name([^a-z]|$)/.test(t)) { found.name = found.name || v; }
    }
    if (!found.name && (first || last)) found.name = (first + ' ' + last).trim();
    return found.email || found.name ? found : null;
  }
  if (/^(1|true|yes)$/i.test(script.getAttribute('data-forms') || '')) {
    document.addEventListener('submit', function (e) {
      try { var who = e.target && e.target.tagName === 'FORM' && fromForm(e.target); if (who) identify(who); } catch (err) {}
    }, true);
  }

  // Single-page apps: count client-side route changes too.
  var push = history.pushState;
  history.pushState = function () { push.apply(this, arguments); setTimeout(pageview, 0); };
  var replace = history.replaceState;
  history.replaceState = function () { replace.apply(this, arguments); setTimeout(pageview, 0); };
  window.addEventListener('popstate', pageview);

  // Calls made before the script loaded: window.svt = window.svt || []; svt.push(['identify', {...}])
  var queued = Array.isArray(window.svt) ? window.svt : [];
  window.svt = { identify: identify, push: function (c) { if (c && c[0] === 'identify') identify(c[1]); } };
  for (var i = 0; i < queued.length; i++) window.svt.push(queued[i]);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pageview);
  else pageview();
})();
