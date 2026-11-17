// Hub active/inactive schedule for REBUILT 2026.
//
// Both hubs are active during AUTO, the TRANSITION SHIFT, and END GAME. There is
// a 3-second field-reset delay between AUTO and TELEOP where both are inactive.
// During the four ALLIANCE SHIFTS one hub is active and the other is inactive.
// The alliance that scored more AUTO fuel has its hub inactive in SHIFT 1;
// the status then alternates each shift. A tied AUTO is resolved by the FMS
// (random), so this module reports the shift status as unknown on a tie.
// The caller currently supplies the 0x41 auto score fields; if those include
// non-fuel AUTO points, pass an explicit forcedOrder instead.

function computeHub(time, autoRed, autoBlue, alliance, forcedOrder) {
  if (forcedOrder === 'r' || forcedOrder === 'R') forcedOrder = 'red';
  if (forcedOrder === 'b' || forcedOrder === 'B') forcedOrder = 'blue';
  const out = {
    active: null,
    red_active: null,
    blue_active: null,
    red_inactive_first: null,
    phase: 'unknown',
    source: 'unknown',
  };
  if (time == null || !Number.isFinite(time)) return out;

  if (forcedOrder === 'red' || forcedOrder === 'blue') {
    out.red_inactive_first = forcedOrder === 'red';
    out.source = 'forced';
  } else if (autoRed > autoBlue) {
    out.red_inactive_first = true;
    out.source = 'auto_score';
  } else if (autoBlue > autoRed) {
    out.red_inactive_first = false;
    out.source = 'auto_score';
  } else {
    out.red_inactive_first = null;
    out.source = 'tie';
  }

  const both = (active, phase) => {
    out.red_active = active;
    out.blue_active = active;
    out.phase = phase;
  };

  if (time > 143.0) {
    both(true, 'auto');
  } else if (time > 140.0) {
    both(false, 'field_reset');
  } else if (time > 130.0) {
    both(true, 'transition');
  } else if (time > 105.0) {
    out.phase = 'shift1';
  } else if (time > 80.0) {
    out.phase = 'shift2';
  } else if (time > 55.0) {
    out.phase = 'shift3';
  } else if (time > 30.0) {
    out.phase = 'shift4';
  } else if (time > 0.0) {
    both(true, 'endgame');
  } else {
    both(false, 'end');
  }

  if (out.phase.startsWith('shift')) {
    if (out.red_inactive_first == null) {
      // Tied AUTO: the FMS picks the order. We do not know which hub is active.
      out.red_active = null;
      out.blue_active = null;
    } else if (out.phase === 'shift1' || out.phase === 'shift3') {
      out.red_active = !out.red_inactive_first;
      out.blue_active = out.red_inactive_first;
    } else {
      out.red_active = out.red_inactive_first;
      out.blue_active = !out.red_inactive_first;
    }
  }

  if (alliance === 'red') out.active = out.red_active;
  else if (alliance === 'blue') out.active = out.blue_active;
  return out;
}

module.exports = { computeHub };
