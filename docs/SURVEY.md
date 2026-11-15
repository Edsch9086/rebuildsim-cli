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

### 4.1 Fuel — solved

The wasm memory contains a fixed array of **456 fuel records × 7 bytes**:

```
u8  present        // 0/1
u16 x              // (v - 0x8000) / 4096
u16 y
u16 z              // bottom; add ~0.045 m for centre
```

The array is **ID-indexed** and matches the `0x42` packet ids exactly. In one
run it was at `0x56ff37`; in another at `0x570f23`. The address depends on heap
layout, so the engine finds it by scanning for a run of 456 records with
`present ∈ {0,1}` and `z` in the expected range. This is fast enough to do once
per match.

The `0x42` packet also gives velocities and cluster counts; the engine can merge
those by id. For most bot logic, finite-differencing positions at 30–60 Hz is
simpler and sufficient for fuel.

### 4.2 Robot poses — found, one caveat

The live player state is a struct in wasm memory. We found it by searching for
the player's display name and reading nearby floats:

```
name field (32 bytes, zero-padded)
+0x1b  f32 x
+0x1f  f32 y
+0x23  f32 z (chassis, ~0.001)
+0x27  f32 \
+0x2b  f32  > small values (likely velocities/derived state)
+0x2f  f32 /
...
+0x3f  f32 heading (radians)
...
+0x57  f32 1.0 (valid/active)
```

Example: `MemBot` at `0x1f5c45`, pose base at `0x1f5c60`:
`x=-4.6725, y=3.4012, heading=-1.1787`. After driving, the same struct showed
`x=-0.4478, y=3.4013, heading=-3.1172`.

There are multiple copies of the same player (room UI, telemetry, replay,
network buffers). The copy at `name+0x1b` in the `0x1f....` region is the one that
matched the simulated robot. The **server-acked** copy appears to update on
network keyframes, so it can lag the local predicted pose by a few seconds in a
headless client. The game's render path clearly has a lower-latency copy; finding
that copy is the main remaining RE task for a fast closed-loop bot.

For a **spectator** connection the player state is the authoritative view and is
fine for observation/opponent tracking. For a **player** bot we recommend either:

1. find the predicted render transform (likely a 4×4 model/view matrix or a
   physics-body pose), or
2. run the bot as a spectator and send inputs through a separate player
   connection (more complex, two sockets), or
3. use the acked pose for slow, high-level decisions and local open-loop
   primitives for execution.

### 4.3 Match/room state

`0x41` carries the match clock and settings. The engine reads the float at
offset 10 (e.g. `143.0`) and derives `phase` (`>143` auto, `>0` teleop, else end).
`0x06` carries room code, host, seat assignments, names, teams, robot ids, and
spawn selections. `rbTrack` analytics events (`page_view`, `match_start`,
`room_join`) are a convenient blind-UI feedback channel while automating the menu.

## 5. Control

### 5.1 Input packet — decoded

`0x40` is 12 bytes:

```
u8  0x40
u16 tick
u16 buttons
i16 axis1          // 0x8000 neutral, 0xffff = +1, 0x0000 = -1
i16 axis2
i16 axis3
u8  0x34
```

Pressing **W** changed `axis1` to `0xffff`. `0x8000` is neutral on all axes, so
the game sends full analog axes even for keyboard input. Intake/shoot are in the
`buttons` bitfield. A native client can send this packet directly, but the local
simulation reads the game's own input state, so the clean path is to drive the
game through synthetic keyboard/gamepad input.

Driver input is **ignored during the auto period**. The `0x41` match clock starts
around `163.0 s`, auto ends at `143.0 s`, and teleop runs from there down to 0.
The engine reports `phase: "auto" | "teleop" | "end"` from this clock, and bot
code must wait for `teleop` before expecting drive/shoot inputs to move the
robot. The engine's own teleop gating is a one-line threshold in
`engine/headless.cjs`; if the game changes the auto length, update it.

For analog control, implement a **virtual gamepad** (`navigator.getGamepads`)
and feed axes; the game will encode them into `0x40` and use them locally. This
avoids overriding packets and keeps prediction in sync.

### 5.2 UI automation

The headless engine can drive the game with synthetic DOM events:

- `Space` dismisses the title.
- `MULTIPLAYER` opens the name/room list.
- The room code input is text box index 1; the name is box 0.
- Use `rb_tap_text_box(index, x, y)` + `rb_type_text(str)` for game text fields.
- `CREATE A ROOM`, `JOIN`, `READY`, `START MATCH` are normal clicks.
- The host's start flow may show "N players are not ready" → `START ANYWAY`
  or have the bot click `READY` first.
- Joining a room whose match is already running puts you in as a **spectator**
  (`via: joined_running`); join before start to drive.

The 1280×720 UI coordinates are in `docs/PROTOCOL.md`; the game is responsive
and lays out differently at 1280×800. Use 720p for the headless engine.

## 6. Spawnpoint / robot selection

The room UI has a robot dropdown (team 359 in our tests), a `SWITCH ROBOTS`
button, and a field map where the host can drag/place robots. The join packet
`0x07` (14 bytes) carries the seat/robot/spawn selection token; the room state
`0x06` echoes it. Choosing a specific spawn is a UI/protocol task that still
needs a capture of each action. The CLI flag can map `--spawnpoint` to a seat
index (red/blue 1/2/3) and either:

- click the field map at the seat coordinate before the match, or
- send the equivalent room action packet once the `0x07` fields are fully
  decoded.

This is low risk but not finished in the prototype.

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

- One engine per bot; each bot needs its own wasm instance and WebSocket.
- Six bots = six Node processes (~1 GB RSS, ~1 core total). Acceptable on a
  small server, not on a laptop with other work.
- The server has a **per-IP connection limit** and room expiry. Don't run a
  swarm from one address; coordinate with the developer.
- For ML self-play, run **offline/singleplayer** matches and step the wasm
  simulation faster than real-time. The engine already runs without a server;
  the next step is a virtual clock and a direct `step(n)` API so training can
  run headless at high throughput. This is separate from the multiplayer CLI
  and probably the highest-value thing for the ML lead.

## 9. Ethics / ToS / anti-bot

The game explicitly says no account is required for multiplayer, and there is a
visible anti-automation check. Treat this as a community service:

- **Ask the developer first** (Chief Delphi / Discord) before running bots in
  public rooms. A private lobby with permission is the safe path.
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
| Robot pose extraction (authoritative/spectator) | 1 day (done) |
| Predicted local pose / low-latency control | 3–7 days |
| Analog gamepad + spawnpoint selection | 2–4 days |
| Rust CLI + JSON/binary API + docs | 3–5 days |
| Robust version/build handling | 1–2 days |
| **Total to a usable procedural bot (Phase 1)** | **~2–3 weeks** |
| Pure Rust Wasmtime engine (Phase 2) | 1–3 weeks |
| Pure Rust physics reimplementation | months, not recommended |

The networking and lobby automation are straightforward. The only genuinely
uncertain part is finding the low-latency predicted robot pose; the
authoritative/spectator pose is already available.

## 11. Recommended next steps

1. Wrap the current headless harness into a stable engine API (JSON lines):
   `join`, `ready`, `start`, `state`, `input`, `leave`.
2. Map the live/predicted pose by comparing the render/model transform in the
   browser wasm memory with the headless client; add a `pose_source` field so
   the bot can choose authoritative vs predicted.
3. Implement a virtual gamepad for true analog `x/y/rotate`.
4. Decode `0x07` and the room field map for `--spawnpoint`.
5. Add a version/build check: fetch the page, parse `BUILD="..."`, download the
   matching `index.js`/`index.wasm`, and refuse to run if the server version
   differs.
6. Build the Rust CLI around the engine, then hand the state/input API to the
   ML lead. Keep the engine protocol documented and versioned.
7. In parallel, add an offline `step(n)` mode with a virtual clock for training.
