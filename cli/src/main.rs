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
    validate_server,
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
    restart_on_exit: bool,
    max_restarts: u32,
    join_timeout: u64,
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
            restart_on_exit: false,
            max_restarts: 3,
            join_timeout: 60,
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
  --fuel <PCT>        host only: fuel rule (25, 50, 75, 100, 125, 150; % optional)
  --server <HOST:PORT> connect to a local server build
  --json              use newline JSON (default is the binary fuel channel)
  --field-frame       report raw global coordinates instead of alliance-normalized
  --hub-order <red|blue> force the SHIFT 1 inactive hub (tied AUTO / practice)
  --expect-build <H>  fail fast unless the cached build hash matches H
  --no-build-check    skip the live server BUILD comparison
  --state-timeout <S> fail (exit 5) if no state arrives for S seconds in a match (default: 5)
  --allow-ws-close    keep running if the room WebSocket closes (default: exit 6)
  --restart-on-exit   rejoin the lobby after a disconnect (join mode only)
  --max-restarts <N>  restart limit with --restart-on-exit (default: 3)
  --join-timeout <S>  fail (exit 5) if no room/seat state within S seconds (default: 60)
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
            "--spawnpoint" => {
                let value = it.next().ok_or("--spawnpoint needs a value")?;
                if value.trim().is_empty() || value != value.trim() || value.starts_with('-') {
                    return Err("invalid --spawnpoint".into());
                }
                a.spawnpoint = Some(value);
            }
            "--create" => a.create = true,
            "--start" => a.start = true,
            "--demo" => a.demo = true,
            "--watch" => a.watch = true,
            "--debug" => a.debug = true,
            "--keyboard" => a.keyboard = true,
            "--fuel" => {
                let value = it.next().ok_or("--fuel needs a value")?;
                let normalized = value.strip_suffix('%').unwrap_or(&value);
                if !["25", "50", "75", "100", "125", "150"].contains(&normalized) {
                    return Err("--fuel must be one of 25, 50, 75, 100, 125, 150".into());
                }
                a.fuel = Some(normalized.to_string());
            }
            "--server" => {
                let value = it.next().ok_or("--server needs a value")?;
                validate_server(&value)?;
                a.server = Some(value);
            }
            "--json" => a.binary = false,
            "--field-frame" => a.field_frame = true,
            "--hub-order" => {
                let value = it.next().ok_or("--hub-order needs red or blue")?;
                if !matches!(value.as_str(), "red" | "blue" | "r" | "b" | "R" | "B") {
                    return Err("--hub-order must be red or blue".into());
                }
                a.hub_order = Some(value);
            }
            "--expect-build" => {
                let value = it.next().ok_or("--expect-build needs a value")?;
                if value.trim().is_empty() || value != value.trim() || value.starts_with('-') {
                    return Err("--expect-build must not be empty or padded".into());
                }
                a.expect_build = Some(value);
            }
            "--no-build-check" => a.no_build_check = true,
            "--state-timeout" => {
                a.state_timeout = it
                    .next()
                    .ok_or("--state-timeout needs a value")?
                    .parse()
                    .map_err(|_| "invalid --state-timeout")?;
                if a.state_timeout == 0 {
                    return Err("--state-timeout must be at least 1".into());
                }
            }
            "--allow-ws-close" => a.exit_on_ws_close = false,
            "--restart-on-exit" => a.restart_on_exit = true,
            "--max-restarts" => {
                a.max_restarts = it
                    .next()
                    .ok_or("--max-restarts needs a value")?
                    .parse()
                    .map_err(|_| "invalid --max-restarts")?
            }
            "--join-timeout" => {
                a.join_timeout = it
                    .next()
                    .ok_or("--join-timeout needs a value")?
                    .parse()
                    .map_err(|_| "invalid --join-timeout")?;
                if a.join_timeout == 0 {
                    return Err("--join-timeout must be at least 1".into());
                }
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
            "--engine" => {
                let value = it.next().ok_or("--engine needs a value")?;
                if value.trim().is_empty() || value != value.trim() || value.starts_with('-') {
                    return Err("--engine must be a path, not an option".into());
                }
                a.engine = PathBuf::from(value);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    if a.username.is_empty()
        || a.username != a.username.trim()
        || a.username.len() > 10
        || a.username.starts_with('-')
        || !a.username.bytes().all(|b| (0x20..=0x7e).contains(&b))
    {
        return Err(
            "--username must be 1-10 ASCII characters without leading/trailing spaces".into(),
        );
    }
    if let Some(code) = &a.code {
        if code.len() != 5 || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("--code must be a 5-character alphanumeric room code".to_string());
        }
    }
    if a.code.is_some() && a.create {
        return Err("use --code <LOBBY> or --create, not both".to_string());
    }
    if a.code.is_none() && !a.create {
        return Err("pass --code <LOBBY> or --create".to_string());
    }
    if let Some(code) = &a.code {
        if code.trim().is_empty() {
            return Err("--code must not be empty".to_string());
        }
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

fn spawn_engine(opts: &EngineOptions) -> Engine {
    match Engine::spawn(opts) {
        Ok(engine) => engine,
        Err(e) => {
            eprintln!("failed to start engine: {e}");
            std::process::exit(1);
        }
    }
}

fn restart_engine(opts: &EngineOptions, restarts: &mut u32, max_restarts: u32) -> Option<Engine> {
    if *restarts >= max_restarts {
        eprintln!("restart limit ({max_restarts}) reached");
        return None;
    }
    *restarts += 1;
    eprintln!(
        "restarting engine after disconnect ({}/{}) in 2s...",
        *restarts, max_restarts
    );
    std::thread::sleep(Duration::from_secs(2));
    match Engine::spawn(opts) {
        Ok(engine) => Some(engine),
        Err(e) => {
            eprintln!("restart failed: {e}");
            None
        }
    }
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
    let mut engine = spawn_engine(&opts);
    let mut restarts = 0u32;

    let mut demo = if args.demo {
        Some(Demo::default())
    } else {
        None
    };
    let mut states = 0u64;
    let state_timeout = Duration::from_secs(args.state_timeout.max(1));
    let mut started_at = Instant::now();
    let mut in_match = false;
    let mut ready_seen = false;
    let mut joined = false;
    let mut room_state_seen = false;
    let mut join_started: Option<Instant> = None;
    let mut last_state = Instant::now();
    let mut last_heartbeat = Instant::now();
    let mut match_seen = false;
    let mut fatal_error = false;
    let mut spectator_pending: Option<Instant> = None;

    loop {
        if let Some(t) = spectator_pending {
            if t.elapsed() > Duration::from_secs(1) {
                eprintln!("no driver seat after room update; exiting");
                engine.shutdown(Duration::from_secs(1));
                std::process::exit(7);
            }
        }
        if !ready_seen && started_at.elapsed() > Duration::from_secs(30) {
            eprintln!("engine did not become ready within 30s; exiting");
            engine.shutdown(Duration::from_secs(1));
            std::process::exit(5);
        }
        if let Some(t) = join_started {
            if t.elapsed() > Duration::from_secs(args.join_timeout.max(1)) {
                eprintln!(
                    "join timeout: no room state after {:.1}s; engine is stalled or blocked",
                    t.elapsed().as_secs_f64()
                );
                engine.shutdown(Duration::from_secs(1));
                std::process::exit(5);
            }
        }
        if ready_seen && last_heartbeat.elapsed() > Duration::from_secs(15) {
            eprintln!("heartbeat timeout: engine event loop is stalled; exiting");
            engine.shutdown(Duration::from_secs(1));
            std::process::exit(5);
        }
        if in_match && last_state.elapsed() > state_timeout {
            eprintln!(
                "state timeout: no state for {:.1}s; engine is stalled or disconnected",
                last_state.elapsed().as_secs_f64()
            );
            engine.shutdown(Duration::from_secs(1));
            std::process::exit(5);
        }
        match engine.next_event_timeout(Duration::from_secs(1)) {
            Ok(Some(EngineEvent::Ready { build })) => {
                eprintln!(
                    "engine ready (build {})",
                    build.unwrap_or_else(|| "?".into())
                );
                ready_seen = true;
                join_started = Some(Instant::now());
                last_heartbeat = Instant::now();
                fatal_error = false;
            }
            Ok(Some(EngineEvent::Room {
                code,
                host,
                seated,
                role,
                seats,
                match_active,
            })) => {
                println!(
                    "joined room {code} host={host} seated={seated} role={}",
                    role.unwrap_or_else(|| "?".into())
                );
                print_seats(&seats);
                joined = true;
                if room_state_seen || !seats.is_empty() {
                    room_state_seen = true;
                    join_started = None;
                }
                last_heartbeat = Instant::now();
                if let Some(active) = match_active {
                    in_match = active;
                    match_seen = active;
                    last_state = Instant::now();
                } else {
                    // Legacy engine: a room event means we are back in the
                    // lobby, so do not leave a stale in-match watchdog armed.
                    in_match = false;
                    match_seen = false;
                    last_state = Instant::now();
                }
                if !seated {
                    eprintln!("room reports no driver seat; waiting for engine outcome");
                    spectator_pending = Some(Instant::now());
                } else {
                    spectator_pending = None;
                }
            }
            Ok(Some(EngineEvent::Seats { code, seats })) => {
                println!("room {code} seats updated");
                print_seats(&seats);
                room_state_seen = true;
                join_started = None;
                last_heartbeat = Instant::now();
            }
            Ok(Some(EngineEvent::Match {
                phase,
                substage,
                time,
                seats,
            })) => {
                println!("match started phase={phase} substage={substage} time={time:?}");
                print_seats(&seats);
                spectator_pending = None;
                in_match = true;
                match_seen = true;
                restarts = 0;
                last_state = Instant::now();
                last_heartbeat = Instant::now();
                if demo.is_some() {
                    demo = Some(Demo::default());
                }
            }
            Ok(Some(EngineEvent::State(state))) => {
                states += 1;
                last_state = Instant::now();
                last_heartbeat = Instant::now();
                if state.phase == "end" {
                    in_match = false;
                    // Do not re-arm match_seen here: a Room{match_active:false}
                    // may already have cleared it for lobby restart.
                } else {
                    in_match = true;
                    match_seen = true;
                }
                if args.watch || states == 1 || states % 5 == 0 {
                    print_state(&state, &args.username);
                }
                if let Some(d) = demo.as_mut() {
                    d.observe(&state);
                    if let Err(e) = d.tick(&mut engine, &state) {
                        eprintln!("demo input error: {e}");
                        engine.shutdown(Duration::from_secs(1));
                        std::process::exit(1);
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
                if ok == Some(false) {
                    eprintln!("build check failed");
                    engine.shutdown(Duration::from_secs(1));
                    std::process::exit(3);
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
            Ok(Some(EngineEvent::Error {
                error,
                detail,
                extra,
            })) => {
                if error == "match_clock_stalled" {
                    eprintln!("engine reported a stalled match clock; exiting");
                    engine.shutdown(Duration::from_secs(1));
                    std::process::exit(5);
                }
                if error == "not_all_ready" {
                    eprintln!("host could not start: not all seats ready; exiting");
                    engine.shutdown(Duration::from_secs(1));
                    std::process::exit(5);
                }
                if matches!(
                    error.as_str(),
                    "memory_unavailable"
                        | "game_boot_failed"
                        | "build_drift"
                        | "asset_hash_mismatch"
                        | "protocol_mismatch"
                ) {
                    fatal_error = true;
                }
                let extra = if extra.is_empty() {
                    String::new()
                } else {
                    format!(" {}", serde_json::to_string(&extra).unwrap_or_default())
                };
                eprintln!(
                    "engine error: {error}{}{extra}",
                    detail
                        .filter(|d| !d.trim().is_empty())
                        .map(|d| format!(" ({d})"))
                        .unwrap_or_default()
                );
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
                    engine.shutdown(Duration::from_secs(1));
                    if args.restart_on_exit
                        && args.code.is_some()
                        && !in_match
                        && !match_seen
                        && !fatal_error
                    {
                        if let Some(new_engine) =
                            restart_engine(&opts, &mut restarts, args.max_restarts)
                        {
                            engine = new_engine;
                            if demo.is_some() {
                                demo = Some(Demo::default());
                            }
                            joined = false;
                            room_state_seen = false;
                            ready_seen = false;
                            join_started = None;
                            fatal_error = false;
                            spectator_pending = None;
                            started_at = Instant::now();
                            last_state = Instant::now();
                            last_heartbeat = Instant::now();
                            continue;
                        }
                    }
                    std::process::exit(6);
                }
            }
            Ok(Some(EngineEvent::Heartbeat { .. })) => {
                last_heartbeat = Instant::now();
            }
            Ok(Some(EngineEvent::Timeout))
            | Ok(Some(EngineEvent::Pong { .. }))
            | Ok(Some(EngineEvent::Other)) => {}
            Ok(None) => {
                let code = engine.wait_code_timeout(Duration::from_secs(2));
                eprintln!("engine exited code={code:?}");
                let retryable = args.restart_on_exit
                    && args.code.is_some()
                    && !in_match
                    && !match_seen
                    && !fatal_error
                    && matches!(code, Some(1));
                if retryable {
                    if let Some(new_engine) =
                        restart_engine(&opts, &mut restarts, args.max_restarts)
                    {
                        engine = new_engine;
                        if demo.is_some() {
                            demo = Some(Demo::default());
                        }
                        joined = false;
                        room_state_seen = false;
                        ready_seen = false;
                        join_started = None;
                        fatal_error = false;
                        spectator_pending = None;
                        started_at = Instant::now();
                        last_state = Instant::now();
                        last_heartbeat = Instant::now();
                        continue;
                    }
                }
                match code {
                    Some(0) if joined && !in_match => break,
                    Some(0) => {
                        eprintln!(
                            "engine exited normally before/inside a match; treating as failure"
                        );
                        std::process::exit(5);
                    }
                    Some(c) => std::process::exit(c),
                    None => {
                        eprintln!("engine exited without a status code");
                        std::process::exit(5);
                    }
                }
            }
            Err(e) => {
                eprintln!("engine read error: {e}");
                engine.shutdown(Duration::from_secs(1));
                std::process::exit(5);
            }
        }
    }

    engine.shutdown(Duration::from_secs(1));
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
