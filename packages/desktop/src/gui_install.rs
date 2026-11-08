//! The graphical install: the app runs Codeman's installer itself and the
//! connect page is its interface, so a fresh Mac needs neither Terminal nor an
//! administrator password.
//!
//! `install.sh --no-admin` is what makes that possible: it puts Node.js and
//! tmux in the home folder, so nothing in it asks for a password, and the two
//! questions only a person can answer (which coding agent, who may reach
//! Codeman) are asked by the page and passed as flags. The Terminal route in
//! `terminal_install.rs` stays for what this one cannot do, a Mac older than
//! macOS 15 with no tmux first of all.
//!
//! `prepare` downloads the installer once into a private folder and asks it
//! what is on this Mac (`install.sh preflight`); `start` runs the same file with
//! every answer given; `follow` reports what it prints.
//!
//! **Its output goes to a file, never a pipe.** With a pipe, quitting the app
//! would kill the installer at its next write, half way through an install. The
//! file also holds the whole run, so `follow` can start over from the top: a
//! connect page that was reloaded, or an app that was quit and opened again,
//! finds the running install in `ps` and replays it. That is why this module
//! keeps no state about a run but the file and the process.
//!
//! Adding a coding agent to a Mac that has Codeman is the same machinery with a
//! smaller job: `install.sh agent <id>`. It is a [`Run`] of its own, in a folder
//! of its own, because everything else here reads a running install as "Codeman
//! is being installed", and because it touches no service, so it may run next to
//! a live server, which `refuse_start` exists to prevent for an install.

use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::local_server;
use crate::setup;

const SCRIPT_FILE: &str = "install.sh";
const OUTPUT_FILE: &str = "install.out";

/// The `install.sh preflight` schema this app understands.
const PREFLIGHT_SCHEMA: u32 = 1;

/// What the app asks the installer. `--no-admin` here and on an agent run: it
/// decides which agents count as installable, so the two must agree, or the page
/// offers one the run refuses.
const PREFLIGHT_ARGS: [&str; 2] = ["preflight", "--no-admin"];

const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(60);

/// How often `follow` looks at the output file and the process.
const POLL: Duration = Duration::from_millis(500);

/// How long the installer gets to end after Cancel before it is killed.
const CANCEL_GRACE: Duration = Duration::from_secs(5);

/// One line of output, for the page's details view.
const MAX_LOG_LINE: usize = 500;

/// When the login shell's PATH cannot be read.
const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// Lines of the installer's output protocol (`progress_phase` in install.sh).
const PROTOCOL_PREFIX: &str = "@@codeman ";

/// Set by Cancel, so `follow` can tell a cancelled run from a failed one.
static CANCELLED: AtomicBool = AtomicBool::new(false);

/// The two things the app runs the installer for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Run {
    /// Install Codeman (`start`).
    Codeman,
    /// Add one coding agent (`start_agent`).
    Agent,
}

impl Run {
    /// The folder under the per-user temporary folder that holds the run. A
    /// fixed name, so an app that was opened again finds it.
    fn folder(self) -> &'static str {
        match self {
            Run::Codeman => "codeman-install",
            Run::Agent => "codeman-agent",
        }
    }

    fn dir(self) -> PathBuf {
        std::env::temp_dir().join(self.folder())
    }

    /// Whether a command line is this run. `preflight` from the same file is
    /// not one: it has no `--progress`.
    pub fn matches(self, command: &str) -> bool {
        let suffix = format!("/{}/{SCRIPT_FILE}", self.folder());
        command.split_whitespace().any(|w| w.ends_with(&suffix))
            && command.split_whitespace().any(|w| w == "--progress")
    }

    /// A process of this run, if it is running.
    pub fn process(self) -> Option<u32> {
        setup::list_processes()
            .into_iter()
            .find(|(_, command)| self.matches(command))
            .map(|(pid, _)| pid)
    }
}

/// What `install.sh preflight` found. Fields the installer adds later are
/// ignored here, and `schema` changes when one changes meaning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub schema: u32,
    pub os: String,
    pub arch: String,
    /// Why `--no-admin` cannot finish on this Mac; empty when it can.
    pub blocker: String,
    pub needs: Needs,
    pub clis: Vec<CliEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Needs {
    pub node: bool,
    pub tmux: bool,
    pub git: bool,
}

/// One coding agent of the installer's catalogue. The app has no list of its
/// own, so a new agent appears here without a new app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CliEntry {
    pub id: String,
    pub label: String,
    pub installed: bool,
    pub installable: bool,
    pub docs: String,
}

/// What the person chose on the connect page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub port: u16,
    /// Reachable from other devices, with this login password. `None`: this
    /// Mac only.
    pub network_password: Option<String>,
    /// The catalogue id of the agent to install. `None`: none.
    pub ai_cli: Option<String>,
}

/// `install.sh`'s arguments for adding one agent. The id is in the shape
/// `policy::is_cli_id` allows, and the installer checks it against its catalogue.
pub fn agent_args(id: &str) -> Vec<String> {
    ["agent", id, "--no-admin", "--progress"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// `install.sh`'s flags for a graphical install. The password is not among
/// them: anything here can be read in `ps`. Always `--service`, like the
/// Terminal route: a LaunchAgent runs Codeman, so it keeps running when the app
/// quits. Always `--ai-cli`: without it `CODEMAN_NONINTERACTIVE` would install
/// the first agent of the catalogue by itself.
pub fn install_args(plan: &Plan) -> Vec<String> {
    let mut args: Vec<String> = ["--no-admin", "--progress", "--service"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.push(
        if plan.network_password.is_some() {
            "--lan"
        } else {
            "--local"
        }
        .to_string(),
    );
    args.push("--port".to_string());
    args.push(plan.port.to_string());
    args.push("--ai-cli".to_string());
    args.push(plan.ai_cli.clone().unwrap_or_else(|| "none".to_string()));
    args
}

/// There is no terminal, so `CODEMAN_NONINTERACTIVE` is what lets
/// `headless_guard` go ahead.
fn no_terminal_env() -> Vec<(String, String)> {
    vec![("CODEMAN_NONINTERACTIVE".to_string(), "1".to_string())]
}

/// What a graphical install adds to the environment.
pub fn install_env(plan: &Plan) -> Vec<(String, String)> {
    let mut env = no_terminal_env();
    if let Some(password) = &plan.network_password {
        env.push(("CODEMAN_PASSWORD".to_string(), password.clone()));
    }
    if let Some(branch) = setup::INSTALL_BRANCH {
        env.push(("CODEMAN_BRANCH".to_string(), branch.to_string()));
    }
    env
}

/// Read what `install.sh preflight` printed. An installer without that
/// subcommand ends before this; one that speaks another schema stops here.
pub fn parse_preflight(stdout: &str) -> Result<Preflight, String> {
    let found: Preflight = serde_json::from_str(stdout.trim())
        .map_err(|_| "The installer gave an answer this app cannot read.".to_string())?;
    if found.schema != PREFLIGHT_SCHEMA {
        return Err(format!(
            "This installer speaks a newer language than this app (schema {}). Update Codeman Desktop, or install in Terminal.",
            found.schema
        ));
    }
    Ok(found)
}

/// A fresh folder for a run, for this user only. The per-user temporary folder
/// of macOS is private already; the mode covers a `TMPDIR` that is not.
fn fresh_run_dir(run: Run) -> Result<PathBuf, String> {
    let dir = run.dir();
    match fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Could not clear {}: {e}", dir.display())),
    }
    DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The login shell's environment, so the installer finds the Node.js, git and
/// agents this person already has, wherever their profile puts them on PATH. A
/// double-clicked app gets launchd's bare PATH instead (see local_server.rs).
fn installer_env() -> Vec<(String, String)> {
    with_path(local_server::login_environment().unwrap_or_default())
}

fn with_path(mut env: Vec<(String, String)>) -> Vec<(String, String)> {
    if !env.iter().any(|(k, _)| k == "PATH") {
        env.push(("PATH".to_string(), FALLBACK_PATH.to_string()));
    }
    env
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

fn download_installer(script: &Path) -> Result<(), String> {
    let mut cmd = Command::new("/usr/bin/curl");
    cmd.args(["-fsSL", "--connect-timeout", "15", "-o"])
        .arg(script)
        .arg(setup::INSTALLER_URL);
    let out = local_server::exec_bounded(
        cmd,
        Instant::now() + DOWNLOAD_TIMEOUT,
        "Downloading the installer took too long, so it was stopped.",
    )?;
    if out.code == Some(0) && script.is_file() {
        return Ok(());
    }
    const FAILED: &str = "Could not download the installer. Check the internet connection, then try again.";
    let said = out.stderr.trim();
    Err(if said.is_empty() {
        FAILED.to_string()
    } else {
        format!("{FAILED}\n{said}")
    })
}

fn ask_installer(script: &Path, env: &[(String, String)]) -> Result<Preflight, String> {
    let mut cmd = Command::new("/bin/bash");
    cmd.arg(script)
        .args(PREFLIGHT_ARGS)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .current_dir(home());
    let out = local_server::exec_bounded(
        cmd,
        Instant::now() + PREFLIGHT_TIMEOUT,
        "The installer took too long to look at this Mac, so it was stopped.",
    )?;
    if out.code != Some(0) {
        return Err("This installer cannot run from the app yet. Install in Terminal instead.".to_string());
    }
    parse_preflight(&out.stdout)
}

/// Get the installer and ask it what is on this Mac.
pub fn prepare() -> Result<Preflight, String> {
    if let Some(why) = refuse_start() {
        return Err(why);
    }
    fetch_and_ask(Run::Codeman)
}

/// The same for adding an agent, where a running Codeman is the normal case.
pub fn prepare_agent() -> Result<Preflight, String> {
    if let Some(why) = refuse_second_run() {
        return Err(why);
    }
    fetch_and_ask(Run::Agent)
}

fn fetch_and_ask(run: Run) -> Result<Preflight, String> {
    let dir = fresh_run_dir(run)?;
    let script = dir.join(SCRIPT_FILE);
    download_installer(&script)?;
    ask_installer(&script, &installer_env())
}

/// One run at a time: both may install into the same runtime folder.
fn refuse_second_run() -> Option<String> {
    if Run::Codeman.process().is_some() {
        return Some("Codeman is already being installed.".to_string());
    }
    if Run::Agent.process().is_some() {
        return Some("A coding agent is already being installed.".to_string());
    }
    None
}

/// Why no install may start now: a run is going, or a Codeman server is and the
/// installer's service step would replace it under its sessions.
fn refuse_start() -> Option<String> {
    refuse_second_run().or_else(setup::already_running)
}

/// Run the installer `prepare` fetched. It outlives the app (see the module
/// docs): when an app's job ends, launchd kills what is left in that job's
/// process group, so the installer gets a group of its own. A thread reaps it
/// if it ends first.
pub fn start(plan: &Plan) -> Result<(), String> {
    if let Some(why) = refuse_start() {
        return Err(why);
    }
    spawn_run(Run::Codeman, &install_args(plan), &install_env(plan))
}

/// Add one coding agent. Runs the same way as an install, so it outlives the
/// app too, and leaves a running Codeman alone.
pub fn start_agent(id: &str) -> Result<(), String> {
    if let Some(why) = refuse_second_run() {
        return Err(why);
    }
    spawn_run(Run::Agent, &agent_args(id), &no_terminal_env())
}

fn spawn_run(run: Run, args: &[String], env: &[(String, String)]) -> Result<(), String> {
    let dir = run.dir();
    let script = dir.join(SCRIPT_FILE);
    if !script.is_file() {
        return Err("The installer is gone from the temporary folder. Try again.".to_string());
    }
    let output = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(dir.join(OUTPUT_FILE))
        .map_err(|e| format!("Could not start the installer: {e}"))?;
    let stderr = output
        .try_clone()
        .map_err(|e| format!("Could not start the installer: {e}"))?;
    CANCELLED.store(false, Ordering::SeqCst);
    let mut child = Command::new("/bin/bash")
        .arg(&script)
        .args(args)
        .envs(installer_env())
        .envs(env.iter().map(|(k, v)| (k, v)))
        .current_dir(home())
        .stdin(Stdio::null())
        .stdout(output)
        .stderr(stderr)
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Could not start the installer: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The process group of `pid`. `Run::process` may answer with one of the
/// installer's subshells, which `ps` shows with the installer's own command
/// line, so its pid is not always the group's.
fn group_of(pid: u32) -> Option<u32> {
    let out = Command::new("/bin/ps")
        .args(["-o", "pgid=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .ok()
        .filter(|g| *g > 1)
}

fn signal_group(group: u32, signal: &str) {
    let _ = Command::new("/bin/kill")
        .arg(format!("-{signal}"))
        .arg("--")
        .arg(format!("-{group}"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Stop the running install and whatever it started. What it left behind is
/// picked up by the next run: `install.sh` re-runs a partial install in full.
pub fn cancel() {
    let running = [Run::Codeman, Run::Agent]
        .into_iter()
        .find_map(|run| Some((run, run.process().and_then(group_of)?)));
    let Some((run, group)) = running else {
        return;
    };
    CANCELLED.store(true, Ordering::SeqCst);
    signal_group(group, "TERM");
    let deadline = Instant::now() + CANCEL_GRACE;
    while Instant::now() < deadline {
        if run.process().is_none() {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    signal_group(group, "KILL");
}

/// Drop terminal colour and cursor sequences.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        }
    }
    out
}

/// One line of the installer's output.
#[derive(Debug, PartialEq, Eq)]
enum Line {
    Phase(String),
    Error(String),
    Text(String),
}

fn parse_line(raw: &str) -> Line {
    let line = strip_ansi(raw.trim_end_matches('\r'));
    if let Some(rest) = line.strip_prefix(PROTOCOL_PREFIX) {
        let (word, text) = rest.split_once(' ').unwrap_or((rest, ""));
        match word {
            "phase" if !text.is_empty() && text.chars().all(|c| c.is_ascii_lowercase()) => {
                return Line::Phase(text.to_string())
            }
            "error" if !text.is_empty() => return Line::Error(text.to_string()),
            _ => {}
        }
    }
    Line::Text(line)
}

/// What a run has said so far.
#[derive(Debug, Default)]
pub struct Progress {
    partial: Vec<u8>,
    phase: Option<String>,
    /// The first error: the cause. The ones after it are its consequences.
    error: Option<String>,
    done: bool,
}

impl Progress {
    fn take_line(&mut self, raw: &str, log: &mut Vec<String>) {
        match parse_line(raw) {
            Line::Phase(phase) => {
                self.done = phase == "done";
                self.phase = Some(phase);
            }
            Line::Error(text) => {
                self.error.get_or_insert(text);
            }
            Line::Text(text) if text.trim().is_empty() => {}
            Line::Text(text) => log.push(text.chars().take(MAX_LOG_LINE).collect()),
        }
    }

    /// Take bytes of output; returns the complete lines to show.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        self.partial.extend_from_slice(bytes);
        let mut log = Vec::new();
        while let Some(end) = self.partial.iter().position(|b| *b == b'\n') {
            let rest = self.partial.split_off(end + 1);
            let line = std::mem::replace(&mut self.partial, rest);
            self.take_line(String::from_utf8_lossy(&line[..end]).as_ref(), &mut log);
        }
        log
    }

    /// The output ended: a last line without a newline is complete now.
    pub fn finish(&mut self) -> Vec<String> {
        let line = std::mem::take(&mut self.partial);
        let mut log = Vec::new();
        self.take_line(String::from_utf8_lossy(&line).as_ref(), &mut log);
        log
    }

    pub fn update_message(&self, log: Vec<String>) -> Value {
        json!({ "type": "installUpdate", "phase": self.phase, "log": log })
    }

    pub fn finished_message(&self, cancelled: bool, log: Vec<String>) -> Value {
        json!({
            "type": "installFinished",
            "ok": self.done,
            "cancelled": cancelled && !self.done,
            "error": self.error,
            "log": log,
        })
    }
}

fn read_more(file: &mut Option<File>, path: &Path, offset: &mut u64) -> Vec<u8> {
    if file.is_none() {
        *file = File::open(path).ok();
    }
    let mut bytes = Vec::new();
    if let Some(f) = file {
        if f.seek(SeekFrom::Start(*offset)).is_ok() && f.read_to_end(&mut bytes).is_ok() {
            *offset += bytes.len() as u64;
        }
    }
    bytes
}

/// Report a run from its first line to its end. `stale` ends this reader
/// (the page asked for another). Every look at the process comes BEFORE the read
/// of the file, so what it wrote just before it ended is never missed. `done`
/// ends the run by itself: a subshell of the installer that lingers looks just
/// like the installer, and must not keep the page waiting.
pub fn follow(run: Run, stale: impl Fn() -> bool, send: impl Fn(Value)) {
    let path = run.dir().join(OUTPUT_FILE);
    let mut file = None;
    let mut offset = 0;
    let mut progress = Progress::default();
    let mut reported = None;
    loop {
        if stale() {
            return;
        }
        let running = run.process().is_some();
        let mut log = progress.feed(&read_more(&mut file, &path, &mut offset));
        if !running || progress.done {
            log.extend(progress.finish());
            let cancelled = CANCELLED.load(Ordering::SeqCst);
            if progress.done {
                let _ = fs::remove_dir_all(run.dir());
            }
            send(progress.finished_message(cancelled, log));
            return;
        }
        if !log.is_empty() || reported != progress.phase {
            reported = progress.phase.clone();
            send(progress.update_message(log));
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Plan {
        Plan {
            port: 3000,
            network_password: None,
            ai_cli: None,
        }
    }

    #[test]
    fn a_this_mac_install_never_waits_for_a_person() {
        let args = install_args(&plan());
        for flag in ["--no-admin", "--progress", "--service", "--local"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(!args.iter().any(|a| a == "--lan"));
        let env = install_env(&plan());
        assert!(env.contains(&("CODEMAN_NONINTERACTIVE".to_string(), "1".to_string())));
    }

    #[test]
    fn it_always_names_the_agent_so_the_installer_never_picks_one() {
        let at = |args: &[String]| args[args.iter().position(|a| a == "--ai-cli").unwrap() + 1].clone();
        assert_eq!(at(&install_args(&plan())), "none");
        let mut p = plan();
        p.ai_cli = Some("codex".to_string());
        assert_eq!(at(&install_args(&p)), "codex");
    }

    #[test]
    fn the_agent_list_and_the_agent_run_use_the_same_route() {
        // `cli_offerable` leaves Homebrew entries out only under --no-admin, so
        // without it on both the page could offer what the run then refuses.
        let args = agent_args("codex");
        assert!(args.iter().any(|a| a == "--no-admin"));
        assert!(PREFLIGHT_ARGS.contains(&"--no-admin"));
        assert_eq!(args[..2], ["agent".to_string(), "codex".to_string()]);
    }

    #[test]
    fn an_agent_run_changes_nothing_but_the_agent() {
        let args = agent_args("codex");
        for flag in ["--service", "--local", "--lan", "--port", "--ai-cli"] {
            assert!(!args.iter().any(|a| a == flag), "{flag}");
        }
        assert!(args.iter().any(|a| a == "--progress"));
    }

    #[test]
    fn the_password_goes_in_the_environment_and_never_in_the_arguments() {
        let mut p = plan();
        p.network_password = Some("hunter2".to_string());
        let args = install_args(&p);
        assert!(args.iter().any(|a| a == "--lan"));
        assert!(!args.iter().any(|a| a == "--local"));
        assert!(!args.iter().any(|a| a.contains("hunter2")));
        assert!(!args.iter().any(|a| a.starts_with("--password")));
        assert!(install_env(&p).contains(&("CODEMAN_PASSWORD".to_string(), "hunter2".to_string())));
    }

    #[test]
    fn it_reads_the_preflight_answer() {
        let text = r#"{"schema":1,"os":"macos","arch":"arm64","noAdmin":true,"blocker":"",
            "needs":{"node":true,"tmux":true,"git":false},"later":"ignored",
            "clis":[{"id":"claude","label":"Claude Code","installed":false,"installable":true,"docs":"https://x"}]}"#;
        let found = parse_preflight(text).unwrap();
        assert_eq!(found.arch, "arm64");
        assert!(found.needs.node && !found.needs.git);
        assert_eq!(found.clis[0].label, "Claude Code");
    }

    #[test]
    fn it_refuses_an_answer_it_cannot_trust() {
        assert!(parse_preflight("Unknown option").is_err());
        let newer = r#"{"schema":2,"os":"macos","arch":"arm64","blocker":"","needs":{"node":true,"tmux":true,"git":true},"clis":[]}"#;
        assert!(parse_preflight(newer).unwrap_err().contains("schema 2"));
    }

    #[test]
    fn the_page_gets_the_preflight_in_its_own_spelling() {
        let found = Preflight {
            schema: 1,
            os: "macos".into(),
            arch: "arm64".into(),
            blocker: String::new(),
            needs: Needs {
                node: true,
                tmux: false,
                git: true,
            },
            clis: vec![],
        };
        let text = serde_json::to_value(&found).unwrap();
        assert_eq!(text["needs"]["node"], json!(true));
        assert_eq!(text["blocker"], json!(""));
    }

    #[test]
    fn only_a_real_run_counts_as_an_install() {
        let script = "/var/folders/ab/T/codeman-install/install.sh";
        assert!(Run::Codeman.matches(&format!(
            "/bin/bash {script} --no-admin --progress --service --local --port 3000"
        )));
        assert!(!Run::Codeman.matches(&format!("/bin/bash {script} preflight --no-admin")));
        assert!(!Run::Codeman.matches("/bin/bash /tmp/other/install.sh --progress"));
        assert!(!Run::Codeman.matches("vim /tmp/codeman-install/notes.txt --progress"));
    }

    #[test]
    fn an_agent_run_is_never_taken_for_an_install() {
        let command = "/bin/bash /var/folders/ab/T/codeman-agent/install.sh agent codex --no-admin --progress";
        assert!(Run::Agent.matches(command));
        assert!(!Run::Codeman.matches(command));
        assert_eq!(setup::install_in_progress(command), None);
        assert!(!Run::Agent.matches("/bin/bash /var/folders/ab/T/codeman-agent/install.sh preflight --no-admin"));
    }

    #[test]
    fn it_follows_the_installer_protocol() {
        assert_eq!(parse_line("@@codeman phase build"), Line::Phase("build".into()));
        assert_eq!(
            parse_line("@@codeman error Building Codeman failed (exit 1)"),
            Line::Error("Building Codeman failed (exit 1)".into())
        );
        assert_eq!(parse_line("plain text\r"), Line::Text("plain text".into()));
    }

    #[test]
    fn what_is_not_the_protocol_stays_output() {
        for line in [
            "@@codeman phase",
            "@@codeman phase Not-A-Phase",
            "@@codeman nonsense here",
            "@@codeman",
        ] {
            assert_eq!(parse_line(line), Line::Text(line.into()));
        }
    }

    #[test]
    fn colours_do_not_reach_the_page() {
        assert_eq!(
            parse_line("\u{1b}[0;34m==>\u{1b}[0m \u{1b}[1mDone\u{1b}[0m"),
            Line::Text("==> Done".into())
        );
        assert_eq!(parse_line("\u{1b}[2K\u{1b}[1Gnpm"), Line::Text("npm".into()));
    }

    #[test]
    fn a_line_split_across_reads_is_read_whole() {
        let mut p = Progress::default();
        assert!(p.feed(b"@@codeman pha").is_empty());
        assert!(p.feed(b"se packages\nHello ").is_empty());
        assert_eq!(p.phase.as_deref(), Some("packages"));
        assert_eq!(p.feed(b"world\n"), vec!["Hello world".to_string()]);
    }

    #[test]
    fn output_without_a_last_newline_is_kept() {
        let mut p = Progress::default();
        p.feed(b"@@codeman phase done");
        assert!(!p.done);
        p.finish();
        assert!(p.done);
    }

    #[test]
    fn a_broken_utf8_byte_costs_one_character_not_the_line() {
        let mut p = Progress::default();
        let log = p.feed(b"caf\xff bar\n");
        assert_eq!(log, vec!["caf\u{fffd} bar".to_string()]);
    }

    #[test]
    fn a_very_long_line_is_cut() {
        let mut p = Progress::default();
        let line = format!("{}\n", "x".repeat(MAX_LOG_LINE * 2));
        assert_eq!(p.feed(line.as_bytes())[0].chars().count(), MAX_LOG_LINE);
    }

    #[test]
    fn the_first_error_is_the_one_reported() {
        let mut p = Progress::default();
        p.feed(b"@@codeman error Building Codeman failed\n@@codeman error Installation failed. Partial\n");
        let done = p.finished_message(false, vec![]);
        assert_eq!(done["error"], json!("Building Codeman failed"));
        assert_eq!(done["ok"], json!(false));
    }

    #[test]
    fn only_done_is_success() {
        let mut p = Progress::default();
        p.feed(b"@@codeman phase service\n");
        assert_eq!(p.finished_message(false, vec![])["ok"], json!(false));
        p.feed(b"@@codeman phase done\n");
        assert_eq!(p.finished_message(false, vec![])["ok"], json!(true));
    }

    #[test]
    fn a_run_that_finished_before_cancel_landed_is_not_cancelled() {
        let mut p = Progress::default();
        p.feed(b"@@codeman phase done\n");
        assert_eq!(p.finished_message(true, vec![])["cancelled"], json!(false));
        let mut q = Progress::default();
        q.feed(b"@@codeman phase build\n");
        assert_eq!(q.finished_message(true, vec![])["cancelled"], json!(true));
    }

    /// The process side, against a stand-in installer: `cargo test` on a Mac
    /// runs it. One test, because a run is one folder and one process.
    #[test]
    fn a_run_outlives_its_reader_and_ends_as_reported() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::{Arc, Mutex};

        let plan = Plan {
            port: 3999,
            network_password: Some("not-in-ps".to_string()),
            ai_cli: None,
        };
        let stand_in_as = |run: Run, body: &str| {
            let dir = fresh_run_dir(run).unwrap();
            fs::write(dir.join(SCRIPT_FILE), format!("#!/bin/bash\n{body}\n")).unwrap();
            spawn_run(run, &install_args(&plan), &install_env(&plan)).unwrap();
            dir
        };
        let stand_in = |body: &str| stand_in_as(Run::Codeman, body);
        let collect_from = |run: Run, stop_after: Option<usize>| {
            let got = Arc::new(Mutex::new(Vec::<Value>::new()));
            let (seen, sink) = (got.clone(), got.clone());
            let calls = AtomicUsize::new(0);
            follow(
                run,
                move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    stop_after.is_some_and(|n| seen.lock().unwrap().len() >= n)
                },
                move |msg| sink.lock().unwrap().push(msg),
            );
            let out = got.lock().unwrap().clone();
            out
        };
        let collect = |stop_after: Option<usize>| collect_from(Run::Codeman, stop_after);

        // A reader that goes away (the page reloaded, the app quit) leaves the
        // install running, and the next reader gets it from the first line.
        let dir = stand_in(
            r#"echo "==> first"
echo "@@codeman phase source" >&2
while [ ! -f "$(dirname "$0")/go" ]; do sleep 0.1; done
echo "==> second"
echo "@@codeman phase done" >&2"#,
        );
        let first = collect(Some(1));
        assert_eq!(first[0]["phase"], json!("source"));
        assert_eq!(first[0]["log"], json!(["==> first"]));
        assert!(Run::Codeman.process().is_some(), "the install stopped with its reader");

        fs::write(dir.join("go"), "").unwrap();
        let replay = collect(None);
        let last = replay.last().unwrap();
        assert_eq!(last["type"], json!("installFinished"));
        assert_eq!(last["ok"], json!(true));
        let lines: Vec<&Value> = replay.iter().flat_map(|m| m["log"].as_array().unwrap()).collect();
        assert_eq!(lines, vec!["==> first", "==> second"]);
        assert!(!dir.exists(), "a finished run leaves nothing behind");

        // Cancel reaches what the installer started, not only the installer.
        let marker = "31337";
        stand_in(&format!(
            r#"echo "@@codeman phase build" >&2
sleep {marker} &
( while true; do sleep {marker}; done ) &
wait"#
        ));
        std::thread::sleep(Duration::from_millis(500));
        let sleeper = |procs: Vec<(u32, String)>| procs.iter().any(|(_, c)| c == &format!("sleep {marker}"));
        assert!(sleeper(setup::list_processes()), "the stand-in did not start");
        cancel();
        assert!(Run::Codeman.process().is_none());
        std::thread::sleep(Duration::from_millis(300));
        assert!(!sleeper(setup::list_processes()), "a child outlived Cancel");
        let done = collect(None);
        assert_eq!(done.last().unwrap()["cancelled"], json!(true));
        assert_eq!(done.last().unwrap()["ok"], json!(false));

        // A subshell that outlives `done` does not keep the page waiting.
        let dir = stand_in(
            r#"( while true; do sleep 1; done ) &
echo "@@codeman phase done" >&2
wait"#,
        );
        assert_eq!(collect(None).last().unwrap()["ok"], json!(true));
        assert!(!dir.exists());
        std::thread::sleep(Duration::from_millis(100));
        cancel();

        // A failure reports its first error, and keeps the output for a look.
        let dir = stand_in(
            r#"echo "@@codeman phase packages" >&2
echo "@@codeman error npm said no" >&2
echo "@@codeman error Installation failed." >&2
exit 1"#,
        );
        let done = collect(None);
        let last = done.last().unwrap();
        assert_eq!(last["ok"], json!(false));
        assert_eq!(last["cancelled"], json!(false));
        assert_eq!(last["error"], json!("npm said no"));
        assert!(dir.join(OUTPUT_FILE).is_file());
        let _ = fs::remove_dir_all(&dir);

        // An agent run is its own run: an install sees none, a second run of
        // either kind is refused, and Cancel reaches it all the same.
        let dir = stand_in_as(
            Run::Agent,
            r#"echo "@@codeman phase agent" >&2
echo "==> Installing Codex..."
while true; do sleep 1; done"#,
        );
        std::thread::sleep(Duration::from_millis(300));
        assert!(Run::Agent.process().is_some());
        assert!(Run::Codeman.process().is_none());
        assert!(start_agent("codex").unwrap_err().contains("coding agent"));
        assert!(prepare_agent().unwrap_err().contains("coding agent"));
        assert!(start(&plan).unwrap_err().contains("coding agent"));
        let first = collect_from(Run::Agent, Some(1));
        assert_eq!(first[0]["phase"], json!("agent"));
        assert_eq!(first[0]["log"], json!(["==> Installing Codex..."]));
        cancel();
        assert!(Run::Agent.process().is_none());
        assert_eq!(collect_from(Run::Agent, None).last().unwrap()["cancelled"], json!(true));
        let _ = fs::remove_dir_all(&dir);

        // Done ends it and leaves nothing, like an install.
        let dir = stand_in_as(
            Run::Agent,
            r#"echo "@@codeman phase agent" >&2
echo "@@codeman phase done" >&2"#,
        );
        assert_eq!(collect_from(Run::Agent, None).last().unwrap()["ok"], json!(true));
        assert!(!dir.exists());
    }

    /// A whole real install, driven down the same path as the page: build with
    /// `CODEMAN_DESKTOP_INSTALLER_URL` and run under a throwaway HOME with
    /// `CODEMAN_E2E_AI_CLI` set. Skips `refuse_start`, which a machine with a
    /// live Codeman would answer, and that machine is where this runs. With
    /// `CODEMAN_E2E_CANCEL_AT=<phase>` it cancels there instead of finishing.
    #[test]
    #[ignore = "installs Codeman: see the comment"]
    fn a_real_install_under_a_throwaway_home() {
        let found = fetch_and_ask(Run::Codeman).unwrap();
        println!("preflight: {}", serde_json::to_string(&found).unwrap());
        let ai_cli = std::env::var("CODEMAN_E2E_AI_CLI").ok();
        let port = std::env::var("CODEMAN_E2E_PORT").unwrap().parse().unwrap();
        let plan = Plan {
            port,
            network_password: None,
            ai_cli,
        };
        spawn_run(Run::Codeman, &install_args(&plan), &install_env(&plan)).unwrap();
        let ok = std::sync::Arc::new(AtomicBool::new(false));
        let result = ok.clone();
        let started = Instant::now();
        let cancel_at = std::env::var("CODEMAN_E2E_CANCEL_AT").ok();
        let cancelling = cancel_at.is_some();
        let asked = AtomicBool::new(false);
        follow(
            Run::Codeman,
            || false,
            move |msg| {
                let at = started.elapsed().as_secs();
                if cancel_at.as_deref().is_some_and(|p| msg["phase"] == json!(p)) && !asked.swap(true, Ordering::SeqCst)
                {
                    println!("[{at}s] cancelling");
                    std::thread::spawn(cancel);
                }
                if msg["type"] == "installFinished" {
                    result.store(msg["ok"] == json!(true), Ordering::SeqCst);
                    println!("[{at}s] {}", serde_json::to_string(&msg).unwrap());
                } else if !msg["log"].as_array().unwrap().is_empty() {
                    println!("[{at}s] {} {}", msg["phase"], msg["log"]);
                }
            },
        );
        assert_eq!(
            ok.load(Ordering::SeqCst),
            !cancelling,
            "the install did not end as asked"
        );
    }

    /// A real agent, down the same path as the page, under a throwaway HOME
    /// whose login PATH holds that HOME's Node.js: with the machine's own, npm
    /// would write into its real global prefix. `CODEMAN_E2E_AI_CLI` names it,
    /// and `CODEMAN_E2E_CANCEL=1` cancels it once it has started.
    #[test]
    #[ignore = "installs a coding agent: see the comment"]
    fn a_real_agent_under_a_throwaway_home() {
        let id = std::env::var("CODEMAN_E2E_AI_CLI").unwrap();
        let found = prepare_agent().unwrap();
        println!("preflight: {}", serde_json::to_string(&found.clis).unwrap());
        start_agent(&id).unwrap();
        let ok = std::sync::Arc::new(AtomicBool::new(false));
        let result = ok.clone();
        let cancelling = std::env::var("CODEMAN_E2E_CANCEL").is_ok();
        let asked = AtomicBool::new(false);
        follow(
            Run::Agent,
            || false,
            move |msg| {
                if msg["type"] == "installFinished" {
                    result.store(msg["ok"] == json!(true), Ordering::SeqCst);
                } else if cancelling && !asked.swap(true, Ordering::SeqCst) {
                    std::thread::spawn(cancel);
                }
                println!("{}", serde_json::to_string(&msg).unwrap());
            },
        );
        assert_eq!(ok.load(Ordering::SeqCst), !cancelling, "the agent did not end as asked");
    }

    #[test]
    fn a_bare_path_is_filled_in() {
        let env = with_path(vec![("HOME".to_string(), "/Users/a".to_string())]);
        assert!(env.iter().any(|(k, v)| k == "PATH" && v == FALLBACK_PATH));
        let own = with_path(vec![("PATH".to_string(), "/mine".to_string())]);
        assert_eq!(own, vec![("PATH".to_string(), "/mine".to_string())]);
    }
}
