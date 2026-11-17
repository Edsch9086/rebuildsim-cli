// Binary stdout framing test: RSB1 header + JSON frames + packed fuel frames.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.env.RB_ALLOW_LIVE_TESTS !== '1') {
  console.log('SKIP live test: set RB_ALLOW_LIVE_TESTS=1 to create/join a private room');
  process.exit(0);
}

const OUT = process.env.RB_TEST_OUT || path.join(os.tmpdir(), 'rebuildsim-tests');
fs.mkdirSync(OUT, { recursive: true });
const child = spawn(process.execPath, ['headless.cjs', '--create', '--start', '--fuel', '25',
  '--username', 'BinBot', '--emit-hz', '2', '--binary'],
  { cwd: __dirname, env: { ...process.env, RB_ASSET_DIR: process.env.RB_ASSET_DIR || path.join(__dirname, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe'] });
child.stderr.pipe(fs.createWriteStream(path.join(OUT, 'bin_err.log')));

let buf = Buffer.alloc(0);
let jsonFrames = 0, fuelFrames = 0, state = null, fuelCount = null;
let lastFuelSeq = null, lastKind = null;
let done = false;

child.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 16) {
    if (buf.subarray(0, 4).toString() !== 'RSB1') {
      console.error('bad magic', buf.subarray(0, 16).toString('hex'));
      child.kill(); process.exit(1);
    }
    if (buf[4] !== 1) { console.error('bad framing version', buf[4]); child.kill(); process.exit(1); }
    const kind = buf[5];
    const len = buf.readUInt32LE(8);
    if (len > 16 * 1024 * 1024) { console.error('frame too large', len); child.kill(); process.exit(1); }
    const seq = buf.readUInt32LE(12);
    const prevKind = lastKind;
    lastKind = kind;
    if (buf.length < 16 + len) break;
    const payload = buf.subarray(16, 16 + len);
    buf = buf.subarray(16 + len);
    if (kind === 1) {
      jsonFrames++;
      const obj = JSON.parse(payload.toString());
      if (obj.type === 'state') {
        state = obj;
        if (!state.fuel_bin) { console.error('state did not set fuel_bin'); child.kill(); process.exit(1); }
        if (state.fuel.length !== 0) { console.error('binary state still includes fuel array'); child.kill(); process.exit(1); }
        if (lastFuelSeq !== state.seq) { console.error('fuel/state seq mismatch', lastFuelSeq, state.seq); child.kill(); process.exit(1); }
        if (prevKind !== 2) { console.error('state did not immediately follow fuel frame'); child.kill(); process.exit(1); }
        if (state.fuel_ok !== true) { console.error('state fuel_ok is not true', state.fuel_ok); child.kill(); process.exit(1); }
        if (state.fuel_source !== 'packet') { console.error('fuel locator used fallback:', state.fuel_source); child.kill(); process.exit(1); }
        if (fuelFrames < 1) { console.error('no fuel frame before state'); child.kill(); process.exit(1); }
        if (fuelCount !== state.fuel_count) { console.error('fuel count mismatch', fuelCount, state.fuel_count); child.kill(); process.exit(1); }
        console.log('OK binary state', JSON.stringify({
          seq: state.seq, phase: state.phase, substage: state.substage,
          fuel_count: state.fuel_count, fuel_ok: state.fuel_ok, fuel_source: state.fuel_source, fuel_bin: state.fuel_bin,
          fuel_frames: fuelFrames, json_frames: jsonFrames,
          scores: state.scores, time: state.time,
        }));
        console.log('packed records', fuelCount);
        done = true;
        child.kill();
        process.exit(0);
      }
    } else if (kind === 2) {
      fuelFrames++;
      fuelCount = payload.readUInt16LE(0);
      if (fuelCount < 1) { console.error('empty fuel frame'); child.kill(); process.exit(1); }
      if (payload.readUInt16LE(2) !== 7) { console.error('bad record size'); child.kill(); process.exit(1); }
      if (payload.length !== 8 + fuelCount * 7) { console.error('bad fuel payload length', payload.length); child.kill(); process.exit(1); }
      // check the first record is a valid fixed-point position
      const present = payload[8];
      if (present !== 0 && present !== 1) { console.error('bad present byte', present); child.kill(); process.exit(1); }
      const x = ((payload.readUInt16LE(9) - 0x8000) / 4096);
      const y = ((payload.readUInt16LE(11) - 0x8000) / 4096);
      const z = ((payload.readUInt16LE(13) - 0x8000) / 4096);
      if (!(Math.abs(x) < 20 && Math.abs(y) < 20 && Math.abs(z) < 5)) { console.error('bad fuel record', x, y, z); child.kill(); process.exit(1); }
      lastFuelSeq = seq;
    }
  }
});

setTimeout(() => {
  if (!done) { console.error('timeout: no binary state', { jsonFrames, fuelFrames }); child.kill(); process.exit(1); }
}, 40000);
