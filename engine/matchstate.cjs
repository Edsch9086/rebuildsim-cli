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

// The 0x41 countdown at +6 can be non-zero before the match clock starts. That
// state is PREMATCH, not match end; only a clock that has actually started can
// trigger an end-of-match reset.
function classifyMatch(t, countdown, clockStarted) {
  const inCountdown = countdown != null && countdown > 0 && (t == null || t <= 0);
  const phase = inCountdown ? 'countdown' : phaseFor(t);
  const substage = inCountdown ? 'prematch' : substageFor(t);
  const ended = t != null && t <= 0 && clockStarted && !inCountdown;
  return { phase, substage, countdown: inCountdown, ended };
}

module.exports = { phaseFor, substageFor, substageRemaining, classifyMatch };
