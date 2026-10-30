// "Likely automated": email link scanners (Microsoft Safe Links opens every emailed link
// from Azure), uptime checkers, SEO crawlers that run a real browser. The rule:
//   never interacted with the page (no mouse, wheel, tap or key)
//   AND never gave a name, email or company
//   AND every visit came from a cloud / VPN network.
// A person on a VPN who moves the mouse stays visible. The flag is stored on the visitor so
// the dashboard can filter cheaply, and recomputed whenever any of its inputs change.
import { stmt } from './db.js';

const RULE = `
  CASE WHEN visitors.engaged = 0
        AND visitors.name IS NULL AND visitors.email IS NULL AND visitors.company IS NULL
        AND EXISTS (SELECT 1 FROM pageviews p WHERE p.visitor_id = visitors.id)
        AND NOT EXISTS (SELECT 1 FROM pageviews p WHERE p.visitor_id = visitors.id
                        AND (p.network_type IS NULL OR p.network_type != 'hosting'))
       THEN 1 ELSE 0 END`;

/** Recompute for some visitors of one site (by visitor_key), or the whole site when keys is null. */
export function refreshAutomated(siteId, keys = null) {
  if (keys && !keys.length) return [];
  const unique = keys ? [...new Set(keys)] : null;
  const statements = [];
  // Chunked so a big sync page never exceeds SQLite's limit on query parameters.
  for (let i = 0; i < (unique ? unique.length : 1); i += 400) {
    const chunk = unique ? unique.slice(i, i + 400) : null;
    statements.push(stmt(
      `UPDATE visitors SET automated = ${RULE}
       WHERE site_id = ?${chunk ? ` AND visitor_key IN (${chunk.map(() => '?').join(',')})` : ''}`,
      chunk ? [siteId, ...chunk] : [siteId]));
  }
  return statements;
}

/** Every visitor everywhere — after network labels change, or once at start-up. */
export const refreshAllAutomated = () => stmt(`UPDATE visitors SET automated = ${RULE}`);
