// Seat parser tests. Run: node engine/room06_test.cjs
const assert = require('node:assert');
const fs = require('node:fs');
const { parseRoom06 } = require('./room06.cjs');

// Synthetic room state: 4 player records, seats 0-2 red, seat 3 blue.
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
