//! Keep This Mac Awake: while Codeman's agents work on this Mac, the app keeps the
//! Mac from going to sleep, also with the lid closed. Opt-in (app menu > Keep This
//! Mac Awake), off by default, and no password anywhere.
//!
//! Two layers, because macOS draws a line between them:
//!
//! - **Idle sleep**: the app holds a power assertion of its own (`NSProcessInfo`
//!   activity with `IdleSystemSleepDisabled`, which is `PreventUserIdleSystemSleep`
//!   in `pmset -g assertions`). The kernel drops it with the process, so a crash or a
//!   Force Quit can never leave the Mac awake. The display still sleeps.
//! - **Lid close**: nothing an app holds stops a MacBook from sleeping when its lid
//!   closes, but one switch in the kernel does (lid sleep off), and any process may
//!   set it. It has no owner and outlives the process that set it, so a child process
//!   holds it and always lets go (`lid_awake`): when the app stops asking, when the
//!   app ends however it ends, when the app hangs, and on battery whatever the app
//!   says. Codeman 1.50.1 did this job with a root helper behind the administrator
//!   password (`pmset disablesleep`). Nothing uses that helper any more: it only acts
//!   on a request file this version never writes, and the menu offers to remove it
//!   where it is still installed (`remove_command`, the one thing left that asks for
//!   the password).
//!
//! When it holds is the user's pick: **While Agents Work** (an agent at work, and for
//! `GRACE` after the last one stopped, so the gap between two turns or a reply from
//! the phone does not let the Mac drop off), or **Always** (while the app is open).
//! Only for a Codeman on this Mac: keeping this Mac awake does nothing for agents that
//! run on another machine. Only when plugged in unless the user says otherwise (a
//! MacBook only), and the lid never on battery, whatever the setting.
//!
//! The menu is kept short on purpose: three modes, then on a MacBook two check items
//! (Only When Plugged In, With the Lid Closed).
//!
//! It lives in the app, so it ends with the app: Codeman's LaunchAgent keeps the server
//! running after the app quits, but nothing keeps the Mac awake then. So while it watches
//! a Codeman on this Mac, closing the main window hides the app instead of quitting it
//! (`close_hides_app`): only Cmd+Q (or Quit from the Dock) ends it.
//!
//! The agents are asked natively, like the logo blink does (`agents`): WebKit stalls the
//! event stream of a hidden page. A worker thread does the asking and the holding, and
//! while it watches for work it keeps App Nap off (an activity that still allows sleep),
//! so a hidden app does not see work late.

use crate::agents::{Poll, Poller, POLL_EVERY};
use crate::lid_awake::Lid;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::net::IpAddr;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};
use url::{Host, Url};

/// How often the worker looks: at the agents (While Agents Work) and the power
/// source. Each look is also the word the lid keeper waits for (`lid_awake`).
const TICK: Duration = POLL_EVERY;
/// How long the Mac stays awake after the last agent stopped working: the gap
/// between two turns, a respawn, a short Bash call the server reports as idle, and
/// time to answer from the phone.
pub const GRACE: Duration = Duration::from_secs(5 * 60);

// The root helper Codeman 1.50.1 installed for the lid, only named here to find it
// and to remove it.
const HELPER_LABEL: &str = "com.getcodeman.keepawake";
const HELPER_PLIST: &str = "/Library/LaunchDaemons/com.getcodeman.keepawake.plist";
const HELPER_DIR: &str = "/Library/Application Support/Codeman";
const HELPER_SCRIPT: &str = "/Library/Application Support/Codeman/keep-awake-lid.sh";
const HELPER_OWNED: &str = "/Library/Application Support/Codeman/keep-awake.owned";
/// Where 1.50.1 asked its helper for the lid, next to `desktop.json`.
const LEGACY_REQUEST_FILE: &str = "keep-awake-lid.pid";

pub const AC_ONLY_ID: &str = "keep-awake-ac-only";
pub const LID_ID: &str = "keep-awake-lid";
pub const REMOVE_OLD_HELPER_ID: &str = "keep-awake-remove-old-helper";

/// The status line while nothing is watched.
pub const OFF_TEXT: &str = "Sleeps as usual";
pub const NO_SERVER_TEXT: &str = "Waiting for Codeman on this Mac";

/// What macOS shows in the administrator prompt (`with prompt`). No double quote or
/// backslash: they would end the AppleScript string (`applescript` refuses them).
const REMOVE_PROMPT: &str = "Codeman wants to remove the lid helper that version 1.50.1 installed. It is no \
longer needed: Codeman keeps a closed Mac awake without it now.";

/// When the Mac is kept awake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// The default: it changes how the Mac sleeps, so it is asked for.
    #[default]
    Off,
    WhileWorking,
    Always,
}

impl Mode {
    pub const ALL: [Mode; 3] = [Mode::Off, Mode::WhileWorking, Mode::Always];

    pub fn label(self) -> &'static str {
        match self {
            Mode::Off => "Off",
            Mode::WhileWorking => "While Agents Work",
            Mode::Always => "Always",
        }
    }

    pub fn menu_id(self) -> &'static str {
        match self {
            Mode::Off => "keep-awake-off",
            Mode::WhileWorking => "keep-awake-while-working",
            Mode::Always => "keep-awake-always",
        }
    }

    pub fn from_menu_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|mode| mode.menu_id() == id)
    }
}

/// The `keepAwake` object in `desktop.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub mode: Mode,
    /// Only while the Mac runs on its power adapter (a MacBook; a desktop Mac always
    /// does). On by default.
    pub ac_only: bool,
    /// Also with the lid closed (`lid_awake`). Never on battery.
    pub lid: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            mode: Mode::Off,
            ac_only: true,
            lid: false,
        }
    }
}

impl Settings {
    /// Each field on its own: a value this version does not know reads as that field's
    /// default, never as a broken file.
    pub fn read(value: &Value) -> Self {
        let default = Settings::default();
        Settings {
            mode: value
                .get("mode")
                .and_then(|mode| Mode::deserialize(mode).ok())
                .unwrap_or(default.mode),
            ac_only: value.get("acOnly").and_then(Value::as_bool).unwrap_or(default.ac_only),
            lid: value.get("lid").and_then(Value::as_bool).unwrap_or(default.lid),
        }
    }
}

/// What the worker knows about the agents on one look.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agents {
    /// Not asked (Always, or a server elsewhere), or no answer and no recent work.
    Unknown,
    /// The server turned the login down; it is not asked again.
    Refused,
    Working,
    /// None at work now, but one was within `GRACE` (or the server stopped answering
    /// within it, a restart, say).
    WorkedRecently,
    Idle,
}

/// What one look found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    /// The server the window shows runs on this Mac.
    pub local: bool,
    pub on_battery: bool,
    pub agents: Agents,
}

/// Why the Mac is or is not held, which the status line says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Off,
    Remote,
    OnBattery,
    NoAnswer,
    Refused,
    Idle,
    Working,
    Recently,
    Always,
}

impl Status {
    fn text(self) -> &'static str {
        match self {
            Status::Off => OFF_TEXT,
            Status::Remote => "Sleeps as usual: Codeman runs on another machine",
            Status::OnBattery => "Paused: on battery",
            Status::NoAnswer => "Paused: Codeman does not answer",
            Status::Refused => "Paused: Codeman refused the login",
            Status::Idle => "Sleeps as usual: no agent working",
            Status::Working => "Awake: agents working",
            Status::Recently => "Awake: an agent finished in the last 5 minutes",
            Status::Always => "Awake: Codeman is open",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    /// Hold the idle-sleep assertion.
    pub hold: bool,
    /// Keep the Mac awake with the lid closed as well.
    pub lid: bool,
    pub status: Status,
}

/// The whole rule, in one place.
pub fn decide(settings: Settings, facts: Facts) -> Decision {
    let status = match settings.mode {
        Mode::Off => Status::Off,
        _ if !facts.local => Status::Remote,
        _ if settings.ac_only && facts.on_battery => Status::OnBattery,
        Mode::Always => Status::Always,
        Mode::WhileWorking => match facts.agents {
            Agents::Unknown => Status::NoAnswer,
            Agents::Refused => Status::Refused,
            Agents::Working => Status::Working,
            Agents::WorkedRecently => Status::Recently,
            Agents::Idle => Status::Idle,
        },
    };
    let hold = matches!(status, Status::Working | Status::Recently | Status::Always);
    Decision {
        hold,
        lid: hold && settings.lid && !facts.on_battery,
        status,
    }
}

/// The line under the menu's choices. `lid` is what the lid keeper said on this
/// look, while the lid is asked for.
pub fn status_line(decision: Decision, settings: Settings, facts: Facts, lid: &Lid) -> String {
    let text = decision.status.text();
    if !decision.hold || !settings.lid {
        return text.to_owned();
    }
    let lid = match lid {
        _ if facts.on_battery => "not with the lid closed on battery".to_owned(),
        Lid::Held { slept: None } => "lid closed too".to_owned(),
        // It held and the Mac slept anyway (macOS forced it, or let go of the switch).
        Lid::Held { slept: Some(until) } => format!("lid closed too, but the Mac slept until {until}"),
        // Nothing of Codeman's holds the lid: macOS's own closed-lid mode is left to.
        Lid::Docked { slept: None } => "lid left to macOS at a display".to_owned(),
        Lid::Docked { slept: Some(until) } => {
            format!("lid left to macOS at a display, but the Mac slept until {until}")
        }
        Lid::Off | Lid::Starting => "lid closed in a moment".to_owned(),
        Lid::OnBattery => "not with the lid closed on battery".to_owned(),
        Lid::Refused => "not with the lid closed: macOS refused it".to_owned(),
        Lid::Failed => "not with the lid closed: it could not start".to_owned(),
    };
    format!("{text}, {lid}")
}

/// Whether closing the main window hides the app instead of quitting it.
/// Keep-awake ends with the app, so while it watches a Codeman on this Mac the
/// red button (or Cmd+W) must not end it: the app hides as Cmd+H does, a click
/// on its Dock icon brings it back, and Cmd+Q still quits. That holds while it
/// is only paused (on battery, no agent at work, no answer), since it carries
/// on by itself once that changes. With no server open (the connect page), or
/// one on another machine, it keeps nothing awake, so closing the window quits.
/// `local_addresses` is only read with a mode on and a server open.
pub fn close_hides_app(mode: Mode, server: Option<&Url>, local_addresses: impl FnOnce() -> Vec<IpAddr>) -> bool {
    mode != Mode::Off && server.is_some_and(|server| is_this_mac(server, &local_addresses()))
}

/// Every address of this Mac's interfaces.
#[cfg(target_os = "macos")]
pub fn local_addresses() -> Vec<IpAddr> {
    system::local_addresses()
}

#[cfg(not(target_os = "macos"))]
pub fn local_addresses() -> Vec<IpAddr> {
    Vec::new()
}

/// Whether `server` is this Mac: a loopback address or `localhost`, or an address
/// literal one of this Mac's interfaces has. A host name is not looked up.
pub fn is_this_mac(server: &Url, local_addresses: &[IpAddr]) -> bool {
    if crate::policy::is_loopback(server) {
        return true;
    }
    let ip = match server.host() {
        Some(Host::Ipv4(ip)) => IpAddr::V4(ip),
        Some(Host::Ipv6(ip)) => IpAddr::V6(ip),
        _ => return false,
    };
    local_addresses.contains(&ip)
}

/// The server to watch, its login and what to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Watch {
    pub server: Url,
    pub authorization: Option<String>,
    pub settings: Settings,
}

/// What the worker asks of the server, so tests can stand in for it.
pub trait AgentSource {
    fn poll(&mut self) -> Poll;
}

impl AgentSource for Poller {
    fn poll(&mut self) -> Poll {
        Poller::poll(self)
    }
}

/// What the process holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    None,
    /// Watching for work: App Nap off, sleep allowed.
    Watching,
    /// Idle sleep held off.
    Holding,
}

/// What the worker does to the Mac, so tests can stand in for it.
pub trait System {
    fn on_battery(&mut self) -> bool;
    fn set_hold(&mut self, hold: Hold);
    /// Ask for the lid, or stop asking, and what came of it. Called on every look:
    /// while it is asked for, the call is also the word the lid keeper waits for.
    fn lid(&mut self, wanted: bool) -> Lid;
    fn is_this_mac(&mut self, server: &Url) -> bool;
}

/// Made inside the worker thread, so it needs no `Send`.
type NewSource = Box<dyn FnMut(&Watch) -> Option<Box<dyn AgentSource>>>;

/// The worker's state between looks.
struct Worker<S: System> {
    sys: S,
    new_source: NewSource,
    watch: Option<Watch>,
    local: bool,
    source: Option<Box<dyn AgentSource>>,
    refused: bool,
    working: Option<bool>,
    last_work: Option<Instant>,
    hold: Hold,
    status: Option<String>,
}

impl<S: System> Worker<S> {
    fn new(sys: S, new_source: NewSource) -> Self {
        Worker {
            sys,
            new_source,
            watch: None,
            local: false,
            source: None,
            refused: false,
            working: None,
            last_work: None,
            hold: Hold::None,
            status: None,
        }
    }

    /// A new value from the app: another server, other settings, or nothing.
    fn update(&mut self, watch: Option<Watch>) {
        let other_server = match (&self.watch, &watch) {
            (Some(was), Some(now)) => was.server != now.server || was.authorization != now.authorization,
            (None, None) => false,
            _ => true,
        };
        if other_server {
            self.source = None;
            self.refused = false;
            self.working = None;
            self.last_work = None;
            self.local = match &watch {
                Some(watch) => self.sys.is_this_mac(&watch.server),
                None => false,
            };
        }
        self.watch = watch;
        // The app numbers its values, so the line goes out again under the new one.
        self.status = None;
    }

    /// Whether the worker has to look again on its own: something to hold or to
    /// watch for. A server elsewhere is told once and waits for the app.
    fn ticking(&self) -> bool {
        self.local
            && self
                .watch
                .as_ref()
                .is_some_and(|watch| watch.settings.mode != Mode::Off)
    }

    /// One look. The new status line, when it changed.
    fn look(&mut self, now: Instant) -> Option<String> {
        let Some(watch) = self.watch.clone() else {
            self.release();
            return None;
        };
        let settings = watch.settings;
        let agents = self.agents(&watch, now);
        let facts = Facts {
            local: self.local,
            on_battery: self.local && settings.mode != Mode::Off && self.sys.on_battery(),
            agents,
        };
        let decision = decide(settings, facts);
        let watching = self.local && settings.mode == Mode::WhileWorking && !self.refused;
        self.set_hold(match (decision.hold, watching) {
            (true, _) => Hold::Holding,
            (false, true) => Hold::Watching,
            (false, false) => Hold::None,
        });
        let lid = self.sys.lid(decision.lid);
        let line = status_line(decision, settings, facts, &lid);
        (self.status.as_deref() != Some(line.as_str())).then(|| {
            self.status = Some(line.clone());
            line
        })
    }

    fn agents(&mut self, watch: &Watch, now: Instant) -> Agents {
        if !self.local || watch.settings.mode != Mode::WhileWorking {
            return Agents::Unknown;
        }
        if !self.refused {
            if self.source.is_none() {
                self.source = (self.new_source)(watch);
            }
            let poll = self.source.as_mut().map_or(Poll::Failed, |source| source.poll());
            match poll {
                Poll::Seen(activity) => {
                    self.working = Some(activity.working);
                    if activity.working {
                        self.last_work = Some(now);
                    }
                }
                Poll::Failed => self.working = None,
                Poll::Refused => {
                    // Codeman counts each refused login against its rate limit.
                    self.refused = true;
                    self.working = None;
                    self.source = None;
                }
            }
        }
        let recently = self.last_work.is_some_and(|at| now.duration_since(at) < GRACE);
        match (self.refused, self.working) {
            (true, _) => Agents::Refused,
            (false, Some(true)) => Agents::Working,
            _ if recently => Agents::WorkedRecently,
            (false, Some(false)) => Agents::Idle,
            (false, None) => Agents::Unknown,
        }
    }

    fn set_hold(&mut self, hold: Hold) {
        if hold != self.hold {
            self.sys.set_hold(hold);
            self.hold = hold;
        }
    }

    /// Let go of everything: the app went away or watches nothing.
    fn release(&mut self) {
        self.set_hold(Hold::None);
        self.sys.lid(false);
    }
}

/// The worker thread: a look every `TICK` while there is something to watch, and at
/// once for every new value. Ends, and lets go of everything, when the app drops its
/// end of the channel.
fn run<S: System>(rx: &Receiver<(u64, Option<Watch>)>, mut worker: Worker<S>, report: &dyn Fn(u64, String)) {
    let mut generation = 0;
    loop {
        let message = if worker.ticking() {
            rx.recv_timeout(TICK)
        } else {
            rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
        };
        match message {
            Ok(first) => {
                let (latest, watch) = rx.try_iter().last().unwrap_or(first);
                generation = latest;
                worker.update(watch);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if let Some(line) = worker.look(Instant::now()) {
            report(generation, line);
        }
    }
    worker.release();
}

type Report = Box<dyn Fn(u64, String) + Send>;

/// The app's side: the channel to the worker, which starts with the first thing to
/// watch.
pub struct KeepAwake {
    sender: Option<Sender<(u64, Option<Watch>)>>,
    report: Option<Report>,
    generation: u64,
    current: Option<Watch>,
}

impl KeepAwake {
    /// `report` gets the worker's status lines, each with the number of the value it
    /// is about (`is_current`).
    pub fn new(report: impl Fn(u64, String) + Send + 'static) -> Self {
        KeepAwake {
            sender: None,
            report: Some(Box::new(report)),
            generation: 0,
            current: None,
        }
    }

    /// Watch this server with these settings, or nothing.
    pub fn sync(&mut self, watch: Option<Watch>) {
        if watch != self.current {
            self.current = watch;
            self.send();
        }
    }

    /// Whether a status line is about the latest value.
    pub fn is_current(&self, generation: u64) -> bool {
        generation == self.generation && self.current.is_some()
    }

    fn send(&mut self) {
        self.generation += 1;
        if self.sender.is_none() && self.current.is_some() {
            self.sender = self.report.take().and_then(spawn);
        }
        if let Some(sender) = &self.sender {
            let _ = sender.send((self.generation, self.current.clone()));
        }
    }

    /// The app is about to exit: the worker ends and lets go. The power assertion
    /// and the pipe to the lid keeper go with the process in any case.
    pub fn shutdown(&mut self) {
        self.sender = None;
    }
}

#[cfg(target_os = "macos")]
fn spawn(report: Report) -> Option<Sender<(u64, Option<Watch>)>> {
    let (sender, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(move || {
            let new_source: NewSource = Box::new(|watch: &Watch| {
                Poller::new(&watch.server, watch.authorization.clone(), false)
                    .map(|poller| Box::new(poller) as Box<dyn AgentSource>)
            });
            let worker = Worker::new(system::Mac::new(), new_source);
            run(&rx, worker, &*report);
        })
        .ok()?;
    Some(sender)
}

#[cfg(not(target_os = "macos"))]
fn spawn(_report: Report) -> Option<Sender<(u64, Option<Watch>)>> {
    None
}

/// Whether this build can keep the Mac awake at all.
pub fn available() -> bool {
    cfg!(target_os = "macos")
}

/// Whether the root helper Codeman 1.50.1 installed for the lid is still on this
/// Mac. Anyone may look.
pub fn old_helper_installed() -> bool {
    old_helper_under("")
}

fn old_helper_under(root: &str) -> bool {
    [HELPER_PLIST, HELPER_SCRIPT]
        .iter()
        .any(|path| Path::new(&format!("{root}{path}")).exists())
}

/// Removes the request file 1.50.1 kept for its helper, so a helper that is still
/// installed has nothing to act on (it honours a file younger than 2 minutes that
/// names a live process).
pub fn forget_legacy_request() {
    if let Some(path) = crate::config::Config::default_path() {
        let _ = std::fs::remove_file(path.with_file_name(LEGACY_REQUEST_FILE));
    }
}

/// The root shell command that removes 1.50.1's helper: stop it, undo a `disablesleep`
/// it set (its marker; an administrator's own setting is left alone), delete its files.
/// `root` is empty, except in tests, which run it in a temporary folder.
pub fn remove_command(root: &str) -> String {
    let dir = format!("{root}{HELPER_DIR}");
    let script = format!("{root}{HELPER_SCRIPT}");
    let plist = format!("{root}{HELPER_PLIST}");
    let owned = format!("{root}{HELPER_OWNED}");
    [
        format!("launchctl bootout system/{HELPER_LABEL} 2>/dev/null || true"),
        format!("if [ -f '{owned}' ]; then pmset -a disablesleep 0 || true; fi"),
        format!("rm -f '{plist}' '{script}' '{owned}'"),
        format!("rmdir '{dir}' 2>/dev/null || true"),
    ]
    .join("; ")
}

/// `do shell script` with macOS's administrator prompt. None for text that would end
/// the AppleScript string early.
pub fn applescript(command: &str, prompt: &str) -> Option<String> {
    let safe = |text: &str| !text.contains(['"', '\\']);
    (safe(command) && safe(prompt))
        .then(|| format!("do shell script \"{command}\" with prompt \"{prompt}\" with administrator privileges"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdminOutcome {
    Done,
    Cancelled,
    Failed(String),
}

/// Remove 1.50.1's helper behind the administrator prompt. Blocks until it is answered.
pub fn remove_old_helper() -> AdminOutcome {
    run_admin(&remove_command(""), REMOVE_PROMPT)
}

/// In osascript, not in the app: `do shell script` needs nothing of the app's hardened
/// runtime that way, and the event loop goes on while the prompt is open.
fn run_admin(command: &str, prompt: &str) -> AdminOutcome {
    let Some(script) = applescript(command, prompt) else {
        return AdminOutcome::Failed("The command could not be written safely.".into());
    };
    match std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
    {
        Ok(out) if out.status.success() => AdminOutcome::Done,
        Ok(out) => {
            let error = String::from_utf8_lossy(&out.stderr);
            // "execution error: User canceled. (-128)"
            if error.contains("(-128)") {
                AdminOutcome::Cancelled
            } else {
                AdminOutcome::Failed(error.trim().chars().take(400).collect())
            }
        }
        Err(error) => AdminOutcome::Failed(error.to_string()),
    }
}

#[cfg(target_os = "macos")]
pub use system::{has_lid, on_battery};

/// A desktop Mac has no lid and always runs on mains.
#[cfg(not(target_os = "macos"))]
pub fn has_lid() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod system {
    use super::{Hold, Lid, System};
    use crate::lid_awake::Holder;
    use objc2::rc::Retained;
    use objc2::runtime::{NSObjectProtocol, ProtocolObject};
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use std::ffi::{c_char, c_void};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use std::sync::OnceLock;
    use url::Url;

    /// What `pmset -g assertions` and Activity Monitor show for the app.
    const HOLDING: &str = "Codeman keeps this Mac awake while its agents work";
    const WATCHING: &str = "Codeman watches its agents to keep this Mac awake";

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPSCopyPowerSourcesInfo() -> *const c_void;
        fn IOPSGetProvidingPowerSourceType(snapshot: *const c_void) -> *const c_void;
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IORegistryEntryCreateCFProperty(
            entry: u32,
            key: *const c_void,
            allocator: *const c_void,
            options: u32,
        ) -> *const c_void;
        fn IOObjectRelease(object: u32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(object: *const c_void);
    }

    /// "Battery Power" as the source in use. "AC Power", "UPS Power" and no answer
    /// all count as mains. The lid keeper reads the same for itself.
    pub fn on_battery() -> bool {
        // SAFETY: IOPSCopyPowerSourcesInfo returns an owned CFTypeRef or NULL, released
        // below. IOPSGetProvidingPowerSourceType returns a CFStringRef owned by that
        // snapshot (the Get rule), read before the release; a CFString is toll-free
        // bridged to NSString.
        unsafe {
            let snapshot = IOPSCopyPowerSourcesInfo();
            if snapshot.is_null() {
                return false;
            }
            let kind = IOPSGetProvidingPowerSourceType(snapshot);
            let battery = !kind.is_null() && (*kind.cast::<NSString>()).to_string() == "Battery Power";
            CFRelease(snapshot);
            battery
        }
    }

    /// A MacBook: the power management root has a clamshell state (what `ioreg -r -k
    /// AppleClamshellState` finds). Asked once.
    pub fn has_lid() -> bool {
        static LID: OnceLock<bool> = OnceLock::new();
        *LID.get_or_init(|| {
            let key = NSString::from_str("AppleClamshellState");
            // SAFETY: IOServiceMatching returns a dictionary that
            // IOServiceGetMatchingService consumes; the service is released below.
            // IORegistryEntryCreateCFProperty returns an owned CFTypeRef or NULL, and
            // takes the NSString as its toll-free bridged CFString.
            unsafe {
                let matching = IOServiceMatching(c"IOPMrootDomain".as_ptr());
                if matching.is_null() {
                    return false;
                }
                let root = IOServiceGetMatchingService(0, matching);
                if root == 0 {
                    return false;
                }
                let value = IORegistryEntryCreateCFProperty(root, Retained::as_ptr(&key).cast(), std::ptr::null(), 0);
                IOObjectRelease(root);
                if value.is_null() {
                    return false;
                }
                CFRelease(value);
                true
            }
        })
    }

    /// Every address of this Mac's interfaces.
    pub(super) fn local_addresses() -> Vec<IpAddr> {
        let mut found = Vec::new();
        // SAFETY: getifaddrs fills a list that freeifaddrs frees; each ifa_addr is
        // NULL or a sockaddr whose family says which struct it is.
        unsafe {
            let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
            if libc::getifaddrs(&mut list) != 0 {
                return found;
            }
            let mut entry = list;
            while !entry.is_null() {
                let addr = (*entry).ifa_addr;
                if !addr.is_null() {
                    match i32::from((*addr).sa_family) {
                        libc::AF_INET => {
                            let v4 = &*addr.cast::<libc::sockaddr_in>();
                            found.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(v4.sin_addr.s_addr))));
                        }
                        libc::AF_INET6 => {
                            let v6 = &*addr.cast::<libc::sockaddr_in6>();
                            found.push(IpAddr::V6(Ipv6Addr::from(v6.sin6_addr.s6_addr)));
                        }
                        _ => {}
                    }
                }
                entry = (*entry).ifa_next;
            }
            libc::freeifaddrs(list);
        }
        found
    }

    pub struct Mac {
        activity: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
        lid: Holder,
    }

    impl Mac {
        pub fn new() -> Self {
            Mac {
                activity: None,
                lid: Holder::default(),
            }
        }
    }

    impl System for Mac {
        fn on_battery(&mut self) -> bool {
            on_battery()
        }

        fn set_hold(&mut self, hold: Hold) {
            let info = NSProcessInfo::processInfo();
            let next = match hold {
                Hold::None => None,
                Hold::Watching => Some((NSActivityOptions::UserInitiatedAllowingIdleSystemSleep, WATCHING)),
                Hold::Holding => Some((NSActivityOptions::UserInitiated, HOLDING)),
            }
            .map(|(options, reason)| info.beginActivityWithOptions_reason(options, &NSString::from_str(reason)));
            // The new one first, so a change from watching to holding has no gap.
            if let Some(previous) = std::mem::replace(&mut self.activity, next) {
                // SAFETY: the object beginActivityWithOptions:reason: returned.
                unsafe { info.endActivity(&previous) };
            }
        }

        fn lid(&mut self, wanted: bool) -> Lid {
            self.lid.hold(wanted)
        }

        fn is_this_mac(&mut self, server: &Url) -> bool {
            super::is_this_mac(server, &local_addresses())
        }
    }

    impl Drop for Mac {
        fn drop(&mut self) {
            // The pipe to the lid keeper closes with the `Holder`.
            self.set_hold(Hold::None);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// What this Mac answers, for a look by hand on a real Mac:
        /// `cargo test what_this_mac_answers -- --ignored --nocapture`, with
        /// `pmset -g assertions | grep -i codeman` in another terminal.
        #[test]
        #[ignore]
        fn what_this_mac_answers() {
            println!("has a lid: {}", has_lid());
            println!("on battery: {}", on_battery());
            println!("addresses: {:?}", local_addresses());
            let mut mac = Mac::new();
            mac.set_hold(Hold::Holding);
            println!("holding for 15 s");
            std::thread::sleep(std::time::Duration::from_secs(15));
            mac.set_hold(Hold::Watching);
            println!("watching for 15 s");
            std::thread::sleep(std::time::Duration::from_secs(15));
            mac.set_hold(Hold::None);
            println!("let go");
        }

        /// The exact AppleScript the app runs, compiled by macOS without running it
        /// (no prompt, nothing as root). Also in the gate, since it needs no hardware.
        #[test]
        fn the_admin_script_compiles() {
            use super::super::{applescript, remove_command, REMOVE_PROMPT};
            let out_dir = std::env::temp_dir().join(format!("keep-awake-osa-{}", std::process::id()));
            std::fs::create_dir_all(&out_dir).unwrap();
            let script = applescript(&remove_command(""), REMOVE_PROMPT).unwrap();
            let out = std::process::Command::new("/usr/bin/osacompile")
                .arg("-e")
                .arg(&script)
                .arg("-o")
                .arg(out_dir.join("remove.scpt"))
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            let _ = std::fs::remove_dir_all(&out_dir);
        }

        /// This process's lines in `pmset -g assertions`.
        fn own_assertions() -> String {
            let out = std::process::Command::new("/usr/bin/pmset")
                .args(["-g", "assertions"])
                .output()
                .unwrap();
            let pid = format!("pid {}(", std::process::id());
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|line| line.contains(&pid))
                .collect::<Vec<_>>()
                .join("\n")
        }

        /// The whole chain on a real Mac: the worker thread, the poller and the
        /// assertion, against a stand-in server on loopback whose agent works.
        /// `cargo test holds_while_a_local_server_says_an_agent_works -- --ignored --nocapture`
        #[test]
        #[ignore]
        fn holds_while_a_local_server_says_an_agent_works() {
            use super::super::{KeepAwake, Mode, Settings, Watch};
            use std::io::{Read, Write};
            use std::sync::{Arc, Mutex};
            use std::time::Duration;

            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for mut stream in listener.incoming().flatten() {
                    let mut request = [0u8; 4096];
                    let _ = stream.read(&mut request);
                    let body = r#"{"success":true,"data":[{"status":"busy","mode":"claude"}]}"#;
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            });
            let lines = Arc::new(Mutex::new(Vec::new()));
            let seen = lines.clone();
            let mut keep = KeepAwake::new(move |_, line| seen.lock().unwrap().push(line));
            assert!(own_assertions().is_empty());
            keep.sync(Some(Watch {
                server: Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
                authorization: None,
                settings: Settings {
                    mode: Mode::WhileWorking,
                    ac_only: true,
                    lid: false,
                },
            }));
            std::thread::sleep(Duration::from_secs(3));
            let held = own_assertions();
            println!("while the agent works:\n{held}");
            assert!(held.contains("PreventUserIdleSystemSleep"), "{held}");
            println!("status lines: {:?}", lines.lock().unwrap());
            keep.sync(None);
            std::thread::sleep(Duration::from_secs(1));
            let after = own_assertions();
            println!("after the app watches nothing: {after:?}");
            assert!(after.is_empty(), "{after}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::Activity;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    const WORK: Settings = Settings {
        mode: Mode::WhileWorking,
        ac_only: true,
        lid: false,
    };
    const ALWAYS: Settings = Settings {
        mode: Mode::Always,
        ac_only: true,
        lid: false,
    };
    const HERE: Facts = Facts {
        local: true,
        on_battery: false,
        agents: Agents::Working,
    };

    #[test]
    fn the_setting_reads_each_field_on_its_own() {
        assert_eq!(Settings::read(&Value::Null), Settings::default());
        assert_eq!(Settings::default().mode, Mode::Off);
        assert!(Settings::default().ac_only);
        assert!(!Settings::default().lid);
        let read = Settings::read(&serde_json::json!({ "mode": "whileWorking", "acOnly": false, "lid": true }));
        assert_eq!(
            read,
            Settings {
                mode: Mode::WhileWorking,
                ac_only: false,
                lid: true
            }
        );
        // A mode from a later version, and fields of the wrong type: each its default.
        let read = Settings::read(&serde_json::json!({ "mode": "sometimes", "acOnly": "no", "lid": 1 }));
        assert_eq!(read, Settings::default());
        let read = Settings::read(&serde_json::json!({ "mode": "always" }));
        assert_eq!(read, ALWAYS);
    }

    #[test]
    fn the_setting_round_trips() {
        let settings = Settings {
            mode: Mode::Always,
            ac_only: false,
            lid: true,
        };
        let text = serde_json::to_value(settings).unwrap();
        assert_eq!(
            text,
            serde_json::json!({ "mode": "always", "acOnly": false, "lid": true })
        );
        assert_eq!(Settings::read(&text), settings);
    }

    #[test]
    fn the_grace_is_the_one_the_status_line_names() {
        assert_eq!(GRACE, Duration::from_secs(5 * 60));
        assert!(Status::Recently.text().contains("5 minutes"));
    }

    #[test]
    fn closing_the_window_hides_the_app_only_while_it_watches_this_mac() {
        let own = || vec!["192.168.1.20".parse::<IpAddr>().unwrap()];
        let unread = || -> Vec<IpAddr> { panic!("the addresses decide nothing here") };
        let here = url("http://127.0.0.1:3000/");
        let lan = url("http://192.168.1.20:3000/");
        let elsewhere = url("http://192.168.1.21:3000/");
        for mode in [Mode::WhileWorking, Mode::Always] {
            // Keep-awake ends with the app, so the red button must not end it.
            assert!(close_hides_app(mode, Some(&here), own), "{mode:?}");
            assert!(close_hides_app(mode, Some(&lan), own), "{mode:?}");
            // Another machine's Codeman, or the connect page: nothing is kept
            // awake, so closing the window quits.
            assert!(!close_hides_app(mode, Some(&elsewhere), own), "{mode:?}");
            assert!(!close_hides_app(mode, None, unread), "{mode:?}");
        }
        // Off quits as it always did.
        assert!(!close_hides_app(Mode::Off, Some(&here), unread));
    }

    #[test]
    fn a_menu_id_names_one_mode() {
        for mode in Mode::ALL {
            assert_eq!(Mode::from_menu_id(mode.menu_id()), Some(mode));
        }
        assert_eq!(Mode::from_menu_id(AC_ONLY_ID), None);
        assert_eq!(Mode::from_menu_id(LID_ID), None);
    }

    #[test]
    fn it_holds_while_agents_work_and_for_the_grace_after() {
        assert!(decide(WORK, HERE).hold);
        let recently = Facts {
            agents: Agents::WorkedRecently,
            ..HERE
        };
        assert_eq!(decide(WORK, recently).status, Status::Recently);
        assert!(decide(WORK, recently).hold);
        for agents in [Agents::Idle, Agents::Unknown, Agents::Refused] {
            assert!(!decide(WORK, Facts { agents, ..HERE }).hold, "{agents:?}");
        }
    }

    #[test]
    fn always_holds_whatever_the_agents_do() {
        let idle = Facts {
            agents: Agents::Unknown,
            ..HERE
        };
        assert_eq!(decide(ALWAYS, idle).status, Status::Always);
        assert!(decide(ALWAYS, idle).hold);
    }

    #[test]
    fn off_and_a_server_elsewhere_never_hold() {
        let off = Settings {
            mode: Mode::Off,
            ..ALWAYS
        };
        assert_eq!(decide(off, HERE).status, Status::Off);
        assert!(!decide(off, HERE).hold);
        let elsewhere = Facts { local: false, ..HERE };
        for settings in [WORK, ALWAYS] {
            assert_eq!(decide(settings, elsewhere).status, Status::Remote);
            assert!(!decide(settings, elsewhere).hold);
        }
    }

    #[test]
    fn battery_pauses_it_only_when_asked_to() {
        let battery = Facts {
            on_battery: true,
            ..HERE
        };
        assert_eq!(decide(ALWAYS, battery).status, Status::OnBattery);
        assert!(!decide(ALWAYS, battery).hold);
        let anywhere = Settings {
            ac_only: false,
            ..ALWAYS
        };
        assert!(decide(anywhere, battery).hold);
    }

    #[test]
    fn the_lid_needs_the_setting_mains_and_a_hold() {
        let lid = Settings { lid: true, ..WORK };
        assert!(decide(lid, HERE).lid);
        assert!(!decide(WORK, HERE).lid, "setting off");
        assert!(
            !decide(
                lid,
                Facts {
                    agents: Agents::Idle,
                    ..HERE
                }
            )
            .lid,
            "nothing held"
        );
        // Never on battery, even when the idle hold goes on there.
        let anywhere = Settings { ac_only: false, ..lid };
        let battery = Facts {
            on_battery: true,
            ..HERE
        };
        assert!(decide(anywhere, battery).hold);
        assert!(!decide(anywhere, battery).lid);
    }

    #[test]
    fn the_status_line_says_what_the_lid_does() {
        let lid = Settings { lid: true, ..WORK };
        let held = Lid::Held { slept: None };
        let line = |settings, facts, lid: &Lid| status_line(decide(settings, facts), settings, facts, lid);
        assert_eq!(line(WORK, HERE, &Lid::Off), "Awake: agents working");
        assert_eq!(line(lid, HERE, &held), "Awake: agents working, lid closed too");
        assert_eq!(
            line(lid, HERE, &Lid::Starting),
            "Awake: agents working, lid closed in a moment"
        );
        // It held and the Mac slept all the same: the line is the evidence.
        let slept = Lid::Held {
            slept: Some("07:42".into()),
        };
        assert_eq!(
            line(lid, HERE, &slept),
            "Awake: agents working, lid closed too, but the Mac slept until 07:42"
        );
        // At a display Codeman writes nothing, and the line must not read as if it did.
        assert_eq!(
            line(lid, HERE, &Lid::Docked { slept: None }),
            "Awake: agents working, lid left to macOS at a display"
        );
        let slept_docked = Lid::Docked {
            slept: Some("07:42".into()),
        };
        assert_eq!(
            line(lid, HERE, &slept_docked),
            "Awake: agents working, lid left to macOS at a display, but the Mac slept until 07:42"
        );
        assert_eq!(
            line(lid, HERE, &Lid::Refused),
            "Awake: agents working, not with the lid closed: macOS refused it"
        );
        assert_eq!(
            line(lid, HERE, &Lid::Failed),
            "Awake: agents working, not with the lid closed: it could not start"
        );
        // The app's reading of the power source, and the keeper's own.
        let battery = Facts {
            on_battery: true,
            ..HERE
        };
        let anywhere = Settings { ac_only: false, ..lid };
        for said in [&Lid::Off, &held] {
            assert_eq!(
                line(anywhere, battery, said),
                "Awake: agents working, not with the lid closed on battery"
            );
        }
        assert_eq!(
            line(lid, HERE, &Lid::OnBattery),
            "Awake: agents working, not with the lid closed on battery"
        );
        // Not held: nothing about the lid.
        let idle = Facts {
            agents: Agents::Idle,
            ..HERE
        };
        assert_eq!(line(lid, idle, &held), "Sleeps as usual: no agent working");
    }

    #[test]
    fn this_mac_is_loopback_or_one_of_its_own_addresses() {
        let own: Vec<IpAddr> = vec!["192.168.1.20".parse().unwrap(), "fd7a::5".parse().unwrap()];
        assert!(is_this_mac(&url("http://127.0.0.1:3000/"), &own));
        assert!(is_this_mac(&url("http://localhost:3000/"), &own));
        assert!(is_this_mac(&url("http://[::1]:3000/"), &own));
        assert!(is_this_mac(&url("http://192.168.1.20:3000/"), &own));
        assert!(is_this_mac(&url("https://[fd7a::5]/codeman/"), &own));
        assert!(!is_this_mac(&url("http://192.168.1.21:3000/"), &own));
        // A name is never looked up, this Mac's own included.
        assert!(!is_this_mac(&url("https://mac.tailnet.ts.net/"), &own));
        assert!(!is_this_mac(&url("http://evil.localhost:3000/"), &own));
    }

    #[test]
    fn the_removal_fits_in_an_applescript_string() {
        let script = applescript(&remove_command(""), REMOVE_PROMPT).expect("no quote or backslash");
        assert!(script.starts_with("do shell script \""));
        assert!(script.ends_with("with administrator privileges"));
        assert_eq!(applescript("echo \"x\"", "p"), None);
        assert_eq!(applescript("echo x", "a \\ b"), None);
    }

    /// The real removal command, run by `sh` in a temporary folder that looks like a
    /// Mac where 1.50.1 installed its helper, with stand-ins for what needs root
    /// (`launchctl`, `pmset`).
    #[cfg(unix)]
    #[test]
    fn the_removal_command_takes_the_old_helper_away() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let root = std::env::temp_dir().join(format!("keep-awake-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let log = root.join("calls.log");
        for tool in ["launchctl", "pmset"] {
            let stub = bin.join(tool);
            std::fs::write(&stub, format!("#!/bin/sh\necho \"{tool} $*\" >> '{}'\n", log.display())).unwrap();
            std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let prefix = root.join("fs").to_string_lossy().into_owned();
        let sh = |command: &str| {
            let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
            let out = Command::new("sh")
                .arg("-c")
                .arg(command)
                .env("PATH", path)
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        let install = |owned: bool| {
            for dir in [HELPER_DIR, "/Library/LaunchDaemons"] {
                std::fs::create_dir_all(format!("{prefix}{dir}")).unwrap();
            }
            for file in [HELPER_PLIST, HELPER_SCRIPT] {
                std::fs::write(format!("{prefix}{file}"), "as 1.50.1 wrote it").unwrap();
            }
            if owned {
                std::fs::write(format!("{prefix}{HELPER_OWNED}"), "").unwrap();
            }
            std::fs::write(&log, "").unwrap();
        };

        assert!(!old_helper_under(&prefix));
        // The helper had set disablesleep: the removal undoes it, then nothing is left.
        install(true);
        assert!(old_helper_under(&prefix));
        sh(&remove_command(&prefix));
        let calls = std::fs::read_to_string(&log).unwrap();
        assert!(
            calls.starts_with(&format!("launchctl bootout system/{HELPER_LABEL}\n")),
            "{calls}"
        );
        assert!(calls.contains("pmset -a disablesleep 0"), "{calls}");
        assert!(!old_helper_under(&prefix));
        assert!(!Path::new(&format!("{prefix}{HELPER_DIR}")).exists());

        // Without the marker, an administrator's own setting is left alone.
        install(false);
        sh(&remove_command(&prefix));
        assert!(!std::fs::read_to_string(&log).unwrap().contains("pmset"));
        assert!(!old_helper_under(&prefix));

        // Half of it is still a helper to remove (a removal that was interrupted).
        install(false);
        std::fs::remove_file(format!("{prefix}{HELPER_PLIST}")).unwrap();
        assert!(old_helper_under(&prefix));
        sh(&remove_command(&prefix));
        assert!(!old_helper_under(&prefix));
        let _ = std::fs::remove_dir_all(&root);
    }

    // The worker, with stand-ins for the Mac and the server.

    #[derive(Default)]
    struct FakeMac {
        battery: bool,
        local: bool,
        holds: Vec<Hold>,
        /// What the lid keeper answers while it is asked.
        lid: Option<Lid>,
        /// Every look's asking, in order.
        lid_asks: Vec<bool>,
    }

    #[derive(Clone, Default)]
    struct Shared(Rc<RefCell<FakeMac>>);

    impl System for Shared {
        fn on_battery(&mut self) -> bool {
            self.0.borrow().battery
        }
        fn set_hold(&mut self, hold: Hold) {
            self.0.borrow_mut().holds.push(hold);
        }
        fn lid(&mut self, wanted: bool) -> Lid {
            let mut mac = self.0.borrow_mut();
            mac.lid_asks.push(wanted);
            match wanted {
                true => mac.lid.clone().unwrap_or(Lid::Starting),
                false => Lid::Off,
            }
        }
        fn is_this_mac(&mut self, _server: &Url) -> bool {
            self.0.borrow().local
        }
    }

    impl Shared {
        fn last_hold(&self) -> Option<Hold> {
            self.0.borrow().holds.last().copied()
        }
    }

    /// The server's answers, one per poll; the last one repeats.
    struct Answers {
        polls: Rc<RefCell<Vec<Poll>>>,
        asked: Rc<RefCell<usize>>,
    }

    impl AgentSource for Answers {
        fn poll(&mut self) -> Poll {
            *self.asked.borrow_mut() += 1;
            let mut polls = self.polls.borrow_mut();
            if polls.len() > 1 {
                return polls.remove(0);
            }
            match polls.first() {
                Some(Poll::Seen(activity)) => Poll::Seen(*activity),
                Some(Poll::Refused) => Poll::Refused,
                Some(Poll::Failed) | None => Poll::Failed,
            }
        }
    }

    fn seen(working: bool) -> Poll {
        Poll::Seen(Activity {
            working,
            ..Activity::default()
        })
    }

    struct Rig {
        mac: Shared,
        polls: Rc<RefCell<Vec<Poll>>>,
        asked: Rc<RefCell<usize>>,
        worker: Worker<Shared>,
        start: Instant,
    }

    fn rig(local: bool) -> Rig {
        let mac = Shared::default();
        mac.0.borrow_mut().local = local;
        let polls = Rc::new(RefCell::new(vec![seen(false)]));
        let asked = Rc::new(RefCell::new(0));
        let (p, a) = (polls.clone(), asked.clone());
        let new_source: NewSource = Box::new(move |_| {
            Some(Box::new(Answers {
                polls: p.clone(),
                asked: a.clone(),
            }) as Box<dyn AgentSource>)
        });
        Rig {
            worker: Worker::new(mac.clone(), new_source),
            mac,
            polls,
            asked,
            start: Instant::now(),
        }
    }

    impl Rig {
        fn watch(&mut self, settings: Settings) {
            self.worker.update(Some(Watch {
                server: url("http://127.0.0.1:3000/"),
                authorization: None,
                settings,
            }));
        }
        fn answer(&self, polls: Vec<Poll>) {
            *self.polls.borrow_mut() = polls;
        }
        fn look_at(&mut self, secs: u64) -> Option<String> {
            self.worker.look(self.start + Duration::from_secs(secs))
        }
    }

    #[test]
    fn the_worker_holds_while_agents_work_and_lets_go_after_the_grace() {
        let mut rig = rig(true);
        rig.watch(WORK);
        assert_eq!(rig.look_at(0).as_deref(), Some("Sleeps as usual: no agent working"));
        assert_eq!(
            rig.mac.last_hold(),
            Some(Hold::Watching),
            "App Nap off while it watches"
        );
        rig.answer(vec![seen(true)]);
        assert_eq!(rig.look_at(2).as_deref(), Some("Awake: agents working"));
        assert_eq!(rig.mac.last_hold(), Some(Hold::Holding));
        rig.answer(vec![seen(false)]);
        assert_eq!(
            rig.look_at(4).as_deref(),
            Some("Awake: an agent finished in the last 5 minutes")
        );
        assert_eq!(rig.mac.last_hold(), Some(Hold::Holding));
        assert_eq!(rig.look_at(200), None, "unchanged: nothing to report");
        assert_eq!(
            rig.look_at(2 + GRACE.as_secs()).as_deref(),
            Some("Sleeps as usual: no agent working")
        );
        assert_eq!(rig.mac.last_hold(), Some(Hold::Watching));
    }

    #[test]
    fn a_server_that_stops_answering_mid_work_keeps_the_hold_for_the_grace() {
        let mut rig = rig(true);
        rig.watch(WORK);
        rig.answer(vec![seen(true)]);
        rig.look_at(0);
        rig.answer(vec![Poll::Failed]);
        rig.look_at(10);
        assert_eq!(rig.mac.last_hold(), Some(Hold::Holding));
        assert_eq!(
            rig.look_at(GRACE.as_secs()).as_deref(),
            Some("Paused: Codeman does not answer")
        );
        assert_eq!(rig.mac.last_hold(), Some(Hold::Watching));
    }

    #[test]
    fn a_refused_login_is_never_tried_again() {
        let mut rig = rig(true);
        rig.watch(WORK);
        rig.answer(vec![Poll::Refused]);
        assert_eq!(rig.look_at(0).as_deref(), Some("Paused: Codeman refused the login"));
        rig.look_at(2);
        rig.look_at(4);
        assert_eq!(*rig.asked.borrow(), 1);
        // A new login is a new try.
        rig.worker.update(Some(Watch {
            server: url("http://127.0.0.1:3000/"),
            authorization: Some("Basic eA==".into()),
            settings: WORK,
        }));
        rig.answer(vec![seen(true)]);
        rig.look_at(6);
        assert_eq!(*rig.asked.borrow(), 2);
        assert_eq!(rig.mac.last_hold(), Some(Hold::Holding));
    }

    #[test]
    fn always_holds_without_asking_the_server() {
        let mut rig = rig(true);
        rig.watch(ALWAYS);
        assert_eq!(rig.look_at(0).as_deref(), Some("Awake: Codeman is open"));
        assert_eq!(rig.mac.last_hold(), Some(Hold::Holding));
        assert_eq!(*rig.asked.borrow(), 0);
    }

    #[test]
    fn a_server_elsewhere_is_told_once_and_neither_asked_nor_held() {
        let mut rig = rig(false);
        rig.watch(WORK);
        assert!(!rig.worker.ticking());
        assert_eq!(
            rig.look_at(0).as_deref(),
            Some("Sleeps as usual: Codeman runs on another machine")
        );
        assert_eq!(*rig.asked.borrow(), 0);
        assert!(rig.mac.0.borrow().holds.is_empty());
    }

    #[test]
    fn unplugging_pauses_it_and_plugging_in_resumes() {
        let mut rig = rig(true);
        rig.watch(ALWAYS);
        rig.look_at(0);
        rig.mac.0.borrow_mut().battery = true;
        assert_eq!(rig.look_at(2).as_deref(), Some("Paused: on battery"));
        assert_eq!(rig.mac.last_hold(), Some(Hold::None));
        rig.mac.0.borrow_mut().battery = false;
        rig.look_at(4);
        assert_eq!(rig.mac.last_hold(), Some(Hold::Holding));
    }

    #[test]
    fn the_lid_is_asked_for_on_every_look_and_let_go_of() {
        let mut rig = rig(true);
        rig.watch(Settings { lid: true, ..ALWAYS });
        assert_eq!(
            rig.look_at(0).as_deref(),
            Some("Awake: Codeman is open, lid closed in a moment")
        );
        rig.mac.0.borrow_mut().lid = Some(Lid::Held { slept: None });
        assert_eq!(
            rig.look_at(2).as_deref(),
            Some("Awake: Codeman is open, lid closed too")
        );
        assert_eq!(rig.look_at(4), None);
        // Every look asks: it is the word the keeper waits for.
        assert_eq!(rig.mac.0.borrow().lid_asks, [true, true, true]);
        // On battery the lid is never asked for, whatever the setting.
        rig.watch(Settings {
            lid: true,
            ac_only: false,
            ..ALWAYS
        });
        rig.mac.0.borrow_mut().battery = true;
        assert_eq!(
            rig.look_at(6).as_deref(),
            Some("Awake: Codeman is open, not with the lid closed on battery")
        );
        assert_eq!(rig.mac.0.borrow().lid_asks.last(), Some(&false));
        rig.mac.0.borrow_mut().battery = false;
        rig.look_at(8);
        assert_eq!(rig.mac.0.borrow().lid_asks.last(), Some(&true));
        // The setting off: let go, though the Mac is still held awake.
        rig.watch(ALWAYS);
        assert_eq!(rig.look_at(10).as_deref(), Some("Awake: Codeman is open"));
        assert_eq!(rig.mac.0.borrow().lid_asks.last(), Some(&false));
        assert_eq!(rig.mac.last_hold(), Some(Hold::Holding));
        // Nothing to watch: everything let go.
        rig.watch(Settings { lid: true, ..ALWAYS });
        rig.look_at(12);
        assert_eq!(rig.mac.0.borrow().lid_asks.last(), Some(&true));
        rig.worker.update(None);
        assert_eq!(rig.look_at(14), None);
        assert_eq!(rig.mac.last_hold(), Some(Hold::None));
        assert_eq!(rig.mac.0.borrow().lid_asks.last(), Some(&false));
    }

    #[test]
    fn the_lid_goes_with_the_hold_when_the_agents_stop() {
        let mut rig = rig(true);
        rig.mac.0.borrow_mut().lid = Some(Lid::Held { slept: None });
        rig.watch(Settings { lid: true, ..WORK });
        rig.answer(vec![seen(true)]);
        assert_eq!(rig.look_at(0).as_deref(), Some("Awake: agents working, lid closed too"));
        rig.answer(vec![seen(false)]);
        rig.look_at(2);
        assert_eq!(
            rig.mac.0.borrow().lid_asks.last(),
            Some(&true),
            "held through the grace"
        );
        assert_eq!(
            rig.look_at(2 + GRACE.as_secs()).as_deref(),
            Some("Sleeps as usual: no agent working")
        );
        assert_eq!(rig.mac.0.borrow().lid_asks.last(), Some(&false));
    }

    #[test]
    fn a_new_value_reports_its_line_again() {
        let mut rig = rig(true);
        rig.watch(ALWAYS);
        assert!(rig.look_at(0).is_some());
        assert!(rig.look_at(2).is_none());
        rig.watch(ALWAYS);
        assert!(
            rig.look_at(4).is_some(),
            "the app numbers each value and waits for its line"
        );
    }

    #[test]
    fn the_thread_reports_under_the_latest_number_and_lets_go_at_the_end() {
        let mac = Shared::default();
        mac.0.borrow_mut().local = true;
        let new_source: NewSource = Box::new(|_| None);
        let worker = Worker::new(mac.clone(), new_source);
        let (sender, rx) = mpsc::channel();
        let watch = |settings| {
            Some(Watch {
                server: url("http://127.0.0.1:3000/"),
                authorization: None,
                settings,
            })
        };
        sender.send((1, watch(WORK))).unwrap();
        sender.send((2, watch(ALWAYS))).unwrap();
        drop(sender);
        let lines = RefCell::new(Vec::new());
        run(&rx, worker, &|generation, line| {
            lines.borrow_mut().push((generation, line))
        });
        assert_eq!(lines.into_inner(), vec![(2, "Awake: Codeman is open".to_owned())]);
        assert_eq!(mac.last_hold(), Some(Hold::None), "the end lets go");
    }
}
