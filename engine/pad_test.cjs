// Diagnostic: map virtual gamepad buttons to the game's 0x40 input bits.
// Run from engine/: node pad_test.cjs
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const env = { ...process.env, RB_ASSET_DIR: process.env.RB_ASSET_DIR || '/tmp/opencode/site' };
const child = spawn(process.execPath, ['headless.cjs', '--create', '--start', '--gamepad', '--debug', '--username', 'BtnBot', '--emit-hz', '1'], {
  cwd: __dirname, env, stdio: ['pipe', 'pipe', 'pipe'],
});
const err = fs.createWriteStream('/tmp/opencode/pad_buttons_err.log');
child.stderr.pipe(err);
child.stdout.on('data', () => {});

const zero = Array(16).fill(0);
function pad(buttons, axes = [0, 0, 0, 0]) {
  child.stdin.write(JSON.stringify({ type: 'pad', axes, buttons }) + '\n');
}

setTimeout(() => {
  console.log('starting button scan');
  let i = 0;
  const timer = setInterval(() => {
    if (i >= 16) { clearInterval(timer); setTimeout(() => { pad(zero); child.kill('SIGINT'); }, 1200); return; }
    const buttons = [...zero]; buttons[i] = 1;
    pad(buttons);
    console.log('button', i);
    setTimeout(() => pad(zero), 700);
    i++;
  }, 1300);
}, 16000);

child.on('exit', () => { console.log('engine exited'); err.end(); });
