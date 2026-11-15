# REBUILD Simulator — observed protocol and memory map

Build `4a8a0e8`. All multi-byte values little-endian. This is a working map, not
an official spec; the server/client may change without notice.

## 1. WebSocket

- URL: `wss://rebuildsim.com/ws`
- Binary frames, no subprotocol.
- The server accepts the socket but sends nothing until the client hello.

### 1.1 Hello (C→S, 67 bytes)

```
01 6c 00 00 00  44 55 42 52  34 61 38 61 30 65 38  00 ... 00  04
^  ^^^^^^^^^^^  ^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^
|  u32 108?     "DUBR"       build hash "4a8a0e8"
type
```

The rest is zero padding and a final `04`. The real engine sends this for you;
a native client should copy the current build hash from the page.

### 1.2 Handshake responses

```
S→C  02 2f e1 c9 5a 00        // 6 bytes: client/connection id
S→C  3e 00                    // 2 bytes: heartbeat
S→C  21 00 01 00 00           // 5 bytes: protocol version 1
C→S  31 00 00                 // ack
S→C  32 ...                   // room list chunks (312–611 bytes)
```

### 1.3 Name and room join

```
C→S  10 <24-byte name>        // set display name
C→S  04                       // ack / continue
S→C  06 <308-byte room state>
S→C  13 <90–175 bytes>        // room info / join result
C→S  07 <14 bytes>            // seat/robot/spawn selection
```

Example from a real join:

```
C→S 10 50 72 6f 62 65 42 6f 74 00 ...     // "ProbeBot"
C→S 04
S→C 06 41 57 33 56 51 ...                 // room AW3VQ
C→S 07 00 00 67 01 00 00 01 16 62 c2 95 00 80
```

The `0x06` room state contains the room code, host id, seats, display names,
teams, robot ids, and spawn selections. Names are printable ASCII, zero-padded.
The `0x07` seats the joining player; the last `00 80` is part of the selection
(spawn/robot), not yet fully decoded.

### 1.4 Input (C→S, 12 bytes)

```
u8  0x40
u16 tick
u16 buttons
i16 axis1        // 0x8000 neutral; 0xffff = +1; 0x0000 = -1
i16 axis2
i16 axis3
u8  0x34
```

Neutral:

```
40 0d 00 00 00 00 80 00 80 00 80 34
```

W held (`axis1` = +1):

```
40 8d 0c 00 00 ff ff 00 80 00 80 34
```

The game sends full analog axes even for keyboard input. Intake/shoot/etc. are
in `buttons`. The client also sends `0x44 <u32> ...` pings (7 bytes) and receives
`0x45 <u32> ...` echoes (5 bytes).

### 1.5 Fuel state (S→C, 1161 bytes)

```
u8   0x42
u32  tick
u16  456        // total fuel
u16  48         // records in this packet
48 × 24 bytes:
  u16 id        // 0..455, 1:1 with memory array index
  u16 count     // 1, or >1 for a cluster
  u32 0x00010000
  u32 flags     // 0 normal; 7 seen for a hub cluster
  u16 x, y, z   // fixed point: (v - 0x8000) / 4096 m
  u16 vx, vy, vz// 0x8000 = zero
```

The server cycles through all 456 fuel in 48-record chunks (`id` starts at
0, 48, 96, ... and wraps). It sends chunks continuously; the full set refreshes
in ~0.3 s at 30 Hz. Example first record:

```
42 04 00 00 00 c8 01 30 00 00 00
   00 00 01 00 00 00 01 00 00 00 00 00
   25 7a 41 6f 33 81 00 80 00 80 00 80
```

`25 7a` = 31269 → x=-0.366 m, `41 6f` = 28481 → y=-1.047 m, `33 81` = 33075
→ z=+0.075 m. `00 80` = 32768 = zero velocity.

### 1.6 Match/room state (`0x41`, 154–340 bytes)

- `u8 0x41`, `u32 tick`, then a float match clock at offset 10
  (e.g. `c8 09 0f 43` = 143.0 s remaining).
- The clock starts at ~163 s. Auto ends at ~143 s; teleop runs to 0.
  Driver input is ignored before teleop. The engine uses this to set `phase`.
- The rest is settings, scores, seat/robot state. The packet grows when
  spectators/players join (154 → 224/228 → 340 bytes).
- This is **not** robot pose state.

### 1.7 Other observed packets

```
S→C 48 <u32 tick> <4 × u32 status> <8-byte hash>   // 30 bytes
S→C 4b <u32 tick> ... <3 × u16 axes> 34            // 8 or 19 bytes
S→C 43 <u32 tick> <u32>                            // 9 bytes
```

`0x48` looks like per-player status/state hashes; `0x4b` like input/ack. They do
not contain full robot poses.

## 2. Wasm memory map

Addresses are examples from one run; heap layout shifts between runs. Use
signature scanning, not fixed addresses.

### 2.1 Fuel array

- 456 records × 7 bytes, ID-ordered.
- Found at `0x56ff37` in one run, `0x570f23` in another.
- Record:

```
u8  present       // 0/1
u16 x             // (v - 0x8000) / 4096
u16 y
u16 z             // bottom; add ~0.045 m for centre
```

- The array is immediately after the room/match state in the heap. A scan for
  456 consecutive records with `present ∈ {0,1}` and `z` in `[32700, 33200]`
  works. Stop after the first 8 MB for speed.
- The packet id equals the array index (id 0 → record 0).

### 2.2 Player state struct

- The display name is a 32-byte zero-padded field. The live copy is preceded by
  a `0x01` byte.
- Pose fields, relative to the **start of the name string**:

```
+0x1b  f32 x
+0x1f  f32 y
+0x23  f32 z (chassis, ~0.001)
+0x27  f32  \
+0x2b  f32   > small values; likely velocities/derived state
+0x2f  f32  /
+0x33  f32 0
+0x37  f32 0
+0x3b  u32 1
+0x3f  f32 heading (radians)
+0x43  f32 small
+0x47  f32 small
...
+0x57  f32 1.0
```

Example (headless match, `HeadBot` at `0x1f5c45`):

```
name+0x1b = -4.6725   (x, spawn)
name+0x1f =  3.4012   (y, spawn)
name+0x3f = -1.1787   (heading)
```

After driving:

```
x = -0.4478, y = 3.4013, heading = -3.1172
```

There are many copies (room UI, telemetry, replay, network). The copy in the
`0x1f....` region with the preceding `0x01` is the player state. The
server-acked copy can lag the local predicted pose; see `SURVEY.md` §4.2.

### 2.3 Match/room state in memory

The `0x06`/`0x41` data is also mirrored in the heap near the player state. We
found `HeadBot` at `0x56feda`, the match clock float at `0x56fe6c`, and the fuel
array at `0x56ff37`. This is useful for scanning if the packet capture is
unavailable, but the socket packets are cleaner.

## 3. Headless UI coordinates (1280×720)

The game lays out differently at 1280×800 (menu moves to the left). Use 1280×720
for the headless engine.

### Title/menu

- Dismiss title: `Space`.
- Multiplayer button: `(1070, 244)`.

### Name prompt

- Name text box: `(640, 270)`; use `rb_tap_text_box(0, 640, 270)` then
  `rb_type_text("name")`.
- Continue: `(640, 326)`.

### Room list

- Name box: `(90..346, 126..170)`.
- `SIGN IN`: `(352..468, 126..170)`.
- `CREATE A ROOM`: `(90..468, 174..222)`; center `(280, 198)`.
- Room code box: `(90..346, 252..296)`; use text box index 1.
- `JOIN`: `(352..468, 252..296)`; center `(410, 274)`.
- `BACK`: `(24..144, 655..698)`.

### Room

- Robot dropdown: around `(274, 267)`.
- `RANDOMIZE`: `(265..465, 596..642)`.
- Bottom buttons, y=665..710:
  - `LEAVE` (24..264)
  - `SWITCH ROBOTS` (275..515)
  - `READY` (526..766); center `(646, 688)`
  - `SETTINGS` (777..1017)
  - `START MATCH` (1028..1268); center `(1150, 688)`
- Start-with-unready dialog: `START ANYWAY` at `(640, 372)` in 800px layout;
  check the current screenshot before clicking.

### Text API exports

The wasm exports only a few `rb_*` functions:

```
rb_set_clipboard(str)
rb_type_text(str)
rb_type_erase(n)
rb_text_command(cmd)
rb_tap_text_box(index, x, y)
rb_field_typed(index, kind, value)
rb_notice(str, str, int)
rb_wheel(dy, mode)
```

`rb_type_text` is the one used by the in-game name/room-code boxes.

## 4. Engine API proposal

JSON lines on stdin/stdout (debug logs go to stderr). The Rust CLI spawns one
engine per bot.

Engine → CLI:

```json
{"type":"ready","build":"4a8a0e8"}
{"type":"room","code":"URUQM","host":true,"seated":true,"role":"driver"}
{"type":"match","phase":"auto","time":153.2}
{"type":"state","seq":123,"t":12.34,
 "robots":[{"name":"MyBot","team":359,"alliance":"red","x":-4.67,"y":3.40,
            "z":0.1,"heading":-1.18,"vx":0.0,"vy":0.0,"vz":0.0,"yawRate":0.0}],
 "fuel":[{"id":0,"x":-0.37,"y":-1.05,"z":0.075,"present":true}, ...]}
```

CLI → engine:

```json
{"type":"input","x":0.0,"y":1.0,"rotate":0.0,"intake":false,"shoot":false}
{"type":"ready"}
{"type":"start"}
{"type":"leave"}
```

For Phase 1, map `x/y/rotate` to keyboard keys (W/S/A/D + J/L) and
`intake/shoot` to LShift/Space. Phase 2 should use a virtual gamepad for true
analog axes.

## 5. Versioning

The page hardcodes the build hash:

```html
var BUILD="4a8a0e8", Module={locateFile:...}
```

and the wasm handshake contains `DUBR` + the same hash. `engine/prepare.mjs`
should parse the page, download the matching `index.js`/`index.wasm`, and the
engine should refuse to run if the live server's protocol/build differs. The
server sends `0x21 00 01 00 00` (protocol version 1) and can reply with a build
mismatch message.
