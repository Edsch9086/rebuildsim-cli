// Download the current REBUILD Simulator web build into engine/cache/.
// The game assets are not redistributed with this repo; this fetches the
// current build at runtime, which keeps the prototype in sync with the server.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cache = path.join(__dirname, 'cache');
fs.mkdirSync(cache, { recursive: true });

const base = 'https://rebuildsim.com/';
console.error('fetching', base);
const html = await (await fetch(base)).text();
const m = html.match(/BUILD\s*=\s*["']([0-9a-f]+)["']/);
if (!m) throw new Error('could not find BUILD hash in index.html');
const build = m[1];
console.error('build', build);

async function get(file) {
  const url = `${base}${file}?v=${build}`;
  console.error('fetching', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(cache, file), buf);
  console.error('wrote', file, buf.length);
}

await get('index.js');
await get('index.wasm');
fs.writeFileSync(path.join(cache, 'build.json'), JSON.stringify({ build, fetched: new Date().toISOString() }, null, 2));
console.error('done');
