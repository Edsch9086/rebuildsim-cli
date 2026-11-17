const assert = require('node:assert');
const { classifyMatch, phaseFor, substageFor } = require('./matchstate.cjs');

assert.deepStrictEqual(
  [phaseFor(163), phaseFor(150), phaseFor(140), phaseFor(1), phaseFor(0)],
  ['auto', 'auto', 'teleop', 'teleop', 'end'],
);
assert.deepStrictEqual(
  [substageFor(150), substageFor(141), substageFor(135), substageFor(120),
    substageFor(90), substageFor(65), substageFor(45), substageFor(15), substageFor(0)],
  ['auto', 'field_reset', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame', 'end'],
);

// A pre-clock 0x41 countdown is PREMATCH, not match end.
const pre = classifyMatch(0, 2.5, false);
assert.strictEqual(pre.phase, 'countdown');
assert.strictEqual(pre.substage, 'prematch');
assert.strictEqual(pre.ended, false);
assert.strictEqual(pre.countdown, true);

// Once the clock starts, clock=0 means the match ended.
const end = classifyMatch(0, 0, true);
assert.strictEqual(end.phase, 'end');
assert.strictEqual(end.ended, true);

// A live match is not ended.
assert.strictEqual(classifyMatch(120, 0, true).ended, false);
console.log('matchstate tests OK');
