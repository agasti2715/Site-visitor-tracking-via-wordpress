// Tiny static server for the demo site: http://localhost:5500/?site=SITE_ID
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
createServer(async (req, res) => {
  let path = new URL(req.url, 'http://x').pathname;
  if (path === '/') path = '/index.html';
  if (!path.includes('.')) path += '.html';
  const file = normalize(join(dir, path));
  if (!file.startsWith(dir) || !file.endsWith('.html')) { res.writeHead(404).end('Not found'); return; }
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(await readFile(file));
  } catch { res.writeHead(404).end('Not found'); }
}).listen(5500, () => console.log('Demo site at http://localhost:5500/?site=YOUR_SITE_ID'));
