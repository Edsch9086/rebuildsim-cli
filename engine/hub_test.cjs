// Hub schedule tests for the REBUILT 2026 rules.
const assert = require('node:assert');
const { computeHub } = require('./hub.cjs');

// Red scored more fuel in AUTO -> red hub inactive in SHIFT 1.
const redWon = (t, a) => computeHub(t, 5, 3, a);
assert.deepStrictEqual([redWon(150).red_active, redWon(150).blue_active], [true, true]);
assert.deepStrictEqual([redWon(141.5).red_active, redWon(141.5).blue_active], [false, false]);
assert.deepStrictEqual([redWon(135).red_active, redWon(135).blue_active], [true, true]);
assert.deepStrictEqual([redWon(120).red_active, redWon(120).blue_active], [false, true]);
assert.deepStrictEqual([redWon(90).red_active, redWon(90).blue_active], [true, false]);
assert.deepStrictEqual([redWon(65).red_active, redWon(65).blue_active], [false, true]);
assert.deepStrictEqual([redWon(45).red_active, redWon(45).blue_active], [true, false]);
assert.deepStrictEqual([redWon(15).red_active, redWon(15).blue_active], [true, true]);
assert.strictEqual(redWon(120, 'red').active, false);
assert.strictEqual(redWon(120, 'blue').active, true);

// Blue scored more fuel in AUTO -> the order is reversed.
const blueWon = (t, a) => computeHub(t, 3, 5, a);
assert.deepStrictEqual([blueWon(120).red_active, blueWon(120).blue_active], [true, false]);
assert.deepStrictEqual([blueWon(90).red_active, blueWon(90).blue_active], [false, true]);
assert.deepStrictEqual([blueWon(65).red_active, blueWon(65).blue_active], [true, false]);
assert.deepStrictEqual([blueWon(45).red_active, blueWon(45).blue_active], [false, true]);
assert.strictEqual(blueWon(120, 'red').active, true);
assert.strictEqual(blueWon(120, 'blue').active, false);

// Tied AUTO: the FMS picks the shift order, so shift status is unknown.
const tie = computeHub(120, 4, 4, 'red');
assert.strictEqual(tie.phase, 'shift1');
assert.strictEqual(tie.source, 'tie');
assert.strictEqual(tie.red_active, null);
assert.strictEqual(tie.blue_active, null);
assert.strictEqual(tie.active, null);
assert.deepStrictEqual([computeHub(135, 4, 4, 'red').red_active, computeHub(135, 4, 4, 'red').blue_active], [true, true]);

// Manual override for a tied AUTO: the operator can force the FMS order.
const forcedRed = computeHub(120, 4, 4, 'red', 'red');
assert.strictEqual(forcedRed.source, 'forced');
assert.strictEqual(forcedRed.red_active, false);
assert.strictEqual(forcedRed.blue_active, true);
const forcedBlue = computeHub(120, 4, 4, 'blue', 'blue');
assert.strictEqual(forcedBlue.red_active, true);
assert.strictEqual(forcedBlue.blue_active, false);

// No clock yet.
assert.strictEqual(computeHub(null, 0, 0, 'red').source, 'unknown');
console.log('hub tests OK');
