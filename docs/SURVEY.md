# REBUILD Simulator — technical survey

Surveyed build: `4a8a0e8` (title bar says v4a8a0e8), November 2026.
Assets served from `https://rebuildsim.com/`: `index.html`, `guard.js`, `index.js`
(250 KB Emscripten glue), `index.wasm` (2.45 MB).

## 1. What the game is

- C++ / raylib **6.0**, compiled to WebAssembly with Emscripten.
- Rendering is WebGL2 through Emscripten's GLFW/raylib backend.
- Most assets (fonts, field, robot models, textures) are embedded in the wasm/data
  section. The page makes almost no asset requests after load.
- The game is multiplayer-first. The server is at `wss://rebuildsim.com/ws`.
  `location.host` is read inside the wasm (Emscripten import) to build the URL.
- The client is a normal browser client: no account needed for multiplayer.
  The game includes sign-in/accounts, events, leaderboards, replays, and voice
  links, but none of those are required to join a room.

## 2. What the server actually sends

The binary protocol is custom, not JSON. Packet types observed:

| Type | Dir | Size | Meaning |
| --- | --- | --- | --- |
| `0x01` | C→S | 67 | hello: `DUBR` + build hash + flags |
| `0x02` | S→C | 6 | client/connection id |
| `0x21` | S→C | 5 | protocol version |
| `0x31` | C→S | 3 | ack |
| `0x32` | S→C | 312–611 | room list (chunked) |
| `0x10` | C→S | 25 | set display name (24-byte field) |
| `0x06` | S→C | 308 | room state: code, host, seats, names, teams, robots, spawns |
| `0x13` | S→C | 90–175 | room info / join result |
| `0x07` | C→S | 14 | seat/robot/spawn selection (join) |
| `0x40` | C→S | 12 | input frame (see below) |
| `0x41` | S→C | 154–340 | match/room state, match clock, settings |
| `0x42` | S→C | 1161 | **fuel state** snapshot, 48 records/chunk |
| `0x48` | S→C | 30 | per-player status + 8-byte hash |
| `0x4b` | S→C | 8/19 | input/ack/event |
| `0x43` | S→C | 9 | tick/ack |
| `0x44` | C→S | 7 | ping |
| `0x45` | S→C | 5 | ping echo |

Important conclusion: **the server does not send robot poses.** `0x41` is
match/room state/settings. `0x42` is fuel. `0x48` is status/hashes. `0x4b` is
input/ack. Clients run the same deterministic simulation and exchange inputs.
Robot poses therefore have to come from the client simulation.

`0x42` fuel layout (verified against wasm memory):

```
u8   0x42
u32  tick
u16  456            // total fuel count
u16  48             // records in this packet
48 × {
  u16 id            // 0..455, 1:1 with memory array index
  u16 count         // usually 1; >1 for a cluster
  u32 0x00010000
  u32 flags         // 0 normal; 7 seen for a hub cluster
  u16 x, y, z       // fixed point: (v - 0x8000) / 4096 metres
  u16 vx, vy, vz    // same fixed point; 0x8000 = zero
}
```

Positions are field-centred metres. `z` in the packet is the fuel centre
(~0.075 m). The memory copy stores the bottom (~0.030 m), a ~0.045 m offset
(fuel radius).

## 3. Can it run headless? Yes.

We ran the real `index.js` + `index.wasm` in Node with:

- a fake DOM (`document`, `canvas`, `localStorage`, `navigator`, `location`),
- a no-op WebGL2 context (Proxy with plausible `getParameter` results and
  stub `create*`/`get*` methods),
- Node's global `WebSocket` and `fetch`,
- a 60 Hz `requestAnimationFrame` driver.

Result: the game boots, reaches the title screen, connects to the live server,
creates/joins rooms, starts matches, and simulates at ~59 fps. No Chromium,
no Playwright, no GPU, no WebGL pixels.

Measured on this machine (Node 26, 1280×720 canvas, no-op GL, one match):

- user CPU: **3.83 s over 20 s** ≈ 19% of one core;
- max RSS: **~180 MB** (26 MB wasm linear memory + V8/Node overhead);
- 456 fuel + player state + match packets at 60 fps.

The game's anti-automation checks (`rb_automation_signs`) look at
`navigator.webdriver`, headless UA/brands, and a software WebGL renderer. The
Node harness reports none of those. The browser-side `guard.js` (native
WebAssembly checks + devtools debugger interval) is not present in the Node
harness. This is a technical bypass of the browser guard; see ethics section.

## 4. State extraction

### 4.1 Fuel — solved, dynamic length

The server's `0x42` packet and the wasm memory both use **1-based IDs** for fuel.
The total count is `u16` at packet offset 5; it is **not fixed**. The public
update notes say the staged-fuel rule ranges from ~25% (~135 fuel) to as much as
the field can hold (~4,300 fuel). The engine must therefore never assume 456.

Server packet (`0x42`, 1161 bytes at 48 records/chunk):

```
u8   0x42
u32  tick
u16  total fuel count
u16  records in this chunk (48)
48 × 24 bytes:
  u16 id
  u16 count        // 1, or >1 for a cluster
  u32 0x00010000
  u32 flags        // 0 normal; 7 seen for a hub cluster
  u16 x, y, z      // fixed point: (v - 0x8000) / 4096 m
  u16 vx, vy, vz   // 0x8000 = zero
```

The server cycles through all IDs in 48-record chunks. The wasm memory contains
a parallel `total × 7-byte` array:

```
u8  present
u16 x
u16 y
u16 z              // bottom; add ~0.045 m for the centre
```

The engine locates the array by taking a recent packet record, searching memory
for its `x,y` pair, deriving `base = hit - 1 - id*7`, and verifying several
packet records against that base. This survives both a changing fuel count and
heap reallocation. Validated: a 25% rule produced **150 fuel**, a 50% rule 255, and the default
build 456; the locator found a new base each time (`fuel_count` matched). If fewer than four records are available it falls back to a
run scan for `count <= 2048`. The engine emits `fuel_count` and all `count`
records (with `present`), and merges the packet's velocities/flags when available.
For 4,000+ fuel the JSON state is large, so the engine has an opt-in
`--binary` framing: packed 7-byte fuel records (plus a `RSB1` header) immediately
before the JSON state, and the Rust `Engine` reattaches them. JSON mode remains
available; `fuel_count` and all records are identical in both.

### 4.2 Robot poses — live local simulation

The server does **not** send robot poses. Each client runs the deterministic
simulation. We read the local player state out of wasm memory:

```
name field (32 bytes, zero-padded)
+0x1b  f32 x
+0x1f  f32 y
+0x23  f32 z (chassis)
+0x27  f32 small derived value
+0x2b  f32 small derived value
+0x2f  f32 small derived value
+0x3f  f32 heading (radians)
+0x57  f32 1.0 (live-copy signature)
```

There are two useful copies:

- **Player/acked copy** at `0x1f5c45` (pose `0x1f5c60`). This is what the room/
  network side uses; it updates at **~15 Hz**. At a 30 Hz state rate consecutive
  frames can be identical.
- **Predicted/render copy** at `0x512a49` (pose `0x512a64`), in the render/model
  heap region. Same field layout and `1.0` signature, but it updates at
  **~48 Hz**. Example: during a 3 s 60 Hz trace, the predicted x changed on 145
  of 179 frames while the acked copy changed at 15 Hz; the final predicted x was
  `4.3866` vs `4.3865` for the acked copy. This is what the renderer uses.

The engine scans all valid name/pose candidates for each robot and prefers the
render-region copy (`0x500000..0x530000`, highest address); it reports
`pose_source: "predicted"` or `"acked"` on every robot and falls back to the
acked copy if the render copy is missing. Velocities are computed from the last
changed predicted pose; a 10–30 Hz state rate is plenty. A direct velocity field
may exist at +0x27/+0x2b/+0x2f, but finite differences are already smooth.

Earlier confusion about a lagging pose came from sending driver input during
the 3-second pre-match countdown, not from the acked copy. Once the countdown
ends both copies are live; the predicted one is simply higher-rate.

The engine emits a top-level `me` object and an `is_me` flag on every robot,
matched by the CLI username. This avoids the six-robot "which one is mine"
failure mode. A `stale` fallback keeps `me` present if a memory read misses one
frame.

Alliance is decoded from the `0x06` room state. Player records appear in seat
order with the signature `01 <team> 67 01 02 00 00 <name-len> <name...>`;
`<team>` is 0 for red and 1 for blue. A fresh 4-player capture had seats 0–2 red
and seat 3 blue, and the fourth browser client rendered as the blue "YOU" robot.
`engine/room06.cjs` parses this, the engine sets `alliance_source: "room"`, and
the first-sight spawn-x heuristic remains only as a fallback when no `0x06` has
arrived. `is_me` is exact by username. Coordinates are global field
coordinates. The driver input axes are in the driver's control frame (the game
handles the red/blue side); a bot planning in global coordinates must use
`alliance` when converting. This is called out in `docs/API.md`.

Robot linear/angular velocities are finite differences of the predicted pose
(~48 Hz). A 10–30 Hz state rate is enough; velocities are held across unchanged
frames so a stationary robot reports zero instead of noise.

### 4.3 Match/room state

`0x41` carries the match clock at float offset 10. Full-match HUD captures
established the structure (clock 163.0 → 0.0):

| Clock | HUD label | Duration |
| --- | --- | --- |
| 163 → 143 | AUTO | 20 s |
| 143 → 140 | FIELD RESET | 3 s |
| 140 → 130 | TRANSITION | 10 s |
| 130 → 105 | SHIFT 1 | 25 s |
| 105 → 80 | SHIFT 2 | 25 s |
| 80 → 55 | SHIFT 3 | 25 s |
| 55 → 30 | SHIFT 4 | 25 s |
| 30 → 0 | ENDGAME | 30 s |

Driver input is live as soon as the match clock starts (163.0) and stays live
through auto and teleop; the 3-second pre-match countdown happens before
`match_start`/the clock. Field reset (143→140) is a 3-second reset window. The
engine reports `phase` (countdown/auto/teleop/end) and the detailed `substage`.

Scores are u16 fields in `0x41`: red total at `+14`, blue total at `+16`, red
auto at `+18`, blue auto at `+28`. This was verified against the HUD in the same
full-match capture (e.g. HUD RED 5/BLUE 3 with `+14=5,+16=3`; the auto fields
froze at 5/3 while teleop scores continued to 6/5). The engine emits
`red_score`/`blue_score`, `auto_red_score`/`auto_blue_score`, a `score` event on
change, and `substage_remaining`.

`0x06` carries room code, host, seat records, names, team flags, robot ids, and
spawn selections. `rbTrack` events (`page_view`, `match_start`, `room_join`) are
a convenient blind-UI feedback channel while automating the menu.

## 5. Control

### 5.1 Input packet — decoded

`0x40` is 12 bytes:

```
u8  0x40
u16 tick
u16 reserved (observed 0)
i16 axis1          // left stick X / strafe
i16 axis2          // left stick Y / forward (0x8000 neutral)
i16 axis3          // right stick X / turn
u8  actions        // action bitfield
```

The **last byte** is the action bitfield, not a checksum and not bytes 3–4.
Observed values:

| Action | Bit | Neutral→active | Source |
| --- | --- | --- | --- |
| intake | 0 | `0x34 → 0x35` | LT / L trigger |
| shoot | 1 | `0x34 → 0x36` | RT / R trigger |
| outtake | 3 | `0x34 → 0x3c` | LB or RB / bumper |

`0x34` is the in-match neutral value; the low nibble contains the action bits and
bit 2/base bits are game flags (the value is `0x30` during the initial countdown).
Pressing A/B/X/Y does not change the packet. The virtual gamepad maps:

```
axes[0] = x (left stick X)
axes[1] = -y (left stick Y; -1 is forward)
axes[2] = rotate (right stick X)
axes[3] = 0
buttons[6] = intake (LT)
buttons[7] = shoot (RT)
buttons[4] = outtake (LB)
axes[4]/[5] are also set for LT/RT for backends that read trigger axes
```

The engine calls `refreshPad()` after changing buttons so raylib's cached gamepad
state sees them; axes are sampled live. Verified in teleop: holding shoot gives
a stream of `... 36` packets, intake `... 35`, outtake `... 3c`, and releasing
returns to `... 34`.

Shooting is a **trigger, not an aim vector**. Turreted robots aim themselves from
almost anywhere in their alliance zone; dumper-style robots turn toward the hub
automatically when shoot is held. The bot only needs `shoot: true` (and the game
handles the aim/turn). Do not try to synthesize a turret angle unless the game
exposes one.

For a native client, the packet above can be sent directly, but then the local
wasm simulation is out of sync. The supported path is the virtual gamepad.

### 5.2 UI automation

The headless engine drives the game with synthetic DOM events:

- `Space` dismisses the title.
- `MULTIPLAYER` opens the name/room list.
- The room code input is text box index 1; the name is box 0.
- Use `rb_tap_text_box(index, x, y)` + `rb_type_text(str)` for game text fields.
- `CREATE A ROOM`, `JOIN`, `READY`, `START MATCH` are normal clicks.
- The host's start flow may show "N players are not ready" → `START ANYWAY` or
  have the bot click `READY` first.
- Joining a room whose match is already running puts you in as a **spectator**
  (`via: joined_running`); join before start to drive.

The 1280×720 UI coordinates are in `docs/PROTOCOL.md`; the game lays out
differently at 1280×800. Use 720p for the headless engine.

## 6. Spawnpoint / robot selection — deferred

Spawnpoint selection is intentionally **dropped for now**. A tuned system can
read its first pose at spawn and infer where it is; the room UI/`0x07` packet
capture can be revisited later. The CLI still accepts `--spawnpoint` but the
engine logs that it is ignored and joins with the default seat.

The room UI has a robot dropdown (e.g. team 359), `SWITCH ROBOTS`, and a field
map where the host can place robots. The join packet `0x07` carries the
seat/robot/spawn token; the room state `0x06` echoes it. When spawn selection is
needed, capture the field-map drag and the `0x07` fields; it is low risk but not
finished.

## 7. Performance and architecture

### Option A — Rust CLI + headless wasm engine sidecar (recommended)

```
┌──────────────┐   JSON/binary over stdio or UDS   ┌──────────────────────────┐
│ Rust CLI     │ <───────────────────────────────> │ Node + index.js + wasm   │
│ bot logic    │   state @ 30–60 Hz / input cmds   │ no-op GL, real netcode   │
└──────────────┘                                   └──────────────────────────┘
```

- Reuses the exact game build and physics; no protocol/physics reimplementation.
- Automatically matches the server's build/protocol version.
- Headless, no browser, no Playwright, no GPU.
- Cost: ~19% of a core, ~180 MB RSS per bot on Node 26.
- Rust remains the performance-critical control plane; the engine can be swapped
  for a native Wasmtime implementation later without changing the bot API.

### Option B — Rust-native Wasmtime engine

Embed `index.wasm` with Wasmtime and reimplement the ~507 Emscripten imports
(mostly GL no-ops, plus WebSocket/TLS, clock, filesystem, callbacks). This would
drop Node/V8 overhead (~50 MB RSS, lower CPU) and make packaging a single Rust
binary. Estimated effort: **1–3 weeks** of focused work for someone comfortable
with Emscripten internals; higher risk than Option A. Good Phase 2.

### Option C — pure Rust protocol client + own physics

Implement the WebSocket protocol, room flow, and the entire REBUILT physics
game (fuel, intakes, shooters, collisions, auto routines, scoring). Not
recommended: the physics is the hard part and would diverge from the real game.
Only makes sense if the goal is an offline training simulator, not a live bot.

### Option D — Chromium/Playwright

Works today and is the easiest for UI automation, but violates the "no
Playwright" requirement and costs a full browser per bot. Keep only as a
debugging oracle.

## 8. Multiplayer and ML training

- `--server <host:port>` was validated against a local WebSocket listener: the
  engine connects to `ws://host/port/ws` and sends the normal hello. The team
  lead's local server must speak the same protocol/build.
- One engine per bot; each bot needs its own wasm instance and WebSocket. The
  client opens a room-list socket and a room socket at startup; on the public
  server this counts against the per-IP limit.
- Six bots = six Node processes (~1 GB RSS, ~1 core total). Acceptable on a
  small server, not on a laptop with other work.
- The public server has a **per-IP connection limit** and rate limiting. In our
  test a browser host + one headless engine worked, but a second headless engine
  from the same IP was closed with code 1006 before it could join. Six bots on
  one public IP is therefore not reliable. Use the team lead's **local server**
  (or separate egress IPs) for six-bot tests; the engine has `--server`.
- Rooms also expire after ~10 minutes if nobody else joins.
- For ML self-play, run **offline/singleplayer** matches and step the wasm
  simulation faster than real-time. The engine already runs without a server;
  the next step is a virtual clock and a direct `step(n)` API so training can
  run headless at high throughput. The team lead's local server is also the
  right place to run six-bot matches without the public per-IP limit.

## 9. Ethics / ToS / anti-bot

The game explicitly says no account is required for multiplayer, and there is a
visible anti-automation check. Treat this as a community service:

- This project is scoped to **private lobbies with your team/friends**. Do not
  run bots in public rooms; ask the developer first if you ever want to.
- Keep a human in the loop for private matches and label bots clearly.
- **No accounts, no leaderboard entries, no event participation.** Label bots
  clearly in the username/room name.
- **Don't bypass anti-cheat for competitive features.** The headless harness
  avoids the browser guard as a side effect of running the wasm in Node; keep
  that use to private/consented lobbies.
- **Respect rate/connection limits.** One IP, a few bots, backoff on errors.
- **Don't scrape or redistribute game assets.** `prepare.mjs` downloads the
  current build at runtime; the assets stay out of this repo.

## 10. Difficulty estimate

| Work item | Estimate |
| --- | --- |
| Headless engine boot + no-op GL | 1–2 days (done in this survey) |
| Join/create/ready/start flow | 1–2 days (mostly done) |
| Fuel extraction | 1 day (done) |
| Live robot pose, velocities, `me` identity | 1–2 days (done; ~48 Hz predicted) |
| Dynamic fuel count + base locator | 1 day (done) |
| Virtual gamepad (axes + intake/outtake/shoot) | 1–2 days (done) |
| 4-bot identity/alliance + blue controls | 2–3 days (done) |
| 6-bot identity/alliance on local server | 1–2 days remaining |
| Rust CLI + JSON API + docs | 3–5 days (mostly done) |
| Version/build handling + local server | 1–2 days |
| Spawnpoint selection (deferred) | 1–2 days |
| **Total to a usable procedural bot (Phase 1)** | **~1–2 weeks remaining** |
| Pure Rust Wasmtime engine (Phase 2) | 1–3 weeks |
| Pure Rust physics reimplementation | months, not recommended |

The networking, lobby automation, fuel, scores/substages, gamepad actions,
predicted pose, seat decoding, 4-bot identity, and blue controls are solved. The
remaining work is **six-bot validation on the local server** and **version
drift** (memory signatures/protocol after a game update); the build pin now
fails fast when the live `BUILD` differs.

## 11. Recommended next steps

1. Stabilize the current engine API (JSON lines): `join`, `ready`, `start`,
   `state`, `input`, `leave`; keep `me`/`is_me` authoritative.
2. Run a six-bot private match **on the local server** (the public per-IP limit
   blocks six Node clients from one address) and repeat the 4-bot checks:
   `is_me`, the `0x06` seat alliance, and red/blue movement. The 4-bot version is
   done (see §12).
3. Point the engine at the team lead's local server (`--server`) and compare its
   packet/state behavior with the public server.
4. Add an offline/high-speed `step(n)` mode with a virtual clock for ML
   training; this is separate from the real-time multiplayer bot.
5. Revisit spawnpoint selection (`0x07` + field map) only if inferring the spawn
   from the first pose is not enough.
6. Hand the Rust `Engine`/`GameState`/`Input` API to the ML lead and the
   procedural bot team.


## 12. Verification log

These are the reproducible checks used for the current build (`4a8a0e8`).

### 0x06 seat parser

`node engine/room06_test.cjs` parses a synthetic 4-seat packet and the captured
live packet. Captured result:

```
seat 0 HostA  team=0 red
seat 1 RedB   team=0 red
seat 2 RedC   team=0 red
seat 3 BlueD  team=1 blue
room06 tests OK
```

The blue client's HUD showed the blue "YOU" robot at the blue driver station
(live screenshots are kept under `/tmp/opencode` during testing). No manual seat
move was needed; the fourth joiner is blue in a fresh room.

### 4-client identity / control test

`engine/multibot_browser.mjs` starts an engine host plus three browser clients
in separate contexts, starts the match, then drives red host and blue tab
forward. Output:

```
SEATS [{"seat":0,"name":"RedHost",...red},
       {"seat":1,"name":"RedB",...red},
       {"seat":2,"name":"RedC",...red},
       {"seat":3,"name":"BlueD","team_flag":1,"alliance":"blue"}]
STATE robots: RedHost red me=true, RedB red, RedC red, BlueD blue
DELTA red  {"dx":3.815,"dy":0}
DELTA blue {"dx":-10.396,"dy":0}
VERDICT {"seats4":true,"fourthBlue":true,"allUnique":true,
         "hostMe":true,"robots4":true,"redForward":true,"blueForward":true}
```

This proves:
- four unique names occupy four seats;
- the host engine's `me` is exactly its own robot and it sees all four;
- the fourth seat is blue from the `0x06` team flag;
- forward (`y=1` / W) increases global x for red and **decreases** global x
  for blue, so `field_to_driver` is correct for this build.

### Scores / time / substages

A full browser match captured every `0x41` frame plus periodic HUD screenshots.
The HUD labels and match-clock boundaries matched the substage table in §4.3.
Score fields were validated directly:

| Clock | HUD | `+14` red | `+16` blue | `+18` auto red | `+28` auto blue |
| --- | --- | --- | --- | --- | --- |
| 162.97 | RED 0 / BLUE 0 | 0 | 0 | 0 | 0 |
| 157.03 | RED 1 / BLUE 2 | 1 | 2 | 1 | 2 |
| 150.97 | RED 2 / BLUE 3 | 2 | 3 | 2 | 3 |
| 136.57 (teleop) | RED 6 / BLUE 4 | 6 | 4 | 5 | 3 |
| 131.57 (shift 1) | RED 6 / BLUE 6 | 6 | 6 | 5 | 3 |

The auto columns freeze at the end of auto while the totals continue.

### Binary fuel + build pin

`node engine/binary_test.cjs`:

```
OK binary state {"seq":0,"phase":"countdown","substage":"auto",
 "fuel_count":150,"fuel_bin":true,"fuel_frames":1,"json_frames":9,
 "scores":{"red":0,"blue":0},"time":163}
packed records 150
```

Build drift checks:

```
$ node headless.cjs --expect-build deadbee ...
build pin failed: assets are 4a8a0e8 but --expect-build is deadbee
exit=3

$ # build.json = deadbee, live page = 4a8a0e8
build drift: assets are deadbee but server is 4a8a0e8 - run node prepare.mjs
exit=3
```

The Rust CLI propagates those exit codes (verified `--expect-build deadbee`
→ shell exit 3).
