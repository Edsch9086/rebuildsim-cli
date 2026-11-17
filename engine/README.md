# Headless engine

Runs the real REBUILD Simulator `index.js` + `index.wasm` in Node with:

- a fake DOM and a no-op WebGL2 context (no browser, no GPU, no Playwright),
- the real WebSocket netcode and lobby flow,
- wasm memory scanning for fuel and robot state,
- a JSON-lines API on stdin/stdout.

Requires **Node 22+** (global `fetch` and `WebSocket`; tested on Node 26).

## Prepare

```bash
cd engine
node prepare.mjs
```

This reads the current build hash from `https://rebuildsim.com/` and downloads
the matching `index.js` / `index.wasm` into `engine/cache/`. The game assets are
not committed to this repo.

## Run

Normal operation is **join-only**: a human spectator hosts the private room,
bots join and ready themselves, and the human starts the match.

```bash
node headless.cjs --code <LOBBY> --username TestBot --emit-hz 10
```

For local testing you can create/start a room from the engine:

```bash
node headless.cjs --create --start --username TestBot --emit-hz 10
```

Flags:

```
--code <CODE>       join a room
--username <NAME>   display name
--create            create a room
--start             if host, ready and start the match
--spawn <S>         reserved; ignored (infer spawn from first pose)
--server <HOST:PORT> connect to a local server instead of rebuildsim.com
--gamepad           use the virtual gamepad (analog + action buttons)
--fuel <PCT>        host only: set fuel count rule (25/50/75/100/125/150/...)
--binary            framed stdout: JSON + packed fuel records
--field-frame       raw global coordinates (default: alliance-normalized)
--frame-alliance R|B  diagnostic override for the output frame (testing)
--expect-build H    fail fast (exit 3) unless cache/build.json matches H
--no-build-check    skip the live BUILD fetch (offline debugging)
--emit-hz <N>       state rate (1..60, default 10)
--debug             verbose engine logs
```

Set `RB_ASSET_DIR` to override `engine/cache/` (useful when testing another
build).

## Output

stdout is JSON lines only:

```json
{"type":"ready","build":"4a8a0e8","binary":false}
{"type":"build","build":"4a8a0e8","server_build":"4a8a0e8","ok":true}
{"type":"protocol","version":1}
{"type":"seats","code":"ABCDE","seats":[
  {"seat":0,"name":"TestBot","team_flag":0,"alliance":"red"}]}
{"type":"room","code":"ABCDE","host":true,"seated":true,"role":"driver","seats":[...]}
{"type":"match","phase":"auto","substage":"auto","time":163.0,"seats":[...]}
{"type":"score","seq":0,"red":7,"blue":4,"auto_red":3,"auto_blue":2}
{"type":"state","seq":0,"t":...,"phase":"auto","substage":"auto","time":158.0,
 "time_remaining":158.0,"substage_remaining":15.0,
 "red_score":7,"blue_score":4,"auto_red_score":3,"auto_blue_score":2,
 "frame":"alliance","alliance":"red","fuel_count":456,
 "hopper_fuel":8,
 "hub":{"active":true,"red_active":true,"blue_active":true,
        "red_inactive_first":null,"phase":"auto","source":"tie"},
 "me":{"name":"TestBot","is_me":true,"alliance":"red","alliance_source":"room",
       "pose_source":"predicted","x":-4.67,"y":3.4,
       "z":0,"heading":-1.18,"vx":0,"vy":0,"vz":0,"yawRate":0},
 "robots":[...],
 "fuel":[{"id":0,"x":-0.366,"y":-1.0466,"z":0.0748,"present":true}]}
```

stderr is debug/status output.

## Input

Send JSON lines on stdin:

```json
{"type":"input","x":0,"y":1,"rotate":0,"intake":false,"outtake":false,"shoot":false}
```

With `--gamepad` (the default in the Rust CLI):

- `x` → left stick X
- `y` → left stick Y (forward; sent as `-y`)
- `rotate` → right stick X
- `intake` → LT, `outtake` → LB, `shoot` → RT

The action bits are in the last byte of the `0x40` packet: intake `0x35`, shoot
`0x36`, outtake `0x3c` (neutral `0x34`). Shooting is a trigger; the game
auto-aims turreted robots and auto-turns dumper robots.

Use `--keyboard` (CLI) or omit `--gamepad` (engine) for digital WASD/JL +
LShift/K/Space controls.

Other commands: `{"type":"ready"}`, `{"type":"start"}`, `{"type":"leave"}`,
`{"type":"quit"}`, `{"type":"ping"}`, `{"type":"dump06","path":"/tmp/r.bin"}`.

`--binary` frames stdout with a 16-byte `RSB1` header. Kind 2 carries packed
fuel (`present u8, x u16, y u16, z u16`) for the following state; that state has
`fuel_bin: true` and an empty `fuel` array. See `docs/PROTOCOL.md` §1.7.

## Tests

```bash
node room06_test.cjs
node frame_test.cjs
node hopper_test.cjs
node hub_test.cjs
RB_ASSET_DIR=engine/cache node binary_test.cjs
```

`room06_test.cjs` parses a synthetic 4-seat packet and the captured live packet
(seats 0–2 red, seat 3 blue). `frame_test.cjs` forces the blue output frame and
checks that poses/fuel/heading rotate 180 degrees and that forward input reverses
in normalized coordinates. `hopper_test.cjs` starts a 25% match and checks the
hopper goes 8 -> 0 while shooting. `hub_test.cjs` checks the AUTO-winner and
shift-alternation rules plus the tied-AUTO unknown case. `binary_test.cjs`
creates a 25% fuel room and checks the `RSB1` framing, packed 150-fuel frame,
and `fuel_bin` state.

`multibot_browser.mjs` is the optional 4-client identity/control test (engine
host + three browser clients in separate contexts). It needs `playwright-core`
and a Chromium binary; see the header comment.

## Known limitations

- Driver input works during **auto** as soon as the match clock starts.
  `phase` is `countdown`/`auto`/`teleop`/`end`; `substage` adds
  `field_reset`/`transition`/`shift1`..`shift4`/`endgame`.
- Robot pose prefers the render-region **predicted copy** (~48 Hz) and falls
  back to the ~15 Hz player copy; `pose_source` says which. `me`/`is_me`
  identify this CLI's robot. Alliance comes from the `0x06` seat team flag
  (`alliance_source: "room"`); the spawn-x heuristic is only a fallback.
- Positions/headings/velocities are **alliance-normalized by default**: blue
  gets the same 180-degree-rotated frame as red, so identical bot logic works
  on both sides and `alliance` is diagnostic only. `--field-frame` returns raw
  global coordinates.
- Scores come from `0x41` (`+14` red, `+16` blue, `+18`/`+28` auto) and are
  emitted with the state and as `score` events on change.
- `hopper_fuel` is the local robot's hopper count (u32 at name+0x4b). It starts
  at 8 in the default build; the 55 capacity is not decoded yet.
- `hub.active` is our hub (already alliance-normalized); `hub.red_active` /
  `hub.blue_active` are diagnostics. A tied AUTO is reported as `null` during
  shifts because the FMS picks the order.
- `--spawn` is deferred; infer the spawn from `me`.
- The CLI is normally a **joiner**: a human spectator hosts, bots join and
  auto-ready, and the human starts the match. `--create`/`--start` are for
  testing only.
- Fuel count is dynamic (1..~4300). The engine locates the memory array by
  matching recent `0x42` packet records; it does not assume 456.
- One engine = one wasm instance + one WebSocket. For multiple bots, spawn one
  process per bot. The **public server has a per-IP connection limit**; a second
  headless engine from the same IP was closed in testing. Use the local server
  or separate IPs for six-bot runs.
- Game updates can move memory addresses or change the protocol. `prepare.mjs`
  fetches the latest build and writes `build.json`; the engine compares it with
  the live page `BUILD` and exits 3 on drift. `--expect-build` checks before
  connecting. The `0x21` protocol version must be 1 (exit 4 otherwise). The
  fuel-array locator and player-state signature still need re-validation after
  a game update.
