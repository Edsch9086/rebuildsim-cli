# Engine / CLI API

## Rust CLI

```rust
use rebuildsim_cli::engine::{Engine, EngineOptions, Input};
```

The `cli/` crate is a library + demo binary; depend on it as a path dependency
and use `engine` directly.

```rust
let mut opts = EngineOptions::new("engine/headless.cjs", "MyBot");
opts.code = Some("ABCDE".into());      // or opts.create = true
opts.start = false;                     // host only
opts.emit_hz = 30;
opts.gamepad = true;                    // analog; false = keyboard
opts.binary = true;                     // packed fuel frames (default)
let mut engine = Engine::spawn(&opts)?;

while let Some(state) = engine.next_state()? {
    let me = state.me.as_ref().expect("our robot");
    // state.red_score, state.blue_score, state.hub, state.substage, state.time ...
    engine.send_input(&Input { y: 1.0, ..Default::default() })?;
}
```

`Engine` also provides `next_event_timeout`, `next_state_timeout`, and
`next_state_or_event_timeout` (returns `NextState::State` or
`NextState::Event`). Use the timeout variants for bounded waits and the
event-aware variant if you need to observe `Error`, `Ws`, or `Room` events.
`next_state()` is the simple blocking helper; it intentionally drops non-state
events and can block indefinitely if the engine stays alive but silent. The
background reader prevents stdout parsing from blocking the caller, but only the
timeout variants provide a deadline.

## Units and conventions

| Field | Unit / convention |
| --- | --- |
| `seq` | integer state/frame counter |
| `t` | Unix wall-clock seconds |
| `time`, `time_remaining` | seconds on the `0x41` match clock (starts at 163.0, counts down) |
| `substage_remaining` | seconds until the next substage boundary |
| `x`, `y` | meters in `state.frame` (alliance-normalized by default) |
| `z` | meters above the field surface; robot chassis is ~0 at floor level |
| `heading` | radians in `state.frame` |
| `vx`, `vy`, `vz` | meters/second |
| `yaw_rate` | radians/second |
| `fuel_count` | number of fuel records (pieces/clusters) in this match |
| `fuel.id` | zero-based fuel array index, `0..fuel_count-1` |
| `fuel.x/y/z` | meters; `z` already includes the +0.045 m center offset |
| `fuel.count` | number of fuel pieces represented by that record (cluster size; usually 1) |
| `hopper_fuel` | fuel pieces currently in the local robot's hopper (integer) |
| `hopper_capacity` | hopper capacity shown by the HUD (55 in this build) |
| `intake_active` | boolean; true while the intake trigger is held |
| `hub.active` | `true`/`false` for our hub, `null` when AUTO was tied during a shift |
| `fuel.flags` | raw packet bitfield; `0` normal, `7` observed for a hub cluster |
| `red_score`, `blue_score`, `auto_*` | game points as displayed on the HUD (integer) |
| `Input.x` | left stick X, normalized `-1.0..1.0` (right positive) |
| `Input.y` | left stick Y, normalized `-1.0..1.0` (forward positive) |
| `Input.rotate` | right stick X, normalized `-1.0..1.0` |
| `Input.intake/outtake/shoot` | boolean triggers |
| `emit_hz` | states per second |
| `protocol` | server protocol version integer (`1` currently) |
| `team_flag` | seat team enum: `0` red, `1` blue |
| `seat` | zero-based record/seat-order index (normal rooms are seat order) |
| `ready` | `true`/`false` from the 0x06 ready byte; `null` if not decoded |

Notes:

- **Coordinates are alliance-normalized by default** (`state.frame ==
  "alliance"`). For blue, the engine rotates every robot/fuel position, heading,
  and velocity by 180 degrees before reporting it. Red and blue bots therefore
  receive the same convention: own side is negative x, opponent side is
  positive x, and `Input.y = 1` drives toward the opponent on both sides. A bot
  should not need `alliance` at all.
- `--field-frame` switches to raw global coordinates (`frame == "field"`). In
  that mode use `Robot::field_to_driver()` / `alliance_heading()` before feeding
  a global vector into `Input`.
- `heading` uses the game's heading convention, not a compass bearing.
- `z` is the pose height, not a full 3D center of mass. Robot `z` is normally
  near zero on the field. Fuel `z` is the stored bottom plus the 0.045 m radius.
- `time` is match time, not wall time. Wall time is `t`.
- The match clock is authoritative for substage transitions; see the table
  below.

### `GameState`

```rust
pub struct GameState {
    pub seq: u64,
    pub t: f64,               // unix seconds
    pub phase: String,        // "countdown" | "auto" | "teleop" | "end"
    pub substage: String,     // "prematch" | "auto" | "field_reset" |
                              // "transition" | "shift1".."shift4" |
                              // "endgame" | "end"
    pub time: Option<f64>,    // match clock from 0x41 (163.0 -> 0.0)
    pub time_remaining: Option<f64>,      // same value, explicit name
    pub substage_remaining: Option<f64>,  // seconds until the next boundary
    pub red_score: u16,
    pub blue_score: u16,
    pub auto_red_score: u16,  // frozen at the end of auto
    pub auto_blue_score: u16,
    pub protocol: Option<u8>,
    pub frame: String,        // "alliance" (default) | "field" | "unknown"
                              // "unknown" means raw global until 0x06/pose resolves
    pub alliance: String,     // diagnostic only; "unknown" until resolved
    pub hub: HubStatus,
    pub hopper_fuel: Option<u16>,
    pub hopper_capacity: Option<u16>,
    pub intake_active: Option<bool>,
    pub me: Option<Robot>,    // the robot owned by this CLI instance
    pub robots: Vec<Robot>,
    pub fuel: Vec<Fuel>,
    pub fuel_count: Option<u16>, // total fuel for this match (1..~4300)
    pub fuel_bin: bool,          // fuel arrived on the binary channel
    pub fuel_ok: bool,           // false if fuel_count is known but unreadable
    pub fuel_source: Option<String>, // "packet" | "scan"
    pub ws_open: u32,
    pub ws_closed: u32,
}
```

Verified substage boundaries (from a full HUD capture):

| Clock | Substage |
| --- | --- |
| 163 → 143 | `auto` (20 s) |
| 143 → 140 | `field_reset` (3 s) |
| 140 → 130 | `transition` (10 s) |
| 130 → 105 | `shift1` |
| 105 → 80 | `shift2` |
| 80 → 55 | `shift3` |
| 55 → 30 | `shift4` |
| 30 → 0 | `endgame` |

`red_score`/`blue_score` are the live totals displayed on the HUD. The auto
scores freeze when auto ends.

### Hub status

`GameState.hub` follows the REBUILT 2026 rules:

- Both hubs active during AUTO, the TRANSITION SHIFT, and END GAME.
- Both inactive during the 3-second field reset between AUTO and TELEOP.
- During SHIFT 1–4, one hub is active. The alliance that scored more fuel in
  AUTO has its hub **inactive in SHIFT 1**, then the status alternates each
  shift.
- A tied AUTO is decided by the FMS; the API reports `hub.active = null`,
  `hub.red_active = null`, `hub.blue_active = null`, `source = "tie"` during
  shifts. Outside shifts it still reports both active/inactive normally.
- The engine currently uses the `0x41` auto **score** fields (`+18/+28`) to pick
  the AUTO winner. If a robot scored tower points in AUTO, those fields may not
  be fuel-only; use `--hub-order red|blue` when the correct SHIFT-1 order is
  known.

```rust
pub struct HubStatus {
    pub active: Option<bool>,        // our hub; null on a tied AUTO shift
    pub red_active: Option<bool>,
    pub blue_active: Option<bool>,
    pub red_inactive_first: Option<bool>,
    pub phase: String,               // "auto" | "field_reset" | "transition" |
                                     // "shift1".."shift4" | "endgame" | "end" | "unknown"
    pub source: String,              // "auto_score" | "tie" | "forced" | "unknown"
}
```

`hub.active` is the field a bot should normally use; it is already normalized
to our alliance, so the bot does not need to know red/blue.

For a tied AUTO or a practice match where the order is known, pass
`--hub-order red` or `--hub-order blue`. That forces the SHIFT-1 inactive hub
and sets `source = "forced"`; it applies to all four shifts.

### `Robot`

```rust
pub struct Robot {
    pub name: String,
    pub is_me: bool,
    pub alliance: String,     // diagnostic only
    pub alliance_source: String, // "room" (0x06 seats) | "spawn"
    pub x: f32, pub y: f32, pub z: f32, // in state.frame
    pub heading: f32,         // radians, in state.frame
    pub vx: f32, pub vy: f32, pub vz: f32, // m/s, in state.frame
    pub yaw_rate: f32,
    pub pose_source: String,  // "predicted" (~48 Hz) | "acked" | "stale"
    pub stale: bool,          // true when the last known pose was reused
    pub hopper_fuel: Option<u16>, // that robot's hopper fuel, if readable
    pub intake_active: Option<bool>, // that robot's intake flag
}
```

`hopper_fuel` is the local robot's held fuel, read from the player struct at
name+0x4b. It starts at 8 in the default build (HUD `FUEL 8/55`) and decrements
while shooting. `hopper_capacity` is `55`; it is a build/HUD constant, not a
per-robot field. `intake_active` comes from bit 6 of the byte at name+0x56 and
tracks the intake trigger (true while held). Remote robots may report their
hopper/intake too, but the local robot's values are the reliable ones.

There is no separate "shooting" boolean in the player struct: shooting is a
trigger, the hopper count drops as fuel is fired, and a f32 timer at name+0x4f
changes during/after a shot. A separate turret angle has not been isolated for
this robot; the game handles aiming internally. Hub lights are visual; use
`hub.active` for the logical state.

`Fuel`: `id, x, y, z, present`, plus optional `vx, vy, vz, count, flags` merged
from the server packet in JSON mode. In binary mode those optional fields are
`None`. The array length is `fuel_count`, not a fixed 456.

### `Input`

`Input` has `x, y, rotate, intake, outtake, shoot`. With the virtual gamepad:

- `x` left stick X (strafe/right)
- `y` left stick Y (forward; the engine sends `-y`)
- `rotate` right stick X (turn)
- `intake` LT, `outtake` LB, `shoot` RT

`shoot` is a trigger. The game auto-aims turreted robots and auto-turns dumper
robots; do not synthesize an aim angle. Driver input works during **auto** as
soon as the match clock starts; `field_reset` is the 3-second reset window.

### Identity and alliance

`state.me` and `Robot.is_me` are authoritative. `me` is matched against the CLI
username in the live player state; alliance comes from the `0x06` seat team
byte, not from record order. Seats, robots, and spawn slots can be changed
before the match: the engine re-reads `0x06`, switches the normalized frame to
the new team, clears cached poses, and readies the new seat if its ready bit is
0. Infer the spawn from the first in-match `me` pose. Display names are limited
to **10 printable ASCII characters** by the client; the engine rejects longer
names rather than letting the seat name be truncated.
In a six-robot lobby, always read `me` rather than indexing `robots[0]` or
guessing by team.

With the default `frame == "alliance"`, the engine has already rotated
positions/headings/velocities into your driver frame. Just plan in the reported
coordinates (the output-frame rotation is verified; blue browser movement is
observational because headless tab focus is flaky, and a headless blue gamepad
seat remains to be tested on the team server):

```rust
let dx = target_x - me.x;
let dy = target_y - me.y;
engine.send_input(&Input { x: strafe, y: forward, ..Default::default() })?;
```

`Robot::field_to_driver()` and `alliance_heading()` exist for
`--field-frame`/raw-global consumers only; do not call them in alliance frame.
The 4-player seat test showed **seat index 3 / the fourth seat** as blue
(`team=1`), so a fourth bot in a fresh room is blue without moving. In a 3v3,
the first three joiners are red and the next three blue.

## Engine JSON lines (stdio, default)

Engine → CLI:

```json
{"type":"build","build":"b654373","server_build":"b654373","ok":true}
{"type":"ready","build":"b654373","binary":false}
{"type":"protocol","version":1}
{"type":"seats","code":"ABCDE","seats":[
  {"seat":0,"name":"MyBot","robot_id":359,"team_flag":0,"alliance":"red",
   "ready":false}]}
{"type":"room","code":"ABCDE","host":true,"seated":true,"role":"driver",
 "match_active":false,"seats":[...]}
{"type":"match","phase":"countdown","substage":"prematch","time":null,"seats":[...]}
{"type":"score","seq":42,"red":7,"blue":4,"auto_red":3,"auto_blue":2}
{"type":"state","seq":42,"t":1794772715.59,"phase":"auto","substage":"auto",
 "time":158.8,"time_remaining":158.8,"substage_remaining":15.8,
 "red_score":7,"blue_score":4,"auto_red_score":3,"auto_blue_score":2,
 "scores":{"red":7,"blue":4},"protocol":1,"frame":"alliance","alliance":"red",
 "fuel_count":456,"fuel_ok":true,"fuel_source":"packet",
 "hopper_fuel":8,"hopper_capacity":55,
 "intake_active":false,"hub":{"active":true,"red_active":true,"blue_active":true,
 "red_inactive_first":true,"phase":"auto","source":"auto_score"},
 "me":{"name":"MyBot","is_me":true,"alliance":"red","alliance_source":"room",
       "pose_source":"predicted","x":-4.67,"y":3.40,
       "z":0.0,"heading":-1.18,"vx":0.0,"vy":0.0,"vz":0.0,"yawRate":0.0},
 "robots":[...],
 "fuel":[{"id":0,"x":-0.366,"y":-1.0466,"z":0.0748,"present":true,
          "vx":0.0,"vy":0.0,"vz":0.0,"count":1,"flags":0}]}
```

CLI → engine:

```json
{"type":"input","x":0.0,"y":1.0,"rotate":0.0,"intake":false,"outtake":false,"shoot":false}
{"type":"pad","axes":[0,-1,0,0,0,0],"buttons":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}
{"type":"ready"}
{"type":"start"}
{"type":"leave"}
{"type":"quit"}
{"type":"ping"}
{"type":"dump06","path":"/tmp/room06.bin"}
```

The raw `pad` command is for diagnostics; normal bot code should use `input`.
`dump06` writes the latest raw `0x06` room packet for offline seat analysis.

### Binary mode (`--binary`)

The Rust `Engine` passes `--binary` by default. Engine stdout then uses 16-byte
`RSB1` frames: kind 1 is a JSON event, kind 2 is packed fuel (7 bytes/record).
The fuel frame carries the same sequence number as the following state; that
state has `"fuel_bin": true` and `"fuel": []`, and the Rust reader reattaches
the decoded array. Packed records carry only `present/x/y/z`; packet
`vx/vy/vz/count/flags` are available only in JSON mode. See
`docs/PROTOCOL.md` §1.7 for the byte layout. Use `EngineOptions.binary = false`
to get plain JSON lines.

## Timeouts and disconnect handling

The CLI adds several watchdogs on top of the engine:

- `--state-timeout <S>` (default 5): if a match is running and no state arrives
  for S seconds, print an error and exit `5`. This catches a stalled Node
  process, a broken stdout pipe, or a silently frozen engine.
- `--join-timeout <S>` (default 60): if no `Room` event with a non-empty seat
  list arrives after the engine is ready, exit `5`. This catches a hung
  title/menu/room UI and a room socket that joined but never delivered `0x06`.
- Startup deadline: if the engine never emits `ready` within 30 s, exit `5`.
- Heartbeat: if no engine event arrives for 15 s after `ready`, exit `5`. The
  engine emits a heartbeat every second, including between matches; the wider
  window tolerates a synchronous fuel scan.
- Room WebSocket close: the engine emits a `ws` event tagged `room: true` when
  the socket that delivered `0x06` closes. The CLI exits `6` in that case
  unless `--allow-ws-close` is passed.
- If `0x41` stops for 4 s during a live match (or no auto clock above 143 s
  arrives within 15 s of match start), the engine emits `match_clock_stalled`;
  the CLI exits `5` immediately (or via the state timeout if states simply
  stop). A stale positive teleop clock from the previous match is ignored until
  the first auto clock.
- A room update that omits the driver seat is debounced for 2.5 s in the lobby
  and 5 s during a match. The CLI waits for the engine's exit `7`; a returning
  seat cancels the demotion and re-emits a driver room event.
- Navigating back to the menu/multiplayer screen after joining exits `6`
  (`left_room`) so the orchestrator can restart or rejoin.
- The engine refuses a `room_join` whose access is not exactly `PRIVATE`
  (including a missing access field) unless the test-only `--allow-public` flag
  is set. Logs contain room codes and player names; treat them as private-lobby
  diagnostics.
- `engine/trusted_build.json` pins the build and both asset hashes in the repo.
  `prepare.mjs` does not update it; update it deliberately after verifying a new
  release, or use `--no-build-check` for offline debugging.

The engine itself does not attempt to reconnect to a running match. Rejoining a
match in progress puts you in as a spectator, so the safe behavior is a clear
failure; the orchestrator can start a fresh bot for the next match. The
room-list socket closing is reported but is not fatal.

CLI exit codes: `0` normal, `1` engine/boot error, `2` bad arguments/config,
`3` build/asset pin failure, `4` protocol mismatch, `5` state/join/heartbeat
timeout, stalled clock, or blocked host start, `6` room WebSocket close, left
room, or stuck results screen, `7` joined as spectator, `8` identity
failure (duplicate names).

For **lobby** disconnects, `--restart-on-exit` respawns the engine and rejoins
the same room code after 2 seconds, up to `--max-restarts N` (default 3). It is
join-mode only (not with `--create`) and is disabled after a match starts until
a fresh `room` event arrives, so it never turns a driver bot into a spectator
mid-match. Build/protocol failures (exit 3/4) are not retried.

## Build pinning

`engine/prepare.mjs` writes `cache/build.json` with the downloaded `BUILD` hash.
It refuses to replace the pinned build with a different live build unless
`RB_ALLOW_BUILD_UPDATE=1` is set, and it verifies downloaded hashes against the
pin before installing them. Use `RB_BUILD=<pinned-hash> node prepare.mjs` to
restore pinned assets; update `engine/trusted_build.json` deliberately after
verifying a new release.
At startup the engine fetches the page and compares the live `BUILD`:

- mismatch → emits `{"type":"error","error":"build_drift",...}` and exits `3`;
- `--expect-build <hash>` checks the cached assets before connecting and exits
  `3` on mismatch; asset SHA-256 hashes from `build.json` are verified too;
- `--no-build-check` skips the trusted pin and live fetch (offline/local
  debugging); `build.json` asset hashes are still verified.

The `0x21` protocol hello must report version `1`; a mismatch is a hard error
(`exit 4`).

## Known limitations / next work

- `--spawnpoint` is deferred. The engine joins with the default seat and logs
  that the flag is ignored; a tuned bot can infer its spawn from `me`.
- After a match the engine clicks `BACK TO THE ROOM` at ~3.5 s, 7.5 s, and
  15 s. If the results screen still has not returned at 20 s it emits
  `results_stuck` and exits `6`. A human can click earlier; pending result-screen
  clicks are canceled when the room view appears.
- Blue control-frame inversion is implemented and the 4th seat is confirmed
  blue. The 4-client test asserts the four seats, host `me`, robot identities,
  and the normalized frame; it logs blue keyboard movement as observational
  evidence (a verified run moved BlueD toward red, dx -10.376). Headless
  Chromium tab focus makes that movement check flaky, so it is not a hard gate.
  A headless blue *gamepad* seat still needs the team server (the public per-IP
  limit blocks a second engine).
- Six-robot identity/team validation should be repeated on the team lead's
  local server; `me`/`is_me` and the `0x06` seat parser are the safety
  mechanisms.
- The engine prefers the render-region **predicted pose** (~48 Hz) and reports
  `pose_source`. It falls back to the ~15 Hz acked copy if the render copy is
  missing. A 10–30 Hz `emit_hz` is enough; velocities use the last changed pose.
- The engine is Node + wasm. A native Wasmtime engine is the Phase 2
  optimization; the JSON/binary API is designed to survive that swap.
- Point at a locally hosted server with `--server <host:port>`; the engine sets
  `location.host`/protocol accordingly.
