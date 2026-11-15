//! Headless engine process wrapper and the public state/input API.
//!
//! The engine is the Node harness in `engine/headless.cjs`. It speaks JSON lines:
//! engine -> CLI: `ready`, `room`, `match`, `state`, `pong`
//! CLI -> engine: `input`, `ready`, `start`, `leave`, `quit`, `ping`.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

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
    },
    #[serde(rename = "match")]
    Match { phase: String, time: Option<f64> },
    #[serde(rename = "state")]
    State(GameState),
    #[serde(rename = "pong")]
    Pong { t: f64 },
    #[serde(other)]
    Other,
}

pub struct Engine {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
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
        Ok(Self { child, stdin, stdout })
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
        loop {
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line)?;
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
