// Match phase/substage classification. Kept separate from the engine so the
// countdown/end boundary logic can be tested without booting the wasm client.

function phaseFor(t) {
  if (t == null) return 'countdown';
  if (t > 143.0) return 'auto';
  if (t > 0.0) return 'teleop';
  return 'end';
}

function substageFor(t) {
  if (t == null) return 'prematch';
  if (t > 143.0) return 'auto';
  if (t > 140.0) return 'field_reset';
  if (t > 130.0) return 'transition';
  if (t > 105.0) return 'shift1';
  if (t > 80.0) return 'shift2';
  if (t > 55.0) return 'shift3';
  if (t > 30.0) return 'shift4';
  if (t > 0.0) return 'endgame';
  return 'end';
}

function substageRemaining(t, stage) {
  if (t == null) return null;
  const end = {
    auto: 143, field_reset: 140, transition: 130, shift1: 105,
    shift2: 80, shift3: 55, shift4: 30, endgame: 0,
  }[stage];
  return end == null ? null : Math.max(0, t - end);
}

// The clock can be absent or 0 before the match starts, with countdown either
// non-zero (counting down) or 0 (between countdown and first clock sample).
// Both are PREMATCH, not match end. Only a clock that has actually been
// positive can trigger an end-of-match transition; allow a small epsilon for
// the last packet (0.01-0.03) instead of requiring exactly 0.
const END_EPSILON = 0.05;

function classifyMatch(t, countdown, clockStarted) {
  const prematch = !clockStarted && (t == null || t <= END_EPSILON);
  const phase = prematch ? 'countdown' : phaseFor(t);
  const substage = prematch ? 'prematch' : substageFor(t);
  const ended = clockStarted && t != null && t <= END_EPSILON;
  return { phase, substage, countdown: prematch, ended };
}

module.exports = { phaseFor, substageFor, substageRemaining, classifyMatch };
