# REBUILDSIM AI — survey and base tooling

This repo is the starting point for a headless REBUILD Simulator bot/CLI.
It contains:

- `docs/SURVEY.md` — what the game is, how it works, feasibility, risks, recommended architecture.
- `docs/PROTOCOL.md` — observed WebSocket packets, input encoding, and wasm memory map.
- `engine/` — a proof-of-concept headless engine that runs the real game wasm in Node with a stubbed WebGL2 context.
- `cli/` — a Rust library + demo CLI that launches the engine and exposes a small state/input API.

The game assets are **not** committed. `engine/prepare.mjs` downloads the current
`index.js` / `index.wasm` from rebuildsim.com into `engine/cache/`.

## TL;DR

- The game is C++/raylib 6.0 compiled to wasm, served by Cloudflare, with a custom
  binary WebSocket protocol at `wss://rebuildsim.com/ws`.
- The server sends **fuel state** (1 to ~4,300 fuel depending on gamerules, in
  48-record chunks, fixed-point positions) and match/room state. It does **not**
  send robot poses. Robot poses come from the client-side deterministic
  simulation.
- The wasm runs **headless in Node** with a no-op WebGL2 context at ~59 fps. No
  Chromium, no Playwright, no GPU. Measured ~19% of one core and ~180 MB RSS.
- We can drive the real client's UI in the headless engine (create/join by code,
  ready, start) and read the live fuel array + player pose structs out of wasm memory.
  The player-state pose updates live; driver input works during auto as soon as
  the match clock starts (the 3-second countdown is before the match).
- The practical architecture is **Rust CLI + headless wasm engine sidecar**. A pure
  Rust native client would require reimplementing the whole physics sim; not worth it.
- The remaining risks are robot identity in a 6-bot lobby (we expose `me` / `is_me`),
  alliance-frame control conventions, spawn selection (dropped for now), and
  game-version drift.

## Status

| Piece | Status |
| --- | --- |
| Headless wasm boot in Node | ✅ works |
| Live server handshake + room list | ✅ works |
| Create room / join room by code | ✅ works |
| Ready / start match | ✅ joiner auto-ready; test host can start |
| Fuel positions from wasm memory | ✅ dynamic count (1..~4300), packet-matched base |
| Fuel positions from server packets | ✅ `0x42` decoded |
| Robot pose (predicted) | ✅ render copy ~48 Hz; acked fallback |
| Robot identity | ✅ `me` + `is_me` by username |
| Alliance-normalized poses | ✅ red/blue get the same coordinate frame |
| Seat/alliance from `0x06` | ✅ team flag (red=0/blue=1); seat 4 blue confirmed |
| Scores / time / substages | ✅ `0x41` scores + full substage table |
| Binary fuel channel | ✅ `--binary` packed frames; Rust reattaches |
| Input packet (`0x40`) | ✅ axes + action bits decoded |
| Analog axes / gamepad | ✅ virtual standard gamepad; drive/turn/intake/outtake/shoot |
| Auto/teleop phase from `0x41` clock | ✅ countdown/auto/teleop + substages |
| Build pin / drift fail-fast | ✅ `build.json` + live check + `--expect-build` |
| Spawnpoint selection | ⏸ dropped for now (infer from spawn pose) |
| Local server (`--server`) | ✅ connects to a local WS listener |
| Fuel rule (`--fuel`) | ✅ host UI flow; 25% → 150 fuel validated |
| Rust CLI | ✅ library + demo binary |

## Quick start (local prototype)

```bash
cd engine
node prepare.mjs            # downloads current game assets into cache/
node headless.cjs --code <LOBBY> --username MyBot
```

The engine prints JSON lines on stdout and accepts JSON commands on stdin.
Normal bots only join (`--code`); a human host starts the match. `--create` /
`--start` remain for local testing. `--binary` switches to framed stdout with
packed fuel records (the Rust CLI uses this by default). `--expect-build <hash>`
pins the downloaded build; startup fails with exit 3 if the live server build
differs.

Rust CLI (from the repo root):

```bash
# normal operation: a human hosts, the bot joins and readies itself
cargo run --release -p rebuildsim-cli -- --code <LOBBY> --username MyBot
# use --keyboard for digital controls instead of the virtual gamepad

# test-only: create/start a private room and run the axis diagnostic
cargo run --release -p rebuildsim-cli -- --create --start --username TestBot --demo
```

If the engine assets live somewhere else, pass `--asset-dir <DIR>` or set
`RB_ASSET_DIR`. The engine uses the current build downloaded by `prepare.mjs`.
To point at a locally hosted server build, pass `--server <host:port>` to the
engine or the Rust CLI. For repeated multi-bot tests, use that local server; the
public server enforces a per-IP connection limit.

See `docs/SURVEY.md` for the architecture discussion, `docs/PROTOCOL.md` for
the packet/memory details, and `docs/API.md` for the engine/CLI API.
