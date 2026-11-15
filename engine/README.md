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
--spawn <S>         reserved; not implemented yet
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
{"type":"state","seq":0,"t":...,"phase":"auto","time":163.0,
 "robots":[{"name":"TestBot","x":-4.67,"y":3.4,"z":0,"heading":-1.18,
            "vx":0,"vy":0,"vz":0,"yawRate":0}],
 "fuel":[{"id":0,"x":-0.366,"y":-1.0466,"z":0.0748,"present":true}]}
```

stderr is debug/status output.

## Input

Send JSON lines on stdin:

```json
{"type":"input","x":0,"y":1,"rotate":0,"intake":false,"outtake":false,"shoot":false}
```

Axes are Phase 1 digital mappings:

- `y` > 0 → W, `y` < 0 → S
- `x` > 0 → D, `x` < 0 → A
- `rotate` > 0 → L, `rotate` < 0 → J
- `intake` → LShift, `outtake` → K, `shoot` → Space

Phase 2 should replace this with a virtual gamepad for true analog axes.

Other commands: `{"type":"ready"}`, `{"type":"start"}`, `{"type":"leave"}`,
`{"type":"quit"}`, `{"type":"ping"}`.

## Known limitations

- Driver input is ignored during auto. Wait for `phase:"teleop"`.
- Robot pose is the player-state copy found in wasm memory. It may lag the
  local predicted pose by server keyframes; see `docs/SURVEY.md` §4.2.
- `--spawn` is not implemented.
- One engine = one wasm instance + one WebSocket. For multiple bots, spawn one
  process per bot and respect the server's per-IP connection limit.
- Game updates can move memory addresses or change the protocol. `prepare.mjs`
  fetches the latest build; the fuel-array scan and player-state signature are
  heuristic and must be re-validated after a game update.
