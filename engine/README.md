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
--username <NAME>   display name (1-10 ASCII; the engine rejects longer names)
--create            test-only: create a room
--start             test-only: if host, ready and start the match
--spawn <S>         reserved; ignored (infer spawn from first pose)
--server <HOST:PORT> connect to a local server instead of rebuildsim.com
--gamepad           use the virtual gamepad (analog + action buttons)
--fuel <PCT>        test-only host fuel rule (25, 50, 75, 100, 125, 150)
--hopper-capacity <N>  override the robot's hopper capacity (0..65535)
--robot <ID>        select this robot/team id after joining
--binary            framed stdout: JSON + packed fuel records
--field-frame       raw global coordinates (default: alliance-normalized)
--frame-alliance red|blue  diagnostic override for the output frame (r/b accepted)
--hub-order red|blue  force the SHIFT-1 inactive hub (tied AUTO/testing)
--expect-build H    fail fast (exit 3) unless cache/build.json matches H
--no-build-check    skip trusted/live checks (build.json asset hashes still checked)
--allow-public      test-only: permit a non-PRIVATE or missing room_join access
--emit-hz <N>       state rate (1..60, default 10)
--debug             verbose engine logs
--wslog             capture WebSocket frames for dumpws (also on with --debug)
--exit-on-stdin-close  exit when stdin closes (default: keep running)
```

Set `RB_ASSET_DIR` to override `engine/cache/` (useful when testing another
build).

## Output

stdout is JSON lines only:

```json
{"type":"build","build":"b654373","server_build":"b654373","ok":true}
{"type":"ready","build":"b654373","binary":false}
{"type":"protocol","version":1}
{"type":"seats","code":"ABCDE","seats":[
  {"seat":0,"name":"TestBot","team_flag":0,"alliance":"red"}]}
{"type":"room","code":"ABCDE","host":true,"seated":true,"role":"driver",
 "match_active":false,"seats":[...]}
{"type":"match","phase":"countdown","substage":"prematch","time":null,"seats":[...]}
{"type":"score","seq":0,"red":7,"blue":4,"auto_red":3,"auto_blue":2}
{"type":"state","seq":0,"t":...,"phase":"auto","substage":"auto","time":158.0,
 "time_remaining":158.0,"substage_remaining":15.0,
 "red_score":7,"blue_score":4,"auto_red_score":3,"auto_blue_score":2,
 "frame":"alliance","alliance":"red","fuel_count":456,
 "hopper_fuel":8,"hopper_capacity":55,"intake_active":false,
 "hub":{"active":true,"red_active":true,"blue_active":true,
        "red_inactive_first":true,"phase":"auto","source":"auto_score"},
 "me":{"name":"TestBot","is_me":true,"alliance":"red","alliance_source":"room",
       "pose_source":"predicted","x":-4.67,"y":3.4,
       "z":0,"heading":0,"turret_heading":-1.18,"vx":0,"vy":0,"vz":0,"yawRate":0},
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
`{"type":"quit"}`, `{"type":"ping"}`, `{"type":"dump06","path":"/tmp/r.bin"}`,
`{"type":"dumpmem","path":"/tmp/mem.bin"}`.

The engine emits a `heartbeat` about once per second and `ws` events for socket
open/close/error. The close event includes `room: true` when it was the socket
that carried `0x06`. The Rust CLI uses these for timeout/exit handling.

`--binary` frames stdout with a 16-byte `RSB1` header. Kind 2 carries packed
fuel (`present u8, x u16, y u16, z u16`) for the following state; that state has
`fuel_bin: true` and an empty `fuel` array. Packed records carry only
`present/x/y/z`; packet `vx/vy/vz/count/flags` are JSON-mode only. See
`docs/PROTOCOL.md` §1.7.

## Tests

```bash
npm test                 # room06 + hub + matchstate (offline)
cargo build -p rebuildsim-cli
npm run test:cli         # deterministic fake-engine CLI exit codes

RB_ALLOW_LIVE_TESTS=1 npm run test:hopper
RB_ALLOW_LIVE_TESTS=1 npm run test:frame
RB_ALLOW_LIVE_TESTS=1 npm run test:binary
# optional 4-client browser test (installs playwright-core devDependency):
RB_ALLOW_LIVE_TESTS=1 npm run test:multibot
```

Live tests create/join private rooms and skip unless `RB_ALLOW_LIVE_TESTS=1`.
`test:cli` uses inline fake engines, needs no network, and requires a built
`target/debug/rebuildsim-cli` (or `RB_CLI=/path/to/cli`).

`matchstate_test.cjs` checks the pre-clock countdown/end boundary. `room06_test.cjs` parses a synthetic 5-seat packet (seats 0–2 red, seat 3 blue,
seat 4 red) and can optionally check a captured packet via
`RB_ROOM06_FIXTURE`. `frame_test.cjs` forces the blue output frame and
checks that poses/fuel/heading rotate 180 degrees and that forward input reverses
in normalized coordinates. `hopper_test.cjs` starts a 25% match and checks the
hopper goes 8 -> 0 while shooting. `hub_test.cjs` checks the AUTO-winner and
shift-alternation rules plus the tied-AUTO unknown case. `binary_test.cjs`
creates a 25% fuel room and checks the `RSB1` framing, packed 150-fuel frame,
and `fuel_bin` state.

`multibot_browser.mjs` is the optional 4-client identity/control test (engine
host + three browser clients in separate contexts). `playwright-core` is a
devDependency; set `PLAYWRIGHT_CHROMIUM` to an executable if Playwright's
bundled browser is not installed. The headless engine itself does not use
Playwright.

## Known limitations

- Driver input works during **auto** as soon as the match clock starts.
  `phase` is `countdown`/`auto`/`teleop`/`end`; `substage` adds
  `prematch`/`field_reset`/`transition`/`shift1`..`shift4`/`endgame`.
- Robot pose prefers the render-region **predicted copy** (~48 Hz) and falls
  back to the ~15 Hz player copy; `pose_source` says which. `me`/`is_me`
  identify this CLI's robot. Alliance comes from the `0x06` seat team flag
  (`alliance_source: "room"`); the spawn-x heuristic is only a fallback.
- Positions/headings/velocities are **alliance-normalized by default**: blue
  gets the same 180-degree-rotated frame as red, so identical bot logic is the
  intended contract; `alliance` is diagnostic only. `--field-frame` returns raw
  global coordinates. Output rotation is verified; the 4-client browser test
  logs blue keyboard movement as observational evidence (headless tab focus is
  flaky), and a headless blue gamepad seat still needs the team server (public
  per-IP limit).
- Scores come from `0x41` (`+14` red, `+16` blue, `+18`/`+28` auto) and are
  emitted with the state and as `score` events on change.
- `hopper_fuel` is the local robot's hopper count (u32 at name+0x4b).
  `hopper_capacity` is read from the selected robot's definition (359=55,
  4414=110, 2910 V2=50; others 0–115, modded up to 600). `--hopper-capacity <N>`
  is an override/fallback. `intake_active` is bit 6 of name+0x56.
- `heading` is the **chassis** yaw (name+0x23); `turret_heading` is the turret
  yaw (name+0x3f). Turning uses the `rotate` input axis and updates `heading`;
  the game auto-aims the turret.
- `hub.active` is our hub (already alliance-normalized); `hub.red_active` /
  `hub.blue_active` are diagnostics. A tied AUTO is reported as `null` during
  shifts because the FMS picks the order; use `--hub-order red|blue` to force it
  for practice/test matches.
- `--spawn` is deferred; infer the spawn from `me`.
- After a match the engine clicks `BACK TO THE ROOM` on the results screen at
  ~3.5 s, 7.5 s, and 15 s. If the room has not returned at 20 s it emits
  `results_stuck` and exits 6. A human can click earlier; the pending clicks are
  canceled by the room view.
- The CLI is normally a **joiner**: a human spectator hosts, bots join and
  auto-ready, and the human starts the match. The engine checks the 0x06 ready
  byte and only clicks READY if the seat is not ready (rematch), so it never
  toggles a ready seat off. `--create`/`--start` are for testing only.
- Fuel count is dynamic (1..~4300). Positions/presence come from the latest
  `0x42` record for each id; the memory copy is only a pre-first-chunk fallback.
  The game has both a static start-position table and the live simulation array,
  so packet data is authoritative. It does not assume 456.
- One engine = one wasm instance + two WebSocket connections (room list + room).
  For multiple bots, spawn one
  process per bot. The **public server has a per-IP connection limit**; a second
  headless engine from the same IP was closed in testing. Use the local server
  or separate IPs for six-bot runs.
- A dropped **room** WebSocket is fatal for the current match; the engine reports
  it but does not auto-reconnect. Auxiliary room-list/queue sockets close with
  `1006` routinely; they are logged as `ws aux close` and ignored, and the
  driver loop continues. `--wslog` records close entries with `code`, `reason`,
  `wasClean`, and `room`. The Rust CLI exits 5 on state timeout and 6 only on
  the authoritative room-WS close (disable the latter with
  `--allow-ws-close`). In the lobby,
  `--restart-on-exit` can respawn/rejoin the same room code (up to
  `--max-restarts`, default 3); it is disabled after a match starts until a
  fresh lobby/room event arrives.
- Game updates can move memory addresses or change the protocol. `prepare.mjs`
  downloads both assets to temp files, records their SHA-256 hashes, and writes
  `build.json` last. The engine also verifies the tracked
  `engine/trusted_build.json` pin (build + both asset hashes), compares the
  cached `BUILD` with the live page, and exits 3 on any mismatch or fetch
  failure. `prepare.mjs` does not update the trusted pin; update it deliberately
  after verifying a new release, or use `--no-build-check` offline. A new live
  build is refused unless `RB_ALLOW_BUILD_UPDATE=1`; `RB_BUILD=<pin>` restores
  the pinned assets.
  With `--server`, a local server that does not serve the HTML page soft-skips
  the live check (`ok:true, skipped:true`); use `--no-build-check` offline.
  `--no-build-check` is the explicit offline escape hatch. The `0x21` protocol
  version must be 1 (exit 4 otherwise). The fuel-array locator and player-state
  signature still need re-validation after a game update.
