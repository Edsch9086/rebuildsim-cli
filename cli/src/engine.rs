//! Headless engine process wrapper and the public state/input API.
//!
//! The engine is the Node harness in `engine/headless.cjs`. It speaks JSON lines:
//! engine -> CLI: `ready`, `room`, `match`, `state`, `pong`
//! CLI -> engine: `input`, `ready`, `start`, `leave`, `quit`, `ping`.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct EngineOptions {
    pub engine: PathBuf,
    pub code: Option<String>,
    pub username: String,
    pub create: bool,
    pub start: bool,
    pub spawn: Option<String>,
    pub emit_hz: u32,
    pub asset_dir: Option<PathBuf>,
    pub debug: bool,
    pub gamepad: bool,
    pub fuel: Option<String>,
    pub server: Option<String>,
    pub binary: bool,
    pub field_frame: bool,
    pub hub_order: Option<String>,
    pub expect_build: Option<String>,
    pub no_build_check: bool,
}

impl EngineOptions {
    pub fn new(engine: impl Into<PathBuf>, username: impl Into<String>) -> Self {
        Self {
            engine: engine.into(),
            code: None,
            username: username.into(),
            create: false,
            start: false,
            spawn: None,
            emit_hz: 10,
            asset_dir: None,
            debug: false,
            gamepad: true,
            fuel: None,
            server: None,
            binary: true,
            field_frame: false,
            hub_order: None,
            expect_build: None,
            no_build_check: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Robot {
    pub name: String,
    #[serde(default)]
    pub is_me: bool,
    #[serde(default)]
    pub alliance: String,
    /// "room" when decoded from the 0x06 seat records, "spawn" for the fallback.
    #[serde(default)]
    pub alliance_source: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub heading: f32,
    #[serde(default)]
    pub vx: f32,
    #[serde(default)]
    pub vy: f32,
    #[serde(default)]
    pub vz: f32,
    #[serde(default, rename = "yawRate")]
    pub yaw_rate: f32,
    #[serde(default)]
    pub pose_source: String,
    /// Local hopper fuel count (u32 at name+0x4b in the player struct).
    #[serde(default)]
    pub hopper_fuel: Option<u16>,
    /// Intake flag (bit 6 of the byte at name+0x56).
    #[serde(default)]
    pub intake_active: Option<bool>,
}

impl Robot {
    pub fn is_blue(&self) -> bool {
        self.alliance.eq_ignore_ascii_case("blue")
    }

    /// Convert a global field vector into the driver/control frame used by `Input`.
    /// Red drives with the field axes; blue is rotated 180 degrees. Validate this
    /// against a blue client when possible (see docs/SURVEY.md §4.2).
    pub fn field_to_driver(&self, x: f32, y: f32) -> (f32, f32) {
        if self.is_blue() { (-x, -y) } else { (x, y) }
    }

    pub fn driver_to_field(&self, x: f32, y: f32) -> (f32, f32) {
        self.field_to_driver(x, y)
    }

    /// Alliance-relative heading if the game exposes a global heading.
    pub fn alliance_heading(&self) -> f32 {
        if self.is_blue() {
            let mut h = self.heading + std::f32::consts::PI;
            while h > std::f32::consts::PI {
                h -= 2.0 * std::f32::consts::PI;
            }
            while h < -std::f32::consts::PI {
                h += 2.0 * std::f32::consts::PI;
            }
            h
        } else {
            self.heading
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HubStatus {
    /// Our hub status. `None` during alliance shifts when AUTO was tied.
    pub active: Option<bool>,
    pub red_active: Option<bool>,
    pub blue_active: Option<bool>,
    /// True when red's hub is inactive in SHIFT 1 (red won AUTO).
    pub red_inactive_first: Option<bool>,
    /// "auto" | "field_reset" | "transition" | "shift1".."shift4" |
    /// "endgame" | "end" | "unknown"
    pub phase: String,
    /// "auto_score" | "tie" | "unknown"
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fuel {
    pub id: u16,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    #[serde(default)]
    pub present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameState {
    pub seq: u64,
    #[serde(default)]
    pub me: Option<Robot>,
    #[serde(default)]
    pub fuel_count: Option<u16>,
    pub t: f64,
    pub phase: String,
    #[serde(default)]
    pub time: Option<f64>,
    #[serde(default)]
    pub robots: Vec<Robot>,
    #[serde(default)]
    pub fuel: Vec<Fuel>,
    /// Detail phase from the 0x41 match clock.
    #[serde(default)]
    pub substage: String,
    /// Seconds remaining in the match (same as `time`).
    #[serde(default)]
    pub time_remaining: Option<f64>,
    /// Seconds until the next substage boundary.
    #[serde(default)]
    pub substage_remaining: Option<f64>,
    #[serde(default)]
    pub red_score: u16,
    #[serde(default)]
    pub blue_score: u16,
    #[serde(default)]
    pub auto_red_score: u16,
    #[serde(default)]
    pub auto_blue_score: u16,
    /// Server protocol version from 0x21.
    #[serde(default)]
    pub protocol: Option<u8>,
    #[serde(default)]
    pub ws_open: u32,
    #[serde(default)]
    pub ws_closed: u32,
    /// "alliance" (default, identical for red and blue) or "field".
    #[serde(default)]
    pub frame: String,
    /// Our alliance for diagnostics; bots should not need it in alliance frame.
    #[serde(default)]
    pub alliance: String,
    /// Our robot's hopper fuel count, if the player struct is readable.
    #[serde(default)]
    pub hopper_fuel: Option<u16>,
    /// HUD/build hopper capacity (55 in build 4a8a0e8).
    #[serde(default)]
    pub hopper_capacity: Option<u16>,
    /// Our intake flag.
    #[serde(default)]
    pub intake_active: Option<bool>,
    #[serde(default)]
    pub hub: HubStatus,
    /// True when `fuel` was delivered on the binary channel (fuel is empty).
    #[serde(default)]
    pub fuel_bin: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Input {
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub rotate: f32,
    #[serde(default)]
    pub intake: bool,
    #[serde(default)]
    pub outtake: bool,
    #[serde(default)]
    pub shoot: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Seat {
    pub seat: u32,
    pub name: String,
    #[serde(default)]
    pub team_flag: u8,
    pub alliance: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum EngineEvent {
    #[serde(rename = "ready")]
    Ready { build: Option<String> },
    #[serde(rename = "room")]
    Room {
        code: String,
        host: bool,
        seated: bool,
        role: Option<String>,
        #[serde(default)]
        seats: Vec<Seat>,
    },
    #[serde(rename = "seats")]
    Seats { code: String, seats: Vec<Seat> },
    #[serde(rename = "match")]
    Match {
        phase: String,
        time: Option<f64>,
        #[serde(default)]
        seats: Vec<Seat>,
    },
    #[serde(rename = "state")]
    State(GameState),
    #[serde(rename = "build")]
    Build {
        build: String,
        #[serde(default)]
        server_build: Option<String>,
        #[serde(default)]
        ok: bool,
    },
    #[serde(rename = "protocol")]
    Protocol { version: Option<u8> },
    #[serde(rename = "score")]
    Score {
        #[serde(default)]
        red: u16,
        #[serde(default)]
        blue: u16,
        #[serde(default)]
        auto_red: u16,
        #[serde(default)]
        auto_blue: u16,
    },
    #[serde(rename = "error")]
    Error { error: String },
    #[serde(rename = "ws")]
    Ws {
        state: String,
        #[serde(default)]
        id: Option<u32>,
        #[serde(default)]
        code: Option<u16>,
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        room: Option<bool>,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat {
        #[serde(default)]
        t: f64,
        #[serde(default)]
        ws_open: u32,
        #[serde(default)]
        ws_closed: u32,
    },
    #[serde(rename = "pong")]
    Pong { t: f64 },
    /// Synthetic event returned by `next_event_timeout`; never sent by the engine.
    #[serde(rename = "__timeout")]
    Timeout,
    #[serde(other)]
    Other,
}

pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<std::io::Result<EngineEvent>>,
    _reader: thread::JoinHandle<()>,
}

fn read_frame(stdout: &mut BufReader<ChildStdout>) -> std::io::Result<Option<(u8, u32, Vec<u8>)>> {
    use std::io::Read;
    let mut hdr = [0u8; 16];
    let mut read = 0;
    while read < hdr.len() {
        let n = stdout.read(&mut hdr[read..])?;
        if n == 0 {
            return Ok(None);
        }
        read += n;
    }
    if &hdr[0..4] != b"RSB1" {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("bad engine frame magic: {:02x?}", &hdr[0..4]),
        ));
    }
    let kind = hdr[5];
    let len = u32::from_le_bytes([hdr[8], hdr[9], hdr[10], hdr[11]]) as usize;
    let seq = u32::from_le_bytes([hdr[12], hdr[13], hdr[14], hdr[15]]);
    let mut payload = vec![0u8; len];
    stdout.read_exact(&mut payload)?;
    Ok(Some((kind, seq, payload)))
}

fn read_next_event(
    stdout: &mut BufReader<ChildStdout>,
    binary: bool,
    pending_fuel: &mut Vec<Fuel>,
    pending_fuel_seq: &mut Option<u32>,
) -> std::io::Result<Option<EngineEvent>> {
    loop {
        if binary {
            let Some((kind, seq, payload)) = read_frame(stdout)? else {
                return Ok(None);
            };
            match kind {
                2 => {
                    *pending_fuel = decode_fuel(&payload);
                    *pending_fuel_seq = Some(seq);
                }
                1 => {
                    let line = String::from_utf8_lossy(&payload);
                    match serde_json::from_str::<EngineEvent>(&line) {
                        Ok(EngineEvent::State(mut state)) => {
                            if state.fuel_bin && *pending_fuel_seq == Some(state.seq as u32) {
                                state.fuel = pending_fuel.clone();
                            }
                            return Ok(Some(EngineEvent::State(state)));
                        }
                        Ok(event) => return Ok(Some(event)),
                        Err(err) => {
                            eprintln!("engine: ignoring malformed frame ({err}): {line}");
                        }
                    }
                }
                _ => {}
            }
        } else {
            let mut line = String::new();
            let n = stdout.read_line(&mut line)?;
            if n == 0 {
                return Ok(None);
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<EngineEvent>(line) {
                Ok(event) => return Ok(Some(event)),
                Err(err) => {
                    eprintln!("engine: ignoring malformed line ({err}): {line}");
                }
            }
        }
    }
}

fn reader_loop(
    mut stdout: BufReader<ChildStdout>,
    binary: bool,
    tx: Sender<std::io::Result<EngineEvent>>,
) {
    let mut pending_fuel = Vec::new();
    let mut pending_fuel_seq = None;
    loop {
        match read_next_event(
            &mut stdout,
            binary,
            &mut pending_fuel,
            &mut pending_fuel_seq,
        ) {
            Ok(Some(event)) => {
                if tx.send(Ok(event)).is_err() {
                    break;
                }
            }
            Ok(None) => break,
            Err(err) => {
                let _ = tx.send(Err(err));
                break;
            }
        }
    }
}

impl Engine {
    pub fn spawn(opts: &EngineOptions) -> std::io::Result<Self> {
        let mut cmd = Command::new("node");
        cmd.arg(&opts.engine);
        if let Some(code) = &opts.code {
            cmd.arg("--code").arg(code);
        }
        cmd.arg("--username").arg(&opts.username);
        if opts.create {
            cmd.arg("--create");
        }
        if opts.start {
            cmd.arg("--start");
        }
        if let Some(spawn) = &opts.spawn {
            cmd.arg("--spawn").arg(spawn);
        }
        if opts.debug {
            cmd.arg("--debug");
        }
        if opts.gamepad {
            cmd.arg("--gamepad");
        }
        if let Some(fuel) = &opts.fuel {
            cmd.arg("--fuel").arg(fuel);
        }
        if let Some(server) = &opts.server {
            cmd.arg("--server").arg(server);
        }
        if opts.binary {
            cmd.arg("--binary");
        }
        if opts.field_frame {
            cmd.arg("--field-frame");
        }
        if let Some(order) = &opts.hub_order {
            cmd.arg("--hub-order").arg(order);
        }
        if let Some(build) = &opts.expect_build {
            cmd.arg("--expect-build").arg(build);
        }
        if opts.no_build_check {
            cmd.arg("--no-build-check");
        }
        cmd.arg("--emit-hz").arg(opts.emit_hz.to_string());
        if let Some(dir) = &opts.asset_dir {
            cmd.env("RB_ASSET_DIR", dir);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let (tx, rx) = mpsc::channel();
        let binary = opts.binary;
        let reader = thread::spawn(move || reader_loop(stdout, binary, tx));
        Ok(Self {
            child,
            stdin,
            rx,
            _reader: reader,
        })
    }

    pub fn send(&mut self, value: &serde_json::Value) -> std::io::Result<()> {
        serde_json::to_writer(&mut self.stdin, value)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()
    }

    pub fn send_input(&mut self, input: &Input) -> std::io::Result<()> {
        let value = serde_json::json!({
            "type": "input",
            "x": input.x,
            "y": input.y,
            "rotate": input.rotate,
            "intake": input.intake,
            "outtake": input.outtake,
            "shoot": input.shoot,
        });
        self.send(&value)
    }

    pub fn ready(&mut self) -> std::io::Result<()> {
        self.send(&serde_json::json!({"type":"ready"}))
    }
    pub fn start(&mut self) -> std::io::Result<()> {
        self.send(&serde_json::json!({"type":"start"}))
    }
    pub fn leave(&mut self) -> std::io::Result<()> {
        self.send(&serde_json::json!({"type":"leave"}))
    }
    pub fn quit(&mut self) -> std::io::Result<()> {
        self.send(&serde_json::json!({"type":"quit"}))
    }

    pub fn next_event(&mut self) -> std::io::Result<Option<EngineEvent>> {
        match self.rx.recv() {
            Ok(Ok(event)) => Ok(Some(event)),
            Ok(Err(err)) => Err(err),
            Err(_) => Ok(None),
        }
    }

    /// Like `next_event`, but returns `EngineEvent::Timeout` after `timeout`.
    pub fn next_event_timeout(
        &mut self,
        timeout: Duration,
    ) -> std::io::Result<Option<EngineEvent>> {
        match self.rx.recv_timeout(timeout) {
            Ok(Ok(event)) => Ok(Some(event)),
            Ok(Err(err)) => Err(err),
            Err(RecvTimeoutError::Timeout) => Ok(Some(EngineEvent::Timeout)),
            Err(RecvTimeoutError::Disconnected) => Ok(None),
        }
    }

    /// Wait for the next state, returning `None` on EOF or timeout.
    pub fn next_state_timeout(&mut self, timeout: Duration) -> std::io::Result<Option<GameState>> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            match self.next_event_timeout(remaining)? {
                Some(EngineEvent::State(state)) => return Ok(Some(state)),
                Some(EngineEvent::Timeout) | None => return Ok(None),
                Some(_) => continue,
            }
        }
    }

    /// Block until the next `state` event, returning the game state.
    pub fn next_state(&mut self) -> std::io::Result<Option<GameState>> {
        loop {
            match self.next_event()? {
                Some(EngineEvent::State(state)) => return Ok(Some(state)),
                Some(_) => continue,
                None => return Ok(None),
            }
        }
    }

    /// Wait for the engine process to exit and return its status code.
    pub fn wait_code(&mut self) -> Option<i32> {
        self.child.wait().ok().and_then(|s| s.code())
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.quit();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Find `engine/headless.cjs` relative to the current directory or the repo root.
pub fn default_engine_path() -> PathBuf {
    if let Ok(p) = std::env::var("REBUILDSIM_ENGINE") {
        return PathBuf::from(p);
    }
    let candidates = [
        Path::new("engine/headless.cjs"),
        Path::new("../engine/headless.cjs"),
        Path::new("headless.cjs"),
    ];
    for c in candidates {
        if c.exists() {
            return c.to_path_buf();
        }
    }
    PathBuf::from("engine/headless.cjs")
}

pub fn find_me<'a>(state: &'a GameState, username: &str) -> Option<&'a Robot> {
    state.robots.iter().find(|r| r.name == username)
}

/// Decode the packed fuel frame: u16 count, u16 record size, u32 reserved,
/// then `count` records of `present u8, x u16, y u16, z u16` in 1/4096 m
/// fixed point (0x8000 = zero).
fn decode_fuel(payload: &[u8]) -> Vec<Fuel> {
    if payload.len() < 8 {
        return Vec::new();
    }
    let count = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    let rec = u16::from_le_bytes([payload[2], payload[3]]) as usize;
    if rec < 7 || payload.len() < 8 + count * rec {
        return Vec::new();
    }
    let q = |o: usize| {
        let raw = u16::from_le_bytes([payload[o], payload[o + 1]]);
        (raw as f32 - 32768.0) / 4096.0
    };
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let off = 8 + i * rec;
        out.push(Fuel {
            id: i as u16,
            present: payload[off] == 1,
            x: q(off + 1),
            y: q(off + 3),
            z: q(off + 5) + 0.045,
        });
    }
    out
}
