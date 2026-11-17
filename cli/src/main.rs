#![allow(dead_code)]
//! REBUILDSIM headless bot CLI.
//!
//! Examples:
//!   rebuildsim-cli --code URUQM --username MyBot
//!   rebuildsim-cli --create --start --username TestBot --demo
//!
//! The CLI launches one headless engine (Node + the real game wasm) and exposes
//! a state/input API. Bot logic lives here; the engine handles the game UI,
//! netcode, simulation, and state extraction.

use rebuildsim_cli::engine::{
    Engine, EngineEvent, EngineOptions, GameState, Input, default_engine_path, find_me,
};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Debug)]
struct Args {
    code: Option<String>,
    username: String,
    spawnpoint: Option<String>,
    create: bool,
    start: bool,
    emit_hz: u32,
    asset_dir: Option<PathBuf>,
    engine: PathBuf,
    demo: bool,
    watch: bool,
    debug: bool,
    keyboard: bool,
    fuel: Option<String>,
    server: Option<String>,
    binary: bool,
    field_frame: bool,
    hub_order: Option<String>,
    expect_build: Option<String>,
    no_build_check: bool,
    state_timeout: u64,
    exit_on_ws_close: bool,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            code: None,
            username: "Bot".to_string(),
            spawnpoint: None,
            create: false,
            start: false,
            emit_hz: 10,
            asset_dir: None,
            engine: default_engine_path(),
            demo: false,
            watch: false,
            debug: false,
            keyboard: false,
            fuel: None,
            server: None,
            binary: true,
            field_frame: false,
            hub_order: None,
            expect_build: None,
            no_build_check: false,
            state_timeout: 5,
            exit_on_ws_close: true,
        }
    }
}

fn usage() {
    eprintln!(
        "rebuildsim-cli — headless REBUILD Simulator bot CLI

USAGE:
  rebuildsim-cli --code <LOBBY> --username <NAME> [OPTIONS]
  rebuildsim-cli --create --start --username <NAME> [OPTIONS]

OPTIONS:
  --code <CODE>       join an existing lobby by code
  --username <NAME>   display name (default: Bot)
  --spawnpoint <S>    reserved; currently ignored (infer spawn from pose)
  --create            test-only: create a lobby instead of joining
  --start             test-only: auto-ready/start when hosting
  --emit-hz <N>       state rate from the engine (default: 10)
  --asset-dir <DIR>   directory containing index.js/index.wasm (default: engine/cache)
  --engine <PATH>     path to engine/headless.cjs
  --demo              run a short forward/strafe/reverse/turn diagnostic (auto/teleop)
  --watch             print every state (otherwise every 5th)
  --debug             verbose engine logs
  --keyboard          use digital keyboard controls instead of the virtual gamepad
  --fuel <PCT>        host only: set the fuel-count rule (25, 50, 75, 100, 125, 150, ...)
  --server <HOST:PORT> connect to a local server build
  --json              use newline JSON (default is the binary fuel channel)
  --field-frame       report raw global coordinates instead of alliance-normalized
  --hub-order <red|blue> force the SHIFT 1 inactive hub (tied AUTO / practice)
  --expect-build <H>  fail fast unless the cached build hash matches H
  --no-build-check    skip the live server BUILD comparison
  --state-timeout <S> fail (exit 5) if no state arrives for S seconds in a match (default: 5)
  --allow-ws-close    keep running if the room WebSocket closes (default: exit 6)
  -h, --help          show this help

The engine downloads no assets by itself; run `node engine/prepare.mjs` first.
Bots should be run in private/consented lobbies only. See docs/SURVEY.md."
    );
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                usage();
                std::process::exit(0);
            }
            "--code" => a.code = Some(it.next().ok_or("--code needs a value")?),
            "--username" => a.username = it.next().ok_or("--username needs a value")?,
            "--spawnpoint" => a.spawnpoint = Some(it.next().ok_or("--spawnpoint needs a value")?),
            "--create" => a.create = true,
            "--start" => a.start = true,
            "--demo" => a.demo = true,
            "--watch" => a.watch = true,
            "--debug" => a.debug = true,
            "--keyboard" => a.keyboard = true,
            "--fuel" => a.fuel = Some(it.next().ok_or("--fuel needs a value")?),
            "--server" => a.server = Some(it.next().ok_or("--server needs a value")?),
            "--json" => a.binary = false,
            "--field-frame" => a.field_frame = true,
            "--hub-order" => a.hub_order = Some(it.next().ok_or("--hub-order needs red or blue")?),
            "--expect-build" => {
                a.expect_build = Some(it.next().ok_or("--expect-build needs a value")?)
            }
            "--no-build-check" => a.no_build_check = true,
            "--state-timeout" => {
                a.state_timeout = it
                    .next()
                    .ok_or("--state-timeout needs a value")?
                    .parse()
                    .map_err(|_| "invalid --state-timeout")?
            }
            "--emit-hz" => {
                a.emit_hz = it
                    .next()
                    .ok_or("--emit-hz needs a value")?
                    .parse()
                    .map_err(|_| "bad --emit-hz")?
            }
            "--asset-dir" => {
                a.asset_dir = Some(PathBuf::from(it.next().ok_or("--asset-dir needs a value")?))
            }
            "--engine" => a.engine = PathBuf::from(it.next().ok_or("--engine needs a value")?),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if a.code.is_none() && !a.create {
        return Err("pass --code <LOBBY> or --create".to_string());
    }
    if a.emit_hz == 0 || a.emit_hz > 60 {
        return Err("--emit-hz must be 1..60".to_string());
    }
    Ok(a)
}

fn print_seats(seats: &[rebuildsim_cli::engine::Seat]) {
    if seats.is_empty() {
        return;
    }
    let s: Vec<String> = seats
        .iter()
        .map(|x| format!("{}={}({})", x.seat, x.name, x.alliance))
        .collect();
    println!("seats: {}", s.join(" "));
}

fn print_state(state: &GameState, username: &str) {
    let me = state.me.as_ref().or_else(|| find_me(state, username));
    let me_s = match me {
        Some(r) => format!(
            "me={}({}:{} {:+.2},{:+.2}) h={:+.2} v=({:+.2},{:+.2}) hop={}",
            r.name,
            r.alliance,
            r.pose_source,
            r.x,
            r.y,
            r.heading,
            r.vx,
            r.vy,
            r.hopper_fuel
                .map(|h| h.to_string())
                .unwrap_or_else(|| "?".into())
        ),
        None => "me=?".to_string(),
    };
    let time = state
        .time
        .map(|t| format!("{t:.1}s"))
        .unwrap_or_else(|| "?".to_string());
    let fuel_count = state.fuel_count.unwrap_or(0);
    let hub = match state.hub.active {
        Some(true) => "hub=on",
        Some(false) => "hub=off",
        None => "hub=?",
    };
    println!(
        "state #{:<5} {:<10} t={:<7} score={}-{} {} robots={:<2} fuel={}/{} {}",
        state.seq,
        format!("{}/{}", state.phase, state.substage),
        time,
        state.red_score,
        state.blue_score,
        hub,
        state.robots.len(),
        state.fuel.len(),
        fuel_count,
        me_s
    );
}

fn main() {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: {e}\n");
            usage();
            std::process::exit(2);
        }
    };

    if let Some(spawn) = &args.spawnpoint {
        eprintln!(
            "note: --spawnpoint {spawn} is not wired yet; the engine will join with the default seat. \
             See docs/SURVEY.md §6."
        );
    }

    let mut opts = EngineOptions::new(&args.engine, &args.username);
    opts.code = args.code.clone();
    opts.create = args.create;
    opts.start = args.start;
    opts.spawn = args.spawnpoint.clone();
    opts.emit_hz = args.emit_hz;
    opts.asset_dir = args.asset_dir.clone();
    opts.debug = args.debug;
    opts.gamepad = !args.keyboard;
    opts.fuel = args.fuel.clone();
    opts.server = args.server.clone();
    opts.binary = args.binary;
    opts.field_frame = args.field_frame;
    opts.hub_order = args.hub_order.clone();
    opts.expect_build = args.expect_build.clone();
    opts.no_build_check = args.no_build_check;

    eprintln!("engine: {}", args.engine.display());
    let mut engine = match Engine::spawn(&opts) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("failed to start engine: {e}");
            std::process::exit(1);
        }
    };

    let mut demo = if args.demo {
        Some(Demo::default())
    } else {
        None
    };
    let mut states = 0u64;
    let state_timeout = Duration::from_secs(args.state_timeout.max(1));
    let mut in_match = false;
    let mut last_state = Instant::now();

    loop {
        if in_match && last_state.elapsed() > state_timeout {
            eprintln!(
                "state timeout: no state for {:.1}s; engine is stalled or disconnected",
                last_state.elapsed().as_secs_f64()
            );
            engine.kill();
            std::process::exit(5);
        }
        match engine.next_event_timeout(Duration::from_secs(1)) {
            Ok(Some(EngineEvent::Ready { build })) => {
                eprintln!(
                    "engine ready (build {})",
                    build.unwrap_or_else(|| "?".into())
                );
            }
            Ok(Some(EngineEvent::Room {
                code,
                host,
                seated,
                role,
                seats,
            })) => {
                println!(
                    "joined room {code} host={host} seated={seated} role={}",
                    role.unwrap_or_else(|| "?".into())
                );
                print_seats(&seats);
            }
            Ok(Some(EngineEvent::Seats { code, seats })) => {
                println!("room {code} seats updated");
                print_seats(&seats);
            }
            Ok(Some(EngineEvent::Match { phase, time, seats })) => {
                println!("match started phase={phase} time={time:?}");
                print_seats(&seats);
                in_match = true;
                last_state = Instant::now();
            }
            Ok(Some(EngineEvent::State(state))) => {
                states += 1;
                last_state = Instant::now();
                if args.watch || states == 1 || states % 5 == 0 {
                    print_state(&state, &args.username);
                }
                if let Some(d) = demo.as_mut() {
                    d.observe(&state);
                    if d.tick(&mut engine, &state).is_err() {
                        break;
                    }
                }
            }
            Ok(Some(EngineEvent::Build {
                build,
                server_build,
                ok,
            })) => {
                println!(
                    "build {} (server {})",
                    build,
                    server_build.unwrap_or_else(|| "?".into())
                );
                if !ok {
                    eprintln!("build check failed");
                }
            }
            Ok(Some(EngineEvent::Protocol { version })) => {
                println!("protocol version {version:?}");
            }
            Ok(Some(EngineEvent::Score {
                red,
                blue,
                auto_red,
                auto_blue,
            })) => {
                println!("score red={red} blue={blue} auto={auto_red}/{auto_blue}");
            }
            Ok(Some(EngineEvent::Error { error })) => {
                eprintln!("engine error: {error}");
            }
            Ok(Some(EngineEvent::Ws {
                state,
                id,
                code,
                reason,
                room,
                ..
            })) => {
                if state == "close" || state == "error" {
                    eprintln!(
                        "engine ws {state} id={id:?} code={code:?} room={room:?} reason={reason:?}"
                    );
                }
                if state == "close" && room == Some(true) && args.exit_on_ws_close {
                    eprintln!(
                        "room WebSocket closed; exiting (use --allow-ws-close to keep running)"
                    );
                    engine.kill();
                    std::process::exit(6);
                }
            }
            Ok(Some(EngineEvent::Heartbeat { .. }))
            | Ok(Some(EngineEvent::Timeout))
            | Ok(Some(EngineEvent::Pong { .. }))
            | Ok(Some(EngineEvent::Other)) => {}
            Ok(None) => {
                let code = engine.wait_code();
                eprintln!("engine exited code={code:?}");
                if let Some(c) = code {
                    if c != 0 {
                        std::process::exit(c);
                    }
                }
                break;
            }
            Err(e) => {
                eprintln!("engine read error: {e}");
                break;
            }
        }
    }

    engine.kill();
}

#[derive(Default)]
struct Demo {
    start: Option<Instant>,
    phase: u8,
}

impl Demo {
    fn observe(&mut self, state: &GameState) {
        if self.start.is_none() && (state.phase == "auto" || state.phase == "teleop") {
            eprintln!("demo: auto/teleop detected (phase={})", state.phase);
            self.start = Some(Instant::now());
            self.phase = 0;
        }
    }

    fn tick(&mut self, engine: &mut Engine, _state: &GameState) -> std::io::Result<()> {
        let Some(start) = self.start else {
            return Ok(());
        };
        let e = start.elapsed().as_secs_f32();
        let step = |engine: &mut Engine, input: Input| -> std::io::Result<()> {
            engine.send_input(&input)
        };
        match self.phase {
            0 if e >= 0.5 => {
                eprintln!("demo: forward");
                step(
                    engine,
                    Input {
                        y: 1.0,
                        ..Default::default()
                    },
                )?;
                self.phase = 1;
            }
            1 if e >= 3.0 => {
                eprintln!("demo: stop");
                step(engine, Input::default())?;
                self.phase = 2;
            }
            2 if e >= 4.5 => {
                eprintln!("demo: strafe right");
                step(
                    engine,
                    Input {
                        x: 1.0,
                        ..Default::default()
                    },
                )?;
                self.phase = 3;
            }
            3 if e >= 6.5 => {
                eprintln!("demo: stop");
                step(engine, Input::default())?;
                self.phase = 4;
            }
            4 if e >= 8.0 => {
                eprintln!("demo: reverse");
                step(
                    engine,
                    Input {
                        y: -1.0,
                        ..Default::default()
                    },
                )?;
                self.phase = 5;
            }
            5 if e >= 10.0 => {
                eprintln!("demo: stop");
                step(engine, Input::default())?;
                self.phase = 6;
            }
            6 if e >= 11.0 => {
                eprintln!("demo: turn");
                step(
                    engine,
                    Input {
                        rotate: 1.0,
                        ..Default::default()
                    },
                )?;
                self.phase = 7;
            }
            7 if e >= 13.0 => {
                eprintln!("demo: stop/done");
                step(engine, Input::default())?;
                self.phase = 8;
            }
            _ => {}
        }
        Ok(())
    }
}
