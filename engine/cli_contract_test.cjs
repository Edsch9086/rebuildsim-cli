// Deterministic CLI contract tests using a fake engine (no network, no wasm).
// Build the Rust CLI first: cargo build -p rebuildsim-cli
// Run: node engine/cli_contract_test.cjs
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = process.env.RB_CLI || path.join(__dirname, '..', 'target', 'debug', 'rebuildsim-cli');
if (!fs.existsSync(CLI)) {
  console.log(`SKIP cli contract test: ${CLI} not found; run cargo build -p rebuildsim-cli`);
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-cli-'));
const heartbeat = 'setInterval(()=>console.log(JSON.stringify({type:"heartbeat",t:Date.now()/1000,ws_open:2,ws_closed:0})),500);';
const seats = '[{seat:0,name:"Bot",team_flag:0,alliance:"red",ready:true}]';
function fake(name, body) {
  const file = path.join(dir, name + '.cjs');
  fs.writeFileSync(file, body + '\n' + heartbeat + '\n');
  return file;
}
const ready = 'console.log(JSON.stringify({type:"ready",build:"fake"}));';
const room = (code, seated, active = false) =>
  `console.log(JSON.stringify({type:"room",code:"${code}",host:false,seated:${seated},role:"${seated ? 'driver' : 'spectator'}",match_active:${active},seats:${seats}}));`;
const after = (ms, line) => `setTimeout(()=>{${line}},${ms});`;

const scripts = {
  spectator: fake('spectator', ready + after(100, room('SPEC1', false))),
  noroom: fake('noroom', ready),
  stall: fake('stall', ready + after(100, room('STAL1', true, true)) +
    after(200, 'console.log(JSON.stringify({type:"match",phase:"auto",substage:"auto",time:160,seats:[]}));') +
    after(300, 'console.log(JSON.stringify({type:"error",error:"match_clock_stalled"}));')),
  notready: fake('notready', ready + after(100, room('NREA1', true)) +
    after(300, 'console.log(JSON.stringify({type:"error",error:"not_all_ready",detail:"RedB"}));')),
  transient: fake('transient', ready + after(100, room('TRAN1', true)) +
    after(300, room('TRAN1', false)) + after(800, room('TRAN1', true))),
};

function run(engine, args, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const p = spawn(CLI, ['--engine', engine, '--json', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      resolve({ code: null, err, timedOut: true });
    }, timeoutMs);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, err, timedOut: false });
    });
  });
}

let failures = 0;
function check(name, result, wantCode, wantAlive = false) {
  const ok = wantAlive ? result.timedOut : (!result.timedOut && result.code === wantCode);
  console.log(`${ok ? 'OK' : 'FAIL'} ${name} code=${result.code} timedOut=${result.timedOut}`);
  if (!ok) {
    failures++;
    console.log(result.err.split('\n').slice(-4).join('\n'));
  }
}

(async () => {
  check('spectator exits 7', await run(scripts.spectator, ['--code', 'SPEC1']), 7);
  check('join timeout exits 5', await run(scripts.noroom, ['--code', 'NORM1', '--join-timeout', '2']), 5);
  check('stalled clock exits 5', await run(scripts.stall, ['--code', 'STAL1']), 5);
  check('not-all-ready exits 5', await run(scripts.notready, ['--code', 'NREA1']), 5);
  check('transient seat loss stays alive', await run(scripts.transient, ['--code', 'TRAN1'], 3000), null, true);
  if (failures) {
    console.error(`${failures} CLI contract test(s) failed`);
    process.exit(1);
  }
  console.log('cli contract tests OK');
  process.exit(0);
})();
