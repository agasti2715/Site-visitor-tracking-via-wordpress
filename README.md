# Site Visit Tracker

A self-hosted tracker for all your websites. For every visitor it shows:

- **Who they are.** Their name, email and company when the visitor identifies themselves (login, contact form, sign-up). Otherwise, the organisation that owns their internet connection.
- **Where they are.** City, region and country.
- **Their history.** Every visit and the pages they opened, in order.

It also shows totals, a daily chart, top companies, countries, regions, pages, where visitors came from, and a live activity feed. You can export the visitor list to CSV.

## Two ways visits are collected

1. **WordPress plugin (recommended).** Visits are stored in the client site's **own database**. The dashboard pulls them in over a key-protected REST route. No hosting, no subdomain, no third-party requests, and ad blockers don't block it.
2. **Hosted script.** For non-WordPress sites: the site loads `t.js` from this tracker and posts visits straight to it. This needs the tracker deployed at a public address.

### Why the plugin doesn't slow a site down

- The tracker file is served from the site's own domain, ~2 KB, `async` in the footer, versioned and cached for a year: no render blocking, no extra DNS lookup.
- The tag is static, so page caching still works and no PHP runs while a page is served.
- Recording a visit is two indexed queries. **No IP lookups happen on the client's server** — the dashboard does those when it syncs.
- Old rows are pruned daily (visits after 180 days, raw IPs after 30), so the database stays small.
- The script tag carries the "don't touch me" attributes for Perfmatters, WP Rocket, Autoptimize and Cloudflare.

## WordPress sites: no code needed

1. In the dashboard, enter the site's URL, then click **Download the plugin for this site**. The zip already contains the site's tracker address and ID.
2. In WordPress: **Plugins → Add New → Upload Plugin**, choose the zip, click **Install Now**, then **Activate**.

The plugin also finds out who visitors are, with nothing to set up:

- **Logged-in users.** Name and email, plus company for WooCommerce customers.
- **Anyone who submits a form.** Tested with Contact Form 7, WPForms, Elementor Forms, Gravity Forms and newsletter sign-ups. Only name, email and company fields are read, never passwords or messages.
- **Your own team is skipped.** Visits from logged-in authors, editors and admins are not counted.

Everything can be switched off under **Settings → Site Visit Tracker**. The plugin files are in `wordpress/site-visit-tracker/`.

> The plugin stores visits on the WordPress site itself, so it works whether the dashboard runs on your laptop or on Render. The dashboard catches up on everything it missed whenever it runs.

## How it works

You can't see who visits a site just from its URL. Every tracker, including Google Analytics, Leadfeeder and Apollo, needs a small script on the site. So:

1. Enter the site's URL in the dashboard. It registers the site and gives you a one-line snippet.
2. Paste the snippet into that site's `<head>`, or once in its template or theme header.
3. From then on every page view is sent to this tracker, and the visitor's IP is looked up to find their location and network.

```
 your website ──(t.js sends page views)──▶ tracker server ──▶ SQLite
                                               │
                                               └─ IP lookup (ip-api.com, cached 30 days)
 you ──▶ dashboard (http://localhost:4000)
```

### What "company" means

- **Identified.** Your site called `svt.identify(...)`, so the name, email and company are exactly what the visitor gave you.
- **Company.** The visitor's IP belongs to a business network. This is how B2B tools spot "someone at Infosys is on your pricing page".
- **ISP / Mobile.** The visitor is on home broadband or mobile data (Jio, Airtel and so on). Their company can't be known, but the location still is.
- **Cloud / VPN.** The traffic came through a data centre or VPN, so the location may not be where the person really is.

IP locations are usually right to the city, but not always.

### Getting names

Call this on your site when a visitor logs in or submits a form:

```html
<script>
  svt.identify({ name: 'Jane Doe', email: 'jane@acme.com', company: 'Acme Inc' });
</script>
```

Every earlier and later visit from that browser is then linked to the name.

## Run it locally

Needs Node.js 22.13 or newer. With no Turso settings in `.env`, data is kept in a local SQLite file, so there is no database to install.

On Windows you can also double-click `start.bat`.

```bash
npm install
cp .env.example .env
npm start
```

Open http://localhost:4000.

### Try it with the demo site

```bash
npm run demo
```

1. In the dashboard, add `http://localhost:5500` and copy the site ID from the snippet (`data-site="…"`).
2. Open `http://localhost:5500/?site=THAT_ID`, click around, and submit the Contact form.
3. Your visits appear in the dashboard within about 15 seconds.

## Configuration (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Port for the tracker and dashboard |
| `DASHBOARD_PASSWORD` | *(empty)* | Turns on a login for the dashboard (any username, this password). **Always set it on a hosted dashboard.** |
| `TURSO_DATABASE_URL` | *(empty)* | Hosted database address (`libsql://…`). Empty = local SQLite file. |
| `TURSO_AUTH_TOKEN` | *(empty)* | Token for that database. Secret: never commit it or paste it anywhere public. |
| `TRUST_PROXY` | `false` | Set to `true` behind nginx, Caddy, Render, Railway and similar, so the real visitor IP is used |
| `DB_PATH` | `./data/tracker.db` | Local SQLite file, used when no Turso URL is set |
| `IPAPI_KEY` | *(empty)* | ip-api.com Pro key. The free tier allows 45 lookups a minute and **non-commercial use only**. |
| `RESOLVE_LOCALHOST_AS_SELF` | `true` in the example | Local testing: `localhost` visits are looked up as your own public IP. Set to `false` in production. |

## Hosting it for free (Render + Turso)

- **Render** (free web service) runs the dashboard and gives it a shareable `*.onrender.com` link. It sleeps after 15 minutes without visitors and takes about a minute to wake. Nothing is lost while it sleeps: the WordPress sites keep recording, and the dashboard catches up when it wakes.
- **Turso** (free, no card) keeps the data. Render's free disk is wiped on every restart, so the data can't live there.

1. **Turso**: create a database in **Mumbai (aws-ap-south-1)**. Copy its URL (`libsql://…`) and create a token.
2. **Move your existing data** (once): put both values in your local `.env`, then run `npm run copy-to-turso`. It refuses to run twice.
3. **Render**: New → Blueprint → this repo. `render.yaml` sets everything except three secrets, which you type in: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `DASHBOARD_PASSWORD`.
4. Open the `*.onrender.com` link, log in with any username and the password, and share it.

Every push to `main` redeploys automatically. Free-tier limits change, so check Render's and Turso's pricing pages now and then.

## Privacy and law

This tool stores IP addresses, locations and, when identified, names and emails. Under GDPR (EU/UK), India's DPDP Act, CCPA and similar laws, that is personal data. Say so in each site's privacy policy, and where those laws require consent (for example EU visitors), load the snippet only after the visitor accepts.

## Project layout

```
src/server.js   API, collector (/collect), dashboard auth
src/db.js       database: Turso when configured, else a local SQLite file
src/services/   wpSync.js: pulls visits from the WordPress plugins
src/geo.js      IP → location / organisation, with cache and rate-limit handling
src/ua.js       browser / OS / device, bot filter
public/t.js     the tracking snippet your sites load
public/         the dashboard (index.html, app.js, style.css)
wordpress/      the WordPress plugin (the dashboard builds a zip per site with its key)
scripts/        copy-to-turso.mjs: one-off move of local data to Turso
render.yaml     Render deployment settings
demo/           a 3-page demo site for local testing
```
