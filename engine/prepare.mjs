// Download the current REBUILD Simulator web build into engine/cache/.
// The game assets are not redistributed with this repo; this fetches the
// current build at runtime, which keeps the prototype in sync with the server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cache = path.join(__dirname, 'cache');
fs.mkdirSync(cache, { recursive: true });

const base = process.env.RB_BASE_URL || 'https://rebuildsim.com/';
console.error('fetching', base);
const page = await fetch(base, { signal: AbortSignal.timeout(30000) });
if (!page.ok) throw new Error(`${base}: HTTP ${page.status}`);
const html = await page.text();
const m = html.match(/BUILD\s*=\s*["']([0-9a-f]+)["']/);
if (!m) throw new Error('could not find BUILD hash in index.html');
const build = m[1];
console.error('build', build);

async function get(file) {
  const url = `${base}${file}?v=${build}`;
  console.error('fetching', url);
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  console.error('downloaded', file, buf.length);
  return buf;
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Download both files before touching the installed copies. This avoids a
// partially updated cache if one request fails.
const js = await get('index.js');
const wasm = await get('index.wasm');

for (const [file, buf] of [['index.js', js], ['index.wasm', wasm]]) {
  const tmp = path.join(cache, `${file}.tmp`);
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, path.join(cache, file));
  console.error('wrote', file, buf.length);
}

const metadata = {
  build,
  fetched: new Date().toISOString(),
  files: { 'index.js': sha(js), 'index.wasm': sha(wasm) },
};
const btmp = path.join(cache, 'build.json.tmp');
fs.writeFileSync(btmp, JSON.stringify(metadata, null, 2));
fs.renameSync(btmp, path.join(cache, 'build.json'));
console.error('done');
