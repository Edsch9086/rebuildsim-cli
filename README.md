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
- The server sends **fuel state** (456 fuel, 48-record chunks, fixed-point positions)
  and match/room state. It does **not** send robot poses. Robot poses come from the
  client-side deterministic simulation.
- The wasm runs **headless in Node** with a no-op WebGL2 context at ~59 fps. No
  Chromium, no Playwright, no GPU. Measured ~19% of one core and ~180 MB RSS.
- We can drive the real client's UI in the headless engine (create/join by code,
  ready, start) and read the live fuel array + player pose structs out of wasm memory.
- The practical architecture is **Rust CLI + headless wasm engine sidecar**. A pure
  Rust native client would require reimplementing the whole physics sim; not worth it.
- The main remaining RE risk is a robust locator for the **predicted** local robot
  pose (the server-acked player copy lags). Fuel and the authoritative/spectator
  player state are solved.

## Status

| Piece | Status |
| --- | --- |
| Headless wasm boot in Node | ✅ works |
| Live server handshake + room list | ✅ works |
| Create room / join room by code | ✅ works |
| Ready / start match | ✅ works (host auto-ready + start; joiner ready) |
| Fuel positions from wasm memory | ✅ exact 456-record array, ID-indexed |
| Fuel positions from server packets | ✅ `0x42` decoded |
| Robot pose (server-acked / spectator) | ✅ player struct found |
| Robot pose (local predicted, low latency) | ⚠️ needs more memory mapping |
| Input packet (`0x40`) | ✅ decoded; teleop axis diagnostic moves the robot |
| Auto/teleop phase from `0x41` clock | ✅ engine reports `phase` |
| Analog axes / gamepad | ⚠️ not yet wired |
| Spawnpoint selection | ⚠️ UI/protocol capture in progress |
| Rust CLI | ✅ library + demo binary |

## Quick start (local prototype)

```bash
cd engine
node prepare.mjs            # downloads current game assets into cache/
node headless.cjs --code <LOBBY> --username MyBot
```

The engine prints JSON lines on stdout and accepts JSON commands on stdin.
Use `--create` to make a room, and `--start` to start it as host.

Rust CLI (from the repo root):

```bash
cargo run --release -p rebuildsim-cli -- --code <LOBBY> --username MyBot
# or create/start a private room and run the axis diagnostic:
cargo run --release -p rebuildsim-cli -- --create --start --username TestBot --demo
```

If the engine assets live somewhere else, pass `--asset-dir <DIR>` or set
`RB_ASSET_DIR`. The engine uses the current build downloaded by `prepare.mjs`.

See `docs/SURVEY.md` for the architecture discussion, `docs/PROTOCOL.md` for
the packet/memory details, and `docs/API.md` for the engine/CLI API.
