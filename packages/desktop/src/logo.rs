//! The lit Apple logo on the lid of a MacBook Pro with a PROLED XDR display
//! shows what the agents are doing, so you can read it across the room. One
//! rule: the more it moves, the more it needs you. It breathes while they work
//! (soft fades: busy, leave it), blinks for a yellow tab (an agent finished and
//! waits for you) and flashes for a red tab (it needs a permission or an
//! answer). One switch turns that on (View > Blink Apple Logo), and each state
//! can take another style under View > Apple Logo Blink Styles. The menu exists
//! only on a Mac that has such a logo.
//!
//! How it moves the logo is what LogoLight (github.com/Ark0N/LogoLight, MIT,
//! its `docs/corebrightnessd.md`) measured on that MacBook, reimplemented here.
//! `corebrightnessd` owns the LED, and `BrightnessSystemClient` in the private
//! CoreBrightness framework reaches it without an administrator. Writing
//! `DisplayLogicalState` 1 (Blank) fades the logo to dark and 2 (Unblank) back
//! to lit, over `LEPWMFactorFadeDuration` seconds, on the LED's own spring
//! curve. Nothing of that is saved anywhere, so unlike the first version of this
//! feature (which switched `LEBacklightMode`, a setting `corebrightnessd` keeps
//! in root's preferences) a blink writes no setting and nothing it does survives
//! a restart. `LEBacklightMode` is only read: a logo the user switched off
//! stays off.
//!
//! What the daemon does with those keys decides the shape of the code:
//! - A fade only starts on a change of direction, and the state cannot be read
//!   back (it reads the last value sent to anything). So the direction is
//!   tracked here, and when it is not known, the logo is first turned round
//!   with a fade so slow it never visibly moves.
//! - The keyboard backlight follows `DisplayLogicalState` too. After every Blank
//!   the keyboards alone are told Unblank, while the display is awake; when it
//!   sleeps they are told Blank, and Unblank again when it wakes.
//! - A rise from exactly dark waits for the display to show a frame, up to half
//!   a second with nothing changing on screen. A short dark beat (Alarm's,
//!   Heartbeat's) is therefore turned round while its fall is still under way,
//!   so the logo never quite reaches 0 and the rise is not held back. A long one
//!   (Calm's) goes all the way to dark, and its light is timed from when the
//!   rise really starts, so a held-back rise makes that dark beat longer and
//!   leaves the light as long as it should be.
//!
//! When several states hold at once the most urgent one with a style is shown:
//! red, then yellow, then work.
//!
//! All of this runs in a child process (this same binary with `BLINK_ARG`), for
//! as long as the switch is on and a server is open. The app hands it the
//! server and the login over a pipe (never on its command line, where `ps`
//! shows them) and keeps the pipe open. When the pipe closes, however the app
//! ended (quit, crash, `panic = "abort"`, Force Quit), the child puts the logo
//! back to normal (lit, with the daemon's automatic fade duration) and exits.
//! Switching it off closes the same pipe, so there is one way out and it is the
//! one a crash takes. A child that cannot finish (a SIGKILL) leaves a marker
//! file next to the app's settings, and the next launch puts the logo back;
//! until then it stays where the blink left it, or the display's next sleep and
//! wake relight it.
//!
//! The child also does the asking (`agents`), so it needs nothing from the app
//! once started: a hidden window, a stalled page and App Nap cannot hold up the
//! logo, and the app's event loop gets no timers for it.
//!
//! Another app driving the logo the same way (LogoLight itself) would fight
//! every fade, so while one runs the logo is left to it, as it is while the
//! user has it switched off: the child tries again once the agents go quiet.

use crate::agents::Activity;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

/// The argument that makes this binary the child instead of the app.
pub const BLINK_ARG: &str = "--logo-blink";

/// `LEBacklightMode`: the logo is dark in every lighting condition (Apple's
/// documented value). Only read, apart from undoing what the first version of
/// this feature could leave behind (`recover`).
const MODE_OFF: i64 = 0;
/// `LEBacklightMode`: the logo follows the display and the ambient light. What
/// the setting reads on a Mac where nobody touched it.
const MODE_AUTO: i64 = 2;

/// A fade duration so long that a fade started with it never visibly moves:
/// how the logo is stopped where it is, or turned round without moving.
const HOLD_SECONDS: f64 = 1e9;
/// How long a new fade takes to start moving. The daemon moves the logo in
/// frames of about 17.5 ms, and a new fade first moved 18 to 20 ms after the
/// write (LogoLight's measurements).
const START_LATENCY: Duration = Duration::from_millis(18);
/// The longest a rise from exactly dark waits for the display: the daemon's
/// display-ready gate gives up after 0.5 s.
const GATE_WAIT: Duration = Duration::from_millis(600);
/// How often the logo is looked at while a rise from dark waits for that gate.
const RISE_POLL: Duration = Duration::from_millis(10);
/// The fades of the hard styles: LogoLight's Heartbeat beats, which were seen
/// as beats on the real logo. A rise from dark looks about twice as fast as a
/// fall over the same time, so the rise is the shorter of the two.
const HARD_FALL: Duration = Duration::from_millis(180);
const HARD_RISE: Duration = Duration::from_millis(120);
/// A dark beat up to this long is a dip: it turns round before its fall ends.
const DIP_LIMIT: Duration = Duration::from_millis(350);
/// How much longer than its dark beat a dip's fall is set to take, so the rise
/// starts while the fall is still under way: about three of the daemon's
/// frames, more than a late sleep and the start latency together.
const DIP_OVERRUN: Duration = Duration::from_millis(60);
/// A fade level the logo counts as fully lit at.
const LIT: f64 = 0.999;

/// One dark moment and the light after it: the hard styles.
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

/// One move of the logo: fade toward lit or dark over `fade`, then wait `wait`
/// (counted from the write, or for a rise from dark, from when it moves) before
/// the next move.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Move {
    lit: bool,
    fade: Duration,
    wait: Duration,
}

const fn fade(lit: bool, fade_ms: u64, wait_ms: u64) -> Move {
    Move {
        lit,
        fade: Duration::from_millis(fade_ms),
        wait: Duration::from_millis(wait_ms),
    }
}

impl Beat {
    /// A hard beat as moves: a quick fall, and a quick rise after the dark time.
    /// A short dark time is a dip, whose fall is set to take longer than the dark
    /// time, so the rise turns it round before it reaches 0.
    fn moves(self) -> [Move; 2] {
        let fall = if self.dark <= DIP_LIMIT {
            (self.dark + DIP_OVERRUN).max(HARD_FALL)
        } else {
            HARD_FALL
        };
        [
            Move {
                lit: false,
                fade: fall,
                wait: self.dark,
            },
            Move {
                lit: true,
                fade: HARD_RISE,
                wait: self.lit,
            },
        ]
    }
}

/// How a style moves the logo.
enum Rhythm {
    /// Hard changes, made of quick fades.
    Hard(&'static [Beat]),
    /// Slow fades.
    Soft(&'static [Move]),
}

/// A rhythm for the logo, the user's pick in the styles menu for each `Signal`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlinkStyle {
    /// Nothing for this state; the next one down shows instead.
    #[default]
    Off,
    Breathe,
    Calm,
    Slow,
    Wink,
    Heartbeat,
    Fast,
    Alarm,
}

impl BlinkStyle {
    pub const ALL: [BlinkStyle; 8] = [
        BlinkStyle::Off,
        BlinkStyle::Breathe,
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
            BlinkStyle::Breathe => "Breathe",
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

    fn rhythm(self) -> Rhythm {
        match self {
            BlinkStyle::Off => Rhythm::Hard(&[]),
            BlinkStyle::Breathe => Rhythm::Soft(BREATHE),
            BlinkStyle::Calm => Rhythm::Hard(CALM),
            BlinkStyle::Slow => Rhythm::Hard(SLOW),
            BlinkStyle::Wink => Rhythm::Hard(WINK),
            BlinkStyle::Heartbeat => Rhythm::Hard(HEARTBEAT),
            BlinkStyle::Fast => Rhythm::Hard(FAST),
            BlinkStyle::Alarm => Rhythm::Hard(ALARM),
        }
    }

    /// The moves, repeated for as long as its state holds. Every cycle starts
    /// with a fall, and the moves alternate between falls and rises.
    fn moves(self) -> Vec<Move> {
        match self.rhythm() {
            Rhythm::Hard(beats) => beats.iter().flat_map(|beat| beat.moves()).collect(),
            Rhythm::Soft(moves) => moves.to_vec(),
        }
    }
}

/// What the logo can tell, in the order of the styles menu.
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

/// The switch and the style for each `Signal`: `logoBlink` in the settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BlinkStyles {
    /// The one switch. Off until the user turns it on: it moves a light the whole
    /// room sees.
    pub enabled: bool,
    pub working: BlinkStyle,
    pub waiting: BlinkStyle,
    pub needs_you: BlinkStyle,
}

impl Default for BlinkStyles {
    /// The switch off, and the styles it turns on: the more the logo moves, the
    /// more it needs you.
    fn default() -> Self {
        BlinkStyles {
            enabled: false,
            ..Self::RECOMMENDED
        }
    }
}

impl BlinkStyles {
    /// Soft while they work, a plain blink for yellow, three flashes for red.
    pub const RECOMMENDED: BlinkStyles = BlinkStyles {
        enabled: true,
        working: BlinkStyle::Breathe,
        waiting: BlinkStyle::Calm,
        needs_you: BlinkStyle::Alarm,
    };

    /// Reads whatever the file holds. A bad value is off, for its state alone: it
    /// must not make the file unreadable.
    ///
    /// Two older shapes are kept. Before the switch, a style per state was all
    /// there was, and any style but off meant on: such a file keeps its styles
    /// and its switch reads as on, unless all three are off, which was the old
    /// default and means it was never touched, so it gets the recommended styles
    /// with the switch off. Before the states, a single style was the choice for
    /// work, and whoever made it gets the alerts with it, since they asked for a
    /// logo that talks.
    pub fn read(value: &Value) -> Self {
        let style = |value: Option<&Value>| -> BlinkStyle {
            value
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default()
        };
        match value {
            Value::Object(saved) => {
                let recommended = Self::default();
                let pick = |key: &str, fallback: BlinkStyle| match saved.get(key) {
                    None => fallback,
                    some => style(some),
                };
                let styles = BlinkStyles {
                    enabled: false,
                    working: pick("working", recommended.working),
                    waiting: pick("waiting", recommended.waiting),
                    needs_you: pick("needsYou", recommended.needs_you),
                };
                match saved.get("enabled") {
                    Some(enabled) => BlinkStyles {
                        enabled: enabled.as_bool().unwrap_or(false),
                        ..styles
                    },
                    None if styles.any_style() => BlinkStyles {
                        enabled: true,
                        ..styles
                    },
                    None => recommended,
                }
            }
            Value::String(_) => match style(Some(value)) {
                BlinkStyle::Off => Self::default(),
                working => BlinkStyles {
                    enabled: true,
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

    /// Whether any state has a style, switch or not.
    pub fn any_style(self) -> bool {
        Signal::ALL.iter().any(|&signal| self.get(signal) != BlinkStyle::Off)
    }

    /// Whether the logo is to be watched at all: the switch is on and some state
    /// has a style.
    pub fn active(self) -> bool {
        self.enabled && self.any_style()
    }

    /// Whether anything but work has a style, which is what makes the alerts
    /// worth asking the server for.
    fn wants_alerts(self) -> bool {
        self.enabled && (self.waiting != BlinkStyle::Off || self.needs_you != BlinkStyle::Off)
    }

    /// What the logo should do: the most urgent state that holds and has a
    /// style. A state set to off is not a reason for silence, so it falls through.
    fn pick(self, activity: Activity) -> BlinkStyle {
        if !self.enabled {
            return BlinkStyle::Off;
        }
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

/// LogoLight's Breathe, like the old MacBook sleep light: a slow fall to dark, a
/// short rest, a slower rise and a short hold (fade + wait, in ms). A rise from
/// dark looks about twice as fast as a fall over the same time, so the rise is
/// the longer one.
const BREATHE: &[Move] = &[fade(false, 2000, 2500), fade(true, 3500, 3800)];
// The hard styles. No style goes above three flashes in any second, the limit
// accessibility guidelines set for flashing light, so what makes Alarm urgent is
// its shape: three hard flashes with a short rest, not a higher rate.
/// A plain blink, every two seconds: yellow's.
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
    /// `LEBacklightMode`, None if it could not be read.
    fn mode(&self) -> Option<i64>;
    /// Only to put back a logo the first version of this feature left switched off.
    fn set_mode(&self, mode: i64) -> bool;
    /// Where the logo is in a fade, from 0 (dark) to 1 (lit): `LEPWMState.Factor`.
    fn factor(&self) -> Option<f64>;
    /// `LEPWMFactorFadeDuration`, in seconds, for the next fade; 0 is the
    /// daemon's automatic one. False if the daemon did not take it.
    fn set_fade_duration(&self, seconds: f64) -> bool;
    /// `DisplayLogicalState`: fade toward lit (Unblank) or dark (Blank). Ignored
    /// by the daemon when it already heads that way.
    fn set_heading(&self, lit: bool) -> bool;
    /// The same key, sent to the keyboard backlights only.
    fn set_keyboards_lit(&self, lit: bool);
    /// The built-in display is on: the lid is open and the display awake.
    fn display_awake(&self) -> bool;
    /// Another app drives the logo the same way.
    fn driven_elsewhere(&self) -> bool;
}

/// Moves the logo, and keeps what cannot be read back: which way it heads, and
/// what the keyboards were last told.
struct Fader<'a, L: Logo> {
    logo: &'a L,
    /// Which way the logo was last told to fade (true is toward lit), or None
    /// when that is not known: at the start, and once the display slept (the
    /// daemon changes the state itself then).
    heading: Option<bool>,
    /// What the keyboards were last told, if anything.
    keyboards: Option<bool>,
    /// Anything was written.
    touched: bool,
    /// Every write was taken.
    ok: bool,
}

impl<'a, L: Logo> Fader<'a, L> {
    fn new(logo: &'a L) -> Self {
        Fader {
            logo,
            heading: None,
            keyboards: None,
            touched: false,
            ok: true,
        }
    }

    fn duration(&mut self, seconds: f64) {
        self.touched = true;
        self.ok &= self.logo.set_fade_duration(seconds);
    }

    /// The keyboards would darken with the logo, so after a Blank they alone are
    /// told the display is still on, which they take without a visible change.
    /// Never while the display sleeps: that would light the keyboard of a
    /// sleeping Mac.
    fn heading(&mut self, lit: bool, awake: bool) {
        self.touched = true;
        self.ok &= self.logo.set_heading(lit);
        self.heading = Some(lit);
        if !lit && awake {
            self.keyboards(true);
        }
    }

    fn keyboards(&mut self, lit: bool) {
        self.logo.set_keyboards_lit(lit);
        self.keyboards = Some(lit);
    }

    /// Starts a fade the other way that is too slow to see. It stops the logo
    /// where it is, and makes heading `toward` a change, which a fade needs.
    fn turn_round(&mut self, toward: bool, awake: bool) {
        self.duration(HOLD_SECONDS);
        self.heading(!toward, awake);
    }

    /// Fade toward lit or dark over `time`.
    fn fade(&mut self, lit: bool, time: Duration, awake: bool) {
        if self.heading != Some(!lit) {
            self.turn_round(lit, awake);
        }
        self.duration(time.as_secs_f64());
        self.heading(lit, awake);
    }

    /// The display went to sleep: the daemon now moves the logo itself, with the
    /// automatic duration rather than the last one written here (LogoLight does
    /// the same), and the keyboards follow the display again.
    fn display_slept(&mut self) {
        self.heading = None;
        if self.touched {
            self.duration(0.0);
        }
        if self.keyboards == Some(true) {
            self.keyboards(false);
        }
    }

    fn display_woke(&mut self) {
        if self.keyboards == Some(false) {
            self.keyboards(true);
        }
    }

    /// Back to normal: fully lit (when the display is on), with the automatic
    /// fade duration. True once that is done; false while the display sleeps or
    /// a write was refused, which keeps the marker for another try.
    fn restore(&mut self) -> bool {
        if !self.touched && self.keyboards.is_none() {
            return true;
        }
        let awake = self.logo.display_awake();
        // A fade toward lit may be a held one, or still under way at its own
        // duration: turn it round without moving, so relighting is a change.
        if self.heading != Some(false) && self.logo.factor().unwrap_or(1.0) < LIT {
            self.turn_round(true, awake);
        }
        self.duration(0.0);
        if awake {
            self.heading(true, awake);
        }
        self.ok && awake
    }
}

/// The file that says a blink may have left the logo dark.
pub struct Marker(Option<PathBuf>);

impl Marker {
    fn named(name: &str) -> Self {
        Marker(dirs::config_dir().map(|d| d.join("Codeman").join(name)))
    }

    fn default_location() -> Self {
        Self::named("logo-fade")
    }

    /// The first version's marker, which meant the logo may have been left
    /// switched off.
    fn legacy_location() -> Self {
        Self::named("logo-blink")
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
    /// `wait` said stop, and the logo is back to normal.
    Stopped,
    /// The logo is not ours to blink, or stopped doing what it is told.
    Declined,
}

/// Move the logo through `moves`, over and over, until `wait` reports that it is
/// time to stop, then put it back to normal. `wait` sleeps for the given time and
/// answers true if the blink should end. A marker that cannot be written refuses
/// the blink: without it a child killed in a dark phase would have no way back.
fn blink(logo: &impl Logo, marker: &Marker, moves: &[Move], mut wait: impl FnMut(Duration) -> bool) -> Ended {
    if moves.is_empty() || logo.mode() != Some(MODE_AUTO) || logo.driven_elsewhere() || !marker.set() {
        return Ended::Declined;
    }
    let mut fader = Fader::new(logo);
    let mut ended = Ended::Stopped;
    let mut asleep = false;
    let mut next = 0;
    'blink: loop {
        let step = moves[next % moves.len()];
        let awake = logo.display_awake();
        // Every cycle starts with a fall: the moment to check that the logo is
        // still the agents' and can be seen.
        if !step.lit {
            if logo.mode() != Some(MODE_AUTO) || logo.driven_elsewhere() {
                ended = Ended::Declined;
                break;
            }
            if !awake {
                if !asleep {
                    fader.display_slept();
                    asleep = true;
                }
                if wait(NOT_LIT_RECHECK) {
                    break;
                }
                continue;
            }
            if asleep {
                fader.display_woke();
                asleep = false;
            }
        }
        let from_dark = step.lit && logo.factor().is_some_and(|factor| factor <= 0.0);
        fader.fade(step.lit, step.fade, awake);
        if !fader.ok {
            ended = Ended::Declined;
            break;
        }
        let mut left = step.wait;
        if from_dark {
            // Held back until the display shows a frame: time the light from when
            // it moves, so a held-back rise lengthens the dark, not shortens the light.
            let mut waited = Duration::ZERO;
            while waited < GATE_WAIT && logo.factor().is_some_and(|factor| factor <= 0.0) {
                if wait(RISE_POLL) {
                    break 'blink;
                }
                waited += RISE_POLL;
            }
            left = left.saturating_sub(START_LATENCY);
        }
        if wait(left) {
            break;
        }
        next += 1;
    }
    if fader.restore() {
        marker.clear();
    }
    ended
}

/// Put back a logo that a blink could not finish with.
pub fn recover(logo: &impl Logo, marker: &Marker, legacy: &Marker) {
    // The first version blinked by switching the setting off, so with its marker
    // a logo switched off is its doing.
    if legacy.is_set() && (logo.mode() != Some(MODE_OFF) || logo.set_mode(MODE_AUTO)) {
        legacy.clear();
    }
    if marker.is_set() {
        let mut fader = Fader::new(logo);
        // Which way it heads is not known: `restore` turns it round first.
        fader.touched = true;
        if fader.restore() {
            marker.clear();
        }
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
/// change of state ends the blink that is running, which puts the logo back to
/// normal, and the next look starts the new one.
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
        let ended = blink(logo, marker, &style.moves(), |time| {
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
    /// back to normal well before the next child looks, which takes `SETTLE`.
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
pub use system::{available, blink_main, driven_elsewhere, recover_at_launch, switched_off};

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

#[cfg(not(target_os = "macos"))]
pub fn driven_elsewhere() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod system {
    use super::{recover, watch, Connection, Logo, Marker, Signals, MODE_OFF};
    use crate::agents::{Activity, Poll, Poller, POLL_EVERY};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    use objc2_foundation::{ns_string, NSBundle, NSDictionary, NSNumber, NSString};
    use std::io::Read;
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use url::Url;

    /// The process name of the other app that drives the logo this way.
    const LOGOLIGHT: &[u8] = b"LogoLight";

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetOnlineDisplayList(max_displays: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayIsBuiltin(display: u32) -> u32;
        fn CGDisplayIsAsleep(display: u32) -> u32;
    }

    struct SystemLogo {
        client: Retained<AnyObject>,
        /// The keyboard backlights, for telling them apart from the logo. Empty if
        /// this macOS has no way to: the keyboard then dims with each dark beat.
        keyboards: Vec<u64>,
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
                let keyboards = if class.instance_method(sel!(setProperty:withKey:keyboardID:)).is_some() {
                    keyboard_ids()
                } else {
                    Vec::new()
                };
                client.map(|client| SystemLogo { client, keyboards })
            })
        }

        fn property(&self, key: &NSString) -> Option<Retained<AnyObject>> {
            // SAFETY: the method was checked in `open`. It takes a string and
            // answers an owned object or nil.
            unsafe { msg_send![&*self.client, copyPropertyForKey: key] }
        }

        fn set(&self, value: &NSNumber, key: &NSString) -> bool {
            // SAFETY: the method was checked in `open`. It takes an object and a
            // string and answers a BOOL, which says the message was delivered.
            unsafe { msg_send![&*self.client, setProperty: value, forKey: key] }
        }

        /// A number in `LEPWMState`.
        fn pwm(&self, key: &NSString) -> Option<f64> {
            let state = self.property(ns_string!("LEPWMState"))?;
            let state = state.downcast_ref::<NSDictionary>()?;
            // SAFETY: an NSDictionary answers objectForKey:, with nil for a key it
            // does not have.
            let value: Option<Retained<AnyObject>> = unsafe { msg_send![state, objectForKey: key] };
            Some(value?.downcast_ref::<NSNumber>()?.as_f64())
        }
    }

    /// The IDs of the keyboard backlights, from CoreBrightness's own client for them.
    fn keyboard_ids() -> Vec<u64> {
        let Some(class) = AnyClass::get(c"KeyboardBrightnessClient") else {
            return Vec::new();
        };
        if class.instance_method(sel!(copyKeyboardBacklightIDs)).is_none() {
            return Vec::new();
        }
        // SAFETY: `new` is NSObject's, and the class was checked above.
        let Some(client): Option<Retained<AnyObject>> = (unsafe { msg_send![class, new] }) else {
            return Vec::new();
        };
        // SAFETY: checked above; a "copy" method, so it answers an owned array or nil.
        let Some(ids): Option<Retained<AnyObject>> = (unsafe { msg_send![&*client, copyKeyboardBacklightIDs] }) else {
            return Vec::new();
        };
        // SAFETY: an array answers count and objectAtIndex: below its count; it is
        // checked to be one first.
        let is_array: Bool = unsafe { msg_send![&*ids, isKindOfClass: AnyClass::get(c"NSArray")] };
        if !is_array.as_bool() {
            return Vec::new();
        }
        let count: usize = unsafe { msg_send![&*ids, count] };
        (0..count)
            .filter_map(|i| {
                let id: Option<Retained<AnyObject>> = unsafe { msg_send![&*ids, objectAtIndex: i] };
                Some(id?.downcast_ref::<NSNumber>()?.as_u64())
            })
            .collect()
    }

    impl Logo for SystemLogo {
        fn mode(&self) -> Option<i64> {
            autoreleasepool(|_| {
                let value = self.property(ns_string!("LEBacklightMode"))?;
                Some(value.downcast_ref::<NSNumber>()?.as_i64())
            })
        }

        fn set_mode(&self, mode: i64) -> bool {
            autoreleasepool(|_| self.set(&NSNumber::new_i64(mode), ns_string!("LEBacklightMode")))
        }

        fn factor(&self) -> Option<f64> {
            autoreleasepool(|_| self.pwm(ns_string!("Factor")))
        }

        fn set_fade_duration(&self, seconds: f64) -> bool {
            autoreleasepool(|_| {
                self.set(
                    &NSNumber::new_f64(seconds.max(0.0)),
                    ns_string!("LEPWMFactorFadeDuration"),
                )
            })
        }

        fn set_heading(&self, lit: bool) -> bool {
            autoreleasepool(|_| {
                self.set(
                    &NSNumber::new_i64(if lit { 2 } else { 1 }),
                    ns_string!("DisplayLogicalState"),
                )
            })
        }

        fn set_keyboards_lit(&self, lit: bool) {
            autoreleasepool(|_| {
                let value = NSNumber::new_i64(if lit { 2 } else { 1 });
                for &id in &self.keyboards {
                    // SAFETY: the method was checked in `open`. It takes an object,
                    // a string and a 64-bit keyboard ID and answers a BOOL.
                    let _: bool = unsafe {
                        msg_send![&*self.client, setProperty: &*value, withKey: ns_string!("DisplayLogicalState"), keyboardID: id]
                    };
                }
            })
        }

        fn display_awake(&self) -> bool {
            built_in_display_awake()
        }

        fn driven_elsewhere(&self) -> bool {
            driven_elsewhere()
        }
    }

    /// Whether the built-in display is on. A closed lid takes it off the list.
    /// If the list cannot be had, the answer is yes: the logo is then blinked as
    /// before there was a check.
    fn built_in_display_awake() -> bool {
        let mut displays = [0u32; 16];
        let mut count = 0u32;
        // SAFETY: the buffer holds 16 IDs and the call is told so.
        if unsafe { CGGetOnlineDisplayList(16, displays.as_mut_ptr(), &mut count) } != 0 {
            return true;
        }
        let online = &displays[..(count as usize).min(displays.len())];
        // SAFETY: both take any display ID and answer a boolean.
        online
            .iter()
            .find(|&&display| unsafe { CGDisplayIsBuiltin(display) } != 0)
            .is_some_and(|&display| unsafe { CGDisplayIsAsleep(display) } == 0)
    }

    /// Whether LogoLight runs, which drives the logo with the same fades.
    pub fn driven_elsewhere() -> bool {
        running(LOGOLIGHT)
    }

    /// Whether a process of this name runs (the name the kernel keeps, at most
    /// 32 bytes, which LogoLight's is well inside).
    fn running(wanted: &[u8]) -> bool {
        // SAFETY: with no buffer it answers how many processes there are.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return false;
        }
        let mut pids = vec![0 as libc::pid_t; count as usize + 32];
        let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        // SAFETY: the buffer is `bytes` long, and the answer is how many it filled.
        let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        pids.truncate(filled.max(0) as usize);
        pids.iter().any(|&pid| {
            let mut name = [0u8; 64];
            // SAFETY: the buffer is 64 bytes, and the answer is the name's length.
            let len = unsafe { libc::proc_name(pid, name.as_mut_ptr().cast(), name.len() as u32) };
            len > 0 && name.get(..len as usize) == Some(wanted)
        })
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
        let (marker, legacy) = (Marker::default_location(), Marker::legacy_location());
        if marker.is_set() || legacy.is_set() {
            if let Some(logo) = SystemLogo::open() {
                recover(&logo, &marker, &legacy);
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

    #[cfg(test)]
    mod probe {
        use super::*;

        /// Reads what a blink goes by on this Mac, and writes nothing:
        /// `cargo test --locked what_this_mac_answers -- --ignored --nocapture`.
        #[test]
        #[ignore = "reads this Mac's displays, processes and logo: see the comment"]
        fn what_this_mac_answers() {
            println!("logo available: {}", available());
            println!("built-in display awake: {}", built_in_display_awake());
            println!("driven elsewhere: {}", driven_elsewhere());
            println!("finds the shell that ran this (bash): {}", running(b"bash"));
            println!("keyboard backlight IDs: {:?}", keyboard_ids());
            match SystemLogo::open() {
                Some(logo) => println!(
                    "mode {:?}, factor {:?}, keyboards the client can reach {:?}",
                    logo.mode(),
                    logo.factor(),
                    logo.keyboards
                ),
                None => println!("no BrightnessSystemClient"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    /// The daemon moves the logo in frames about this far apart.
    const FRAME: f64 = 0.0175;
    /// A new fade first moves this long after the write.
    const LATENCY: Duration = Duration::from_millis(19);
    /// The daemon's automatic fade duration.
    const AUTOMATIC: f64 = 0.3;

    /// The style most of these tests watch with: work only, in Calm.
    const WORK: BlinkStyles = BlinkStyles {
        enabled: true,
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

    /// The critically damped spring LogoLight fitted to the logo's fades.
    fn spring(s: f64) -> f64 {
        let k = 6.51;
        if s <= 0.0 {
            0.0
        } else {
            1.0 - (1.0 + k * s) * (-k * s).exp()
        }
    }

    #[derive(Debug, Clone, Copy, PartialEq)]
    enum W {
        Mode(i64),
        Duration(f64),
        Heading(bool),
        Keyboards(bool),
    }

    #[derive(Debug, Clone, Copy)]
    struct Fade {
        from: f64,
        to: f64,
        start: Duration,
        length: f64,
    }

    /// A `corebrightnessd` that moves like the real one: in frames, on the spring,
    /// starting a little after the write, only on a change of direction, and with
    /// a rise from exactly dark held back by `gate`. Asleep, the logo is dark.
    struct FakeLogo {
        now: Rc<Cell<Duration>>,
        mode: Cell<i64>,
        awake: Cell<bool>,
        elsewhere: Cell<bool>,
        gate: Cell<Duration>,
        refuse_writes: Cell<bool>,
        lit: Cell<bool>,
        duration: Cell<f64>,
        fade: Cell<Fade>,
        writes: RefCell<Vec<(Duration, W)>>,
        /// The level each rise left from, and whether the display was awake.
        rises_from: RefCell<Vec<f64>>,
    }

    impl FakeLogo {
        fn new(mode: i64) -> Self {
            FakeLogo {
                now: Rc::new(Cell::new(Duration::ZERO)),
                mode: Cell::new(mode),
                awake: Cell::new(true),
                elsewhere: Cell::new(false),
                gate: Cell::new(Duration::ZERO),
                refuse_writes: Cell::new(false),
                lit: Cell::new(true),
                duration: Cell::new(0.0),
                fade: Cell::new(Fade {
                    from: 1.0,
                    to: 1.0,
                    start: Duration::ZERO,
                    length: AUTOMATIC,
                }),
                writes: RefCell::new(Vec::new()),
                rises_from: RefCell::new(Vec::new()),
            }
        }

        fn advance(&self, time: Duration) {
            self.now.set(self.now.get() + time);
        }

        fn level_at(&self, at: Duration) -> f64 {
            let fade = self.fade.get();
            if at <= fade.start {
                return fade.from;
            }
            let moved = ((at - fade.start).as_secs_f64() / FRAME).floor() * FRAME;
            let s = moved / fade.length;
            if s >= 1.0 {
                fade.to
            } else {
                fade.from + (fade.to - fade.from) * spring(s)
            }
        }

        fn level(&self) -> f64 {
            self.level_at(self.now.get())
        }

        fn writes(&self) -> Vec<W> {
            self.writes.borrow().iter().map(|&(_, w)| w).collect()
        }

        fn record(&self, w: W) {
            self.writes.borrow_mut().push((self.now.get(), w));
        }

        /// The falls a blink made: Blanks written with a duration that moves.
        fn falls(&self) -> usize {
            let mut duration = 0.0;
            let mut falls = 0;
            for w in self.writes() {
                match w {
                    W::Duration(d) => duration = d,
                    W::Heading(false) if duration < HOLD_SECONDS => falls += 1,
                    _ => {}
                }
            }
            falls
        }

        /// The last fade duration written, if any.
        fn last_duration(&self) -> Option<f64> {
            self.writes().iter().rev().find_map(|w| match w {
                W::Duration(d) => Some(*d),
                _ => None,
            })
        }

        /// Where the logo settles once every fade has run.
        fn settled_level(&self) -> f64 {
            self.level_at(self.now.get() + Duration::from_secs(10))
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
            self.record(W::Mode(mode));
            self.mode.set(mode);
            true
        }

        fn factor(&self) -> Option<f64> {
            Some(if self.awake.get() && self.mode.get() == MODE_AUTO {
                self.level()
            } else {
                0.0
            })
        }

        fn set_fade_duration(&self, seconds: f64) -> bool {
            if self.refuse_writes.get() {
                return false;
            }
            self.record(W::Duration(seconds));
            self.duration.set(seconds);
            true
        }

        fn set_heading(&self, lit: bool) -> bool {
            if self.refuse_writes.get() {
                return false;
            }
            self.record(W::Heading(lit));
            if lit == self.lit.get() {
                return true;
            }
            let now = self.now.get();
            let from = self.level();
            let mut start = now + LATENCY;
            if lit {
                self.rises_from.borrow_mut().push(from);
                if from <= 0.0 {
                    start += self.gate.get();
                }
            }
            let length = match self.duration.get() {
                d if d <= 0.0 => AUTOMATIC,
                d => d,
            };
            self.fade.set(Fade {
                from,
                to: if lit { 1.0 } else { 0.0 },
                start,
                length,
            });
            self.lit.set(lit);
            true
        }

        fn set_keyboards_lit(&self, lit: bool) {
            assert!(
                self.awake.get() || !lit,
                "a keyboard told to light while the display sleeps"
            );
            self.record(W::Keyboards(lit));
        }

        fn display_awake(&self) -> bool {
            self.awake.get()
        }

        fn driven_elsewhere(&self) -> bool {
            self.elsewhere.get()
        }
    }

    fn temp_marker(name: &str) -> (Marker, PathBuf) {
        let dir = std::env::temp_dir().join(format!("codeman-logo-{}-{name}", std::process::id()));
        let path = dir.join("nested").join("logo-fade");
        let _ = std::fs::remove_dir_all(&dir);
        (Marker(Some(path.clone())), path)
    }

    /// Blink `style` until `stop_at` on the fake's clock, calling `meanwhile` at
    /// every wait with the time.
    fn run_until(
        logo: &FakeLogo,
        marker: &Marker,
        style: BlinkStyle,
        stop_at: Duration,
        mut meanwhile: impl FnMut(&FakeLogo, Duration),
    ) -> Ended {
        blink(logo, marker, &style.moves(), |time| {
            logo.advance(time);
            meanwhile(logo, logo.now.get());
            logo.now.get() >= stop_at
        })
    }

    fn run(logo: &FakeLogo, marker: &Marker, style: BlinkStyle, stop_at: Duration) -> Ended {
        run_until(logo, marker, style, stop_at, |_, _| {})
    }

    const fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn breathe_fades_out_and_back_in_and_ends_lit() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("breathe");
        let mut lowest = 1.0_f64;
        let mut highest_while_dark = 0.0_f64;
        run_until(&logo, &marker, BlinkStyle::Breathe, secs(20), |logo, now| {
            lowest = lowest.min(logo.level());
            // The rest in the first cycle, between the fall (2 s) and the rise (2.5 s).
            if now > Duration::from_millis(2_100) && now < Duration::from_millis(2_450) {
                highest_while_dark = highest_while_dark.max(logo.level());
            }
        });
        assert_eq!(lowest, 0.0, "a breath goes all the way to dark");
        assert_eq!(highest_while_dark, 0.0);
        let writes = logo.writes();
        // Heading unknown at the start: turned round first, without moving.
        assert_eq!(writes[..2], [W::Duration(HOLD_SECONDS), W::Heading(true)]);
        assert_eq!(writes[2..5], [W::Duration(2.0), W::Heading(false), W::Keyboards(true)]);
        assert_eq!(writes[5..7], [W::Duration(3.5), W::Heading(true)]);
        assert_eq!(logo.falls(), 4, "about 6.3 s a breath");
        assert_eq!(logo.last_duration(), Some(0.0), "it ends on the automatic duration");
        assert_eq!(logo.settled_level(), 1.0);
        assert!(!path.exists(), "a finished blink leaves no marker");
    }

    #[test]
    fn short_dark_beats_turn_round_before_the_logo_is_dark() {
        for style in [
            BlinkStyle::Alarm,
            BlinkStyle::Heartbeat,
            BlinkStyle::Wink,
            BlinkStyle::Fast,
        ] {
            let logo = FakeLogo::new(MODE_AUTO);
            // A rise from exactly dark would wait this long: none may.
            logo.gate.set(Duration::from_millis(500));
            let (marker, _) = temp_marker("dips");
            let mut lowest = 1.0_f64;
            run_until(&logo, &marker, style, secs(12), |logo, _| {
                lowest = lowest.min(logo.level())
            });
            let rises = logo.rises_from.borrow().clone();
            assert!(rises.len() >= 3, "{style:?}");
            for from in &rises[..rises.len() - 1] {
                assert!(*from > 0.0, "{style:?} rose from exactly dark");
                assert!(*from < 0.2, "{style:?} dips only to {from}");
            }
            assert!(lowest < 0.2, "{style:?}");
        }
    }

    #[test]
    fn a_long_dark_beat_times_its_light_from_when_the_rise_starts() {
        let logo = FakeLogo::new(MODE_AUTO);
        let gate = Duration::from_millis(400);
        logo.gate.set(gate);
        let (marker, _) = temp_marker("gated");
        run(&logo, &marker, BlinkStyle::Calm, secs(30));
        let writes = logo.writes.borrow().clone();
        let falls: Vec<Duration> = writes
            .windows(2)
            .filter(|pair| matches!(pair[0].1, W::Duration(d) if d < HOLD_SECONDS) && pair[1].1 == W::Heading(false))
            .map(|pair| pair[1].0)
            .collect();
        let rises: Vec<Duration> = writes
            .windows(2)
            .filter(|pair| {
                matches!(pair[0].1, W::Duration(d) if d < HOLD_SECONDS && d > 0.0) && pair[1].1 == W::Heading(true)
            })
            .map(|pair| pair[1].0)
            .collect();
        assert!(falls.len() >= 10, "{}", falls.len());
        for (rise, next_fall) in rises.iter().zip(falls.iter().skip(1)) {
            // Lit for Calm's 1.2 s from when it moved: the gate, the latency and a
            // poll's worth of slack after the write.
            let lit = *next_fall - *rise;
            let expected = CALM[0].lit + gate + LATENCY;
            assert!(
                lit + RISE_POLL >= expected && lit <= expected + RISE_POLL * 2,
                "{lit:?}"
            );
        }
        for (fall, rise) in falls.iter().zip(rises.iter()) {
            assert_eq!(*rise - *fall, CALM[0].dark, "the dark beat is written as long as it is");
        }
    }

    #[test]
    fn every_blank_is_followed_by_the_keyboards_told_to_stay_lit() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("keyboards");
        run(&logo, &marker, BlinkStyle::Alarm, secs(6));
        let writes = logo.writes();
        for (i, w) in writes.iter().enumerate() {
            if *w == W::Heading(false) {
                assert_eq!(writes.get(i + 1), Some(&W::Keyboards(true)), "after write {i}");
            }
        }
    }

    #[test]
    fn the_keyboards_follow_the_display_to_sleep_and_back() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("sleep");
        let mut writes_while_asleep = None;
        run_until(&logo, &marker, BlinkStyle::Calm, secs(30), |logo, now| {
            logo.awake.set(!(secs(8)..secs(16)).contains(&now));
            if now >= secs(10) && writes_while_asleep.is_none() {
                writes_while_asleep = Some(logo.writes().len());
            }
            if now >= secs(15) && now < secs(16) {
                assert_eq!(
                    Some(logo.writes().len()),
                    writes_while_asleep,
                    "nothing written while asleep"
                );
            }
        });
        let writes = logo.writes();
        let slept = writes
            .iter()
            .position(|w| *w == W::Keyboards(false))
            .expect("told to sleep");
        assert_eq!(
            writes[slept - 1],
            W::Duration(0.0),
            "the daemon's own sleep and wake get the automatic duration"
        );
        assert_eq!(
            writes.iter().filter(|w| **w == W::Keyboards(false)).count(),
            1,
            "once, when it slept"
        );
        let woke = writes[slept..]
            .iter()
            .position(|w| *w == W::Keyboards(true))
            .expect("told to wake");
        assert!(
            writes[slept + woke..].contains(&W::Heading(false)),
            "it blinks again after the wake"
        );
        assert_eq!(logo.last_duration(), Some(0.0));
        assert_eq!(logo.settled_level(), 1.0);
        assert!(!path.exists());
    }

    #[test]
    fn every_end_puts_the_logo_back_to_normal() {
        for style in BlinkStyle::ALL.into_iter().filter(|&s| s != BlinkStyle::Off) {
            for stop_ms in [50, 150, 700, 1_300, 2_200, 4_000, 6_100] {
                let logo = FakeLogo::new(MODE_AUTO);
                logo.gate.set(Duration::from_millis(300));
                let (marker, path) = temp_marker("ends");
                run(&logo, &marker, style, Duration::from_millis(stop_ms));
                assert_eq!(logo.last_duration(), Some(0.0), "{style:?} at {stop_ms} ms");
                assert_eq!(
                    logo.writes().last(),
                    Some(&W::Heading(true)),
                    "{style:?} at {stop_ms} ms"
                );
                assert_eq!(logo.settled_level(), 1.0, "{style:?} at {stop_ms} ms");
                assert!(!path.exists());
            }
        }
    }

    #[test]
    fn a_logo_the_user_switched_off_is_left_alone() {
        for mode in [MODE_OFF, 1, 7] {
            let logo = FakeLogo::new(mode);
            let (marker, path) = temp_marker("user-off");
            let mut waits = 0;
            let ended = blink(&logo, &marker, &BlinkStyle::Calm.moves(), |_| {
                waits += 1;
                true
            });
            assert_eq!(ended, Ended::Declined);
            assert_eq!(logo.writes(), []);
            assert_eq!(waits, 0, "it does not even wait");
            assert!(!path.exists());
        }
    }

    #[test]
    fn another_app_driving_the_logo_is_left_alone() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.elsewhere.set(true);
        let (marker, path) = temp_marker("elsewhere");
        assert_eq!(run(&logo, &marker, BlinkStyle::Calm, secs(5)), Ended::Declined);
        assert_eq!(logo.writes(), []);
        assert!(!path.exists());

        // One that starts during a blink ends it at the next cycle, put back.
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("elsewhere-later");
        let ended = run_until(&logo, &marker, BlinkStyle::Calm, secs(60), |logo, now| {
            logo.elsewhere.set(now >= secs(5));
        });
        assert_eq!(ended, Ended::Declined);
        assert!(logo
            .writes
            .borrow()
            .iter()
            .all(|&(at, w)| at < secs(7) || !matches!(w, W::Heading(false))));
        assert_eq!(logo.last_duration(), Some(0.0));
        assert!(!path.exists());
    }

    #[test]
    fn a_logo_switched_off_during_a_blink_stays_off() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("off-during");
        let ended = run_until(&logo, &marker, BlinkStyle::Calm, secs(60), |logo, now| {
            if now >= secs(5) {
                logo.mode.set(MODE_OFF);
            }
        });
        assert_eq!(ended, Ended::Declined);
        assert!(
            !logo.writes().iter().any(|w| matches!(w, W::Mode(_))),
            "the setting is never written"
        );
        assert_eq!(logo.mode.get(), MODE_OFF);
        assert!(!path.exists());
    }

    #[test]
    fn a_marker_that_cannot_be_written_refuses_the_blink() {
        let logo = FakeLogo::new(MODE_AUTO);
        assert_eq!(run(&logo, &Marker(None), BlinkStyle::Calm, secs(5)), Ended::Declined);
        assert_eq!(logo.writes(), []);
    }

    #[test]
    fn nothing_is_written_while_the_logo_cannot_be_seen() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.awake.set(false);
        let (marker, path) = temp_marker("not-lit");
        let mut waits = Vec::new();
        blink(&logo, &marker, &BlinkStyle::Calm.moves(), |time| {
            waits.push(time);
            waits.len() >= 3
        });
        assert_eq!(logo.writes(), []);
        assert_eq!(waits, [NOT_LIT_RECHECK; 3]);
        assert!(!path.exists());
    }

    #[test]
    fn a_refused_write_ends_the_blink_and_keeps_the_marker() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("refused");
        let ended = run_until(&logo, &marker, BlinkStyle::Calm, secs(60), |logo, now| {
            logo.refuse_writes.set(now >= secs(3));
        });
        assert_eq!(ended, Ended::Declined);
        assert!(path.exists(), "the next launch tries again");
        logo.refuse_writes.set(false);
        recover(&logo, &marker, &Marker(None));
        assert_eq!(logo.last_duration(), Some(0.0));
        assert_eq!(logo.settled_level(), 1.0);
        assert!(!path.exists());
    }

    #[test]
    fn recover_puts_back_a_logo_a_killed_child_left_dark() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("killed");
        // A blink stopped mid-fall without putting anything back: the child was killed.
        assert!(marker.set());
        assert!(logo.set_fade_duration(0.18) && logo.set_heading(false));
        logo.advance(secs(1));
        assert_eq!(logo.level(), 0.0);
        recover(&logo, &marker, &Marker(None));
        assert_eq!(logo.last_duration(), Some(0.0));
        assert_eq!(logo.settled_level(), 1.0);
        assert!(!path.exists());
    }

    #[test]
    fn recover_needs_a_marker() {
        let logo = FakeLogo::new(MODE_OFF);
        let (marker, _) = temp_marker("no-marker");
        let (legacy, _) = temp_marker("no-legacy");
        recover(&logo, &marker, &legacy);
        assert_eq!(logo.writes(), [], "without a marker a dark logo is the user's");
    }

    #[test]
    fn recover_switches_back_on_a_logo_the_first_version_left_off() {
        let logo = FakeLogo::new(MODE_OFF);
        let (marker, _) = temp_marker("legacy-new");
        let (legacy, legacy_path) = temp_marker("legacy");
        assert!(legacy.set());
        recover(&logo, &marker, &legacy);
        assert_eq!(logo.writes(), [W::Mode(MODE_AUTO)]);
        assert!(!legacy_path.exists());

        // A lit logo with that marker only loses the marker.
        let logo = FakeLogo::new(MODE_AUTO);
        assert!(legacy.set());
        recover(&logo, &marker, &legacy);
        assert_eq!(logo.writes(), []);
        assert!(!legacy_path.exists());
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

    /// A server that shows the given activity in the given spans of time, on the
    /// fake logo's clock. The app goes away at `app_gone_at`.
    struct Script {
        start: Instant,
        now: Rc<Cell<Duration>>,
        spans: Vec<(u64, u64, Activity)>,
        app_gone_at: u64,
    }

    impl Script {
        fn new(logo: &FakeLogo, work: &[(u64, u64)], app_gone_at: u64) -> Self {
            let spans: Vec<_> = work.iter().map(|&(from, to)| (from, to, working())).collect();
            Self::with(logo, &spans, app_gone_at)
        }

        fn with(logo: &FakeLogo, spans: &[(u64, u64, Activity)], app_gone_at: u64) -> Self {
            Script {
                start: Instant::now(),
                now: logo.now.clone(),
                spans: spans.to_vec(),
                app_gone_at,
            }
        }

        fn elapsed_ms(&self) -> u64 {
            self.now.get().as_millis() as u64
        }
    }

    impl Signals for Script {
        fn wait(&mut self, time: Duration) -> bool {
            self.now.set(self.now.get() + time);
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
            self.start + self.now.get()
        }
    }

    const CYCLE_MS: u64 = (CALM[0].lit.as_millis() + CALM[0].dark.as_millis()) as u64;

    #[test]
    fn nothing_is_written_while_no_agent_works() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-quiet");
        let mut script = Script::new(&logo, &[], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.writes(), []);
    }

    #[test]
    fn a_short_flicker_of_work_does_not_blink() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-flicker");
        let mut script = Script::new(&logo, &[(1_000, 2_500)], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.writes(), []);
    }

    #[test]
    fn the_switch_off_shows_nothing_whatever_the_styles() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-switch-off");
        let styles = BlinkStyles { enabled: false, ..WORK };
        let mut script = Script::new(&logo, &[(0, 30_000)], 40_000);
        watch(&logo, &marker, styles, &mut script);
        assert_eq!(logo.writes(), []);
    }

    #[test]
    fn it_blinks_for_the_length_of_the_work_and_ends_lit() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("watch-turn");
        let mut script = Script::new(&logo, &[(1_000, 21_000)], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        let falls = logo.falls() as u64;
        // Settling delays the start and the end alike, so the blink lasts as long
        // as the 20 s of work did, with one fall a cycle.
        let cycles = 20_000 / CYCLE_MS;
        assert!(falls >= cycles, "{falls} falls, {cycles} cycles");
        assert!(falls <= cycles + 2, "{falls} falls, {cycles} cycles");
        assert_eq!(logo.last_duration(), Some(0.0));
        assert_eq!(logo.settled_level(), 1.0);
        assert!(!path.exists());
    }

    #[test]
    fn the_end_of_the_work_relights_a_logo_in_the_middle_of_a_dark_beat() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-stop");
        // Started at about 4.25 s, a dark beat runs from every 2 s after that, and
        // work that ends at 5.5 s settles at 8.5 s, inside the third one.
        let mut script = Script::new(&logo, &[(1_000, 5_500)], 60_000);
        let mut level_at_stop = None;
        struct Watching<'a>(&'a mut Script, &'a FakeLogo, &'a mut Option<f64>);
        impl Signals for Watching<'_> {
            fn wait(&mut self, time: Duration) -> bool {
                if self.0.elapsed_ms() >= 8_500 && self.2.is_none() {
                    *self.2 = Some(self.1.level());
                }
                self.0.wait(time)
            }
            fn activity(&self) -> Activity {
                self.0.activity()
            }
            fn now(&self) -> Instant {
                self.0.now()
            }
        }
        watch(
            &logo,
            &marker,
            WORK,
            &mut Watching(&mut script, &logo, &mut level_at_stop),
        );
        assert_eq!(level_at_stop, Some(0.0), "it was dark when the work ended");
        assert_eq!(logo.falls(), 3);
        assert_eq!(logo.settled_level(), 1.0);
    }

    #[test]
    fn a_gap_between_two_turns_does_not_stop_the_blink() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-gap");
        let mut script = Script::new(&logo, &[(1_000, 15_000), (16_000, 30_000)], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        let falls = logo.falls() as u64;
        assert!(falls >= (29_000 - 2 * SETTLE.as_millis() as u64) / CYCLE_MS, "{falls}");
    }

    #[test]
    fn the_app_going_away_in_a_dark_beat_puts_the_logo_back() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("watch-gone");
        // Work from the start; the first dark beat begins once it has settled.
        let mut script = Script::new(&logo, &[(0, 60_000)], 3_500);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.falls(), 1);
        assert_eq!(logo.last_duration(), Some(0.0));
        assert_eq!(logo.settled_level(), 1.0);
        assert!(!path.exists());
    }

    #[test]
    fn a_logo_the_user_switched_off_is_not_asked_again_during_the_work() {
        let logo = FakeLogo::new(MODE_OFF);
        let (marker, _) = temp_marker("watch-declined");
        let mut script = Script::new(&logo, &[(0, 30_000)], 60_000);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.writes(), []);
    }

    #[test]
    fn after_the_agents_finish_it_may_ask_again() {
        // Declined in the first turn, the logo is back on for the second.
        let logo = FakeLogo::new(MODE_OFF);
        let (marker, _) = temp_marker("watch-again");
        let mut script = Script::new(&logo, &[(0, 5_000), (20_000, 30_000)], 60_000);
        struct TurnsOn<'a>(&'a mut Script, &'a FakeLogo);
        impl Signals for TurnsOn<'_> {
            fn wait(&mut self, time: Duration) -> bool {
                let gone = self.0.wait(time);
                if self.0.elapsed_ms() >= 10_000 {
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
        assert!(logo.falls() > 0, "{:?}", logo.writes());
        assert_eq!(logo.settled_level(), 1.0);
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
    fn every_style_but_off_starts_with_a_fall_and_alternates() {
        for style in BlinkStyle::ALL {
            let moves = style.moves();
            if style == BlinkStyle::Off {
                assert!(moves.is_empty());
                continue;
            }
            assert!(moves.len() >= 2 && moves.len() % 2 == 0, "{style:?}");
            for (i, step) in moves.iter().enumerate() {
                assert_eq!(step.lit, i % 2 == 1, "{style:?}");
                assert!(!step.fade.is_zero() && !step.wait.is_zero(), "{style:?}");
            }
        }
    }

    #[test]
    fn a_hard_style_keeps_its_rhythm() {
        // The waits add up to the beats, so a hard style's cycle is what it says.
        for style in BlinkStyle::ALL {
            let Rhythm::Hard(beats) = style.rhythm() else { continue };
            let beats: Duration = beats.iter().map(|beat| beat.dark + beat.lit).sum();
            let moves: Duration = style.moves().iter().map(|step| step.wait).sum();
            assert_eq!(beats, moves, "{style:?}");
        }
    }

    #[test]
    fn no_style_flashes_more_than_three_times_in_any_second() {
        for style in BlinkStyle::ALL {
            let moves = style.moves();
            let mut falls = Vec::new();
            let mut at = Duration::ZERO;
            for step in moves.iter().cycle().take(80) {
                if !step.lit {
                    falls.push(at);
                }
                at += step.wait;
            }
            for (i, from) in falls.iter().enumerate() {
                let in_a_second = falls[i..].iter().filter(|&&t| t - *from < Duration::from_secs(1));
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
        enabled: true,
        working: BlinkStyle::Breathe,
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
        assert_eq!(ALL_ON.pick(working()), BlinkStyle::Breathe);
        assert_eq!(ALL_ON.pick(Activity::default()), BlinkStyle::Off);
        let switched_off = BlinkStyles {
            enabled: false,
            ..ALL_ON
        };
        assert_eq!(switched_off.pick(everything), BlinkStyle::Off);
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
        assert_eq!(styles.pick(everything), BlinkStyle::Breathe);
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
        let script = Script::with(&logo, &[(0, 30_000, waiting())], 40_000);
        watch(&logo, &marker, WORK, &mut Watching(script, &path));
        assert_eq!(logo.writes(), []);
    }

    fn falls_with(styles: BlinkStyles, spans: &[(u64, u64, Activity)], end: u64) -> usize {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("phases");
        let mut script = Script::with(&logo, spans, end);
        watch(&logo, &marker, styles, &mut script);
        assert_eq!(logo.settled_level(), 1.0, "it ends lit");
        assert_eq!(logo.last_duration(), Some(0.0));
        assert!(!path.exists());
        logo.falls()
    }

    #[test]
    fn a_change_of_state_moves_to_the_other_rhythm_and_back() {
        let styles = BlinkStyles {
            working: BlinkStyle::Calm,
            ..ALL_ON
        };
        let alone = falls_with(styles, &[(0, 60_000, working())], 60_000);
        let interrupted = falls_with(
            styles,
            &[
                (0, 20_000, working()),
                (20_000, 40_000, needs_you()),
                (40_000, 60_000, working()),
            ],
            60_000,
        );
        // About 29 falls of Calm alone, and Alarm's 2 a second for a third of the
        // time. Calm alone again at the end ends the same as it began.
        assert!((27..=31).contains(&alone), "{alone}");
        assert!(interrupted >= alone + 20, "{interrupted} against {alone}");
    }

    #[test]
    fn red_interrupts_yellow_and_yellow_comes_back() {
        let yellow_only = falls_with(ALL_ON, &[(0, 60_000, waiting())], 60_000);
        let with_red = falls_with(
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
    fn the_recommended_styles_rise_with_the_need() {
        // Steady, then a slow soft breath, then a plain blink, then flashes: each
        // more urgent state moves the logo more often.
        let per_minute = |style: BlinkStyle| {
            let cycle: Duration = style.moves().iter().map(|step| step.wait).sum();
            let falls = style.moves().iter().filter(|step| !step.lit).count();
            falls as f64 * 60.0 / cycle.as_secs_f64()
        };
        let r = BlinkStyles::RECOMMENDED;
        assert!(per_minute(r.working) < per_minute(r.waiting));
        assert!(per_minute(r.waiting) * 2.0 < per_minute(r.needs_you));
        // Busy is soft, you are hard.
        assert!(matches!(r.working.rhythm(), Rhythm::Soft(_)));
        assert!(matches!(r.waiting.rhythm(), Rhythm::Hard(_)));
        assert!(matches!(r.needs_you.rhythm(), Rhythm::Hard(_)));
    }

    #[test]
    fn alarm_is_the_sharpest_style_a_second_can_hold() {
        let flashes = |style: BlinkStyle| {
            let cycle: Duration = style.moves().iter().map(|step| step.wait).sum();
            style.moves().iter().filter(|step| !step.lit).count() as f64 / cycle.as_secs_f64()
        };
        assert!(flashes(BlinkStyle::Alarm) > flashes(BlinkStyle::Fast));
        assert!(flashes(BlinkStyle::Alarm) > flashes(BlinkStyle::Heartbeat) * 2.0);
    }

    #[test]
    fn the_setting_reads_every_shape_it_has_had() {
        let read = |text: &str| BlinkStyles::read(&serde_json::from_str(text).unwrap());
        // A new Mac: the switch off, the recommended styles ready behind it.
        assert_eq!(
            BlinkStyles::default(),
            BlinkStyles {
                enabled: false,
                ..BlinkStyles::RECOMMENDED
            }
        );
        // The one style of the first version keeps meaning work, and brings the alerts.
        assert_eq!(
            read(r#""heartbeat""#),
            BlinkStyles {
                enabled: true,
                working: BlinkStyle::Heartbeat,
                waiting: BlinkStyle::Wink,
                needs_you: BlinkStyle::Alarm,
            }
        );
        assert_eq!(read(r#""off""#), BlinkStyles::default());
        assert_eq!(read(r#""strobe""#), BlinkStyles::default());
        assert_eq!(read("3"), BlinkStyles::default());
        assert_eq!(read("null"), BlinkStyles::default());
        // A style per state, before the switch: what was chosen stays, and is on.
        assert_eq!(
            read(r#"{"working":"heartbeat","waiting":"off","needsYou":"alarm"}"#),
            BlinkStyles {
                enabled: true,
                working: BlinkStyle::Heartbeat,
                waiting: BlinkStyle::Off,
                needs_you: BlinkStyle::Alarm,
            }
        );
        // All three off was that version's default: never touched.
        assert_eq!(
            read(r#"{"working":"off","waiting":"off","needsYou":"off"}"#),
            BlinkStyles::default()
        );
        // A bad style costs its own state, not the others.
        assert_eq!(
            read(r#"{"enabled":true,"working":"calm","waiting":"strobe","needsYou":"alarm"}"#),
            BlinkStyles {
                enabled: true,
                working: BlinkStyle::Calm,
                waiting: BlinkStyle::Off,
                needs_you: BlinkStyle::Alarm,
            }
        );
        // A missing state takes the recommended style; a bad switch is off.
        assert_eq!(
            read(r#"{"enabled":"yes","working":"calm"}"#),
            BlinkStyles {
                enabled: false,
                working: BlinkStyle::Calm,
                ..BlinkStyles::RECOMMENDED
            }
        );
        // The switch off keeps the styles behind it.
        let off = BlinkStyles {
            enabled: false,
            ..ALL_ON
        };
        assert_eq!(BlinkStyles::read(&serde_json::to_value(off).unwrap()), off);
        let saved = serde_json::to_value(ALL_ON).unwrap();
        assert_eq!(saved["needsYou"], "alarm");
        assert_eq!(saved["working"], "breathe");
        assert_eq!(saved["enabled"], true);
        assert_eq!(BlinkStyles::read(&saved), ALL_ON);
    }

    #[test]
    fn the_switch_and_the_styles_decide_together() {
        assert!(!WORK.wants_alerts());
        assert!(ALL_ON.wants_alerts());
        assert!(!BlinkStyles::default().active(), "off on a new Mac");
        assert!(BlinkStyles::default().any_style());
        assert!(WORK.active());
        assert!(!BlinkStyles {
            enabled: false,
            ..ALL_ON
        }
        .wants_alerts());
        let nothing = BlinkStyles {
            enabled: true,
            working: BlinkStyle::Off,
            waiting: BlinkStyle::Off,
            needs_you: BlinkStyle::Off,
        };
        assert!(!nothing.active());
    }

    #[test]
    fn a_watcher_with_nothing_to_watch_starts_nothing() {
        let mut watcher = Watcher::default();
        watcher.sync(None);
        assert!(watcher.current.is_none());
    }
}
