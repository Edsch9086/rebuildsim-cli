# REBUILDSIM AI — survey and base tooling

This repo is the starting point for a headless REBUILD Simulator bot/CLI.
It contains:

- `docs/SURVEY.md` — what the game is, how it works, feasibility, risks, recommended architecture.
- `docs/PROTOCOL.md` — observed WebSocket packets, input encoding, and wasm memory map.
- `engine/` — a proof-of-concept headless engine that runs the real game wasm in Node with a stubbed WebGL2 context.
- `cli/` — a Rust library + demo CLI that launches the engine and exposes a small state/input API.

The game assets are **not** committed. `engine/prepare.mjs` downloads the pinned
`index.js` / `index.wasm` from rebuildsim.com into `engine/cache/`. It refuses a
different live build unless `RB_ALLOW_BUILD_UPDATE=1`, and it never updates
`engine/trusted_build.json` automatically.

## TL;DR

- The game is C++/raylib 6.0 compiled to wasm, served by Cloudflare, with a custom
  binary WebSocket protocol at `wss://rebuildsim.com/ws`.
- The server sends **fuel state** (1 to ~4,300 fuel depending on gamerules, in
  48-record chunks, fixed-point positions) and match/room state. It does **not**
  send robot poses. Robot poses come from the client-side deterministic
  simulation.
- The wasm runs **headless in Node** with a no-op WebGL2 context at ~59 fps. No
  Chromium, no Playwright, no GPU. Requires Node >= 22. Measured ~19% of one core and ~180 MB RSS for
  a single bot at default fuel; 3v3/4,300-fuel runs are not yet measured.
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
| Create room / join room by code | ✅ name/room-code UI retried; join timeout still applies |
| Ready / start match | ✅ joiner auto-ready; test host can start |
| Fuel positions from wasm memory | ✅ fallback only before the first `0x42` chunk; may be a static start table |
| Fuel positions from server packets | ✅ live positions/presence (authoritative); memory fallback |
| Robot pose (predicted) | ✅ render copy ~48 Hz; acked fallback |
| Robot heading | ✅ chassis yaw; `turret_heading` exposed separately |
| Robot identity | ✅ `me` + `is_me` by username (1-10 ASCII) |
| Alliance-normalized poses | ✅ red/blue get the same coordinate frame |
| Seat/alliance from `0x06` | ✅ team flag (red=0/blue=1); fourth seat blue confirmed |
| Scores / time / substages | ✅ `0x41` scores + full substage table |
| Hopper fuel | ✅ live count + intake flag; capacity read from the robot definition (359=55, 4414=110, 2910 V2=50) |
| Hub active/inactive | ✅ computed from clock + AUTO winner; tie reports unknown |
| Binary fuel channel | ✅ `--binary` packed frames; Rust reattaches |
| Input packet (`0x40`) | ✅ axes + action bits decoded |
| Analog axes / gamepad | ✅ virtual standard gamepad; drive/turn/intake/outtake/shoot |
| Auto/teleop phase from `0x41` clock | ✅ countdown/auto/teleop + substages |
| Build pin / drift fail-fast | ✅ `trusted_build.json` + `build.json` + live check + `--expect-build` |
| Timeouts / disconnect handling | ✅ state watchdog, room-WS exit, aux-close ignore, lobby restart |
| Spawnpoint selection | ⏸ dropped for now (infer from spawn pose) |
| Local server (`--server`) | ✅ connects to a local WS listener |
| Fuel rule (`--fuel`) | test-only host UI flow; 25% → 150 fuel validated |
| Robot selection | ✅ `--robot <id>` after join (0x07 replay; game default variant, e.g. 2910 V2) |
| Rust CLI | ✅ library + demo binary |

## Quick start (local prototype)

```bash
cd engine
node prepare.mjs            # downloads pinned game assets into cache/
                            # (refuses a different live build unless RB_ALLOW_BUILD_UPDATE=1)
node headless.cjs --code <LOBBY> --username MyBot
```

The engine prints JSON lines on stdout and accepts JSON commands on stdin.
Normal bots only join (`--code`); a human host starts the match. Joining
auto-readies a seat; the engine only clicks READY when the 0x06 ready bit says
the seat is not ready, so it never toggles a ready seat off. A host engine
readies its own seat before `--start` clicks START. `--create` / `--start`
remain for local testing. `--binary` switches to framed stdout with
packed fuel records (the Rust CLI uses this by default). `--expect-build <hash>`
checks the cached build hash; startup also verifies asset hashes and fails with
exit 3 if the live server build differs.

Rust CLI (from the repo root):

```bash
# normal operation: a human hosts, the bot joins and readies itself
cargo run --release -p rebuildsim-cli -- --code <LOBBY> --username MyBot
# use --keyboard for digital controls instead of the virtual gamepad

# test-only: create/start a private room and run the axis diagnostic
cargo run --release -p rebuildsim-cli -- --create --start --username TestBot --demo

# select a robot after joining (the game's default variant for that id)
cargo run --release -p rebuildsim-cli -- --code <LOBBY> --username MyBot --robot 4414
```

## Nix

A `flake.nix` provides a dev shell (`rustc`, `cargo`, clippy, rustfmt,
rust-analyzer, Node 22, `jq`, `curl`) and a `rebuildsim-cli` package:

```bash
nix develop                  # toolchain shell
nix build                    # ./result/bin/rebuildsim-cli
nix run . -- --code <LOBBY> --username MyBot
```

The game assets are not in the Nix store. Download them in the checkout with
`node engine/prepare.mjs` before running; the default engine path and
`RB_ASSET_DIR` still work as described above.

If the engine assets live somewhere else, pass `--asset-dir <DIR>` or set
`RB_ASSET_DIR`. The engine uses the current build downloaded by `prepare.mjs`.
To point at a locally hosted server build, pass `--server <host:port>` to the
engine or the Rust CLI. For repeated multi-bot tests, use that local server; the
public server enforces a per-IP connection limit.

See `docs/SURVEY.md` for the architecture discussion, `docs/PROTOCOL.md` for
the packet/memory details, and `docs/API.md` for the engine/CLI API.
