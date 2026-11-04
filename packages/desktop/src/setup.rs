//! The connect screen's "This Mac" tab and its installs: where the Codeman on
//! this Mac listens, whether it is installed, its login, and the installer runs
//! for this Mac and for another machine over SSH.
//!
//! The installer always runs in Terminal, never inside the app. `install.sh`
//! asks for the administrator password on a terminal (Homebrew, its sudo
//! keep-alive), the Xcode tools arrive as a system dialog, and ssh asks about
//! host keys and passwords on a terminal too: a run without one fails on the
//! first fresh Mac. So the app writes a small script that deletes itself and
//! hands it to Terminal (`open -b com.apple.Terminal`), which needs no
//! permission, unlike scripting Terminal through osascript (an Automation
//! prompt). Everything the scripts contain is built here and unit-tested; the
//! only text from the user is the SSH login, which `SshTarget::parse` limits to
//! the characters of a user and host name before it is quoted.

use std::collections::HashMap;
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use url::Url;

use crate::local_server;
use crate::policy;
use crate::probe::{self, ProbeOutcome};

/// Codeman's published installer (a redirect to `install.sh` on master).
pub const INSTALLER_URL: &str = "https://getcodeman.com/install";

/// What to paste into a terminal on another machine; the SSH install runs the
/// same thing there.
pub const INSTALL_ONE_LINER: &str = "curl -fsSL https://getcodeman.com/install | bash";

/// Codeman's default port, and the first one a fresh install tries.
pub const DEFAULT_PORT: u16 = 3000;

/// The Terminal scripts' file names (`<name>-<pid>-<n>.command`). The local
/// one is also how `inspect` recognizes an install that is still running.
pub const LOCAL_SCRIPT_NAME: &str = "install-codeman-local";
pub const REMOTE_SCRIPT_NAME: &str = "install-codeman-remote";

/// How many ports above 3000 a fresh install tries when 3000 is taken.
const PORT_SEARCH: u16 = 100;

/// The job label both `install.sh` and `codeman service install` use for the
/// default instance (src/config/service-names.ts).
const SERVICE_LABEL: &str = "com.codeman.web";

/// The local Codeman's settings, as its LaunchAgent (or LaunchDaemon) runs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceConfig {
    pub port: u16,
    /// `''` or `/codeman`, as Codeman normalizes it (src/config/base-path.ts).
    pub base_path: String,
    pub https: bool,
    pub username: Option<String>,
    pub password: Option<String>,
    /// From /Library/LaunchDaemons: a system job, not this user's agent.
    pub daemon: bool,
}

/// Read a launchd job as `plutil -convert json` prints it. The two writers
/// differ: `install.sh` runs a bare `web` and puts the port, base path and
/// password in EnvironmentVariables; `codeman service install` passes
/// `--port`, `--base-url` and `--https` as arguments and keeps no secret in
/// the file. A flag wins over its variable, as in Codeman's CLI (src/cli.ts:
/// the variable is only the flag's default).
pub fn parse_service(job: &serde_json::Value) -> ServiceConfig {
    let env = job.get("EnvironmentVariables").and_then(|v| v.as_object());
    let var = |key: &str| {
        env.and_then(|e| e.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    let args: Vec<&str> = job
        .get("ProgramArguments")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();

    let mut port = var("CODEMAN_PORT");
    let mut base = var("CODEMAN_BASE_URL");
    let mut https = false;
    // Only what follows the `web` subcommand: node's own flags come before it.
    let after_web = args
        .iter()
        .position(|a| *a == "web")
        .map_or(&[][..], |i| &args[i + 1..]);
    let mut it = after_web.iter();
    while let Some(arg) = it.next() {
        match *arg {
            "-p" | "--port" => port = it.next().map(|s| s.to_string()),
            "--base-url" => base = it.next().map(|s| s.to_string()),
            "--https" => https = true,
            // Options that take a value: skip it, so it is never read as a flag.
            "-H" | "--host" | "--title-hostname" => {
                it.next();
            }
            other => {
                if let Some(v) = other.strip_prefix("--port=") {
                    port = Some(v.to_string());
                } else if let Some(v) = other.strip_prefix("--base-url=") {
                    base = Some(v.to_string());
                }
            }
        }
    }
    ServiceConfig {
        port: port
            .and_then(|p| p.trim().parse::<u16>().ok())
            .filter(|p| *p > 0)
            .unwrap_or(DEFAULT_PORT),
        base_path: normalize_base_path(base.as_deref().unwrap_or("")),
        https,
        username: var("CODEMAN_USERNAME"),
        password: var("CODEMAN_PASSWORD"),
        daemon: false,
    }
}

/// Codeman's `normalizeBasePath`, plus its character check: a value Codeman
/// would refuse at startup counts as the root here.
fn normalize_base_path(input: &str) -> String {
    let mut p = input.trim().to_string();
    if p.is_empty() || p == "/" {
        return String::new();
    }
    if !p.starts_with('/') {
        p.insert(0, '/');
    }
    while p.contains("//") {
        p = p.replace("//", "/");
    }
    let p = p.trim_end_matches('/').to_string();
    let valid = !p.is_empty()
        && p.split('/')
            .skip(1)
            .all(|seg| !seg.is_empty() && seg.chars().all(|c| c.is_ascii_alphanumeric() || "._~-".contains(c)));
    if valid {
        p
    } else {
        String::new()
    }
}

/// Codeman's `parseEnvFile` (src/codeman-credentials.ts): blank lines and `#`
/// comments skipped, an `export ` prefix allowed, one layer of matching quotes
/// stripped, anything else ignored.
pub fn parse_env_file(text: &str) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    for raw in text.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = match line.strip_prefix("export") {
            Some(rest) if rest.starts_with(char::is_whitespace) => rest.trim_start(),
            _ => line,
        };
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        let mut chars = name.chars();
        let portable = chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !portable {
            continue;
        }
        let mut value = value.trim();
        let quoted =
            (value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\''));
        if quoted {
            // A lone quote reads as empty, as JavaScript's slice(1, -1) does.
            value = value.get(1..value.len() - 1).unwrap_or("");
        }
        vars.insert(name.to_string(), value.to_string());
    }
    vars
}

/// Where the local Codeman answers: its service's port, base path and scheme,
/// else Codeman's defaults. Always 127.0.0.1, which every bind Codeman offers
/// answers on (loopback, all interfaces, and Tailscale serve's target).
pub fn local_url(service: Option<&ServiceConfig>) -> Url {
    let (scheme, port, base) = match service {
        Some(s) => (if s.https { "https" } else { "http" }, s.port, s.base_path.as_str()),
        None => ("http", DEFAULT_PORT, ""),
    };
    Url::parse(&format!("{scheme}://127.0.0.1:{port}{base}/")).expect("a valid loopback URL")
}

/// The login for the Codeman on this Mac, from where it keeps one: its launchd
/// job's environment (which is the server's own), else the data dir's `.env`
/// that Codeman's command-line clients read (src/codeman-credentials.ts).
/// Username and password come from the same place, `admin` by default: the
/// server takes its username from its own environment, so a `.env` username
/// never pairs with the job's password. Only for 127.0.0.1 (the address
/// Codeman binds; `localhost` can be another socket, such as a dev server on
/// `::1`) on the local Codeman's port.
pub fn login_for(
    url: &Url,
    service: Option<&ServiceConfig>,
    env_file: &HashMap<String, String>,
) -> Option<(String, String)> {
    if url.host() != Some(url::Host::Ipv4(Ipv4Addr::LOCALHOST)) {
        return None;
    }
    let port = service.map_or(DEFAULT_PORT, |s| s.port);
    if url.port_or_known_default() != Some(port) {
        return None;
    }
    if let Some(s) = service {
        if let Some(password) = &s.password {
            let username = s.username.clone().unwrap_or_else(|| "admin".into());
            return Some((username, password.clone()));
        }
    }
    let from_file = |key: &str| env_file.get(key).filter(|v| !v.is_empty()).cloned();
    let password = from_file("CODEMAN_PASSWORD")?;
    let username = from_file("CODEMAN_USERNAME").unwrap_or_else(|| "admin".into());
    Some((username, password))
}

fn agent_path(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents").join(format!("{SERVICE_LABEL}.plist"))
}

/// A headless Mac's owner may run Codeman as a system daemon instead.
fn daemon_path() -> PathBuf {
    PathBuf::from(format!("/Library/LaunchDaemons/{SERVICE_LABEL}.plist"))
}

/// The local Codeman's launchd job, if there is one this app can read.
pub fn read_service() -> Option<ServiceConfig> {
    let home = dirs::home_dir()?;
    let agent = agent_path(&home);
    if agent.is_file() {
        if let Some(s) = read_service_file(&agent) {
            return Some(s);
        }
    }
    let daemon = daemon_path();
    if daemon.is_file() {
        return read_service_file(&daemon).map(|s| ServiceConfig { daemon: true, ..s });
    }
    None
}

/// One launchd job file, read with `plutil` (XML or binary plist alike).
fn read_service_file(path: &Path) -> Option<ServiceConfig> {
    let out = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-"])
        .arg(path)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let job: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    Some(parse_service(&job))
}

fn read_env_file() -> HashMap<String, String> {
    dirs::home_dir()
        .and_then(|h| std::fs::read_to_string(h.join(".codeman/.env")).ok())
        .map(|t| parse_env_file(&t))
        .unwrap_or_default()
}

/// `login_for` with what is on disk now, and only while one of this user's
/// own Codeman servers holds that port: with Codeman stopped, whatever else
/// listens there (another user's process, say) never gets the password. Runs
/// `plutil`, `ps` and `lsof`, so never on the event loop.
pub fn local_login(url: &Url) -> Option<(String, String)> {
    if url.host() != Some(url::Host::Ipv4(Ipv4Addr::LOCALHOST)) {
        return None;
    }
    let login = login_for(url, read_service().as_ref(), &read_env_file())?;
    let port = url.port_or_known_default()?;
    let servers = codeman_servers(&list_processes());
    serves_loopback_port(&listeners(&servers), port).then_some(login)
}

/// This user's processes, as `ps` lists them: (pid, command line).
fn list_processes() -> Vec<(u32, String)> {
    let Ok(out) = Command::new("/bin/ps")
        .args(["-x", "-ww", "-o", "pid=", "-o", "command="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    parse_ps(&String::from_utf8_lossy(&out.stdout))
}

fn parse_ps(text: &str) -> Vec<(u32, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, command) = line.split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, command.trim().to_string()))
        })
        .collect()
}

/// Whether a command line is a Codeman server (`codeman web`, the
/// `install.sh` clone's `dist/index.js web`, a source checkout's
/// `src/index.ts web`), not one of its short-lived control commands.
pub fn is_codeman_server(command: &str) -> bool {
    let words: Vec<&str> = command.split_whitespace().collect();
    let entry = words.iter().position(|w| {
        let name = w.rsplit('/').next().unwrap_or(w);
        w.ends_with("dist/index.js") || w.ends_with("src/index.ts") || name == "codeman" || name == "aicodeman"
    });
    match entry {
        Some(i) => {
            words.get(i + 1) == Some(&"web") && !words[i + 1..].iter().any(|w| matches!(*w, "--stop" | "--status"))
        }
        None => false,
    }
}

/// Whether a command line is an install the app started on this Mac (the
/// Terminal script, or the installer it downloaded), and the port it asked
/// for once the installer runs.
pub fn install_in_progress(command: &str) -> Option<Option<u16>> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let name = |w: &&str| w.rsplit('/').next().unwrap_or(w).to_string();
    if words.iter().any(|w| {
        let n = name(w);
        n.starts_with(&format!("{LOCAL_SCRIPT_NAME}-")) && n.ends_with(".command")
    }) {
        return Some(None);
    }
    if words.iter().any(|w| name(w).starts_with("codeman-install.")) {
        let port = words
            .iter()
            .position(|w| *w == "--port")
            .and_then(|i| words.get(i + 1))
            .and_then(|p| p.parse().ok());
        return Some(port);
    }
    None
}

fn codeman_servers(procs: &[(u32, String)]) -> Vec<u32> {
    procs
        .iter()
        .filter(|(_, c)| is_codeman_server(c))
        .map(|(pid, _)| *pid)
        .collect()
}

/// A listening TCP socket: its pid, address (`*`, `127.0.0.1`, `[::1]`, a
/// specific IP) and port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub pid: u32,
    pub host: String,
    pub port: u16,
}

/// What `lsof -F pn` printed: `p<pid>` starts a process, `n<addr>:<port>`
/// names one of its sockets; other fields are ignored.
pub fn parse_lsof(text: &str) -> Vec<Listener> {
    let mut pid = None;
    let mut found = Vec::new();
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.parse().ok();
        } else if let (Some(addr), Some(pid)) = (line.strip_prefix('n'), pid) {
            if let Some((host, port)) = addr.rsplit_once(':') {
                if let Ok(port) = port.parse() {
                    found.push(Listener {
                        pid,
                        host: host.to_string(),
                        port,
                    });
                }
            }
        }
    }
    found
}

/// The TCP ports the given processes listen on.
fn listeners(pids: &[u32]) -> Vec<Listener> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list: Vec<String> = pids.iter().map(u32::to_string).collect();
    let Ok(out) = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-F", "pn", "-p"])
        .arg(list.join(","))
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };
    parse_lsof(&String::from_utf8_lossy(&out.stdout))
}

/// Whether one of `found` answers 127.0.0.1:`port` (bound to it, or to every
/// interface).
fn serves_loopback_port(found: &[Listener], port: u16) -> bool {
    found
        .iter()
        .any(|l| l.port == port && matches!(l.host.as_str(), "*" | "127.0.0.1" | "0.0.0.0"))
}

/// The address a listener is reached at: 127.0.0.1 for a loopback or
/// all-interfaces bind, else its own address.
fn listener_url(l: &Listener) -> Option<Url> {
    let host = match l.host.as_str() {
        "*" | "0.0.0.0" | "127.0.0.1" => "127.0.0.1".to_string(),
        h if h.starts_with('[') => h.to_string(),
        h => h.to_string(),
    };
    Url::parse(&format!("http://{host}:{}/", l.port)).ok()
}

/// What the This Mac tab shows.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalState {
    /// Codeman answers, and the app has its login if it needs one.
    Running,
    /// Codeman answers but wants a login the app does not have.
    NeedsLogin,
    /// A Codeman server of this user runs, but not at an address the app can
    /// open (bound to one network address, say): see `elsewhere`.
    RunningElsewhere,
    /// Nothing answers, and Codeman is installed.
    Stopped,
    /// Nothing answers, and Codeman is not installed (or, in a quick check,
    /// not installed by `install.sh`).
    NotInstalled,
    /// Something else happened at that address: see `outcome`.
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatus {
    /// Where the local Codeman answers, or would.
    pub url: String,
    pub state: LocalState,
    pub version: Option<String>,
    /// A launchd job runs Codeman here.
    pub service: bool,
    /// That job is a system LaunchDaemon, which only an administrator starts.
    pub daemon: bool,
    /// Codeman is on this Mac: it answers or runs, `install.sh` left its
    /// files or a launchd job, or (not in a quick check) the login shell
    /// finds it.
    pub installed: bool,
    /// `install.sh` finished its work (its `.install-complete` marker).
    pub install_complete: bool,
    /// An install the app started is still running in Terminal, and the
    /// port it asked for once that is known.
    pub install_running: bool,
    pub install_port: Option<u16>,
    /// For RunningElsewhere: the addresses that Codeman listens on.
    pub elsewhere: Vec<String>,
    /// The probe's outcome, for the connect page's explanations.
    pub outcome: ProbeOutcome,
}

/// How hard `inspect` looks for an installed Codeman when nothing answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Depth {
    /// Files and processes only (while an install runs).
    Quick,
    /// Also the login shell (`-l`), as every automatic look does.
    Login,
    /// Also the interactive profile (`-i`), on the user's Check again.
    Interactive,
}

/// Look at the Codeman on this Mac.
pub fn inspect(depth: Depth) -> LocalStatus {
    let home = dirs::home_dir().unwrap_or_default();
    let service = read_service();
    let url = local_url(service.as_ref());
    let procs = list_processes();
    let servers = codeman_servers(&procs);
    let found = listeners(&servers);
    let install = procs.iter().find_map(|(_, c)| install_in_progress(c));

    // The login goes only to this user's own Codeman on that port.
    let auth = if serves_loopback_port(&found, url.port_or_known_default().unwrap_or(0)) {
        login_for(&url, service.as_ref(), &read_env_file()).map(|(u, p)| policy::basic_auth_header(&u, &p))
    } else {
        None
    };
    let mut outcome = probe::probe(&url, auth.as_deref());
    let mut url = url;
    let mut elsewhere = Vec::new();

    // Nothing at the usual address, but a Codeman server of this user runs:
    // find where (a `codeman web --port 4000` in a terminal, a bind to one
    // network address), so the tab never offers to start a second server on
    // the same sessions.
    if outcome == ProbeOutcome::Refused && !servers.is_empty() {
        let mut ports_seen = Vec::new();
        for l in &found {
            if ports_seen.contains(&(l.host.clone(), l.port)) {
                continue;
            }
            ports_seen.push((l.host.clone(), l.port));
            let Some(candidate) = listener_url(l) else {
                continue;
            };
            let answer = probe::probe(&candidate, None);
            if matches!(
                answer,
                ProbeOutcome::Ok { .. }
                    | ProbeOutcome::NeedsLogin
                    | ProbeOutcome::BadCredentials
                    | ProbeOutcome::RateLimited { .. }
                    | ProbeOutcome::PasswordChangeRequired
            ) {
                url = candidate;
                outcome = answer;
                break;
            }
            elsewhere.push(format!("{}:{}", l.host, l.port));
        }
        if outcome == ProbeOutcome::Refused && elsewhere.is_empty() {
            elsewhere = servers.iter().map(|pid| format!("process {pid}")).collect();
        }
    }

    let app = home.join(".codeman/app");
    let install_complete = app.join(".install-complete").is_file();
    let answering = match &outcome {
        ProbeOutcome::Ok { .. } | ProbeOutcome::PasswordChangeRequired => Some(LocalState::Running),
        ProbeOutcome::NeedsLogin | ProbeOutcome::BadCredentials | ProbeOutcome::RateLimited { .. } => {
            Some(LocalState::NeedsLogin)
        }
        _ => None,
    };
    // Something else on Codeman's port (a dev server on 3000, say) says
    // nothing about whether Codeman is installed, so look either way.
    let on_disk = install_complete
        || app.join("dist/index.js").is_file()
        || agent_path(&home).is_file()
        || daemon_path().is_file();
    let installed = answering.is_some()
        || !servers.is_empty()
        || on_disk
        || match depth {
            Depth::Quick => false,
            Depth::Login => local_server::installed(false),
            Depth::Interactive => local_server::installed(true),
        };
    let state = match (answering, &outcome) {
        (Some(state), _) => state,
        (None, ProbeOutcome::Refused) if !servers.is_empty() => LocalState::RunningElsewhere,
        (None, ProbeOutcome::Refused) if installed => LocalState::Stopped,
        (None, ProbeOutcome::Refused) => LocalState::NotInstalled,
        (None, _) => LocalState::Other,
    };
    if state != LocalState::RunningElsewhere {
        elsewhere.clear();
    }
    let version = match &outcome {
        ProbeOutcome::Ok { version } => Some(version.clone()),
        _ => None,
    };
    LocalStatus {
        url: url.to_string(),
        state,
        version,
        service: service.is_some(),
        daemon: service.as_ref().is_some_and(|s| s.daemon),
        installed,
        install_complete,
        install_running: install.is_some(),
        install_port: install.flatten(),
        elsewhere,
        outcome,
    }
}

/// Why the app will not start a server: one of this user's Codeman servers
/// already runs. A second one on the same data dir and tmux socket would
/// attach to the first one's live sessions (src/config/instance.ts), and
/// `codeman web -d` only notices a server it started itself or one at the
/// same address.
fn already_running() -> Option<String> {
    let servers = codeman_servers(&list_processes());
    let pid = servers.first()?;
    let found = listeners(&servers);
    let at: Vec<String> = found.iter().map(|l| format!("{}:{}", l.host, l.port)).collect();
    let where_ = if at.is_empty() {
        format!("process {pid}")
    } else {
        at.join(", ")
    };
    Some(format!(
        "A Codeman server is already running on this Mac ({where_}). Starting another one would take over its sessions: connect to it instead, or stop it first."
    ))
}

/// Start the Codeman on this Mac for `url`. A LaunchAgent that serves that
/// address is started through launchd, so it runs with its own settings
/// (host, password) and stays supervised; anything else gets `codeman web -d`
/// (local_server::start). Never while one of this user's Codeman servers runs.
pub fn start_local(url: &Url) -> Result<String, String> {
    if let Some(why) = already_running() {
        return Err(why);
    }
    match read_service() {
        Some(s) if local_url(Some(&s)) == *url => {
            if s.daemon {
                return Err(format!(
                    "A system LaunchDaemon runs Codeman on this Mac; an administrator starts it: sudo launchctl kickstart -k system/{SERVICE_LABEL}"
                ));
            }
            start_launch_agent(s.port)
        }
        _ => local_server::start(url),
    }
}

/// `launchctl kickstart` the LaunchAgent if launchd has it loaded, else
/// `bootstrap` it, then wait until its port takes connections (a TCP connect,
/// never an HTTP request, which a password-protected server would count as a
/// failed login).
fn start_launch_agent(port: u16) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("No home folder.")?;
    let plist = agent_path(&home);
    let uid = Command::new("/usr/bin/id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<u32>().ok())
        .ok_or("Could not find the user id.")?;
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{SERVICE_LABEL}");
    let launchctl = |args: &[&str]| {
        Command::new("/bin/launchctl")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
    };
    let loaded = launchctl(&["print", &target]).is_ok_and(|o| o.status.success());
    let plist_arg = plist.to_string_lossy().to_string();
    let run = if loaded {
        launchctl(&["kickstart", "-k", &target])
    } else {
        launchctl(&["bootstrap", &domain, &plist_arg])
    };
    match run {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            let said = String::from_utf8_lossy(&o.stderr).trim().to_string();
            return Err(format!("launchd did not start Codeman: {said}"));
        }
        Err(e) => return Err(format!("Could not run launchctl: {e}")),
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        if !port_free(port) {
            return Ok(format!("launchd started Codeman ({SERVICE_LABEL})."));
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err("launchd started Codeman, but it did not answer within 30 seconds. Its log is /tmp/codeman.log for an install.sh setup.".into())
}

/// Whether nothing listens on 127.0.0.1:`port`.
fn port_free(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(_) => false,
        Err(e) => e.kind() == std::io::ErrorKind::ConnectionRefused,
    }
}

/// The port a fresh install listens on: 3000 when it is free, else the first
/// free one above it. 3000 is also where most web dev servers run.
pub fn pick_install_port() -> u16 {
    pick_port(port_free)
}

fn pick_port(free: impl Fn(u16) -> bool) -> u16 {
    (DEFAULT_PORT..DEFAULT_PORT + PORT_SEARCH)
        .find(|p| free(*p))
        .unwrap_or(DEFAULT_PORT)
}

/// `s` as one bash word.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// What the This Mac install asks `install.sh` for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalInstall {
    pub port: u16,
    /// Let the installer ask how other devices reach Codeman (Tailscale, the
    /// local network with a password). Off: this Mac only (`--local`).
    pub network: bool,
}

/// `install.sh`'s flags for a This Mac install. Always `--service`: a
/// LaunchAgent runs Codeman, so it keeps running when the app quits and starts
/// again at login, and the app finds it there (read_service). No `--yes`: the
/// user answers the installer's questions (Homebrew, AI coding tools).
pub fn local_install_args(opts: LocalInstall) -> Vec<String> {
    let mut args = Vec::new();
    if !opts.network {
        args.push("--local".to_string());
    }
    args.push("--service".to_string());
    args.push("--port".to_string());
    args.push(opts.port.to_string());
    args
}

/// The Terminal script for a This Mac install. It downloads the installer to a
/// temporary file and runs it from there, so the installer's input is the
/// terminal itself.
pub fn local_install_script(opts: LocalInstall) -> String {
    let args = local_install_args(opts);
    let shown = format!("bash install.sh {}", args.join(" "));
    let quoted: Vec<String> = args.iter().map(|a| sh_quote(a)).collect();
    format!(
        r#"#!/bin/bash
rm -f -- "$0"
printf '\033]0;%s\007' 'Install Codeman'
cat <<'CODEMAN_MSG'
Installing Codeman on this Mac.

The installer may ask for your Mac password (it installs Homebrew, Node.js and
tmux when they are missing) and which AI coding tools to set up. Codeman then
runs in the background and starts when you log in, so your sessions keep
running when the app is closed. The Codeman app opens it by itself when the
install is done.

CODEMAN_MSG
tmp=$(mktemp "${{TMPDIR:-/tmp}}/codeman-install.XXXXXX") || exit 1
trap 'rm -f "$tmp"' EXIT
echo {from}
if ! curl -fsSL {url} -o "$tmp"; then
  echo
  echo 'Could not download the installer. Check the internet connection, then try again from the Codeman app.'
  exit 1
fi
echo {shown}
echo
bash "$tmp" {args}
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo 'Done. You can close this window.'
else
  echo "The installer stopped (exit $status). Its log is ~/.codeman/install.log"
fi
exit "$status"
"#,
        from = sh_quote(&format!("Downloading the installer from {INSTALLER_URL}")),
        url = sh_quote(INSTALLER_URL),
        shown = sh_quote(&format!("$ {shown}")),
        args = quoted.join(" "),
    )
}

/// A machine to install Codeman on, as ssh takes it: `[user@]host`, plus a
/// `:port` the app passes as `-p`. The host may be a name from `~/.ssh/config`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshTarget {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

const SSH_FORMAT: &str =
    "Enter the machine the way ssh takes it: user@host (for example kay@build-box), or a name from your ssh config.";

impl SshTarget {
    /// Only the characters of a user and host name, never a leading `-` (ssh
    /// would read it as an option) and never an IPv6 literal (ambiguous with
    /// the port; a host name or an IPv4 address works).
    pub fn parse(input: &str) -> Result<Self, String> {
        let s = input.trim();
        if s.is_empty() || s.len() > 300 {
            return Err(SSH_FORMAT.into());
        }
        let (user, rest) = match s.split_once('@') {
            Some((u, r)) => (Some(u), r),
            None => (None, s),
        };
        let (host, port) = match rest.split_once(':') {
            Some((h, p)) => {
                let port = p.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| {
                    "The part after the colon must be the SSH port, for example kay@build-box:2222.".to_string()
                })?;
                (h, Some(port))
            }
            None => (rest, None),
        };
        let name_ok = |v: &str, max: usize| {
            !v.is_empty()
                && v.len() <= max
                && !v.starts_with(['-', '.'])
                && v.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        };
        if let Some(u) = user {
            if !name_ok(u, 64) {
                return Err(SSH_FORMAT.into());
            }
        }
        if !name_ok(host, 253) {
            return Err(SSH_FORMAT.into());
        }
        Ok(SshTarget {
            user: user.map(str::to_string),
            host: host.to_string(),
            port,
        })
    }

    /// `user@host`, or `host`.
    pub fn destination(&self) -> String {
        match &self.user {
            Some(u) => format!("{u}@{}", self.host),
            None => self.host.clone(),
        }
    }

    /// The address the connect screen suggests once the install is done: the
    /// installer's default port on that host. Tailscale and a sub-path give
    /// another address, which the installer prints at the end.
    pub fn suggested_url(&self) -> String {
        format!("http://{}:{DEFAULT_PORT}", self.host)
    }
}

/// What the remote login shell runs. It may be fish or tcsh, so the work is
/// one single-quoted `bash -c` word with nothing in it those shells treat
/// specially (no `!`, `$`, backslash or single quote). `curl | bash` is the
/// documented install and the installer asks its questions on ssh's terminal
/// (`-t`); `pipefail` makes a failed download fail the whole command, where a
/// plain pipe would report bash's success on an empty script. The installer
/// needs bash anyway.
pub fn remote_command() -> String {
    format!(
        "bash -o pipefail -c 'if command -v curl >/dev/null 2>&1; then curl -fsSL {u} | bash; \
         elif command -v wget >/dev/null 2>&1; then wget -qO- {u} | bash; \
         else echo \"Codeman needs curl or wget on this machine.\" >&2; exit 1; fi'",
        u = INSTALLER_URL
    )
}

/// `ssh`'s arguments for an install on `target`: a terminal (`-t`) for the
/// installer's questions, the port, and `--` before the destination.
pub fn ssh_args(target: &SshTarget) -> Vec<String> {
    let mut args = vec!["-t".to_string()];
    if let Some(port) = target.port {
        args.push("-p".into());
        args.push(port.to_string());
    }
    args.push("--".into());
    args.push(target.destination());
    args.push(remote_command());
    args
}

/// The Terminal script for an install on another machine over SSH.
pub fn remote_install_script(target: &SshTarget) -> String {
    let args: Vec<String> = ssh_args(target).iter().map(|a| sh_quote(a)).collect();
    let dest = target.destination();
    format!(
        r#"#!/bin/bash
rm -f -- "$0"
printf '\033]0;%s\007' {title}
echo {what}
cat <<'CODEMAN_MSG'

ssh may ask you to confirm the machine and for its password. Then the installer
asks how Codeman should be reached (Tailscale, the local network with a password,
or that machine only) and whether to run it in the background. At the end it
prints the address of Codeman there: connect to it in the Codeman app, under
Another machine.

CODEMAN_MSG
ssh {args}
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo 'Done. You can close this window.'
else
  echo "ssh or the installer stopped (exit $status)."
fi
exit "$status"
"#,
        title = sh_quote(&format!("Install Codeman on {}", target.host)),
        what = sh_quote(&format!("Installing Codeman on {dest} over SSH.")),
        args = args.join(" "),
    )
}

static SCRIPT_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Run `script` in a new Terminal window. The script file is private to this
/// user (the per-user temporary folder, mode 0700, created fresh) and deletes
/// itself as it starts.
#[cfg(target_os = "macos")]
pub fn open_in_terminal(name: &str, script: &str) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;

    let n = SCRIPT_COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("{name}-{}-{n}.command", std::process::id()));
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)
        .and_then(|mut f| f.write_all(script.as_bytes()));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&path);
        return Err(format!("Could not write the install script: {e}"));
    }
    let out = Command::new("/usr/bin/open")
        .args(["-b", "com.apple.Terminal"])
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let _ = std::fs::remove_file(&path);
            let said = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(if said.is_empty() {
                "Could not open Terminal.".into()
            } else {
                format!("Could not open Terminal: {said}")
            })
        }
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            Err(format!("Could not open Terminal: {e}"))
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn open_in_terminal(_name: &str, _script: &str) -> Result<(), String> {
    let _ = &SCRIPT_COUNTER;
    Err("Installing from the app is only available on macOS so far.".into())
}

/// Put `text` on the clipboard (`pbcopy`). The connect page is not a secure
/// context, so it cannot use the web clipboard API itself.
pub fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let mut child = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not copy: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("Could not copy: {e}"))?;
    }
    match child.wait() {
        Ok(s) if s.success() => Ok(()),
        _ => Err("Could not copy the command.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn install_sh_service_reads_from_its_environment() {
        let job = json!({
            "Label": "com.codeman.web",
            "ProgramArguments": ["/opt/homebrew/bin/node", "/Users/k/.codeman/app/dist/index.js", "web"],
            "EnvironmentVariables": {
                "PATH": "/opt/homebrew/bin:/usr/bin",
                "CODEMAN_HOST": "0.0.0.0",
                "CODEMAN_PASSWORD": "s3cret",
                "CODEMAN_PORT": "3001",
                "CODEMAN_BASE_URL": "/codeman/"
            }
        });
        let s = parse_service(&job);
        assert_eq!(s.port, 3001);
        assert_eq!(s.base_path, "/codeman");
        assert!(!s.https);
        assert_eq!(s.password.as_deref(), Some("s3cret"));
        assert_eq!(s.username, None);
        assert_eq!(local_url(Some(&s)).as_str(), "http://127.0.0.1:3001/codeman/");
    }

    /// The real file shapes through the real plutil: install.sh's template
    /// (an XML-escaped password, booleans and an integer plutil must carry
    /// into JSON) and `codeman service install`'s.
    #[cfg(target_os = "macos")]
    #[test]
    fn plutil_reads_both_launch_agent_shapes() {
        let n = SCRIPT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("codeman-plist-test-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let install_sh = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codeman.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/k/.codeman/app/dist/index.js</string>
    <string>web</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/k</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>CODEMAN_HOST</key>
    <string>0.0.0.0</string>
    <key>CODEMAN_PASSWORD</key>
    <string>p&amp;w&lt;"x'</string>
    <key>CODEMAN_PORT</key>
    <string>3002</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>/Users/k</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/tmp/codeman.log</string>
</dict>
</plist>
"#;
        let a = dir.join("install-sh.plist");
        std::fs::write(&a, install_sh).unwrap();
        let s = read_service_file(&a).expect("plutil read the install.sh agent");
        assert_eq!(s.port, 3002);
        assert_eq!(s.password.as_deref(), Some("p&w<\"x'"));
        assert_eq!(local_url(Some(&s)).as_str(), "http://127.0.0.1:3002/");

        let service = install_sh
            .replace(
                "<string>web</string>",
                "<string>web</string>\n    <string>--host</string>\n    <string>127.0.0.1</string>\n    <string>--port</string>\n    <string>4100</string>\n    <string>--base-url</string>\n    <string>/cm</string>",
            )
            .replace("<key>CODEMAN_PASSWORD</key>\n    <string>p&amp;w&lt;\"x'</string>\n", "");
        let b = dir.join("service.plist");
        std::fs::write(&b, service).unwrap();
        let s = read_service_file(&b).expect("plutil read the service-install agent");
        assert_eq!(
            (s.port, s.base_path.as_str(), s.password.as_deref()),
            (4100, "/cm", None)
        );
        assert!(read_service_file(&dir.join("missing.plist")).is_none());
        std::fs::write(dir.join("broken.plist"), "<plist><dict><key>x").unwrap();
        assert!(read_service_file(&dir.join("broken.plist")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn service_install_reads_its_arguments_and_flags_win() {
        let job = json!({
            "ProgramArguments": [
                "/usr/local/bin/node", "--max-old-space-size=4096", "/opt/codeman/dist/index.js",
                "web", "--host", "--port", "--port", "4100", "--https", "--base-url", "x//y/"
            ],
            "EnvironmentVariables": { "CODEMAN_PORT": "3005", "HOME": "/Users/k" }
        });
        let s = parse_service(&job);
        // --host takes "--port" as its value; the real --port follows it.
        assert_eq!(s.port, 4100);
        assert!(s.https);
        assert_eq!(s.base_path, "/x/y");
        assert_eq!(s.password, None);
        assert_eq!(local_url(Some(&s)).as_str(), "https://127.0.0.1:4100/x/y/");

        let eq = parse_service(&json!({ "ProgramArguments": ["node", "i.js", "web", "--port=4200", "--base-url=/a"] }));
        assert_eq!((eq.port, eq.base_path.as_str()), (4200, "/a"));
    }

    #[test]
    fn service_defaults_and_bad_values() {
        let s = parse_service(&json!({}));
        assert_eq!((s.port, s.base_path.as_str(), s.https), (DEFAULT_PORT, "", false));
        assert_eq!(local_url(None).as_str(), "http://127.0.0.1:3000/");
        let bad = parse_service(&json!({
            "EnvironmentVariables": { "CODEMAN_PORT": "0", "CODEMAN_BASE_URL": "/a b", "CODEMAN_PASSWORD": "" }
        }));
        assert_eq!((bad.port, bad.base_path.as_str()), (DEFAULT_PORT, ""));
        assert_eq!(bad.password, None);
        assert_eq!(
            parse_service(&json!({"ProgramArguments": ["web", "--port", "99999"]})).port,
            DEFAULT_PORT
        );
        // Before `web` is node's business, not Codeman's.
        assert_eq!(
            parse_service(&json!({"ProgramArguments": ["--port", "1", "x.js", "web"]})).port,
            DEFAULT_PORT
        );
    }

    #[test]
    fn base_path_matches_codeman() {
        assert_eq!(normalize_base_path(""), "");
        assert_eq!(normalize_base_path("/"), "");
        assert_eq!(normalize_base_path("codeman"), "/codeman");
        assert_eq!(normalize_base_path("//codeman//"), "/codeman");
        assert_eq!(normalize_base_path("/a/b.c~_-/"), "/a/b.c~_-");
        assert_eq!(normalize_base_path("/a?x"), "");
        assert_eq!(normalize_base_path("/%2e"), "");
    }

    #[test]
    fn env_file_like_codeman() {
        let vars = parse_env_file(
            "# comment\n\nexport CODEMAN_PASSWORD=\"pa ss\"\nCODEMAN_USERNAME='kay'\r\n\
             BAD-NAME=1\nexportX=2\nEMPTY=\nQ=\"\nnot an assignment\n",
        );
        assert_eq!(vars.get("CODEMAN_PASSWORD").map(String::as_str), Some("pa ss"));
        assert_eq!(vars.get("CODEMAN_USERNAME").map(String::as_str), Some("kay"));
        assert_eq!(vars.get("exportX").map(String::as_str), Some("2"));
        assert_eq!(vars.get("EMPTY").map(String::as_str), Some(""));
        assert_eq!(vars.get("Q").map(String::as_str), Some(""));
        assert!(!vars.contains_key("BAD-NAME"));
    }

    fn service(port: u16, user: Option<&str>, pass: Option<&str>) -> ServiceConfig {
        ServiceConfig {
            port,
            base_path: String::new(),
            https: false,
            username: user.map(Into::into),
            password: pass.map(Into::into),
            daemon: false,
        }
    }

    #[test]
    fn local_login_only_for_the_local_codeman() {
        let none = HashMap::new();
        let file: HashMap<String, String> = [("CODEMAN_PASSWORD", "fromfile"), ("CODEMAN_USERNAME", "kay")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let svc = service(3001, None, Some("svc"));

        // The service's password, with the service's username or admin: never
        // the file's username, which the server does not read.
        assert_eq!(
            login_for(&u("http://127.0.0.1:3001/"), Some(&svc), &file),
            Some(("admin".into(), "svc".into()))
        );
        assert_eq!(
            login_for(
                &u("http://127.0.0.1:3001/x/"),
                Some(&service(3001, Some("ops"), Some("svc"))),
                &file
            ),
            Some(("ops".into(), "svc".into()))
        );
        // No password in the service: the file's pair.
        assert_eq!(
            login_for(&u("http://127.0.0.1:3001/"), Some(&service(3001, None, None)), &file),
            Some(("kay".into(), "fromfile".into()))
        );
        // Only 127.0.0.1 itself, on the service's port.
        for other in [
            "http://localhost:3001/",
            "http://127.0.0.2:3001/",
            "http://[::1]:3001/",
            "http://127.0.0.1:3000/",
            "http://192.168.1.5:3001/",
            "https://box.ts.net/",
        ] {
            assert_eq!(login_for(&u(other), Some(&svc), &file), None, "{other}");
        }
        assert_eq!(login_for(&u("http://127.0.0.1:3000/"), None, &none), None);
        // No service: Codeman's default port.
        assert_eq!(
            login_for(&u("http://127.0.0.1:3000/"), None, &file),
            Some(("kay".into(), "fromfile".into()))
        );
    }

    #[test]
    fn processes_and_listeners() {
        let ps = "  101 /opt/homebrew/bin/node /Users/k/.codeman/app/dist/index.js web\n\
                  202 node /opt/homebrew/bin/codeman web --port 4000\n\
                  303 /usr/local/bin/node --require /x/tsx/preflight.cjs --import file:///x/loader.mjs src/index.ts web\n\
                  404 node /opt/homebrew/bin/codeman web --stop\n\
                  505 node /opt/homebrew/bin/codeman attach w1\n\
                  606 /bin/zsh -l\n\
                  707 vim dist/index.js\n\
                  808 /bin/bash /var/folders/x/T/install-codeman-local-55-0.command\n\
                  909 bash /var/folders/x/T/codeman-install.Ab12Cd --local --service --port 3001\n\
                  1001 /bin/bash /var/folders/x/T/install-codeman-remote-55-1.command\n\
                  garbage line\n";
        let procs = parse_ps(ps);
        assert_eq!(
            procs[0],
            (
                101,
                "/opt/homebrew/bin/node /Users/k/.codeman/app/dist/index.js web".to_string()
            )
        );
        assert_eq!(codeman_servers(&procs), [101, 202, 303]);
        let installs: Vec<Option<u16>> = procs.iter().filter_map(|(_, c)| install_in_progress(c)).collect();
        assert_eq!(installs, [None, Some(3001)]);

        let lsof = "p101\nf21\nn127.0.0.1:3000\nf22\nn172.17.0.1:3999\np202\nf9\nn*:4000\np303\nn[::1]:5000\nnbogus\n";
        let found = parse_lsof(lsof);
        assert_eq!(found.len(), 4);
        assert_eq!(
            found[0],
            Listener {
                pid: 101,
                host: "127.0.0.1".into(),
                port: 3000
            }
        );
        assert_eq!(
            found[2],
            Listener {
                pid: 202,
                host: "*".into(),
                port: 4000
            }
        );
        assert_eq!(
            found[3],
            Listener {
                pid: 303,
                host: "[::1]".into(),
                port: 5000
            }
        );
        assert!(serves_loopback_port(&found, 3000));
        assert!(serves_loopback_port(&found, 4000));
        assert!(!serves_loopback_port(&found, 3999));
        assert!(!serves_loopback_port(&found, 5000));
        assert_eq!(listener_url(&found[1]).unwrap().as_str(), "http://172.17.0.1:3999/");
        assert_eq!(listener_url(&found[2]).unwrap().as_str(), "http://127.0.0.1:4000/");
        assert_eq!(listener_url(&found[3]).unwrap().as_str(), "http://[::1]:5000/");
    }

    #[test]
    fn install_port_skips_taken_ones() {
        assert_eq!(pick_port(|_| true), 3000);
        assert_eq!(pick_port(|p| p >= 3002), 3002);
        assert_eq!(pick_port(|_| false), 3000);
    }

    #[test]
    fn quoting() {
        assert_eq!(sh_quote("plain"), "'plain'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn local_install_flags() {
        assert_eq!(
            local_install_args(LocalInstall {
                port: 3000,
                network: false
            }),
            ["--local", "--service", "--port", "3000"]
        );
        assert_eq!(
            local_install_args(LocalInstall {
                port: 3007,
                network: true
            }),
            ["--service", "--port", "3007"]
        );
    }

    /// Run a script under bash with `curl` and `bash`... replaced, and report
    /// what it did. The real installer never runs in a test.
    #[cfg(unix)]
    fn run_script(script: &str, fakes: &[(&str, &str)]) -> (String, i32, bool) {
        use std::os::unix::fs::PermissionsExt;
        let n = SCRIPT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("codeman-setup-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        for (name, body) in fakes {
            let p = dir.join("bin").join(name);
            std::fs::write(&p, body.replace("DIR", &dir.display().to_string())).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let file = dir.join("run.command");
        std::fs::write(&file, script).unwrap();
        let out = Command::new("/bin/bash")
            .arg(&file)
            .env("PATH", format!("{}:/usr/bin:/bin", dir.join("bin").display()))
            .env("TMPDIR", &dir)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let log = std::fs::read_to_string(dir.join("log")).unwrap_or_default();
        let self_deleted = !file.exists();
        let _ = std::fs::remove_dir_all(&dir);
        (log, out.status.code().unwrap_or(-1), self_deleted)
    }

    #[cfg(unix)]
    #[test]
    fn local_script_downloads_then_runs_the_installer_with_its_flags() {
        let script = local_install_script(LocalInstall {
            port: 3001,
            network: false,
        });
        let (log, code, self_deleted) = run_script(
            &script,
            &[(
                "curl",
                r#"#!/bin/sh
echo "curl $*" >> DIR/log
out=""
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > "$out" <<'INSTALLER'
for a in "$@"; do printf '[%s]' "$a" >> DIR/log; done
echo >> DIR/log
exit 7
INSTALLER
"#,
            )],
        );
        assert!(self_deleted, "the script must delete itself");
        assert!(
            log.starts_with("curl -fsSL https://getcodeman.com/install -o "),
            "{log}"
        );
        assert!(log.contains("\n[--local][--service][--port][3001]\n"), "{log}");
        assert_eq!(code, 7, "the installer's exit status is the script's");
    }

    #[cfg(unix)]
    #[test]
    fn local_script_stops_when_the_download_fails() {
        let script = local_install_script(LocalInstall {
            port: 3000,
            network: true,
        });
        let (log, code, _) = run_script(&script, &[("curl", "#!/bin/sh\necho curl >> DIR/log\nexit 22\n")]);
        assert_eq!(log, "curl\n");
        assert_eq!(code, 1);
    }

    #[test]
    fn ssh_targets() {
        assert_eq!(
            SshTarget::parse(" kay@build-box ").unwrap(),
            SshTarget {
                user: Some("kay".into()),
                host: "build-box".into(),
                port: None
            }
        );
        assert_eq!(
            SshTarget::parse("pi@192.168.1.20:2222").unwrap(),
            SshTarget {
                user: Some("pi".into()),
                host: "192.168.1.20".into(),
                port: Some(2222)
            }
        );
        assert_eq!(SshTarget::parse("macmini").unwrap().destination(), "macmini");
        assert_eq!(
            SshTarget::parse("a.b@tnode.tailnet.ts.net").unwrap().destination(),
            "a.b@tnode.tailnet.ts.net"
        );
        for bad in [
            "",
            "-oProxyCommand=touch /tmp/x",
            "kay@-oProxyCommand=x",
            "-l@host",
            "kay@host name",
            "kay@host;rm",
            "kay@host$(x)",
            "k'y@host",
            "kay@",
            "@host",
            "kay@host:",
            "kay@host:0",
            "kay@host:x",
            "kay@fe80::1",
            "kay@[::1]",
            "a@b@c",
            ".hidden",
        ] {
            assert!(SshTarget::parse(bad).is_err(), "accepted {bad:?}");
        }
        assert_eq!(SshTarget::parse("kay@box").unwrap().suggested_url(), "http://box:3000");
    }

    #[test]
    fn ssh_arguments() {
        let t = SshTarget::parse("kay@box:2222").unwrap();
        let args = ssh_args(&t);
        assert_eq!(&args[..5], ["-t", "-p", "2222", "--", "kay@box"]);
        assert_eq!(args.len(), 6);
        let remote = &args[5];
        let head = "bash -o pipefail -c '";
        assert!(remote.starts_with(head) && remote.ends_with('\''));
        // One word for fish and tcsh: no quote inside, nothing they expand.
        let inner = &remote[head.len()..remote.len() - 1];
        assert!(!inner.contains(['\'', '!', '$', '\\', '`']), "{inner}");
        assert!(inner.contains("curl -fsSL https://getcodeman.com/install | bash"));
        assert_eq!(ssh_args(&SshTarget::parse("box").unwrap())[..3], ["-t", "--", "box"]);
    }

    #[cfg(unix)]
    #[test]
    fn remote_script_runs_ssh_with_exactly_those_arguments() {
        let t = SshTarget::parse("kay@box:2222").unwrap();
        let (log, code, self_deleted) = run_script(
            &remote_install_script(&t),
            &[(
                "ssh",
                "#!/bin/sh\nfor a in \"$@\"; do printf '[%s]' \"$a\" >> DIR/log; done\necho >> DIR/log\nexit 3\n",
            )],
        );
        assert!(self_deleted);
        let expected: String = ssh_args(&t).iter().map(|a| format!("[{a}]")).collect();
        assert_eq!(log, format!("{expected}\n"));
        assert_eq!(code, 3);
    }

    /// The remote command does what it says under a POSIX shell: curl first,
    /// wget without curl, and a clear error with neither.
    #[cfg(unix)]
    #[test]
    fn remote_command_picks_a_downloader() {
        use std::os::unix::fs::PermissionsExt;
        let n = SCRIPT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("codeman-remote-cmd-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let exe = |name: &str, body: &str| {
            let p = dir.join("bin").join(name);
            std::fs::write(&p, body).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        // The outer `bash -o pipefail` is the real one; the `bash` the
        // download is piped into only reports what it was fed.
        exe(
            "bash",
            "#!/bin/sh\nif [ \"$1\" = -o ]; then exec /bin/bash \"$@\"; fi\nprintf 'bash got: '; /bin/cat\n",
        );
        exe("wget", "#!/bin/sh\necho \"wget $*\"\n");
        let run = || {
            let out = Command::new("/bin/sh")
                .arg("-c")
                .arg(remote_command())
                .env("PATH", dir.join("bin"))
                .output()
                .unwrap();
            (
                String::from_utf8_lossy(&out.stdout).into_owned(),
                String::from_utf8_lossy(&out.stderr).into_owned(),
                out.status.code(),
            )
        };
        let (out, _, _) = run();
        assert_eq!(out, "bash got: wget -qO- https://getcodeman.com/install\n");
        exe("curl", "#!/bin/sh\necho \"curl $*\"\n");
        let (out, _, _) = run();
        assert_eq!(out, "bash got: curl -fsSL https://getcodeman.com/install\n");
        // A failed download fails the command (pipefail), not "Done".
        exe(
            "curl",
            "#!/bin/sh\necho 'curl: (6) Could not resolve host' >&2\nexit 6\n",
        );
        let (_, _, code) = run();
        assert_ne!(code, Some(0));
        std::fs::remove_file(dir.join("bin/curl")).unwrap();
        std::fs::remove_file(dir.join("bin/wget")).unwrap();
        let (out, err, code) = run();
        assert_eq!(out, "");
        assert!(err.contains("needs curl or wget"), "{err}");
        assert_eq!(code, Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
