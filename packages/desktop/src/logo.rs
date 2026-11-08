//! The lit Apple logo on the lid of a MacBook Pro with a PROLED XDR display
//! blinks with what the agents are doing, so you can read it across the room: one
//! rhythm while they work, another for a yellow tab (an agent finished and waits
//! for you) and a sharper one for a red tab (it needs a permission or an answer).
//! Opt-in (View menu, a style per state), and the menu exists only on a Mac that
//! has such a logo.
//!
//! Apple documents one control for the logo (support.apple.com/en-us/149248):
//! `sudo defaults write com.apple.CoreBrightness LEBacklightMode -int 0`. What
//! the app uses is the same setting, reached as a property of
//! `BrightnessSystemClient` in the private CoreBrightness framework, which needs
//! no administrator. Measured on a Mac17,13 with macOS 27.2 from an ad-hoc signed
//! binary: the write lands in about a millisecond with no fade, `corebrightnessd`
//! keeps it in its own defaults, and the NVRAM variable `bklb-backlight-enabled`
//! keeps its value while the logo is dark. The mode reads 2 when nothing was ever
//! set. A Mac without the logo answers nil, which is what `available` goes by; a
//! macOS that drops the property makes the feature disappear rather than fail.
//!
//! The setting is system-wide and survives a reboot, so the one thing that
//! must never happen is the app ending while the logo is dark. All of this
//! therefore runs in a child process (this same binary with `BLINK_ARG`), for as
//! long as any style is chosen and a server is open. The app hands it the server
//! and the login over a pipe (never on its command line, where `ps` shows them)
//! and keeps the pipe open. When the pipe closes, however the app ended (quit,
//! crash, `panic = "abort"`, Force Quit), the child puts the logo back and
//! exits. Switching it off closes the same pipe, so there is one way out
//! and it is the one a crash takes. For what even the child cannot survive
//! (power loss, a SIGKILL of the child itself), a marker file lies next to the
//! app's settings while a blink runs, and `recover` puts the logo back at the
//! next launch.
//!
//! When several states hold at once the most urgent one with a style is shown:
//! red, then yellow, then work.
//!
//! The child also does the asking (`agents`), so it needs nothing from the app
//! once started: a hidden window, a stalled page and App Nap cannot hold up the
//! logo, and the app's event loop gets no timers for it.
//!
//! The logo is only ever blinked from mode 2. A logo the user switched off
//! stays off, and a mode that changes under a running blink means someone else
//! wants the setting: the child leaves it as it found it and does not try again
//! until the agents have finished.

use crate::agents::Activity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

/// The argument that makes this binary the child instead of the app.
pub const BLINK_ARG: &str = "--logo-blink";

/// The logo is dark in every lighting condition (Apple's documented value).
const MODE_OFF: i64 = 0;
/// The logo follows the display and the ambient light. What the setting reads
/// on a Mac where nobody touched it.
const MODE_AUTO: i64 = 2;

/// One dark moment and the light after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Beat {
    dark: Duration,
    lit: Duration,
}

const fn beat(dark_ms: u64, lit_ms: u64) -> Beat {
    Beat {
        dark: Duration::from_millis(dark_ms),
        lit: Duration::from_millis(lit_ms),
    }
}

/// A rhythm for the logo, the user's pick in the View menu for each `Signal`. A
/// style switches `LEBacklightMode`, which is on or off, so it is a rhythm of
/// hard changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlinkStyle {
    /// The default: it changes a system-wide setting, so it is asked for.
    #[default]
    Off,
    Calm,
    Slow,
    Wink,
    Heartbeat,
    Fast,
    Alarm,
}

impl BlinkStyle {
    pub const ALL: [BlinkStyle; 7] = [
        BlinkStyle::Off,
        BlinkStyle::Calm,
        BlinkStyle::Slow,
        BlinkStyle::Wink,
        BlinkStyle::Heartbeat,
        BlinkStyle::Fast,
        BlinkStyle::Alarm,
    ];

    pub fn label(self) -> &'static str {
        match self {
            BlinkStyle::Off => "Off",
            BlinkStyle::Calm => "Calm",
            BlinkStyle::Slow => "Slow",
            BlinkStyle::Wink => "Wink",
            BlinkStyle::Heartbeat => "Heartbeat",
            BlinkStyle::Fast => "Fast",
            BlinkStyle::Alarm => "Alarm",
        }
    }

    pub fn menu_id(self, signal: Signal) -> String {
        format!("logo-blink-{}-{}", signal.key(), self.label().to_ascii_lowercase())
    }

    pub fn from_menu_id(id: &str) -> Option<(Signal, Self)> {
        Signal::ALL
            .into_iter()
            .flat_map(|signal| Self::ALL.map(|style| (signal, style)))
            .find(|(signal, style)| style.menu_id(*signal) == id)
    }

    /// The rhythm, repeated for as long as its state holds.
    const fn pattern(self) -> &'static [Beat] {
        match self {
            BlinkStyle::Off => &[],
            BlinkStyle::Calm => CALM,
            BlinkStyle::Slow => SLOW,
            BlinkStyle::Wink => WINK,
            BlinkStyle::Heartbeat => HEARTBEAT,
            BlinkStyle::Fast => FAST,
            BlinkStyle::Alarm => ALARM,
        }
    }
}

/// What the logo can tell, in the order of the View menu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Working,
    Waiting,
    NeedsYou,
}

impl Signal {
    pub const ALL: [Signal; 3] = [Signal::Working, Signal::Waiting, Signal::NeedsYou];

    pub fn label(self) -> &'static str {
        match self {
            Signal::Working => "While Working",
            Signal::Waiting => "Waiting for You (Yellow)",
            Signal::NeedsYou => "Needs Permission (Red)",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Signal::Working => "working",
            Signal::Waiting => "waiting",
            Signal::NeedsYou => "needs-you",
        }
    }
}

/// The user's style for each `Signal`, `logoBlink` in the settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BlinkStyles {
    pub working: BlinkStyle,
    pub waiting: BlinkStyle,
    pub needs_you: BlinkStyle,
}

impl BlinkStyles {
    /// Reads whatever the file holds. A bad value is off, for its state alone: it
    /// must not make the file unreadable. A single style is what this setting was
    /// before it had states: that was the choice for work, and whoever made it
    /// gets the alerts with it, since they asked for a logo that talks.
    pub fn read(value: &Value) -> Self {
        let style = |value: Option<&Value>| {
            value
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default()
        };
        match value {
            Value::Object(styles) => BlinkStyles {
                working: style(styles.get("working")),
                waiting: style(styles.get("waiting")),
                needs_you: style(styles.get("needsYou")),
            },
            Value::String(_) => match style(Some(value)) {
                BlinkStyle::Off => Self::default(),
                working => BlinkStyles {
                    working,
                    waiting: BlinkStyle::Wink,
                    needs_you: BlinkStyle::Alarm,
                },
            },
            _ => Self::default(),
        }
    }

    pub fn get(self, signal: Signal) -> BlinkStyle {
        match signal {
            Signal::Working => self.working,
            Signal::Waiting => self.waiting,
            Signal::NeedsYou => self.needs_you,
        }
    }

    pub fn set(&mut self, signal: Signal, style: BlinkStyle) {
        match signal {
            Signal::Working => self.working = style,
            Signal::Waiting => self.waiting = style,
            Signal::NeedsYou => self.needs_you = style,
        }
    }

    pub fn any(self) -> bool {
        Signal::ALL.iter().any(|&signal| self.get(signal) != BlinkStyle::Off)
    }

    /// Whether anything but work has a style, which is what makes the alerts
    /// worth asking the server for.
    fn wants_alerts(self) -> bool {
        self.waiting != BlinkStyle::Off || self.needs_you != BlinkStyle::Off
    }

    /// What the logo should do: the most urgent state that holds and has a
    /// style. A state set to off is not a reason for silence, so it falls through.
    fn pick(self, activity: Activity) -> BlinkStyle {
        [
            (activity.needs_you, self.needs_you),
            (activity.waiting, self.waiting),
            (activity.working, self.working),
        ]
        .into_iter()
        .find(|&(holds, style)| holds && style != BlinkStyle::Off)
        .map_or(BlinkStyle::Off, |(_, style)| style)
    }
}

// Every change of the logo is a preference write, so these also set how often
// that happens: from about one every two seconds (Slow, Wink) to about four a
// second (Alarm). No style goes above three flashes in any second, the limit
// accessibility guidelines set for flashing light, so what makes Alarm urgent
// is its shape: three hard flashes with a short rest, not a higher rate.
const CALM: &[Beat] = &[beat(800, 1200)];
const SLOW: &[Beat] = &[beat(1500, 3000)];
/// Mostly lit: a short dark moment every few seconds.
const WINK: &[Beat] = &[beat(250, 3500)];
/// Two quick beats, then a rest.
const HEARTBEAT: &[Beat] = &[beat(120, 180), beat(120, 1600)];
const FAST: &[Beat] = &[beat(300, 300)];
/// Three sharp flashes and a short rest, over and over: hey, I need something.
const ALARM: &[Beat] = &[beat(120, 120), beat(120, 120), beat(120, 900)];

/// How often to look again while the logo cannot be seen (the display sleeps,
/// the lid is closed). Nothing is written in that time.
const NOT_LIT_RECHECK: Duration = Duration::from_secs(2);
/// How long a change has to hold before the logo follows it, so a server
/// restart or an agent between two turns does not flicker it. Not below the 3 s
/// the server waits before it judges a new dialog: a prompt that was answered
/// before its hook landed lives that long and should never flash red.
const SETTLE: Duration = Duration::from_secs(3);
/// How often the child looks at what the poller found, and at the pipe.
const LOOK_EVERY: Duration = Duration::from_millis(250);

/// What a blink needs from the machine, so its decisions can be tested.
pub trait Logo {
    /// The current mode, None if it could not be read.
    fn mode(&self) -> Option<i64>;
    /// Set the mode; false if the daemon did not take it.
    fn set_mode(&self, mode: i64) -> bool;
    /// What the logo is driven at in the current mode, in nits: 0 while it is
    /// off for its own reasons (the display sleeps, the lid is closed).
    fn nits(&self) -> Option<f64>;
}

/// The file that says a blink may have left the logo dark.
pub struct Marker(Option<PathBuf>);

impl Marker {
    fn default_location() -> Self {
        Marker(dirs::config_dir().map(|d| d.join("Codeman").join("logo-blink")))
    }

    fn set(&self) -> bool {
        let Some(path) = &self.0 else { return false };
        path.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok()) && std::fs::write(path, b"").is_ok()
    }

    fn clear(&self) {
        if let Some(path) = &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }

    fn is_set(&self) -> bool {
        self.0.as_ref().is_some_and(|path| path.exists())
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Ended {
    /// `wait` said stop, and the logo is lit again.
    Stopped,
    /// The logo is not ours to blink, or stopped doing what it is told.
    Declined,
}

/// Blink until `wait` reports that it is time to stop, then leave the logo
/// lit. `wait` sleeps for the given time and answers true if the blink should
/// end. A marker that cannot be written refuses the blink: without it a power
/// cut in a dark phase would have no way back.
fn blink(logo: &impl Logo, marker: &Marker, pattern: &[Beat], mut wait: impl FnMut(Duration) -> bool) -> Ended {
    if logo.mode() != Some(MODE_AUTO) || !marker.set() {
        return Ended::Declined;
    }
    let mut dark = false;
    let mut ended = Ended::Stopped;
    for beat in pattern.iter().cycle() {
        if logo.mode() != Some(MODE_AUTO) {
            marker.clear();
            return Ended::Declined;
        }
        if logo.nits() == Some(0.0) {
            if wait(NOT_LIT_RECHECK) {
                break;
            }
            continue;
        }
        if !logo.set_mode(MODE_OFF) {
            ended = Ended::Declined;
            break;
        }
        dark = true;
        if wait(beat.dark) {
            break;
        }
        if logo.mode() != Some(MODE_OFF) {
            marker.clear();
            return Ended::Declined;
        }
        if !logo.set_mode(MODE_AUTO) {
            ended = Ended::Declined;
            break;
        }
        dark = false;
        if wait(beat.lit) {
            break;
        }
    }
    // A logo already lit needs no write, and a failed restore keeps the marker
    // so the next launch tries again.
    if !dark || logo.set_mode(MODE_AUTO) {
        marker.clear();
    }
    ended
}

/// Put back a logo that a blink could not finish with.
pub fn recover(logo: &impl Logo, marker: &Marker) {
    if !marker.is_set() {
        return;
    }
    if logo.mode() != Some(MODE_OFF) || logo.set_mode(MODE_AUTO) {
        marker.clear();
    }
}

/// An answer that only changes once the new one has held for `SETTLE`.
struct Settled<T> {
    answer: T,
    latest: T,
    changed_at: Instant,
}

impl<T: Copy + PartialEq> Settled<T> {
    fn new(answer: T, now: Instant) -> Self {
        Settled {
            answer,
            latest: answer,
            changed_at: now,
        }
    }

    fn update(&mut self, latest: T, now: Instant) -> T {
        if latest != self.latest {
            self.latest = latest;
            self.changed_at = now;
        }
        if now.duration_since(self.changed_at) >= SETTLE {
            self.answer = latest;
        }
        self.answer
    }
}

/// What the child goes by.
trait Signals {
    /// Sleep this long; true if the app went away, right when it did.
    fn wait(&mut self, time: Duration) -> bool;
    fn activity(&self) -> Activity;
    fn now(&self) -> Instant;
}

/// The child's life: show what the agents are doing, until the app goes away. A
/// change of state ends the blink that is running, which leaves the logo lit, and
/// the next look starts the new one.
fn watch(logo: &impl Logo, marker: &Marker, styles: BlinkStyles, signals: &mut impl Signals) {
    let mut settled = Settled::new(BlinkStyle::Off, signals.now());
    let mut declined = false;
    loop {
        if signals.wait(LOOK_EVERY) {
            return;
        }
        let style = settled.update(styles.pick(signals.activity()), signals.now());
        if style == BlinkStyle::Off {
            declined = false;
            continue;
        }
        if declined {
            continue;
        }
        let mut app_gone = false;
        let ended = blink(logo, marker, style.pattern(), |time| {
            let deadline = signals.now() + time;
            loop {
                let left = deadline.saturating_duration_since(signals.now());
                if left.is_zero() {
                    return false;
                }
                if signals.wait(left.min(LOOK_EVERY)) {
                    app_gone = true;
                    return true;
                }
                if settled.update(styles.pick(signals.activity()), signals.now()) != style {
                    return true;
                }
            }
        });
        if app_gone {
            return;
        }
        declined = ended == Ended::Declined;
    }
}

/// The one line the app writes to the child.
#[derive(Serialize, Deserialize)]
struct Connection {
    server: String,
    authorization: Option<String>,
    styles: BlinkStyles,
}

/// The app's side: the pipe to the child, which is all there is to it.
#[derive(Default)]
pub struct Watcher {
    current: Option<(Connection, ChildStdin)>,
}

impl Watcher {
    /// Watch this server with this login in these styles, or nothing. A child
    /// for anything else ends first: its pipe closes with the old value. It is
    /// back to lit well before the next child looks, which takes `SETTLE`.
    pub fn sync(&mut self, want: Option<(&str, Option<&str>, BlinkStyles)>) {
        let same = match (&self.current, want) {
            (Some((now, _)), Some((server, authorization, styles))) => {
                now.server == server && now.authorization.as_deref() == authorization && now.styles == styles
            }
            (None, None) => true,
            _ => false,
        };
        if same {
            return;
        }
        self.current = want.and_then(|(server, authorization, styles)| {
            spawn_child(Connection {
                server: server.to_owned(),
                authorization: authorization.map(str::to_owned),
                styles,
            })
        });
    }
}

fn spawn_child(connection: Connection) -> Option<(Connection, ChildStdin)> {
    let exe = std::env::current_exe().ok()?;
    let mut child = Command::new(exe)
        .arg(BLINK_ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    let line = serde_json::to_string(&connection).ok()? + "\n";
    stdin.write_all(line.as_bytes()).ok()?;
    // It ends by itself once the pipe closes. This only collects it.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Some((connection, stdin))
}

#[cfg(target_os = "macos")]
pub use system::{available, blink_main, recover_at_launch, switched_off};

#[cfg(not(target_os = "macos"))]
pub fn available() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn blink_main() -> ! {
    std::process::exit(0)
}

#[cfg(not(target_os = "macos"))]
pub fn recover_at_launch() {}

#[cfg(not(target_os = "macos"))]
pub fn switched_off() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod system {
    use super::{recover, watch, Connection, Logo, Marker, Signals, MODE_OFF};
    use crate::agents::{Activity, Poll, Poller, POLL_EVERY};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use objc2_foundation::{ns_string, NSBundle, NSDictionary, NSNumber, NSString};
    use std::io::Read;
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use url::Url;

    struct SystemLogo {
        client: Retained<AnyObject>,
    }

    impl SystemLogo {
        /// The framework is private, so it is looked up at run time and never
        /// linked: on a macOS without it this is None, not a failed launch.
        fn open() -> Option<Self> {
            autoreleasepool(|_| {
                let path = ns_string!("/System/Library/PrivateFrameworks/CoreBrightness.framework");
                let bundle = NSBundle::bundleWithPath(path)?;
                // SAFETY: an Apple system framework, which every process that
                // shows a window has mapped already; it runs no code of ours.
                if !unsafe { bundle.load() } {
                    return None;
                }
                let class = AnyClass::get(c"BrightnessSystemClient")?;
                let answers = class.instance_method(sel!(copyPropertyForKey:)).is_some()
                    && class.instance_method(sel!(setProperty:forKey:)).is_some();
                if !answers {
                    return None;
                }
                // SAFETY: `new` is NSObject's, and the class was checked above.
                let client: Option<Retained<AnyObject>> = unsafe { msg_send![class, new] };
                client.map(|client| SystemLogo { client })
            })
        }

        fn property(&self, key: &NSString) -> Option<Retained<AnyObject>> {
            // SAFETY: the method was checked in `open`. It takes a string and
            // answers an owned object or nil.
            unsafe { msg_send![&*self.client, copyPropertyForKey: key] }
        }
    }

    impl Logo for SystemLogo {
        fn mode(&self) -> Option<i64> {
            autoreleasepool(|_| {
                let value = self.property(ns_string!("LEBacklightMode"))?;
                Some(value.downcast_ref::<NSNumber>()?.as_i64())
            })
        }

        fn set_mode(&self, mode: i64) -> bool {
            autoreleasepool(|_| {
                let value = NSNumber::new_i64(mode);
                // SAFETY: the method was checked in `open`. It takes an object
                // and a string and answers a BOOL.
                unsafe { msg_send![&*self.client, setProperty: &*value, forKey: ns_string!("LEBacklightMode")] }
            })
        }

        fn nits(&self) -> Option<f64> {
            autoreleasepool(|_| {
                let state = self.property(ns_string!("LEPWMState"))?;
                let state = state.downcast_ref::<NSDictionary>()?;
                // SAFETY: an NSDictionary answers objectForKey:, with nil for a
                // key it does not have.
                let value: Option<Retained<AnyObject>> =
                    unsafe { msg_send![state, objectForKey: ns_string!("FinalNits")] };
                Some(value?.downcast_ref::<NSNumber>()?.as_f64())
            })
        }
    }

    /// Whether this Mac has a logo the app can drive. Asked once: the answer
    /// is the hardware's and takes a few milliseconds.
    pub fn available() -> bool {
        static AVAILABLE: OnceLock<bool> = OnceLock::new();
        *AVAILABLE.get_or_init(|| SystemLogo::open().is_some_and(|logo| logo.mode().is_some()))
    }

    /// The user (or anything else that is not a blink) has the logo off.
    pub fn switched_off() -> bool {
        SystemLogo::open().is_some_and(|logo| logo.mode() == Some(MODE_OFF))
    }

    pub fn recover_at_launch() {
        let marker = Marker::default_location();
        if marker.is_set() {
            if let Some(logo) = SystemLogo::open() {
                recover(&logo, &marker);
            }
        }
    }

    struct Live {
        pipe_closed: Receiver<()>,
        activity: Arc<Mutex<Activity>>,
    }

    impl Signals for Live {
        fn wait(&mut self, time: Duration) -> bool {
            !matches!(self.pipe_closed.recv_timeout(time), Err(RecvTimeoutError::Timeout))
        }

        fn activity(&self) -> Activity {
            self.activity.lock().map_or(Activity::default(), |activity| *activity)
        }

        fn now(&self) -> Instant {
            Instant::now()
        }
    }

    /// Runs for the life of the child. A server that does not answer counts as
    /// nothing going on, and one that refuses the login is never asked again.
    fn poll_until_refused(mut poller: Poller, shared: &Mutex<Activity>) {
        loop {
            let poll = poller.poll();
            if let Ok(mut activity) = shared.lock() {
                *activity = match poll {
                    Poll::Seen(seen) => seen,
                    _ => Activity::default(),
                };
            }
            if poll == Poll::Refused {
                return;
            }
            std::thread::sleep(POLL_EVERY);
        }
    }

    /// The child process. It ends when the pipe from the app closes, and the
    /// signals that would end it sooner are ignored, because they arrive
    /// together with the app's own end (a logout, Ctrl-C on a terminal that
    /// started the app) and could land in a dark phase.
    pub fn blink_main() -> ! {
        // SAFETY: `signal` with SIG_IGN, before any other thread exists.
        unsafe {
            for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM] {
                libc::signal(signal, libc::SIG_IGN);
            }
        }
        let mut line = String::new();
        let connection = std::io::stdin()
            .read_line(&mut line)
            .ok()
            .and_then(|_| serde_json::from_str::<Connection>(&line).ok());
        let Some(Connection {
            server,
            authorization,
            styles,
        }) = connection
        else {
            std::process::exit(0);
        };
        let poller = Url::parse(&server)
            .ok()
            .and_then(|url| Poller::new(&url, authorization, styles.wants_alerts()));
        let (Some(poller), Some(logo)) = (poller, SystemLogo::open()) else {
            std::process::exit(0);
        };

        let (closed, pipe_closed) = mpsc::channel::<()>();
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 64];
            while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
            let _ = closed.send(());
        });
        let activity = Arc::new(Mutex::new(Activity::default()));
        let found = activity.clone();
        std::thread::spawn(move || poll_until_refused(poller, &found));

        let mut signals = Live { pipe_closed, activity };
        watch(&logo, &Marker::default_location(), styles, &mut signals);
        std::process::exit(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const DARK_FOR: Duration = CALM[0].dark;
    const LIT_FOR: Duration = CALM[0].lit;
    /// The style most of these tests watch with: work only.
    const WORK: BlinkStyles = BlinkStyles {
        working: BlinkStyle::Calm,
        waiting: BlinkStyle::Off,
        needs_you: BlinkStyle::Off,
    };

    fn working() -> Activity {
        Activity {
            working: true,
            ..Activity::default()
        }
    }

    fn waiting() -> Activity {
        Activity {
            waiting: true,
            ..Activity::default()
        }
    }

    fn needs_you() -> Activity {
        Activity {
            needs_you: true,
            ..Activity::default()
        }
    }

    /// A logo that records every write.
    struct FakeLogo {
        mode: Cell<i64>,
        nits: Cell<f64>,
        writes: RefCell<Vec<i64>>,
        refuse_writes: Cell<bool>,
    }

    impl FakeLogo {
        fn new(mode: i64) -> Self {
            FakeLogo {
                mode: Cell::new(mode),
                nits: Cell::new(200.0),
                writes: RefCell::new(Vec::new()),
                refuse_writes: Cell::new(false),
            }
        }

        fn writes(&self) -> Vec<i64> {
            self.writes.borrow().clone()
        }
    }

    impl Logo for FakeLogo {
        fn mode(&self) -> Option<i64> {
            Some(self.mode.get())
        }

        fn set_mode(&self, mode: i64) -> bool {
            if self.refuse_writes.get() {
                return false;
            }
            self.mode.set(mode);
            self.writes.borrow_mut().push(mode);
            true
        }

        fn nits(&self) -> Option<f64> {
            Some(self.nits.get())
        }
    }

    fn temp_marker(name: &str) -> (Marker, PathBuf) {
        let dir = std::env::temp_dir().join(format!("codeman-logo-{}-{name}", std::process::id()));
        let path = dir.join("nested").join("logo-blink");
        let _ = std::fs::remove_dir_all(&dir);
        (Marker(Some(path.clone())), path)
    }

    /// A `wait` that stops the blink on its Nth call, and records the times.
    fn stop_on(call: usize, times: &RefCell<Vec<Duration>>) -> impl FnMut(Duration) -> bool + '_ {
        move |time| {
            times.borrow_mut().push(time);
            times.borrow().len() >= call
        }
    }

    #[test]
    fn a_blink_alternates_and_ends_lit() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("alternates");
        let times = RefCell::new(Vec::new());
        blink(&logo, &marker, CALM, stop_on(4, &times));
        // dark, lit, dark, and the stop in the fourth wait is a dark phase's.
        assert_eq!(logo.writes(), [MODE_OFF, MODE_AUTO, MODE_OFF, MODE_AUTO]);
        assert_eq!(*times.borrow(), [DARK_FOR, LIT_FOR, DARK_FOR, LIT_FOR]);
        assert_eq!(logo.mode.get(), MODE_AUTO);
        assert!(!path.exists(), "a finished blink leaves no marker");
    }

    #[test]
    fn a_stop_in_a_dark_phase_restores_the_logo_at_once() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("dark-stop");
        let times = RefCell::new(Vec::new());
        blink(&logo, &marker, CALM, stop_on(1, &times));
        assert_eq!(logo.writes(), [MODE_OFF, MODE_AUTO]);
        assert!(!path.exists());
    }

    #[test]
    fn a_stop_while_lit_writes_nothing_more() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("lit-stop");
        let times = RefCell::new(Vec::new());
        blink(&logo, &marker, CALM, stop_on(2, &times));
        assert_eq!(logo.writes(), [MODE_OFF, MODE_AUTO]);
    }

    #[test]
    fn a_logo_the_user_switched_off_is_left_alone() {
        for mode in [MODE_OFF, 1, 7] {
            let logo = FakeLogo::new(mode);
            let (marker, path) = temp_marker("user-off");
            let times = RefCell::new(Vec::new());
            assert_eq!(blink(&logo, &marker, CALM, stop_on(1, &times)), Ended::Declined);
            assert_eq!(logo.writes(), [] as [i64; 0]);
            assert!(times.borrow().is_empty(), "it does not even wait");
            assert!(!path.exists());
        }
    }

    #[test]
    fn a_marker_that_cannot_be_written_refuses_the_blink() {
        let logo = FakeLogo::new(MODE_AUTO);
        let times = RefCell::new(Vec::new());
        assert_eq!(blink(&logo, &Marker(None), CALM, stop_on(1, &times)), Ended::Declined);
        assert_eq!(logo.writes(), [] as [i64; 0]);
    }

    #[test]
    fn a_mode_changed_from_outside_ends_the_blink_without_a_write() {
        // Someone switches the logo off during a lit phase: their setting stands.
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("outside-lit");
        let mut calls = 0;
        let ended = blink(&logo, &marker, CALM, |_| {
            calls += 1;
            if calls == 2 {
                logo.mode.set(MODE_OFF);
            }
            false
        });
        assert_eq!(ended, Ended::Declined);
        assert_eq!(logo.writes(), [MODE_OFF, MODE_AUTO]);
        assert_eq!(logo.mode.get(), MODE_OFF);
        assert!(!path.exists());

        // Someone deletes the setting during a dark phase: it stays as they left it.
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("outside-dark");
        let ended = blink(&logo, &marker, CALM, |_| {
            logo.mode.set(MODE_AUTO);
            false
        });
        assert_eq!(ended, Ended::Declined);
        assert_eq!(logo.writes(), [MODE_OFF]);
        assert!(!path.exists());
    }

    #[test]
    fn nothing_is_written_while_the_logo_cannot_be_seen() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.nits.set(0.0);
        let (marker, path) = temp_marker("not-lit");
        let times = RefCell::new(Vec::new());
        blink(&logo, &marker, CALM, stop_on(3, &times));
        assert_eq!(logo.writes(), [] as [i64; 0]);
        assert_eq!(*times.borrow(), [NOT_LIT_RECHECK; 3]);
        assert!(!path.exists());
    }

    #[test]
    fn a_blink_resumes_when_the_logo_comes_back() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.nits.set(0.0);
        let (marker, _) = temp_marker("wakes");
        let mut calls = 0;
        blink(&logo, &marker, CALM, |_| {
            calls += 1;
            logo.nits.set(200.0);
            calls == 2
        });
        assert_eq!(logo.writes(), [MODE_OFF, MODE_AUTO]);
    }

    #[test]
    fn a_failed_restore_keeps_the_marker_for_the_next_launch() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("failed-restore");
        blink(&logo, &marker, CALM, |_| {
            logo.refuse_writes.set(true);
            true
        });
        assert_eq!(logo.mode.get(), MODE_OFF);
        assert!(path.exists());
        logo.refuse_writes.set(false);
        recover(&logo, &marker);
        assert_eq!(logo.mode.get(), MODE_AUTO);
        assert!(!path.exists());
    }

    #[test]
    fn recover_needs_the_marker() {
        let logo = FakeLogo::new(MODE_OFF);
        let (marker, _) = temp_marker("no-marker");
        recover(&logo, &marker);
        assert_eq!(
            logo.writes(),
            [] as [i64; 0],
            "without a marker a dark logo is the user's"
        );
    }

    #[test]
    fn recover_leaves_a_lit_logo_and_clears_the_marker() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("lit-recover");
        assert!(marker.set());
        recover(&logo, &marker);
        assert_eq!(logo.writes(), [] as [i64; 0]);
        assert!(!path.exists());
    }

    #[test]
    fn a_change_counts_once_it_held() {
        let t0 = Instant::now();
        let mut settled = Settled::new(false, t0);
        assert!(!settled.update(true, t0));
        assert!(!settled.update(true, t0 + SETTLE - Duration::from_millis(1)));
        assert!(settled.update(true, t0 + SETTLE));
        // Back to false and on again within the time changes nothing.
        let t1 = t0 + Duration::from_secs(10);
        assert!(settled.update(false, t1));
        assert!(settled.update(true, t1 + Duration::from_secs(1)));
        assert!(settled.update(true, t1 + Duration::from_secs(9)));
        assert!(settled.update(false, t1 + Duration::from_secs(10)));
        assert!(!settled.update(false, t1 + Duration::from_secs(10) + SETTLE));
    }

    #[test]
    fn a_new_dialog_is_judged_before_the_logo_would_follow_it() {
        // The server's check of a new dialog (`STALE_CHECK_DELAY_MS`), which a
        // prompt answered before its hook landed does not survive.
        assert!(SETTLE >= Duration::from_secs(3));
    }

    /// A clock that `wait` moves, and a server that shows the given activity in
    /// the given spans of time. The app goes away at `app_gone_at`.
    struct Script {
        start: Instant,
        clock: Cell<Instant>,
        spans: Vec<(u64, u64, Activity)>,
        app_gone_at: u64,
    }

    impl Script {
        fn new(work: &[(u64, u64)], app_gone_at: u64) -> Self {
            let spans: Vec<_> = work.iter().map(|&(from, to)| (from, to, working())).collect();
            Self::with(&spans, app_gone_at)
        }

        fn with(spans: &[(u64, u64, Activity)], app_gone_at: u64) -> Self {
            let start = Instant::now();
            Script {
                start,
                clock: Cell::new(start),
                spans: spans.to_vec(),
                app_gone_at,
            }
        }

        fn elapsed_ms(&self) -> u64 {
            self.clock.get().duration_since(self.start).as_millis() as u64
        }
    }

    impl Signals for Script {
        fn wait(&mut self, time: Duration) -> bool {
            self.clock.set(self.clock.get() + time);
            self.elapsed_ms() >= self.app_gone_at
        }

        fn activity(&self) -> Activity {
            let t = self.elapsed_ms();
            self.spans
                .iter()
                .find(|&&(from, to, _)| t >= from && t < to)
                .map_or(Activity::default(), |&(_, _, activity)| activity)
        }

        fn now(&self) -> Instant {
            self.clock.get()
        }
    }

    const CYCLE_MS: u64 = (LIT_FOR.as_millis() + DARK_FOR.as_millis()) as u64;

    #[test]
    fn nothing_is_written_while_no_agent_works() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-quiet");
        watch(&logo, &marker, WORK, &mut Script::new(&[], 60_000));
        assert_eq!(logo.writes(), [] as [i64; 0]);
    }

    #[test]
    fn a_short_flicker_of_work_does_not_blink() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-flicker");
        watch(&logo, &marker, WORK, &mut Script::new(&[(1_000, 2_500)], 60_000));
        assert_eq!(logo.writes(), [] as [i64; 0]);
    }

    #[test]
    fn it_blinks_for_the_length_of_the_work_and_ends_lit() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("watch-turn");
        let mut script = Script::new(&[(1_000, 21_000)], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        let writes = logo.writes();
        let dark_phases = writes.iter().filter(|&&m| m == MODE_OFF).count() as u64;
        // Settling delays the start and the end alike, so the blink lasts as long
        // as the 20 s of work did, with one dark phase a cycle.
        let cycles = 20_000 / CYCLE_MS;
        assert!(dark_phases >= cycles, "{dark_phases} dark phases, {cycles} cycles");
        assert!(dark_phases <= cycles + 2, "{dark_phases} dark phases, {cycles} cycles");
        assert_eq!(logo.mode.get(), MODE_AUTO);
        assert!(!path.exists());
    }

    #[test]
    fn the_end_of_the_work_stops_a_blink_in_the_middle_of_a_dark_phase() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-stop");
        // Work has to hold to start and to stop. Started at about 4.25 s, a dark
        // phase runs from every 2 s after that, and work that ends at 5.5 s
        // settles at 8.5 s, inside the third one.
        let mut script = Script::new(&[(1_000, 5_500)], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(
            logo.writes(),
            [MODE_OFF, MODE_AUTO, MODE_OFF, MODE_AUTO, MODE_OFF, MODE_AUTO]
        );
    }

    #[test]
    fn a_gap_between_two_turns_does_not_stop_the_blink() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-gap");
        let mut script = Script::new(&[(1_000, 15_000), (16_000, 30_000)], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        let writes = logo.writes();
        let dark_phases = writes.iter().filter(|&&m| m == MODE_OFF).count() as u64;
        assert!(
            dark_phases >= (29_000 - 2 * SETTLE.as_millis() as u64) / CYCLE_MS,
            "{dark_phases}"
        );
    }

    #[test]
    fn the_app_going_away_in_a_dark_phase_puts_the_logo_back() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("watch-gone");
        // Work from the start; the first dark phase begins once it has settled.
        watch(&logo, &marker, WORK, &mut Script::new(&[(0, 60_000)], 3_500));
        assert_eq!(logo.writes(), [MODE_OFF, MODE_AUTO]);
        assert!(!path.exists());
    }

    #[test]
    fn a_logo_the_user_switched_off_is_not_asked_again_during_the_work() {
        let logo = FakeLogo::new(MODE_OFF);
        let (marker, _) = temp_marker("watch-declined");
        let mut script = Script::new(&[(0, 30_000)], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.writes(), [] as [i64; 0]);
    }

    #[test]
    fn after_the_agents_finish_it_may_ask_again() {
        // Declined in the first turn, the logo is back on for the second.
        let logo = FakeLogo::new(MODE_OFF);
        let (marker, _) = temp_marker("watch-again");
        let mut script = Script::new(&[(0, 5_000), (20_000, 30_000)], 60_000);
        struct TurnsOn<'a>(&'a mut Script, &'a FakeLogo);
        impl Signals for TurnsOn<'_> {
            fn wait(&mut self, time: Duration) -> bool {
                let gone = self.0.wait(time);
                if self.0.elapsed_ms() >= 10_000 && self.0.elapsed_ms() < 10_300 {
                    self.1.mode.set(MODE_AUTO);
                }
                gone
            }
            fn activity(&self) -> Activity {
                self.0.activity()
            }
            fn now(&self) -> Instant {
                self.0.now()
            }
        }
        watch(&logo, &marker, WORK, &mut TurnsOn(&mut script, &logo));
        assert!(logo.writes().contains(&MODE_OFF), "{:?}", logo.writes());
        assert_eq!(logo.mode.get(), MODE_AUTO);
    }

    #[test]
    fn the_connection_line_round_trips_with_and_without_a_login() {
        for authorization in [None, Some("Basic abc".to_string())] {
            let line = serde_json::to_string(&Connection {
                server: "http://127.0.0.1:3000/".into(),
                authorization: authorization.clone(),
                styles: WORK,
            })
            .unwrap();
            assert!(!line.contains('\n'), "one line");
            let back: Connection = serde_json::from_str(&line).unwrap();
            assert_eq!(back.server, "http://127.0.0.1:3000/");
            assert_eq!(back.authorization, authorization);
            assert_eq!(back.styles, WORK);
        }
    }

    #[test]
    fn a_style_of_several_beats_runs_them_in_turn() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("beats");
        let pattern = BlinkStyle::Heartbeat.pattern();
        let times = RefCell::new(Vec::new());
        blink(&logo, &marker, pattern, stop_on(6, &times));
        let [one, two] = pattern else { panic!("two beats") };
        assert_eq!(
            *times.borrow(),
            [one.dark, one.lit, two.dark, two.lit, one.dark, one.lit]
        );
    }

    #[test]
    fn every_style_but_off_has_a_rhythm_with_light_and_dark() {
        for style in BlinkStyle::ALL {
            if style == BlinkStyle::Off {
                assert!(style.pattern().is_empty());
                continue;
            }
            assert!(!style.pattern().is_empty(), "{style:?}");
            for beat in style.pattern() {
                assert!(!beat.dark.is_zero() && !beat.lit.is_zero(), "{style:?}");
            }
        }
    }

    #[test]
    fn no_style_flashes_more_than_three_times_in_any_second() {
        for style in BlinkStyle::ALL {
            let mut starts = Vec::new();
            let mut at = Duration::ZERO;
            for beat in style.pattern().iter().cycle().take(40) {
                starts.push(at);
                at += beat.dark + beat.lit;
            }
            for (i, from) in starts.iter().enumerate() {
                let in_a_second = starts[i..].iter().filter(|&&t| t - *from < Duration::from_secs(1));
                assert!(in_a_second.count() <= 3, "{style:?}");
            }
        }
    }

    #[test]
    fn a_menu_id_names_its_state_and_style_and_nothing_else() {
        for signal in Signal::ALL {
            for style in BlinkStyle::ALL {
                assert_eq!(BlinkStyle::from_menu_id(&style.menu_id(signal)), Some((signal, style)));
            }
        }
        assert_eq!(BlinkStyle::from_menu_id("reload"), None);
        assert_eq!(BlinkStyle::from_menu_id("logo-blink-calm"), None);
        assert_eq!(BlinkStyle::from_menu_id(""), None);
    }

    const ALL_ON: BlinkStyles = BlinkStyles {
        working: BlinkStyle::Calm,
        waiting: BlinkStyle::Wink,
        needs_you: BlinkStyle::Alarm,
    };

    #[test]
    fn the_most_urgent_state_wins() {
        let everything = Activity {
            working: true,
            waiting: true,
            needs_you: true,
        };
        assert_eq!(ALL_ON.pick(everything), BlinkStyle::Alarm);
        assert_eq!(
            ALL_ON.pick(Activity {
                needs_you: false,
                ..everything
            }),
            BlinkStyle::Wink
        );
        assert_eq!(ALL_ON.pick(working()), BlinkStyle::Calm);
        assert_eq!(ALL_ON.pick(Activity::default()), BlinkStyle::Off);
    }

    #[test]
    fn a_state_set_to_off_falls_through_to_the_next_one() {
        let everything = Activity {
            working: true,
            waiting: true,
            needs_you: true,
        };
        let mut styles = ALL_ON;
        styles.needs_you = BlinkStyle::Off;
        assert_eq!(styles.pick(everything), BlinkStyle::Wink);
        styles.waiting = BlinkStyle::Off;
        assert_eq!(styles.pick(everything), BlinkStyle::Calm);
        styles.working = BlinkStyle::Off;
        assert_eq!(styles.pick(everything), BlinkStyle::Off);
    }

    #[test]
    fn a_state_with_no_style_touches_nothing_not_even_the_marker() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("no-style");
        struct Watching<'a>(Script, &'a PathBuf);
        impl Signals for Watching<'_> {
            fn wait(&mut self, time: Duration) -> bool {
                assert!(!self.1.exists(), "no marker was ever needed");
                self.0.wait(time)
            }
            fn activity(&self) -> Activity {
                self.0.activity()
            }
            fn now(&self) -> Instant {
                self.0.now()
            }
        }
        let script = Script::with(&[(0, 30_000, waiting())], 40_000);
        watch(&logo, &marker, WORK, &mut Watching(script, &path));
        assert_eq!(logo.writes(), [] as [i64; 0]);
    }

    fn dark_phases(styles: BlinkStyles, spans: &[(u64, u64, Activity)], end: u64) -> usize {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("phases");
        watch(&logo, &marker, styles, &mut Script::with(spans, end));
        assert_eq!(logo.mode.get(), MODE_AUTO, "it ends lit");
        assert!(!path.exists());
        logo.writes().iter().filter(|&&mode| mode == MODE_OFF).count()
    }

    #[test]
    fn a_change_of_state_moves_to_the_other_rhythm_and_back() {
        let alone = dark_phases(ALL_ON, &[(0, 60_000, working())], 60_000);
        let interrupted = dark_phases(
            ALL_ON,
            &[
                (0, 20_000, working()),
                (20_000, 40_000, needs_you()),
                (40_000, 60_000, working()),
            ],
            60_000,
        );
        // About 29 dark phases of Calm alone, and Alarm's 2 a second for a third
        // of the time. Calm alone again at the end ends the same as it began.
        assert!((27..=31).contains(&alone), "{alone}");
        assert!(interrupted >= alone + 20, "{interrupted} against {alone}");
    }

    #[test]
    fn red_interrupts_yellow_and_yellow_comes_back() {
        let yellow_only = dark_phases(ALL_ON, &[(0, 60_000, waiting())], 60_000);
        let with_red = dark_phases(
            ALL_ON,
            &[
                (0, 20_000, waiting()),
                (20_000, 40_000, needs_you()),
                (40_000, 60_000, waiting()),
            ],
            60_000,
        );
        assert!(with_red > yellow_only * 3, "{with_red} against {yellow_only}");
    }

    #[test]
    fn alarm_is_the_sharpest_style_a_second_can_hold() {
        let flashes = |style: BlinkStyle| {
            let cycle: Duration = style.pattern().iter().map(|beat| beat.dark + beat.lit).sum();
            style.pattern().len() as f64 / cycle.as_secs_f64()
        };
        assert!(flashes(BlinkStyle::Alarm) > flashes(BlinkStyle::Fast));
        assert!(flashes(BlinkStyle::Alarm) > flashes(BlinkStyle::Heartbeat) * 2.0);
    }

    #[test]
    fn the_setting_reads_every_shape_it_has_had() {
        let read = |text: &str| BlinkStyles::read(&serde_json::from_str(text).unwrap());
        // The one style of the first version keeps meaning work, and brings the alerts.
        assert_eq!(
            read(r#""heartbeat""#),
            BlinkStyles {
                working: BlinkStyle::Heartbeat,
                waiting: BlinkStyle::Wink,
                needs_you: BlinkStyle::Alarm,
            }
        );
        assert_eq!(read(r#""off""#), BlinkStyles::default());
        assert_eq!(read(r#""strobe""#), BlinkStyles::default());
        assert_eq!(read("3"), BlinkStyles::default());
        assert_eq!(read("null"), BlinkStyles::default());
        // A bad style costs its own state, not the others.
        assert_eq!(
            read(r#"{"working":"calm","waiting":"strobe","needsYou":"alarm"}"#),
            BlinkStyles {
                working: BlinkStyle::Calm,
                waiting: BlinkStyle::Off,
                needs_you: BlinkStyle::Alarm,
            }
        );
        let saved = serde_json::to_value(ALL_ON).unwrap();
        assert_eq!(saved["needsYou"], "alarm");
        assert_eq!(BlinkStyles::read(&saved), ALL_ON);
    }

    #[test]
    fn nothing_but_work_asks_for_no_alerts() {
        assert!(!WORK.wants_alerts());
        assert!(ALL_ON.wants_alerts());
        assert!(!BlinkStyles::default().any());
        assert!(WORK.any());
    }

    #[test]
    fn a_watcher_with_nothing_to_watch_starts_nothing() {
        let mut watcher = Watcher::default();
        watcher.sync(None);
        assert!(watcher.current.is_none());
    }
}
