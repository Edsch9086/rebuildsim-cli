// Verify the alliance-frame transform without needing a real blue seat.
// 1) forced blue, alliance frame: the world pose/fuel/heading rotate 180 deg,
//    and forward decreases normalized x (like a real blue client).
// 2) forced blue, field frame: raw global coords, forward increases x.
//
// Run: node engine/frame_test.cjs
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = process.env.RB_ENGINE || path.join(__dirname, 'headless.cjs');
const ASSETS = process.env.RB_ASSET_DIR || path.join(__dirname, 'cache');
const OUT = process.env.RB_TEST_OUT || path.join(os.tmpdir(), 'rebuildsim-tests');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(extra, drive) {
  const child = spawn(process.execPath, [ENGINE, '--create', '--start', '--username', `Frame${extra.length}`,
    '--emit-hz', '10', '--gamepad', ...extra], {
    env: { ...process.env, RB_ASSET_DIR: ASSETS }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.pipe(fs.createWriteStream(path.join(OUT, `frame_${extra.join('_')}.log`)));
  let state = null;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let d; try { d = JSON.parse(line); } catch { return; }
    if (d.type === 'state') state = d;
  });
  for (let t = 0; t < 300; t++) { await wait(100); if (state && state.me && state.time != null && state.time < 162.5) break; }
  await wait(300);
  const before = { x: state.me.x, y: state.me.y, h: state.me.heading, frame: state.frame, alliance: state.alliance,
    fuel0: state.fuel && state.fuel[0] && { x: state.fuel[0].x, y: state.fuel[0].y } };
  if (drive) {
    child.stdin.write('{"type":"input","y":1}\n');
    await wait(2000);
    child.stdin.write('{"type":"input"}\n');
    await wait(500);
  }
  const after = { x: state.me.x, y: state.me.y, h: state.me.heading };
  try { child.stdin.write('{"type":"quit"}\n'); } catch {}
  child.kill();
  await wait(300);
  return { before, after, dx: +(after.x - before.x).toFixed(3) };
}

(async () => {
  const alliance = await run(['--frame-alliance', 'blue'], true);
  const field = await run(['--frame-alliance', 'blue', '--field-frame'], true);
  console.log('ALLIANCE', JSON.stringify(alliance));
  console.log('FIELD   ', JSON.stringify(field));
  console.log('VERDICT', JSON.stringify({
    allianceFrame: alliance.before.frame === 'alliance' && alliance.before.alliance === 'blue',
    fieldFrame: field.before.frame === 'field',
    rotated: Math.abs(alliance.before.x + field.before.x) < 0.01 && Math.abs(alliance.before.y + field.before.y) < 0.02,
    fuelRotated: Math.abs(alliance.before.fuel0.x + field.before.fuel0.x) < 0.01 && Math.abs(alliance.before.fuel0.y + field.before.fuel0.y) < 0.02,
    blueForwardNegative: alliance.dx < -0.5,
    fieldForwardPositive: field.dx > 0.5,
    headingRotated: Math.abs(Math.abs(alliance.before.h - field.before.h) - Math.PI) < 0.05,
  }));
  process.exit(0);
})();
