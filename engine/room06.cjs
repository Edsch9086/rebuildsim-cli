// Minimal room-state (0x06) seat parser.
//
// Observed player record:
//   01 <team> <robot-id u16> 02 00 00 <name-len> <name...>
//
// `<team>` is 0 for red seats and 1 for blue seats (verified with a 4-player
// room: seats 0-2 flag 0, seat 3 flag 1, and the seat-3 client rendered blue).
// The two bytes after the team flag are the robot/team id, e.g. `67 01` = 359
// in the default robot. Do not hardcode 359; a different robot changes it.
// Player records appear in room seat order; in a fresh room the first three
// seats are red (captain, red 1, red 2) and the next three are blue (captain,
// blue 1, blue 2). Spectator records use a different signature and are skipped.
//
// The team byte is authoritative: 0 = red, 1 = blue. There is no seat-order
// fallback; a record with an explicit 0 flag is red even at index >= 3.

function parseRoom06(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const seats = [];
  for (let i = 64; i + 9 <= buf.length && seats.length < 6; i++) {
    if (buf[i] !== 1) continue;
    // i+2/i+3 are a variable robot/team id (359 = 67 01 in the default robot).
    if (buf[i + 4] !== 2 || buf[i + 5] !== 0 || buf[i + 6] !== 0) continue;
    const robotId = buf.readUInt16LE(i + 2);
    if (robotId === 0 || robotId >= 0x8000) continue;
    const len = buf[i + 7];
    if (len < 1 || len > 24) continue;
    // A real record has 8 bytes of per-player data after the name; requiring
    // them rejects truncated/coincidental matches without assuming 359.
    if (i + 8 + len + 8 > buf.length) continue;
    const name = buf.subarray(i + 8, i + 8 + len).toString('utf8');
    if (!name || /[\x00-\x1f]/.test(name) || name.includes('\ufffd')) continue;
    const teamFlag = buf[i + 1];
    if (teamFlag > 1) continue;
    // The per-seat ready byte follows padding, a 4-byte value, and a 4-byte
    // field ending in ff ff. That field varies by seat (00 80 ff ff for red;
    // blue has been seen with both 00 00 ff ff and ff ff ff ff). The ready
    // byte is 0 = not ready, 1 = ready (verified live).
    let ready = null;
    // Marker: 00 80 ff ff for red seats, 00 00 ff ff for blue seats;
    // the ready byte follows it (0 = not ready, 1 = ready).
    const stop = Math.min(buf.length - 4, i + 8 + len + 34);
    for (let q = i + 8 + len; q < stop; q++) {
      // The four-byte field before the ready byte ends in ff ff; its first
      // bytes vary by seat (00 80, 00 00, or ff ff). The ready byte is
      // 0 = not ready, 1 = ready.
      if (buf[q + 2] === 0xff && buf[q + 3] === 0xff
          && (buf[q + 4] === 0 || buf[q + 4] === 1)) {
        ready = buf[q + 4] === 1;
        break;
      }
    }
    const seat = seats.length;
    seats.push({
      seat,
      name,
      robot_id: robotId,
      team_flag: teamFlag,
      alliance: teamFlag === 1 ? 'blue' : 'red',
      ready,
    });
    i += 16 + len - 1;
  }
  return { seats };
}

module.exports = { parseRoom06 };
