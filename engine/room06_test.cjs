// Seat parser tests. Run: node engine/room06_test.cjs
const assert = require('node:assert');
const fs = require('node:fs');
const { parseRoom06 } = require('./room06.cjs');

// Synthetic room state: five player records (0-2 red, 3 blue, 4 red).
function rec(team, name, robotId = 359) {
  const b = Buffer.alloc(8 + 24);
  b[0] = 1;
  b[1] = team;
  b.writeUInt16LE(robotId, 2);
  b[4] = 2;
  b[7] = name.length;
  b.write(name, 8, 'utf8');
  return b;
}
const header = Buffer.alloc(64);
header.write('06ABCDE', 0, 'latin1');
const synthetic = Buffer.concat([header, rec(0, 'RedCap'), rec(0, 'Red1', 4414),
  rec(0, 'Red2'), rec(1, 'BlueCap'), rec(0, 'RedFour')]);
const parsed = parseRoom06(synthetic);
assert.deepStrictEqual(
  parsed.seats.map((s) => [s.seat, s.name, s.alliance]),
  [[0, 'RedCap', 'red'], [1, 'Red1', 'red'], [2, 'Red2', 'red'],
   [3, 'BlueCap', 'blue'], [4, 'RedFour', 'red']],
);
console.log('synthetic:', JSON.stringify(parsed.seats));

// Captured single-player 0x06 from build b654373 (one red AnchorBot).
const capturedHex = '0655414c375100738fc5ad020200000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100670102000009416e63686f72426f7400000000000000001662c2950080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff000000000000ff000000';
const captured = parseRoom06(Buffer.from(capturedHex, 'hex'));
assert.strictEqual(captured.seats.length, 1);
assert.strictEqual(captured.seats[0].name, 'AnchorBot');
assert.strictEqual(captured.seats[0].team_flag, 0);
assert.strictEqual(captured.seats[0].alliance, 'red');
assert.strictEqual(captured.seats[0].robot_id, 359);
console.log('captured:', JSON.stringify(captured.seats));
assert.strictEqual(parsed.seats[4].team_flag, 0);
assert.strictEqual(parsed.seats[4].alliance, 'red', 'explicit red flag at index >= 3 must stay red');
assert.strictEqual(parsed.seats[0].robot_id, 359);
assert.strictEqual(parsed.seats[1].robot_id, 4414, 'non-default robot id must parse');

// Captured 4-player packet from a live lobby (all names were Host4 because the
// browser tabs shared a name; the seat/alliance layout is what matters).
const fixture = process.env.RB_ROOM06_FIXTURE || '';
if (fs.existsSync(fixture)) {
  const real = parseRoom06(fs.readFileSync(fixture));
  assert.strictEqual(real.seats.length, 4, 'four seats');
  assert.strictEqual(real.seats[0].alliance, 'red');
  assert.strictEqual(real.seats[3].alliance, 'blue');
  assert.strictEqual(real.seats[3].team_flag, 1);
  console.log('captured:', JSON.stringify(real.seats));
} else {
  console.log('captured fixture not provided (set RB_ROOM06_FIXTURE to test one)');
}
console.log('room06 tests OK');
