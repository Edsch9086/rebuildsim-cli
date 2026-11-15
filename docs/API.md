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
let mut engine = Engine::spawn(&opts)?;

while let Some(state) = engine.next_state()? {
    let me = state.me.as_ref().expect("our robot");
    // ... compute a command in the driver frame ...
    engine.send_input(&Input { y: 1.0, ..Default::default() })?;
}
```

`GameState`:

```rust
pub struct GameState {
    pub seq: u64,
    pub t: f64,               // unix seconds
    pub phase: String,        // "countdown" | "auto" | "teleop" | "end" | "match"
    pub time: Option<f64>,    // match clock from 0x41
    pub me: Option<Robot>,    // the robot owned by this CLI instance
    pub robots: Vec<Robot>,
    pub fuel: Vec<Fuel>,
    pub fuel_count: Option<u16>, // total fuel for this match (1..~4300)
}
```

`Robot`:

```rust
pub struct Robot {
    pub name: String,
    pub is_me: bool,
    pub alliance: String,     // "red" | "blue" (spawn-x heuristic)
    pub x: f32, pub y: f32, pub z: f32,
    pub heading: f32,         // radians
    pub vx: f32, pub vy: f32, pub vz: f32,
    pub yaw_rate: f32,
}
```

`Fuel`: `id, x, y, z, present`, plus optional `vx, vy, vz, count, flags` merged
from the server packet. The array length is `fuel_count`, not a fixed 456.

`Input`: `x, y, rotate, intake, outtake, shoot`. With the virtual gamepad:

- `x` left stick X (strafe/right)
- `y` left stick Y (forward; the engine sends `-y`)
- `rotate` right stick X (turn)
- `intake` LT, `outtake` LB, `shoot` RT

`shoot` is a trigger. The game auto-aims turreted robots and auto-turns dumper
robots; do not synthesize an aim angle. Driver input works during **auto**; only
the 3-second countdown is non-interactive. Use `phase` if you want to wait for
auto/teleop.

### Identity and alliance

`state.me` and `Robot.is_me` are authoritative: they come from matching the
CLI username against the live player state in wasm memory. In a six-robot lobby,
always read `me` rather than indexing `robots[0]` or guessing by team.

`alliance` is currently a first-sight spawn-x heuristic (`x<0` red, `x>0` blue).
Global poses are field coordinates. The driver input axes are in the driver
control frame; the game handles the red/blue side. A bot that plans in global
coordinates must use `alliance` when converting. The room state (`0x06`)
contains the real seat/alliance assignment; decoding it is a TODO.

## Engine JSON lines (stdio)

Engine → CLI:

```json
{"type":"ready","build":"4a8a0e8"}
{"type":"room","code":"ABCDE","host":true,"seated":true,"role":"driver"}
{"type":"match","phase":"countdown","time":null}
{"type":"state","seq":42,"t":1794772715.59,"phase":"auto","time":158.8,
 "fuel_count":456,
 "me":{"name":"MyBot","is_me":true,"alliance":"red","x":-4.67,"y":3.40,
       "z":0.0,"heading":-1.18,"vx":0.0,"vy":0.0,"vz":0.0,"yawRate":0.0},
 "robots":[{"name":"MyBot","is_me":true,"alliance":"red","x":-4.67,"y":3.40,
            "z":0.0,"heading":-1.18,"vx":0.0,"vy":0.0,"vz":0.0,"yawRate":0.0}],
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
```

The raw `pad` command is for diagnostics; normal bot code should use `input`.

## Known limitations / next work

- `--spawnpoint` is deferred. The engine joins with the default seat and logs
  that the flag is ignored; a tuned bot can infer its spawn from `me`.
- `alliance` is a heuristic until `0x06` seat decoding is finished.
- Six-robot identity/team validation is the next milestone; `me`/`is_me` is the
  primary safety mechanism.
- Robot velocities are finite differences of the live pose. They are smooth at
  10–30 Hz; use a higher `emit_hz` if you need finer resolution.
- The engine is Node + wasm. A native Wasmtime engine is the Phase 2
  optimization; the JSON API is designed to survive that swap.
- Point at a locally hosted server with `--server <host:port>`; the engine sets
  `location.host`/protocol accordingly.
