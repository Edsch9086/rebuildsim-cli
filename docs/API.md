# Engine / CLI API

## Rust CLI

```rust
use rebuildsim_cli::engine::{Engine, EngineOptions, Input};
```

The bin crate's modules are available when you depend on `cli/` as a path
dependency; see `cli/src/engine.rs`.

```rust
let mut opts = EngineOptions::new("engine/headless.cjs", "MyBot");
opts.code = Some("URUQM".into());     // or opts.create = true
opts.start = false;                    // host only
opts.emit_hz = 30;
let mut engine = Engine::spawn(&opts)?;

while let Some(state) = engine.next_state()? {
    let me = state.robots.iter().find(|r| r.name == "MyBot");
    // ... compute a command ...
    engine.send_input(&Input { y: 1.0, ..Default::default() })?;
}
```

`GameState`:

```rust
pub struct GameState {
    pub seq: u64,
    pub t: f64,             // unix seconds
    pub phase: String,      // "auto" | "teleop" | "end" | "match"
    pub time: Option<f64>,  // match clock from 0x41
    pub robots: Vec<Robot>,
    pub fuel: Vec<Fuel>,
}
```

`Robot` has `name, x, y, z, heading, vx, vy, vz, yaw_rate`.
`Fuel` has `id, x, y, z, present`.

`Input` has `x, y, rotate, intake, outtake, shoot`. Phase 1 maps the axes to
keyboard keys (digital); Phase 2 will map them to a virtual gamepad for true
analog control.

## Engine JSON lines (stdio)

Engine → CLI:

```json
{"type":"ready","build":"4a8a0e8"}
{"type":"room","code":"URUQM","host":true,"seated":true,"role":"driver"}
{"type":"match","phase":"auto","time":null}
{"type":"state","seq":42,"t":1794772715.59,"phase":"teleop","time":142.8,
 "robots":[{"name":"MyBot","x":-4.67,"y":3.40,"z":0.0,"heading":-1.18,
            "vx":0.0,"vy":0.0,"vz":0.0,"yawRate":0.0}],
 "fuel":[{"id":0,"x":-0.366,"y":-1.0466,"z":0.0748,"present":true}]}
```

CLI → engine:

```json
{"type":"input","x":0.0,"y":1.0,"rotate":0.0,"intake":false,"shoot":false}
{"type":"ready"}
{"type":"start"}
{"type":"leave"}
{"type":"quit"}
{"type":"ping"}
```

## Known limitations

- `--spawnpoint` is not wired yet; the engine joins with the default seat.
- Robot pose is the player-state copy found in wasm memory. It can lag the
  local predicted pose by network keyframes; see `docs/SURVEY.md` §4.2.
- Axis mapping is digital (WASD/JL). Use the input packet directly only if you
  also keep the local sim in sync; otherwise implement a virtual gamepad.
- The engine is Node + wasm. A native Wasmtime engine is the Phase 2
  optimization; the JSON API is designed to survive that swap.
