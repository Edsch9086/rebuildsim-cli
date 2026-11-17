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
    // state.scores, state.substage, state.time ...
    engine.send_input(&Input { y: 1.0, ..Default::default() })?;
}
```

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
| `fuel.flags` | raw packet bitfield; `0` normal, `7` observed for a hub cluster |
| `red_score`, `blue_score`, `auto_*` | game points as displayed on the HUD (integer) |
| `Input.x` | left stick X, normalized `-1.0..1.0` (right positive) |
| `Input.y` | left stick Y, normalized `-1.0..1.0` (forward positive) |
| `Input.rotate` | right stick X, normalized `-1.0..1.0` |
| `Input.intake/outtake/shoot` | boolean triggers |
| `emit_hz` | states per second |
| `protocol` | server protocol version integer (`1` currently) |
| `team_flag` | seat team enum: `0` red, `1` blue |
| `seat` | zero-based room seat index |

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
    pub substage: String,     // "auto" | "field_reset" | "transition" |
                              // "shift1".."shift4" | "endgame" | "end"
    pub time: Option<f64>,    // match clock from 0x41 (163.0 -> 0.0)
    pub time_remaining: Option<f64>,      // same value, explicit name
    pub substage_remaining: Option<f64>,  // seconds until the next boundary
    pub red_score: u16,
    pub blue_score: u16,
    pub auto_red_score: u16,  // frozen at the end of auto
    pub auto_blue_score: u16,
    pub protocol: Option<u8>,
    pub frame: String,        // "alliance" (default) | "field"
    pub alliance: String,     // diagnostic only; bots should not need it
    pub me: Option<Robot>,    // the robot owned by this CLI instance
    pub robots: Vec<Robot>,
    pub fuel: Vec<Fuel>,
    pub fuel_count: Option<u16>, // total fuel for this match (1..~4300)
    pub fuel_bin: bool,          // fuel arrived on the binary channel
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
    pub pose_source: String,  // "predicted" (render copy, ~48 Hz) | "acked"
    pub hopper_fuel: Option<u16>, // that robot's hopper fuel, if readable
}
```

`hopper_fuel` is the local robot's held fuel, read from the player struct at
name+0x4b. It starts at 8 in the default build (HUD `FUEL 8/55`) and decrements
while shooting. The hopper **capacity** (55) is a HUD constant in this build and
is not exposed yet. Remote robots may report their hopper too, but the local
robot's value is the reliable one.

`Fuel`: `id, x, y, z, present`, plus optional `vx, vy, vz, count, flags` merged
from the server packet. The array length is `fuel_count`, not a fixed 456.

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
username in the live player state; alliance comes from the `0x06` seat record.
In a six-robot lobby, always read `me` rather than indexing `robots[0]` or
guessing by team.

With the default `frame == "alliance"`, the engine has already rotated
positions/headings/velocities into your driver frame. Just plan in the reported
coordinates:

```rust
let dx = target_x - me.x;
let dy = target_y - me.y;
engine.send_input(&Input { x: strafe, y: forward, ..Default::default() })?;
```

`Robot::field_to_driver()` and `alliance_heading()` exist for
`--field-frame`/raw-global consumers only; do not call them in alliance frame.
The 4-player seat test showed seat 4 as blue (`team=1`), so a fourth bot in a
fresh room is blue without moving. In a 3v3, the first three joiners are red and
the next three blue.

## Engine JSON lines (stdio, default)

Engine → CLI:

```json
{"type":"ready","build":"4a8a0e8","binary":false}
{"type":"build","build":"4a8a0e8","server_build":"4a8a0e8","ok":true}
{"type":"protocol","version":1}
{"type":"seats","code":"ABCDE","seats":[
  {"seat":0,"name":"MyBot","team_flag":0,"alliance":"red"}]}
{"type":"room","code":"ABCDE","host":true,"seated":true,"role":"driver","seats":[...]}
{"type":"match","phase":"auto","substage":"auto","time":163.0,"seats":[...]}
{"type":"score","seq":42,"red":7,"blue":4,"auto_red":3,"auto_blue":2}
{"type":"state","seq":42,"t":1794772715.59,"phase":"auto","substage":"auto",
 "time":158.8,"time_remaining":158.8,"substage_remaining":15.8,
 "red_score":7,"blue_score":4,"auto_red_score":3,"auto_blue_score":2,
 "scores":{"red":7,"blue":4},"protocol":1,"fuel_count":456,
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
the decoded array. See `docs/PROTOCOL.md` §1.7 for the byte layout. Use
`EngineOptions.binary = false` to get plain JSON lines.

## Build pinning

`engine/prepare.mjs` writes `cache/build.json` with the downloaded `BUILD` hash.
At startup the engine fetches the page and compares the live `BUILD`:

- mismatch → emits `{"type":"error","error":"build_drift",...}` and exits `3`;
- `--expect-build <hash>` checks the cached assets before connecting and exits
  `3` on mismatch;
- `--no-build-check` skips the live fetch (offline/local debugging).

The `0x21` protocol hello must report version `1`; a mismatch is a hard error
(`exit 4`).

## Known limitations / next work

- `--spawnpoint` is deferred. The engine joins with the default seat and logs
  that the flag is ignored; a tuned bot can infer its spawn from `me`.
- Blue control-frame inversion is implemented and the 4th seat is confirmed
  blue, but a blue drive-direction assertion needs a 4-client lobby (the public
  per-IP limit blocks repeated 4-client runs).
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
