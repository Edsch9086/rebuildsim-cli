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

// Captured single-player 0x06 from build b654373 (309 bytes, one red AnchorBot).
const capturedHex = '0655414c375100738fc5ad020200000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100670102000009416e63686f72426f7400000000000000001662c2950080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff000000000000ff000000';
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

// Captured 2-seat room: HostProbe (host) + ProbeBot, before and after a READY
// click on ProbeBot. The ready byte flips 0 (not ready) -> 1 (ready).
const twoSeatNotReadyHex = '0645555a35550023e4fde5020200000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000100670102000009486f737450726f626500000000000000001662c2950080ffff01010067010200000850726f6265426f740000000000000000166299890080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff000000000000ff000000';
const twoSeatReadyHex = '0645555a35550023e4fde5020200000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000100670102000009486f737450726f626500000000000000001662c2950080ffff01010067010200000850726f6265426f740000000000000000166299890080ffff0100000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff000000000000ff000000';
const readyRoom = parseRoom06(Buffer.from(twoSeatReadyHex, 'hex'));
assert.deepStrictEqual(readyRoom.seats.map(s => s.name), ['HostProbe', 'ProbeBot']);
assert.strictEqual(readyRoom.seats[1].ready, true, 'READY click sets the ready bit');
const notReadyRoom = parseRoom06(Buffer.from(twoSeatNotReadyHex, 'hex'));
assert.strictEqual(notReadyRoom.seats[1].ready, false, 'joiner starts not ready');
console.log('ready flags:', readyRoom.seats.map(s => s.name + '=' + s.ready).join(','));

// Captured live 4-seat packet: red host ready, red 1/2 not ready, blue
// captain not ready. Blue uses the 00 00 ff ff marker.
const fourSeatHex = '06444851434100b16aaeb1020200000000000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100670102000007526564486f737400000000000000001662c2950080ffff010100670102000004526564420000000000000000166299890080ffff000100670102000004526564430000000000000000166266760080ffff000101670102000005426c7565440000000000000000e99d3d6affffffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff0000000000000000000000000000000000008000800080ffff000000000000ff000000';
const fourSeat = parseRoom06(Buffer.from(fourSeatHex, 'hex'));
assert.deepStrictEqual(fourSeat.seats.map(s => s.name), ['RedHost','RedB','RedC','BlueD']);
assert.strictEqual(fourSeat.seats[0].ready, true);
assert.strictEqual(fourSeat.seats[1].ready, false);
assert.strictEqual(fourSeat.seats[3].alliance, 'blue');
assert.strictEqual(fourSeat.seats[3].ready, false, 'blue ready marker 00 00 ff ff');
console.log('4-seat ready:', fourSeat.seats.map(s => s.name + '=' + s.ready).join(','));

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
