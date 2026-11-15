// Minimal room-state (0x06) seat parser.
//
// Observed player record:
//   01 <team> 67 01 02 00 00 <name-len> <name...>
//
// `<team>` is 0 for red seats and 1 for blue seats (verified with a 4-player
// room: seats 0-2 flag 0, seat 3 flag 1, and the seat-3 client rendered blue).
// Player records appear in room seat order; in a fresh room the first three
// seats are red (captain, red 1, red 2) and the next three are blue (captain,
// blue 1, blue 2). Spectator records use a different signature and are skipped.
//
// The seat order fallback (first 3 red, next 3 blue) is retained for builds
// that don't populate the team byte.

function parseRoom06(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const seats = [];
  for (let i = 64; i + 9 <= buf.length && seats.length < 6; i++) {
    if (buf[i] !== 1) continue;
    if (buf[i + 2] !== 0x67) continue;
    if (buf[i + 3] !== 1 || buf[i + 4] !== 2 || buf[i + 5] !== 0 || buf[i + 6] !== 0) continue;
    const len = buf[i + 7];
    if (len < 1 || len > 24) continue;
    const name = buf.subarray(i + 8, i + 8 + len).toString('utf8');
    if (!/^[\x20-\x7e]+$/.test(name)) continue;
    const teamFlag = buf[i + 1];
    if (teamFlag > 1) continue;
    const seat = seats.length;
    seats.push({
      seat,
      name,
      team_flag: teamFlag,
      alliance: teamFlag === 1 ? 'blue' : (seats.length < 3 ? 'red' : 'blue'),
    });
    i += 8 + len - 1;
  }
  return { seats };
}

module.exports = { parseRoom06 };
