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

Create and start a private room:

```bash
node headless.cjs --create --start --username TestBot --emit-hz 10
```

Join by code:

```bash
node headless.cjs --code <LOBBY> --username TestBot
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
--emit-hz <N>       state rate (1..60, default 10)
--debug             verbose engine logs
```

Set `RB_ASSET_DIR` to override `engine/cache/` (useful when testing another
build).

## Output

stdout is JSON lines only:

```json
{"type":"ready","build":"4a8a0e8"}
{"type":"room","code":"ABCDE","host":true,"seated":true,"role":"driver"}
{"type":"match","phase":"auto","time":null}
{"type":"state","seq":0,"t":...,"phase":"auto","time":158.0,
 "fuel_count":456,
 "me":{"name":"TestBot","is_me":true,"alliance":"red","x":-4.67,"y":3.4,
       "z":0,"heading":-1.18,"vx":0,"vy":0,"vz":0,"yawRate":0},
 "robots":[{"name":"TestBot","is_me":true,"alliance":"red","x":-4.67,"y":3.4,
            "z":0,"heading":-1.18,"vx":0,"vy":0,"vz":0,"yawRate":0}],
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
`{"type":"quit"}`, `{"type":"ping"}`.

## Known limitations

- Driver input works during **auto**; only the 3-second countdown is
  non-interactive. `phase` is `countdown`/`auto`/`teleop`/`end`.
- Robot pose is the live player-state copy in wasm memory; `me`/`is_me` identify
  this CLI's robot. Alliance is a spawn-x heuristic for now.
- `--spawn` is deferred; infer the spawn from `me`.
- Fuel count is dynamic (1..~4300). The engine locates the memory array by
  matching recent `0x42` packet records; it does not assume 456.
- One engine = one wasm instance + one WebSocket. For multiple bots, spawn one
  process per bot and respect the server's per-IP connection limit.
- Game updates can move memory addresses or change the protocol. `prepare.mjs`
  fetches the latest build; the fuel-array locator and player-state signature are
  heuristic and must be re-validated after a game update.
