//! The connect screen's "This Mac" tab: where the Codeman on this Mac listens,
//! whether it is installed, its login, and which other Codeman servers of this
//! user run here. The install most people get runs in the app
//! (`gui_install.rs`); the Terminal installs are in `terminal_install.rs`.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use url::Url;

use crate::gui_install;
use crate::local_server;
use crate::policy;
use crate::probe::{self, ProbeOutcome};
use crate::terminal_install::LOCAL_SCRIPT_NAME;

/// Codeman's published installer (a redirect to `install.sh` on master). A test
/// build of an installer change sets `CODEMAN_DESKTOP_INSTALLER_URL` when it is
/// compiled; a shipped app has no way to point this anywhere else, at runtime
/// or otherwise.
pub const INSTALLER_URL: &str = match option_env!("CODEMAN_DESKTOP_INSTALLER_URL") {
    Some(url) => url,
    None => "https://getcodeman.com/install",
};

/// The branch that test build installs Codeman from (`CODEMAN_BRANCH`).
pub const INSTALL_BRANCH: Option<&str> = option_env!("CODEMAN_DESKTOP_INSTALL_BRANCH");

/// What to paste into a terminal on another machine; the SSH install runs the
/// same thing there.
pub const INSTALL_ONE_LINER: &str = "curl -fsSL https://getcodeman.com/install | bash";

/// Codeman's default port, and the first one a fresh install tries.
pub const DEFAULT_PORT: u16 = 3000;

/// The username Codeman logs in with when only a password is set
/// (`CODEMAN_USERNAME` unset).
pub const DEFAULT_USERNAME: &str = "admin";

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

    // Only what follows the `web` subcommand: node's own flags come before it.
    let after_web = args
        .iter()
        .position(|a| *a == "web")
        .map_or(&[][..], |i| &args[i + 1..]);
    let flags = WebFlags {
        port: var("CODEMAN_PORT"),
        base: var("CODEMAN_BASE_URL"),
        https: false,
    }
    .read(after_web);
    ServiceConfig {
        port: flags
            .port
            .and_then(|p| p.trim().parse::<u16>().ok())
            .filter(|p| *p > 0)
            .unwrap_or(DEFAULT_PORT),
        base_path: normalize_base_path(flags.base.as_deref().unwrap_or("")),
        https: flags.https,
        username: var("CODEMAN_USERNAME"),
        password: var("CODEMAN_PASSWORD"),
        daemon: false,
    }
}

/// What Codeman's `web` command takes from the arguments after `web`
/// (src/cli.ts). The fields start as what the environment says, or empty.
#[derive(Debug, Default)]
struct WebFlags {
    port: Option<String>,
    base: Option<String>,
    https: bool,
}

impl WebFlags {
    fn read(mut self, after_web: &[&str]) -> Self {
        let mut it = after_web.iter();
        while let Some(arg) = it.next() {
            match *arg {
                "-p" | "--port" => self.port = it.next().map(|s| s.to_string()),
                "--base-url" => self.base = it.next().map(|s| s.to_string()),
                "--https" => self.https = true,
                // Options that take a value: skip it, so it is never read as a flag.
                "-H" | "--host" | "--title-hostname" => {
                    it.next();
                }
                other => {
                    if let Some(v) = other.strip_prefix("--port=") {
                        self.port = Some(v.to_string());
                    } else if let Some(v) = other.strip_prefix("--base-url=") {
                        self.base = Some(v.to_string());
                    }
                }
            }
        }
        self
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
        if !local_server::is_env_name(name) {
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
            let username = s.username.clone().unwrap_or_else(|| DEFAULT_USERNAME.into());
            return Some((username, password.clone()));
        }
    }
    let from_file = |key: &str| env_file.get(key).filter(|v| !v.is_empty()).cloned();
    let password = from_file("CODEMAN_PASSWORD")?;
    let username = from_file("CODEMAN_USERNAME").unwrap_or_else(|| DEFAULT_USERNAME.into());
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
pub fn list_processes() -> Vec<(u32, String)> {
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
    server_args(command).is_some()
}

/// The last path component of a command-line word.
fn basename(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// What follows `web` on a Codeman server's command line, or None for any
/// other command.
fn server_args(command: &str) -> Option<Vec<&str>> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let is_entry = |w: &str| {
        let name = basename(w);
        w.ends_with("dist/index.js") || w.ends_with("src/index.ts") || name == "codeman" || name == "aicodeman"
    };
    // Any entry word that `web` follows: an earlier word may only look like
    // one (a folder named codeman in `tsx watch --cwd ~/codeman src/index.ts web`).
    (0..words.len())
        .find(|&i| {
            is_entry(words[i])
                && words.get(i + 1) == Some(&"web")
                && !words[i + 1..].iter().any(|w| matches!(*w, "--stop" | "--status"))
        })
        .map(|i| words[i + 2..].to_vec())
}

/// Whether a command line is an install the app started on this Mac (the
/// Terminal script, the installer it downloaded, or the graphical install), and
/// the port it asked for once the installer runs.
pub fn install_in_progress(command: &str) -> Option<Option<u16>> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let script = format!("{LOCAL_SCRIPT_NAME}-");
    if words.iter().any(|w| {
        let n = basename(w);
        n.starts_with(&script) && n.ends_with(".command")
    }) {
        return Some(None);
    }
    if words.iter().any(|w| basename(w).starts_with("codeman-install.")) || gui_install::Run::Codeman.matches(command) {
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

/// The install the app started on this Mac, if one runs, with the port it
/// asked for as soon as one of its processes names it. The Terminal script
/// that wraps the installer names none and is the older process, so the first
/// match alone would report no port for the whole install.
fn running_install(procs: &[(u32, String)]) -> Option<Option<u16>> {
    let mut installs = procs.iter().filter_map(|(_, c)| install_in_progress(c)).peekable();
    installs.peek()?;
    Some(installs.flatten().next())
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

/// Where the app can try each of this user's Codeman servers, from their
/// command lines (`procs`) and listening sockets. `default` is the address the
/// app opens by default (local_url); it comes first, then the others by port.
///
/// One address per server and port: 127.0.0.1 when the server listens there
/// or on every interface, `[::1]` when its only loopback socket is the IPv6
/// one, else each address it is bound to. A socket beside a loopback one on
/// the same port is left out (the Docker bridge listener, which serves hook
/// endpoints only). `https` when the command line carries `--https`, and its
/// `--base-url` is the path. `ps` does not show a base path kept in the
/// environment, which is where install.sh's launchd job keeps it, so a server
/// at the default address with no `--base-url` of its own is the default one.
pub fn found_addresses(procs: &[(u32, String)], listeners: &[Listener], default: &Url) -> Vec<Url> {
    let mut urls: Vec<Url> = Vec::new();
    for (pid, command) in procs {
        let Some(args) = server_args(command) else {
            continue;
        };
        let flags = WebFlags::default().read(&args);
        let scheme = if flags.https { "https" } else { "http" };
        let base = flags.base.as_deref().map(normalize_base_path);
        let own: Vec<&Listener> = listeners.iter().filter(|l| l.pid == *pid).collect();
        for l in &own {
            let beside = |hosts: &[&str]| own.iter().any(|o| o.port == l.port && hosts.contains(&o.host.as_str()));
            let host = if beside(&["*", "0.0.0.0", "[::]", "127.0.0.1"]) {
                "127.0.0.1"
            } else if beside(&["[::1]"]) {
                "[::1]"
            } else {
                l.host.as_str()
            };
            let path = base.as_deref().unwrap_or("");
            let Ok(mut url) = Url::parse(&format!("{scheme}://{host}:{}{path}/", l.port)) else {
                continue;
            };
            if base.is_none() && policy::same_origin(&url, default) {
                url = default.clone();
            }
            if !urls.contains(&url) {
                urls.push(url);
            }
        }
    }
    urls.sort_by_key(|u| (u != default, u.port_or_known_default(), u.to_string()));
    urls
}

/// What the This Mac tab says about one found server.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FoundState {
    /// Codeman answers there: Connect opens it.
    Running,
    /// Codeman answers there and wants a login.
    NeedsLogin,
    /// It serves HTTPS with a certificate the app refuses (Codeman's own
    /// self-signed one, from `codeman web --https`).
    Certificate,
    /// Codeman does not answer there.
    Unreachable,
}

/// One of this user's Codeman servers on this Mac, for the This Mac tab's
/// rows.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FoundServer {
    /// Where the app can try it (found_addresses).
    pub url: String,
    pub version: Option<String>,
    pub state: FoundState,
    /// It is at the address the app opens by default (local_url).
    pub is_default: bool,
}

/// The row for the server at `url`, from what it answered.
fn found_server(url: &Url, answer: &ProbeOutcome, default: &Url) -> FoundServer {
    let state = match answer {
        ProbeOutcome::Ok { .. } | ProbeOutcome::PasswordChangeRequired => FoundState::Running,
        _ if answers(answer) => FoundState::NeedsLogin,
        // A Codeman started with --https closes a plain http connection.
        ProbeOutcome::TlsUntrusted { .. } | ProbeOutcome::MaybeHttps => FoundState::Certificate,
        _ => FoundState::Unreachable,
    };
    FoundServer {
        url: url.to_string(),
        version: answer.version(),
        state,
        is_default: url == default,
    }
}

/// How long a found server gets to answer when the tab only lists it.
const FOUND_TIMEOUT: Duration = Duration::from_secs(2);

/// Ask the servers at `urls`, all at the same time, so the look takes as long
/// as the slowest answer and no longer. Without a login: the one the app can
/// read belongs to the default address (login_for).
fn ask_found(urls: &[Url], patience: Duration) -> Vec<ProbeOutcome> {
    std::thread::scope(|scope| {
        let asking: Vec<_> = urls
            .iter()
            .map(|url| scope.spawn(move || probe::probe_within(url, None, patience)))
            .collect();
        asking
            .into_iter()
            .map(|a| {
                a.join().unwrap_or_else(|_| ProbeOutcome::Failed {
                    detail: "The check stopped.".into(),
                })
            })
            .collect()
    })
}

/// The address the This Mac tab is about, with its answer: the default one,
/// or, when nothing answers there, the first found server that does (a
/// `codeman web --port 4000` in a terminal, a bind to one network address).
fn shown<'a>(
    default: &'a Url,
    answer: &'a ProbeOutcome,
    found: &'a [(Url, ProbeOutcome)],
) -> (&'a Url, &'a ProbeOutcome) {
    if *answer == ProbeOutcome::Refused {
        if let Some((url, answer)) = found.iter().find(|(_, a)| answers(a)) {
            return (url, answer);
        }
    }
    (default, answer)
}

/// What the This Mac tab shows.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LocalState {
    /// Codeman answers, and the app has its login if it needs one.
    Running,
    /// Codeman answers but wants a login the app does not have.
    NeedsLogin,
    /// A Codeman server of this user runs but listens nowhere yet: it is
    /// still starting (the LaunchAgent at login, a restart).
    Starting,
    /// A Codeman server of this user runs, but none answers at an address the
    /// app can open (HTTPS with Codeman's own certificate, say): see `found`.
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
    /// An install the app started is still running, and the port it asked
    /// for once that is known.
    pub install_running: bool,
    pub install_port: Option<u16>,
    /// That install is the graphical one, not a Terminal window: the page can
    /// show it (gui_install::follow), also after the app was quit.
    pub install_in_app: bool,
    /// A coding agent is being added the same way. Not an install: it says
    /// nothing about Codeman, which may well be running.
    pub agent_install_in_app: bool,
    /// Every Codeman server of this user that listens on this Mac, the one at
    /// the default address first: the tab offers to connect to each.
    pub found: Vec<FoundServer>,
    /// The probe's outcome, for the connect page's explanations.
    pub outcome: ProbeOutcome,
}

/// Whether the probe got an answer from a Codeman server, logged in or not.
fn answers(outcome: &ProbeOutcome) -> bool {
    matches!(
        outcome,
        ProbeOutcome::Ok { .. }
            | ProbeOutcome::PasswordChangeRequired
            | ProbeOutcome::NeedsLogin
            | ProbeOutcome::BadCredentials
            | ProbeOutcome::RateLimited { .. }
    )
}

/// What the This Mac tab shows for what `inspect` found. `server_runs`: one of
/// this user's Codeman server processes exists. `server_listens`: one of them
/// has a listening socket. `installed`: Codeman is on this Mac.
fn local_state(outcome: &ProbeOutcome, server_runs: bool, server_listens: bool, installed: bool) -> LocalState {
    match outcome {
        ProbeOutcome::Ok { .. } | ProbeOutcome::PasswordChangeRequired => LocalState::Running,
        _ if answers(outcome) => LocalState::NeedsLogin,
        ProbeOutcome::Refused if server_runs && !server_listens => LocalState::Starting,
        ProbeOutcome::Refused if server_runs => LocalState::RunningElsewhere,
        ProbeOutcome::Refused if installed => LocalState::Stopped,
        ProbeOutcome::Refused => LocalState::NotInstalled,
        _ => LocalState::Other,
    }
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
    let default = local_url(service.as_ref());
    let procs = list_processes();
    let servers = codeman_servers(&procs);
    let listening = listeners(&servers);
    let install = running_install(&procs);
    let install_in_app = procs.iter().any(|(_, c)| gui_install::Run::Codeman.matches(c));
    let agent_install_in_app = procs.iter().any(|(_, c)| gui_install::Run::Agent.matches(c));

    // The login goes only to this user's own Codeman on that port.
    let auth = if serves_loopback_port(&listening, default.port_or_known_default().unwrap_or(0)) {
        login_for(&default, service.as_ref(), &read_env_file()).map(|(u, p)| policy::basic_auth_header(&u, &p))
    } else {
        None
    };
    let answer = probe::probe(&default, auth.as_deref());

    // The other addresses this user's Codeman servers listen at, asked once
    // each. With nothing at the default address, the first that answers is
    // what the tab opens (`shown`), so each gets the probe's usual time;
    // otherwise they are only listed, and get less.
    let patience = if answer == ProbeOutcome::Refused {
        probe::TIMEOUT
    } else {
        FOUND_TIMEOUT
    };
    let addresses = found_addresses(&procs, &listening, &default);
    let others: Vec<Url> = addresses.iter().filter(|u| **u != default).cloned().collect();
    let mut answered: Vec<(Url, ProbeOutcome)> = others.iter().cloned().zip(ask_found(&others, patience)).collect();
    // found_addresses puts the default address first.
    if addresses.first() == Some(&default) {
        answered.insert(0, (default.clone(), answer.clone()));
    }
    let found: Vec<FoundServer> = answered.iter().map(|(u, a)| found_server(u, a, &default)).collect();
    // The tab never offers to start a second server on the same sessions: it
    // opens the one that answers, or lists where they listen.
    let (url, outcome) = shown(&default, &answer, &answered);
    let (url, outcome) = (url.clone(), outcome.clone());

    let app = home.join(".codeman/app");
    let install_complete = app.join(".install-complete").is_file();
    // Something else on Codeman's port (a dev server on 3000, say) says
    // nothing about whether Codeman is installed, so look either way.
    let on_disk = install_complete
        || app.join("dist/index.js").is_file()
        || agent_path(&home).is_file()
        || daemon_path().is_file();
    let installed = answers(&outcome)
        || !servers.is_empty()
        || on_disk
        || match depth {
            Depth::Quick => false,
            Depth::Login => local_server::installed(false),
            Depth::Interactive => local_server::installed(true),
        };
    let state = local_state(&outcome, !servers.is_empty(), !listening.is_empty(), installed);
    let version = outcome.version();
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
        install_in_app,
        agent_install_in_app,
        found,
        outcome,
    }
}

/// Why the app will not start a server: one of this user's Codeman servers
/// already runs. A second one on the same data dir and tmux socket would
/// attach to the first one's live sessions (src/config/instance.ts), and
/// `codeman web -d` only notices a server it started itself or one at the
/// same address.
pub fn already_running() -> Option<String> {
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

/// Whether `url` is where the launchd job `service` answers: its scheme and
/// port on this Mac, under `localhost` as much as 127.0.0.1. The path is left
/// out: a job with a base path answers below `/` too, and a second server on
/// its port would run without the job's settings.
fn served_by(service: &ServiceConfig, url: &Url) -> bool {
    let at = local_url(Some(service));
    policy::is_loopback(url) && url.scheme() == at.scheme() && url.port_or_known_default() == at.port_or_known_default()
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
        Some(s) if served_by(&s, url) => {
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
        std::thread::sleep(Duration::from_millis(100));
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
        let dir = std::env::temp_dir().join(format!("codeman-plist-test-{}", std::process::id()));
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
    fn a_start_goes_to_the_launchd_job_that_serves_the_address() {
        let job = parse_service(&json!({
            "ProgramArguments": ["node", "i.js", "web"],
            "EnvironmentVariables": { "CODEMAN_PORT": "3001", "CODEMAN_BASE_URL": "/codeman" }
        }));
        // The app's own address for it, and what a user types for the same server.
        assert!(served_by(&job, &u("http://127.0.0.1:3001/codeman/")));
        assert!(served_by(&job, &u("http://localhost:3001/codeman/")));
        assert!(served_by(&job, &u("http://LOCALHOST:3001/")));
        // Another port, scheme or machine is not this job's server.
        assert!(!served_by(&job, &u("http://127.0.0.1:3000/codeman/")));
        assert!(!served_by(&job, &u("https://127.0.0.1:3001/codeman/")));
        assert!(!served_by(&job, &u("http://192.168.1.5:3001/codeman/")));
        assert!(!served_by(&job, &u("http://localhost.example.com:3001/")));

        let https = parse_service(&json!({ "ProgramArguments": ["node", "i.js", "web", "--https"] }));
        assert!(served_by(&https, &u("https://localhost:3000/")));
        assert!(!served_by(&https, &u("http://localhost:3000/")));
    }

    #[test]
    fn this_mac_state_for_what_was_found() {
        let ok = ProbeOutcome::Ok {
            version: "1.48.0".into(),
        };
        // Whatever else is true, a Codeman that answers is what the tab shows.
        for (runs, listens, installed) in [(false, false, false), (true, true, true), (true, false, false)] {
            assert_eq!(local_state(&ok, runs, listens, installed), LocalState::Running);
            assert_eq!(
                local_state(&ProbeOutcome::PasswordChangeRequired, runs, listens, installed),
                LocalState::Running
            );
            for login in [
                ProbeOutcome::NeedsLogin,
                ProbeOutcome::BadCredentials,
                ProbeOutcome::RateLimited {
                    sent_credentials: false,
                    retry_after_secs: None,
                },
            ] {
                assert_eq!(local_state(&login, runs, listens, installed), LocalState::NeedsLogin);
            }
        }
        // Nothing answers. A server process with no socket yet is starting,
        // which comes before "runs somewhere else": the app must not send the
        // user to another address for a server that is two seconds from up.
        let refused = ProbeOutcome::Refused;
        assert_eq!(local_state(&refused, true, false, true), LocalState::Starting);
        assert_eq!(local_state(&refused, true, false, false), LocalState::Starting);
        assert_eq!(local_state(&refused, true, true, true), LocalState::RunningElsewhere);
        assert_eq!(local_state(&refused, false, false, true), LocalState::Stopped);
        assert_eq!(local_state(&refused, false, false, false), LocalState::NotInstalled);
        // Something else holds the port, or the look itself failed.
        for other in [
            ProbeOutcome::NotCodeman { status: 404 },
            ProbeOutcome::Timeout,
            ProbeOutcome::MaybeHttps,
        ] {
            assert_eq!(local_state(&other, true, true, true), LocalState::Other);
            assert_eq!(local_state(&other, false, false, false), LocalState::Other);
        }
        assert!(answers(&ProbeOutcome::BadCredentials) && !answers(&refused));
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
        // A folder named like the command comes before the real entry point.
        assert!(is_codeman_server(
            "node /x/tsx/cli.mjs watch --cwd /Users/k/codeman src/index.ts web"
        ));
        assert!(is_codeman_server(
            "node --watch-path /Users/k/codeman /Users/k/codeman/src/index.ts web --port 3001"
        ));
        assert!(!is_codeman_server("node /Users/k/codeman/scripts/build.mjs web"));
        assert!(!is_codeman_server("/opt/homebrew/bin/codeman attach web"));
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
        // The Terminal script comes first and names no port: the installer's wins.
        assert_eq!(running_install(&procs), Some(Some(3001)));
        // Before the installer is downloaded, only the script runs.
        assert_eq!(running_install(&procs[..8]), Some(None));
        assert_eq!(running_install(&procs[..7]), None);

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
        // The same four sockets as the addresses the app can try, by port.
        assert_eq!(
            addresses(&procs, &found, "http://127.0.0.1:3000/"),
            [
                "http://127.0.0.1:3000/",
                "http://172.17.0.1:3999/",
                "http://127.0.0.1:4000/",
                "http://[::1]:5000/"
            ]
        );
    }

    fn server(pid: u32, flags: &str) -> (u32, String) {
        (pid, format!("node /opt/homebrew/bin/codeman web{flags}"))
    }

    fn listener(pid: u32, host: &str, port: u16) -> Listener {
        Listener {
            pid,
            host: host.into(),
            port,
        }
    }

    /// found_addresses, as strings. The page sends one back in a `connect`,
    /// so each must be an address the connect takes as it is: the app saves
    /// a server, and finds its saved login, under that exact string.
    fn addresses(procs: &[(u32, String)], listeners: &[Listener], default: &str) -> Vec<String> {
        found_addresses(procs, listeners, &u(default))
            .iter()
            .map(|url| {
                assert_eq!(policy::normalize_server_url(url.as_str()).as_ref(), Ok(url));
                url.to_string()
            })
            .collect()
    }

    #[test]
    fn a_found_server_becomes_an_address_the_app_can_try() {
        let default = "http://127.0.0.1:3000/";
        let one = |flags: &str, listeners: &[Listener]| addresses(&[server(1, flags)], listeners, default);

        // Every interface and IPv4 loopback are reached at 127.0.0.1.
        for host in ["*", "0.0.0.0", "[::]", "127.0.0.1"] {
            assert_eq!(
                one(" --port 4000", &[listener(1, host, 4000)]),
                ["http://127.0.0.1:4000/"],
                "{host}"
            );
        }
        // IPv6 loopback keeps its own address only when it is the server's
        // only loopback socket.
        assert_eq!(one("", &[listener(1, "[::1]", 5000)]), ["http://[::1]:5000/"]);
        assert_eq!(
            one("", &[listener(1, "[::1]", 5000), listener(1, "127.0.0.1", 5000)]),
            ["http://127.0.0.1:5000/"]
        );
        // A dual-stack bind shows as two sockets, both `*`: one address.
        assert_eq!(
            one("", &[listener(1, "*", 5000), listener(1, "*", 5000)]),
            ["http://127.0.0.1:5000/"]
        );
        // A bind to one address stays that address.
        assert_eq!(
            one(" --host 192.168.1.5", &[listener(1, "192.168.1.5", 3000)]),
            ["http://192.168.1.5:3000/"]
        );

        // --https and --base-url come from the command line, in both spellings.
        assert_eq!(
            one(" --https --port 4000 --base-url /codeman/", &[listener(1, "*", 4000)]),
            ["https://127.0.0.1:4000/codeman/"]
        );
        assert_eq!(
            one(" -p 4000 --base-url=cm", &[listener(1, "127.0.0.1", 4000)]),
            ["http://127.0.0.1:4000/cm/"]
        );
        // The value of --host is never read as a flag, and a base path Codeman
        // would refuse counts as none.
        assert_eq!(
            one(" --host --https -p 4000", &[listener(1, "127.0.0.1", 4000)]),
            ["http://127.0.0.1:4000/"]
        );
        assert_eq!(
            one(" -p 4000 --base-url /a?b", &[listener(1, "127.0.0.1", 4000)]),
            ["http://127.0.0.1:4000/"]
        );
        // What comes before `web` is node's business.
        assert_eq!(
            addresses(
                &[(1, "node --https /Users/k/.codeman/app/dist/index.js web".to_string())],
                &[listener(1, "*", 4000)],
                default
            ),
            ["http://127.0.0.1:4000/"]
        );

        // A server with two listeners. Beside a loopback socket on the same
        // port, another one is the same server (the Docker bridge listener);
        // on another port, or with no loopback socket, each is an address.
        assert_eq!(
            one("", &[listener(1, "127.0.0.1", 3001), listener(1, "172.17.0.1", 3001)]),
            ["http://127.0.0.1:3001/"]
        );
        assert_eq!(
            one("", &[listener(1, "172.17.0.1", 3999), listener(1, "127.0.0.1", 3001)]),
            ["http://127.0.0.1:3001/", "http://172.17.0.1:3999/"]
        );
        assert_eq!(
            one("", &[listener(1, "192.168.1.5", 3001), listener(1, "100.64.0.7", 3001)]),
            ["http://100.64.0.7:3001/", "http://192.168.1.5:3001/"]
        );

        // Only the sockets of Codeman servers count: not a control command's,
        // another program's, or one whose process `ps` did not list.
        let procs = [
            server(1, " --port 4000"),
            (2, "node /opt/homebrew/bin/codeman attach w1".to_string()),
            (3, "python3 -m http.server 8000".to_string()),
        ];
        let sockets = [
            listener(2, "*", 4100),
            listener(3, "*", 8000),
            listener(9, "*", 9000),
            listener(1, "*", 4000),
        ];
        assert_eq!(addresses(&procs, &sockets, default), ["http://127.0.0.1:4000/"]);
        assert!(addresses(&procs, &sockets[..3], default).is_empty());
        // An address that makes no URL is left out.
        assert!(one("", &[listener(1, "not a host", 3001)]).is_empty());
    }

    #[test]
    fn found_addresses_start_with_the_default_one_then_go_by_port() {
        // install.sh's launchd job: a bare `web`, the base path in its environment.
        let default = "http://127.0.0.1:3001/codeman/";
        let procs = [
            (
                10,
                "node /x/tsx/cli.mjs /Users/k/codeman/src/index.ts web --port 5000".to_string(),
            ),
            (
                20,
                "/opt/homebrew/bin/node /Users/k/.codeman/app/dist/index.js web".to_string(),
            ),
            server(30, " -p 4000 --https"),
            // The same address twice: a second process on the port of the first.
            server(40, " --port 5000"),
        ];
        let sockets = [
            listener(10, "*", 5000),
            listener(20, "*", 3001),
            listener(30, "127.0.0.1", 4000),
            listener(40, "127.0.0.1", 5000),
        ];
        assert_eq!(
            addresses(&procs, &sockets, default),
            [
                "http://127.0.0.1:3001/codeman/",
                "https://127.0.0.1:4000/",
                "http://127.0.0.1:5000/"
            ]
        );
        // The same list whatever order `ps` and `lsof` gave.
        let mut reversed_procs = procs.to_vec();
        reversed_procs.reverse();
        let mut reversed_sockets = sockets.to_vec();
        reversed_sockets.reverse();
        assert_eq!(
            addresses(&reversed_procs, &reversed_sockets, default),
            addresses(&procs, &sockets, default)
        );

        // On the default port, a command line with its own base path or
        // scheme is taken at its word: it may be another server than the job's.
        let on_3001 = |flags: &str| addresses(&[server(1, flags)], &[listener(1, "*", 3001)], default);
        assert_eq!(on_3001(" --port 3001"), [default]);
        assert_eq!(on_3001(" --port 3001 --base-url /codeman"), [default]);
        assert_eq!(
            on_3001(" --port 3001 --base-url /other"),
            ["http://127.0.0.1:3001/other/"]
        );
        assert_eq!(on_3001(" --port 3001 --base-url /"), ["http://127.0.0.1:3001/"]);
        assert_eq!(on_3001(" --port 3001 --https"), ["https://127.0.0.1:3001/"]);
        // 127.0.0.1 only: a bind to another address is not the default one.
        assert_eq!(
            addresses(&[server(1, "")], &[listener(1, "192.168.1.5", 3001)], default),
            ["http://192.168.1.5:3001/"]
        );
    }

    #[test]
    fn a_found_server_row_says_what_answered() {
        let default = u("http://127.0.0.1:3000/");
        let at = u("http://127.0.0.1:4000/");
        let row = |answer: ProbeOutcome| found_server(&at, &answer, &default);
        assert_eq!(
            row(ProbeOutcome::Ok {
                version: "1.49.0".into()
            }),
            FoundServer {
                url: "http://127.0.0.1:4000/".into(),
                version: Some("1.49.0".into()),
                state: FoundState::Running,
                is_default: false,
            }
        );
        let state = |answer: ProbeOutcome| {
            let row = row(answer);
            assert_eq!(row.version, None);
            row.state
        };
        assert_eq!(state(ProbeOutcome::PasswordChangeRequired), FoundState::Running);
        for login in [
            ProbeOutcome::NeedsLogin,
            ProbeOutcome::BadCredentials,
            ProbeOutcome::RateLimited {
                sent_credentials: false,
                retry_after_secs: Some(60),
            },
        ] {
            assert_eq!(state(login), FoundState::NeedsLogin);
        }
        for certificate in [
            ProbeOutcome::TlsUntrusted {
                detail: "invalid peer certificate: UnknownIssuer".into(),
            },
            ProbeOutcome::MaybeHttps,
        ] {
            assert_eq!(state(certificate), FoundState::Certificate);
        }
        for silent in [
            ProbeOutcome::Refused,
            ProbeOutcome::Timeout,
            ProbeOutcome::Unreachable,
            ProbeOutcome::HostNotAllowed,
            ProbeOutcome::NotCodeman { status: 403 },
            ProbeOutcome::Failed { detail: "x".into() },
        ] {
            assert_eq!(state(silent), FoundState::Unreachable);
        }
        assert!(found_server(&default, &ProbeOutcome::Refused, &default).is_default);

        // As the connect page reads it.
        assert_eq!(
            serde_json::to_value(row(ProbeOutcome::Ok {
                version: "1.49.0".into()
            }))
            .unwrap(),
            json!({ "url": "http://127.0.0.1:4000/", "version": "1.49.0", "state": "running", "isDefault": false })
        );
        assert_eq!(
            serde_json::to_value(found_server(&default, &ProbeOutcome::NeedsLogin, &default)).unwrap(),
            json!({ "url": "http://127.0.0.1:3000/", "version": null, "state": "needsLogin", "isDefault": true })
        );
        assert_eq!(
            serde_json::to_value([FoundState::Certificate, FoundState::Unreachable]).unwrap(),
            json!(["certificate", "unreachable"])
        );
    }

    #[test]
    fn the_tab_is_about_the_default_address_unless_nothing_answers_there() {
        let default = u("http://127.0.0.1:3000/");
        let ok = ProbeOutcome::Ok {
            version: "1.49.0".into(),
        };
        let refused = ProbeOutcome::Refused;
        let found = vec![
            (
                u("https://127.0.0.1:4000/"),
                ProbeOutcome::TlsUntrusted { detail: "x".into() },
            ),
            (u("http://127.0.0.1:5000/"), ProbeOutcome::NeedsLogin),
            (u("http://127.0.0.1:6000/"), ok.clone()),
        ];
        // Nothing at the default address: the first found server that
        // answers, one that wants a login included.
        assert_eq!(
            shown(&default, &refused, &found),
            (&found[1].0, &ProbeOutcome::NeedsLogin)
        );
        assert_eq!(shown(&default, &refused, &found[2..]), (&found[2].0, &ok));
        // None of them answers: the tab stays on the default address, and
        // local_state makes that RunningElsewhere.
        assert_eq!(shown(&default, &refused, &found[..1]), (&default, &refused));
        assert_eq!(shown(&default, &refused, &[]), (&default, &refused));
        // Whatever else the default address says is what the tab shows; the
        // servers found elsewhere are only listed.
        for answer in [
            ok.clone(),
            ProbeOutcome::NeedsLogin,
            ProbeOutcome::NotCodeman { status: 404 },
            ProbeOutcome::Timeout,
            ProbeOutcome::MaybeHttps,
        ] {
            assert_eq!(shown(&default, &answer, &found), (&default, &answer));
        }
    }

    /// Against real sockets: every address is asked, at the same time, and
    /// the answers come back in the order of the addresses.
    #[test]
    fn found_servers_are_asked_together() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::mpsc;

        /// A server for one request: it reads it, and answers with `response`
        /// if `ready` says so.
        fn serve(response: String, ready: impl FnOnce() -> bool + Send + 'static) -> Url {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 4096];
                    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                        match s.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => head.extend_from_slice(&buf[..n]),
                        }
                    }
                    if ready() {
                        let _ = s.write_all(response.as_bytes());
                    }
                }
            });
            u(&format!("http://127.0.0.1:{port}/"))
        }
        fn response(status_line: &str, body: &str) -> String {
            format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
        }

        // The first server answers only once the second has been asked. Asked
        // one after the other, it would hang up without an answer.
        let (asked, was_asked) = mpsc::channel::<()>();
        let first = serve(
            response("200 OK", r#"{"success":true,"data":{"version":"9.9.9"}}"#),
            move || was_asked.recv_timeout(Duration::from_secs(4)).is_ok(),
        );
        let second = serve(response("401 Unauthorized", "Unauthorized"), move || {
            asked.send(()).is_ok()
        });
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            u(&format!("http://127.0.0.1:{}/", l.local_addr().unwrap().port()))
        };
        assert_eq!(
            ask_found(&[first, second, closed], probe::TIMEOUT),
            [
                ProbeOutcome::Ok {
                    version: "9.9.9".into()
                },
                ProbeOutcome::NeedsLogin,
                ProbeOutcome::Refused,
            ]
        );

        // One that does not answer in the time it is given.
        let slow = serve(String::new(), || {
            std::thread::sleep(Duration::from_secs(2));
            false
        });
        assert_eq!(ask_found(&[slow], Duration::from_millis(300)), [ProbeOutcome::Timeout]);
        assert!(ask_found(&[], FOUND_TIMEOUT).is_empty());
    }

    #[test]
    fn install_port_skips_taken_ones() {
        assert_eq!(pick_port(|_| true), 3000);
        assert_eq!(pick_port(|p| p >= 3002), 3002);
        assert_eq!(pick_port(|_| false), 3000);
    }
}
