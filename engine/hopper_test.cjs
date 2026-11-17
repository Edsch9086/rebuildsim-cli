// Verify hopper fuel count: starts at 8, drops while shooting.
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE = process.env.RB_ENGINE || path.join(__dirname, 'headless.cjs');
const ASSETS = process.env.RB_ASSET_DIR || path.join(__dirname, 'cache');
if (process.env.RB_ALLOW_LIVE_TESTS !== '1') {
  console.log('SKIP live test: set RB_ALLOW_LIVE_TESTS=1 to create/join a private room');
  process.exit(0);
}
const child = spawn(process.execPath, [ENGINE, '--create', '--start',
  '--fuel', '25', '--gamepad', '--username', 'HopperTest', '--emit-hz', '10'],
  { env: { ...process.env, RB_ASSET_DIR: ASSETS }, stdio: ['pipe', 'pipe', 'pipe'] });

const OUT = process.env.RB_TEST_OUT || path.join(os.tmpdir(), 'rebuildsim-tests');
fs.mkdirSync(OUT, { recursive: true });
child.stderr.pipe(fs.createWriteStream(path.join(OUT, 'hopper_test.log')));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let state = null;
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let d; try { d = JSON.parse(line); } catch { return; }
  if (d.type === 'state') state = d;
});
(async () => {
  for (let t = 0; t < 300; t++) { await wait(100); if (state && state.time != null && state.time < 162.5) break; }
  const start = state.hopper_fuel;
  console.log('initial hopper', start, 'me.hopper', state.me && state.me.hopper_fuel);
  // Intake flag: bit 6 at name+0x56.
  child.stdin.write('{"type":"input","intake":true}\n');
  await wait(700);
  const intakeOn = state.intake_active;
  child.stdin.write('{"type":"input"}\n');
  await wait(500);
  const intakeOff = state.intake_active;
  console.log('intake flags', intakeOn, intakeOff);
  child.stdin.write('{"type":"input","shoot":true}\n');
  let seen = [];
  for (let t = 0; t < 60; t++) {
    await wait(100);
    const v = state.hopper_fuel;
    if (seen.length === 0 || seen[seen.length - 1] !== v) seen.push(v);
    if (v === 0) break;
  }
  child.stdin.write('{"type":"input"}\n');
  console.log('hopper sequence', JSON.stringify(seen));
  const verdict = {
    initial8: start === 8,
    intakeOn: intakeOn === true,
    intakeOff: intakeOff === false,
    droppedTo0: seen[seen.length - 1] === 0,
  };
  console.log('VERDICT', JSON.stringify(verdict));
  try { child.stdin.write('{"type":"quit"}\n'); } catch {}
  child.kill();
  process.exit(Object.values(verdict).every(Boolean) ? 0 : 1);
})();
