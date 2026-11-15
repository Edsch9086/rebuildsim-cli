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

use rebuildsim_cli::engine::{default_engine_path, find_me, Engine, EngineEvent, EngineOptions, GameState, Input};
use std::path::PathBuf;
use std::time::Instant;

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
  --spawnpoint <S>    requested spawn point (e.g. red1, blue2)
  --create            create a lobby instead of joining
  --start             start the match when host
  --emit-hz <N>       state rate from the engine (default: 10)
  --asset-dir <DIR>   directory containing index.js/index.wasm (default: engine/cache)
  --engine <PATH>     path to engine/headless.cjs
  --demo              run a short forward/strafe/reverse/turn diagnostic in teleop
  --watch             print every state (otherwise every 5th)
  --debug             verbose engine logs
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
            "-h" | "--help" => { usage(); std::process::exit(0); }
            "--code" => a.code = Some(it.next().ok_or("--code needs a value")?),
            "--username" => a.username = it.next().ok_or("--username needs a value")?,
            "--spawnpoint" => a.spawnpoint = Some(it.next().ok_or("--spawnpoint needs a value")?),
            "--create" => a.create = true,
            "--start" => a.start = true,
            "--demo" => a.demo = true,
            "--watch" => a.watch = true,
            "--debug" => a.debug = true,
            "--emit-hz" => {
                a.emit_hz = it.next().ok_or("--emit-hz needs a value")?.parse().map_err(|_| "bad --emit-hz")?
            }
            "--asset-dir" => a.asset_dir = Some(PathBuf::from(it.next().ok_or("--asset-dir needs a value")?)),
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

fn print_state(state: &GameState, username: &str) {
    let me = find_me(state, username);
    let me_s = match me {
        Some(r) => format!(
            "me=({:+.2},{:+.2}) h={:+.2} v=({:+.2},{:+.2})",
            r.x, r.y, r.heading, r.vx, r.vy
        ),
        None => "me=?".to_string(),
    };
    let time = state.time.map(|t| format!("{t:.1}s")).unwrap_or_else(|| "?".to_string());
    println!(
        "state #{:<5} phase={:<6} time={:<7} robots={:<2} fuel={:<3} {}",
        state.seq,
        state.phase,
        time,
        state.robots.len(),
        state.fuel.len(),
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

    loop {
        match engine.next_event() {
            Ok(Some(EngineEvent::Ready { build })) => {
                eprintln!("engine ready (build {})", build.unwrap_or_else(|| "?".into()));
            }
            Ok(Some(EngineEvent::Room { code, host, seated, role })) => {
                println!(
                    "joined room {code} host={host} seated={seated} role={}",
                    role.unwrap_or_else(|| "?".into())
                );
            }
            Ok(Some(EngineEvent::Match { phase, time })) => {
                println!("match started phase={phase} time={time:?}");
            }
            Ok(Some(EngineEvent::State(state))) => {
                states += 1;
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
            Ok(Some(EngineEvent::Pong { .. })) | Ok(Some(EngineEvent::Other)) => {}
            Ok(None) => {
                eprintln!("engine exited");
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
        if self.start.is_none() && state.phase == "teleop" {
            eprintln!("demo: teleop detected");
            self.start = Some(Instant::now());
            self.phase = 0;
        }
    }

    fn tick(&mut self, engine: &mut Engine, _state: &GameState) -> std::io::Result<()> {
        let Some(start) = self.start else { return Ok(()); };
        let e = start.elapsed().as_secs_f32();
        let step = |engine: &mut Engine, input: Input| -> std::io::Result<()> {
            engine.send_input(&input)
        };
        match self.phase {
            0 if e >= 0.5 => { eprintln!("demo: forward"); step(engine, Input { y: 1.0, ..Default::default() })?; self.phase = 1; }
            1 if e >= 3.0 => { eprintln!("demo: stop"); step(engine, Input::default())?; self.phase = 2; }
            2 if e >= 4.5 => { eprintln!("demo: strafe right"); step(engine, Input { x: 1.0, ..Default::default() })?; self.phase = 3; }
            3 if e >= 6.5 => { eprintln!("demo: stop"); step(engine, Input::default())?; self.phase = 4; }
            4 if e >= 8.0 => { eprintln!("demo: reverse"); step(engine, Input { y: -1.0, ..Default::default() })?; self.phase = 5; }
            5 if e >= 10.0 => { eprintln!("demo: stop"); step(engine, Input::default())?; self.phase = 6; }
            6 if e >= 11.0 => { eprintln!("demo: turn"); step(engine, Input { rotate: 1.0, ..Default::default() })?; self.phase = 7; }
            7 if e >= 13.0 => { eprintln!("demo: stop/done"); step(engine, Input::default())?; self.phase = 8; }
            _ => {}
        }
        Ok(())
    }
}
