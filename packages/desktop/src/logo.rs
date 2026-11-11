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
//! With the lid closed `corebrightnessd` keeps the logo dark: it tells every
//! module the lid is closed, and the logo's target is then 0 whatever
//! `DisplayLogicalState` says. While the Mac stays awake with the lid closed on
//! its power adapter (Keep This Mac Awake's lid helper, LogoLight's Lit with
//! Lid Closed, or an external display), the blink goes on, the way LogoLight
//! does it and measured it on the real MacBook (its `docs/corebrightnessd.md`,
//! "The lid", and its 1.3.1 for the Mac with no display attached):
//! - Kept awake like that, the built-in display stays online and CoreGraphics
//!   does not call it asleep, so the lid sensor (`AppleClamshellState`) is what
//!   says the logo cannot be seen (`seen`).
//! - Once the daemon has handled the lid (`CBClamshellState`), the logo is told
//!   the lid is open (`ClamshellUpdate` 0), and each keyboard and each display
//!   alone that it is closed: the keyboards stay dark, and True Tone does not
//!   adapt an external display to the covered light sensor.
//! - The daemon sends the real lid state again when a display or a keyboard
//!   comes up, so a logo found dark where the blink has it lit is told again.
//! - `DisplayPowerStateEvent` is never written: a client's DidSleep keeps the
//!   logo dark, lid open too, until someone writes DidWake.
//!
//! The first rise after that has to move the logo; a blink that ends with the
//! lid closed puts the logo back to normal and tells it the lid is closed, so it
//! is dark as a closed lid has it. What the closed lid did last is the line
//! under View > Apple Logo Blink Styles (`LidStatus`, through a file next to the
//! app's settings), and each step is a line on stderr.
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
//! every fade. A LogoLight that says it steps aside (`LogoLightStepsAsideForCodeman`
//! in its Info.plist) is lent the logo instead: the marker above holds the
//! child's process ID, goes down right before the blink's first write, and
//! comes off once the logo is back to normal, and LogoLight pauses while it
//! names a running `codeman-desktop`. So the child waits `LOAN_GRACE` after
//! writing it, for LogoLight to have paused, unless the last blink ended a
//! moment ago (`LOAN_LINGER`): LogoLight is then still paused. LogoLight ships
//! its side since 1.3.0. An older LogoLight is left the logo, as it is while the
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
/// How long the first rise under the closed lid may take to move the logo: the
/// display-ready gate waits up to a second, and LogoLight saw that rise start
/// 0.5 to 0.8 s after the write.
const LID_PROOF_WAIT: Duration = Duration::from_millis(1500);
/// The fade level that counts as the logo having moved under the closed lid:
/// above any drift of a fade held at 0, and reached in well under the proof's
/// wait by the slowest rise (the breath's).
const LID_MOVED: f64 = 0.01;
/// How many rises in a row may fail to move the logo before the closed lid is
/// said to keep it dark.
const LID_TRIES: u32 = 3;
/// From then on, how many looks (`NOT_LIT_RECHECK` apart) lie between two more
/// tries: half a minute.
const LID_RETRY_LOOKS: u32 = 15;
/// How many looks (`LOOK_EVERY` apart) the daemon gets to handle a lid the
/// sensor already calls closed, before the logo is told anyway.
const LID_HANDLED_LOOKS: u32 = 8;
/// How long a change has to hold before the logo follows it, so a server
/// restart or an agent between two turns does not flicker it. Not below the 3 s
/// the server waits before it judges a new dialog: a prompt that was answered
/// before its hook landed lives that long and should never flash red.
const SETTLE: Duration = Duration::from_secs(3);
/// How often the child looks at what the poller found, and at the pipe.
const LOOK_EVERY: Duration = Duration::from_millis(250);
/// How long a blink waits after writing its marker, before its first write,
/// while a LogoLight that steps aside runs: LogoLight looks at the marker every
/// second, and pauses its effect when it sees it.
const LOAN_GRACE: Duration = Duration::from_secs(2);
/// How long after a blink's end that LogoLight is surely still paused: it takes
/// the logo back only once the marker has been gone for 1.5 s (its
/// `LoanWatcher.returnDelay`). A blink that starts within this of the last one's
/// end (a change of state: work, then a permission) skips the wait above.
const LOAN_LINGER: Duration = Duration::from_secs(1);

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
    /// Another app drives the logo the same way, and would fight a blink.
    fn driven_elsewhere(&self) -> bool;
    /// Another app drives the logo the same way, and steps aside while the
    /// marker says a blink runs.
    fn steps_aside_elsewhere(&self) -> bool;
    /// The lid is closed: the lid sensor (`AppleClamshellState`, what `ioreg -k
    /// AppleClamshellState` shows). None if it cannot be read.
    fn lid_closed(&self) -> Option<bool>;
    /// `CBClamshellState`: `corebrightnessd` has handled the closed lid, a moment
    /// after the sensor. Only a real lid change moves it, whatever `tell_lid`
    /// said since. None if it cannot say.
    fn lid_handled(&self) -> Option<bool>;
    /// `ClamshellUpdate`: tell the logo the lid is open, and then each keyboard
    /// and each display alone that it is closed (`open`), or tell everything it
    /// is closed. False if that was not done: opening it needs the keyboards
    /// within reach, or a keyboard would light under the closed lid.
    fn tell_lid(&self, open: bool) -> bool;
    /// What the closed lid did this time, for the line in the View menu.
    fn lid_status(&self, status: LidStatus);
    /// The Mac runs on battery. It sleeps with the lid closed then, and a dark
    /// wake (Power Nap) must not light the logo in a bag.
    fn on_battery(&self) -> bool;
    /// What a line on stderr says about the logo, for a test on a real Mac.
    fn describe(&self) -> String {
        String::new()
    }
}

/// What the closed lid did, as the line under View > Blink Apple Logo says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LidStatus {
    /// Told the lid is open, the logo moved.
    Blinking,
    /// It did not: macOS keeps the logo dark under this closed lid.
    StayedDark,
    OnBattery,
    NoKeyboards,
    NoLidSensor,
    /// No agent is working (and none waits for you): nothing to show.
    Idle,
    SwitchedOff,
    LogoLight,
    /// The logo refused a change, or the marker could not be written.
    Refused,
    /// The Mac slept with the lid closed: nothing kept it awake.
    Slept,
}

impl LidStatus {
    pub fn text(self) -> &'static str {
        match self {
            LidStatus::Blinking => "blinking",
            LidStatus::StayedDark => "stayed dark, macOS keeps the logo off",
            LidStatus::OnBattery => "not tried, on battery",
            LidStatus::NoKeyboards => "not tried, no keyboard to keep dark",
            LidStatus::NoLidSensor => "not tried, the lid sensor could not be read",
            LidStatus::Idle => "nothing to show, no agent at work",
            LidStatus::SwitchedOff => "not tried, the logo is switched off",
            LidStatus::LogoLight => "not tried, an older LogoLight has the logo",
            LidStatus::Refused => "not tried, the logo refused a change",
            LidStatus::Slept => "the Mac went to sleep",
        }
    }
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
    /// The logo was told the lid is open while it is closed (`open_lid`).
    lid_open: bool,
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
            lid_open: false,
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

    /// Lets the logo move under a closed lid (`Logo::tell_lid`).
    fn open_lid(&mut self) -> bool {
        // A refusal has written nothing.
        let open = self.logo.tell_lid(true);
        self.lid_open |= open;
        self.touched |= open;
        open
    }

    /// Ends `open_lid`: the logo goes dark, as a closed lid has it. Once the lid
    /// has really opened the daemon has told every module so itself, and nothing
    /// is written.
    fn close_lid(&mut self) {
        if std::mem::take(&mut self.lid_open) && self.logo.lid_closed() == Some(true) {
            self.ok &= self.logo.tell_lid(false);
        }
    }

    /// Back to normal: fully lit (when the display is on), with the automatic
    /// fade duration. With the lid closed, normal is dark: a logo told the lid is
    /// open is handed back first (a held level would survive the lid) and then
    /// told it is closed. True once that is done; false while the display sleeps
    /// or a write was refused, which keeps the marker for another try.
    fn restore(&mut self) -> bool {
        if !self.touched && self.keyboards.is_none() {
            return true;
        }
        let awake = seen(self.logo);
        let reachable = awake || self.lid_open;
        // A fade toward lit may be a held one, or still under way at its own
        // duration: turn it round without moving, so relighting is a change.
        if self.heading != Some(false) && self.logo.factor().unwrap_or(1.0) < LIT {
            self.turn_round(true, awake);
        }
        self.duration(0.0);
        if reachable {
            self.heading(true, awake);
        }
        self.close_lid();
        self.ok && reachable
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

    /// Writes the marker, holding this process's ID: LogoLight steps aside while
    /// it names a running Codeman.
    fn set(&self) -> bool {
        let Some(path) = &self.0 else { return false };
        path.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
            && std::fs::write(path, format!("{}\n", std::process::id())).is_ok()
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
/// answers true if the blink should end. The marker goes down right before the
/// first write, and one that cannot be written refuses the blink: without it a
/// child killed in a dark phase would have no way back.
#[cfg(test)]
fn blink(logo: &impl Logo, marker: &Marker, moves: &[Move], wait: impl FnMut(Duration) -> bool) -> Ended {
    blink_after(logo, marker, moves, LOAN_GRACE, wait).0
}

/// `blink`, giving a LogoLight that steps aside `grace` to pause before the
/// first write. Also answers whether the marker went down: LogoLight was then
/// paused until this blink's end, and stays so for a moment (`LOAN_LINGER`).
fn blink_after(
    logo: &impl Logo,
    marker: &Marker,
    moves: &[Move],
    grace: Duration,
    mut wait: impl FnMut(Duration) -> bool,
) -> (Ended, bool) {
    if moves.is_empty() || logo.mode() != Some(MODE_AUTO) || logo.driven_elsewhere() {
        return (Ended::Declined, false);
    }
    let mut fader = Fader::new(logo);
    let mut lid = Lid::default();
    let mut ended = Ended::Stopped;
    let mut asleep = false;
    let mut claimed = false;
    let mut next = 0;
    'blink: loop {
        let step = moves[next % moves.len()];
        let awake = seen(logo);
        // Every cycle starts with a fall: the moment to check that the logo is
        // still the agents' and can be seen.
        if !step.lit {
            if logo.mode() != Some(MODE_AUTO) || logo.driven_elsewhere() {
                ended = Ended::Declined;
                break;
            }
            if awake {
                if asleep {
                    fader.display_woke();
                    asleep = false;
                }
                if std::mem::take(&mut fader.lid_open) {
                    // The daemon told every module itself when the lid opened.
                    note(logo, "the lid opened");
                }
                lid = Lid::default();
            } else {
                if !asleep {
                    fader.display_slept();
                    asleep = true;
                }
                match look_at_lid(logo, &mut fader, &mut lid) {
                    LidLook::Go => {}
                    LidLook::Tell => {
                        // Telling the lid is a write, and may be the blink's first.
                        if !claimed {
                            if let Some(end) = claim(logo, marker, grace, &mut wait) {
                                ended = end;
                                break;
                            }
                            claimed = true;
                        }
                        if !fader.open_lid() {
                            lid.report(logo, LidStatus::NoKeyboards);
                            if wait(NOT_LIT_RECHECK) {
                                break;
                            }
                            continue;
                        }
                        note(logo, "the lid is closed: told the logo it is open");
                    }
                    LidLook::Wait(time) => {
                        if wait(time) {
                            break;
                        }
                        continue;
                    }
                }
            }
        }
        if !claimed {
            // Only now, so a LogoLight is not paused for a blink that is waiting
            // for the display.
            if let Some(end) = claim(logo, marker, grace, &mut wait) {
                ended = end;
                break;
            }
            claimed = true;
        }
        let proving = step.lit && fader.lid_open && !lid.proven;
        let from_dark = step.lit && logo.factor().is_some_and(|factor| factor <= 0.0);
        // With the display off the keyboards are not touched: under a closed lid
        // they stay dark.
        fader.fade(step.lit, step.fade, awake);
        if !fader.ok {
            ended = Ended::Declined;
            break;
        }
        let mut left = step.wait;
        if from_dark || proving {
            // Held back until the display shows a frame: time the light from when
            // it moves, so a held-back rise lengthens the dark, not shortens the light.
            let (gate, still) = if proving {
                (LID_PROOF_WAIT, LID_MOVED)
            } else {
                (GATE_WAIT, 0.0)
            };
            let mut waited = Duration::ZERO;
            while waited < gate && logo.factor().is_some_and(|factor| factor <= still) {
                if wait(RISE_POLL) {
                    break 'blink;
                }
                waited += RISE_POLL;
            }
            if proving {
                lid.proved(logo, logo.factor().is_some_and(|factor| factor > LID_MOVED));
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
    (ended, claimed)
}

/// Puts the marker down, right before a blink's first write, and gives a
/// LogoLight that steps aside `grace` to see it and pause. Some if the blink
/// ends here: the marker could not be written, or `wait` said stop.
fn claim(logo: &impl Logo, marker: &Marker, grace: Duration, wait: &mut impl FnMut(Duration) -> bool) -> Option<Ended> {
    if !marker.set() {
        return Some(Ended::Declined);
    }
    (!grace.is_zero() && logo.steps_aside_elsewhere() && wait(grace)).then_some(Ended::Stopped)
}

/// The built-in display can be seen: it is on, and the lid sensor does not say
/// closed. A closed lid counts as closed even when the display list still has the
/// built-in display awake.
fn seen(logo: &impl Logo) -> bool {
    logo.display_awake() && logo.lid_closed() != Some(true)
}

/// What a closed lid has shown during one blink.
#[derive(Debug, Default)]
struct Lid {
    /// The logo moved under it since it was last told the lid is open.
    proven: bool,
    /// Rises in a row that did not move it.
    failed: u32,
    /// Looks since the last try, once `LID_TRIES` rises failed.
    waited: u32,
    /// Looks at a lid the daemon has not handled yet.
    unhandled: u32,
    /// The last status written, so it is written once per change.
    status: Option<LidStatus>,
}

impl Lid {
    fn report(&mut self, logo: &impl Logo, status: LidStatus) {
        if self.status != Some(status) {
            self.status = Some(status);
            logo.lid_status(status);
            note(logo, status.text());
        }
    }

    /// A rise under the closed lid moved the logo, or did not.
    fn proved(&mut self, logo: &impl Logo, moved: bool) {
        if moved {
            self.proven = true;
            self.failed = 0;
            self.waited = 0;
            self.report(logo, LidStatus::Blinking);
        } else {
            self.failed += 1;
            if self.failed >= LID_TRIES {
                self.report(logo, LidStatus::StayedDark);
            } else {
                note(logo, "the logo did not rise under the closed lid");
            }
        }
    }
}

/// What to do about the lid at the start of a cycle with the built-in display
/// out of sight.
#[derive(Debug, PartialEq)]
enum LidLook {
    /// The logo was told the lid is open, and nothing says otherwise: blink on.
    Go,
    /// Tell the logo the lid is open (again), then blink on.
    Tell,
    /// Nothing to blink for now: look again after this long.
    Wait(Duration),
}

/// Never while the display only sleeps (the lid is open), nor on battery. The
/// logo is told the lid is open once the daemon has handled the closed lid, and
/// again when it is found dark where the blink has it lit, or when a rise did
/// not move it: a few times in a row, then every half minute.
fn look_at_lid<'a, L: Logo>(logo: &'a L, fader: &mut Fader<'a, L>, lid: &mut Lid) -> LidLook {
    match logo.lid_closed() {
        Some(true) => {}
        Some(false) => {
            // The display sleeps with the lid open; an override ended when it opened.
            fader.lid_open = false;
            *lid = Lid::default();
            return LidLook::Wait(NOT_LIT_RECHECK);
        }
        None => {
            lid.report(logo, LidStatus::NoLidSensor);
            return LidLook::Wait(NOT_LIT_RECHECK);
        }
    }
    if logo.on_battery() {
        // Unplugged under the lid: the logo goes dark, and the Mac to sleep.
        fader.close_lid();
        let status = lid.status;
        *lid = Lid {
            status,
            ..Lid::default()
        };
        lid.report(logo, LidStatus::OnBattery);
        return LidLook::Wait(NOT_LIT_RECHECK);
    }
    if fader.lid_open {
        if lid.proven {
            // Every cycle ends lit, so dark here is not the blink's doing: the
            // daemon sent the real lid state again (a display or a keyboard came up).
            if !logo.factor().is_some_and(|factor| factor <= LID_MOVED) {
                return LidLook::Go;
            }
            note(logo, "the logo went dark under the closed lid");
            lid.proven = false;
        } else if lid.failed == 0 {
            return LidLook::Go;
        }
    } else if logo.lid_handled() == Some(false) && lid.unhandled < LID_HANDLED_LOOKS {
        // The daemon's own update for this lid is still to come, and would undo ours.
        lid.unhandled += 1;
        return LidLook::Wait(LOOK_EVERY);
    }
    if lid.failed >= LID_TRIES {
        lid.waited += 1;
        if lid.waited < LID_RETRY_LOOKS {
            return LidLook::Wait(NOT_LIT_RECHECK);
        }
        lid.waited = 0;
    }
    LidLook::Tell
}

/// A line on stderr about the closed lid, which `open -a Codeman --stderr <file>`
/// keeps: how blinking under it is checked on a real Mac.
fn note(logo: &impl Logo, text: &str) {
    // Not eprintln!, which panics on a failed write, and the child has
    // `panic = "abort"`: a broken stderr must not stop the blink mid-pattern.
    let _ = writeln!(std::io::stderr().lock(), "codeman logo: {text} ({})", logo.describe());
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
        // A child killed with the lid closed may have told the logo it is open.
        // With a LogoLight running the lid is its to tell: it may be lighting
        // the logo under it (Lit with Lid Closed), and nothing here would make it
        // tell the logo again.
        fader.lid_open = logo.lid_closed() == Some(true) && !logo.driven_elsewhere() && !logo.steps_aside_elsewhere();
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
    /// The Mac slept since this was last asked.
    fn slept(&mut self) -> bool {
        false
    }
}

/// The child's life: show what the agents are doing, until the app goes away. A
/// change of state ends the blink that is running, which puts the logo back to
/// normal, and the next look starts the new one.
fn watch(logo: &impl Logo, marker: &Marker, styles: BlinkStyles, signals: &mut impl Signals) {
    let mut settled = Settled::new(BlinkStyle::Off, signals.now());
    let mut declined = false;
    // What the menu line was last told from here, and when the lid is next read.
    let mut said: Option<LidStatus> = None;
    let mut lid_look_due = signals.now();
    // When the last blink that had its marker down ended.
    let mut released: Option<Instant> = None;
    loop {
        if signals.wait(LOOK_EVERY) {
            return;
        }
        if signals.slept() && logo.lid_closed() == Some(true) {
            logo.lid_status(LidStatus::Slept);
            said = Some(LidStatus::Slept);
        }
        let style = settled.update(styles.pick(signals.activity()), signals.now());
        if style == BlinkStyle::Off {
            declined = false;
        }
        if style == BlinkStyle::Off || declined {
            // No blink runs: if the lid is closed, the menu line says why.
            if signals.now() >= lid_look_due {
                lid_look_due = signals.now() + NOT_LIT_RECHECK;
                if logo.lid_closed() == Some(true) {
                    let why = if style == BlinkStyle::Off {
                        LidStatus::Idle
                    } else if logo.mode() != Some(MODE_AUTO) {
                        LidStatus::SwitchedOff
                    } else if logo.driven_elsewhere() {
                        LidStatus::LogoLight
                    } else {
                        LidStatus::Refused
                    };
                    if said != Some(why) && said != Some(LidStatus::Slept) {
                        logo.lid_status(why);
                        note(logo, why.text());
                    }
                    said = Some(why);
                }
            }
            continue;
        }
        let mut app_gone = false;
        let grace = match released {
            Some(at) if signals.now().duration_since(at) < LOAN_LINGER => Duration::ZERO,
            _ => LOAN_GRACE,
        };
        let (ended, claimed) = blink_after(logo, marker, &style.moves(), grace, |time| {
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
                if signals.slept() && logo.lid_closed() == Some(true) {
                    logo.lid_status(LidStatus::Slept);
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
        released = claimed.then(|| signals.now());
        // The blink may have said something since: say it again once it ends.
        said = None;
        lid_look_due = signals.now();
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
    /// A child runs.
    pub fn watching(&self) -> bool {
        self.current.is_some()
    }

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

/// Where the child leaves what the closed lid did last (`Logo::lid_status`):
/// next to the app's settings, like the marker.
fn lid_status_path() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("Codeman").join("logo-lid"))
}

/// The line under View > Blink Apple Logo while no child runs.
pub const LID_NOT_WATCHED: &str = "Lid Closed: not watched (Blink Apple Logo off, or no server open)";

/// The line under View > Blink Apple Logo.
pub fn lid_status_line() -> String {
    let last = lid_status_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| text.lines().next().map(str::to_owned))
        .filter(|line| !line.is_empty());
    format!("Lid Closed: {}", last.as_deref().unwrap_or("not seen yet"))
}

/// Calls `changed` with the line whenever the child writes a new one. A thread
/// that reads one small file every two seconds, for the life of the app.
pub fn watch_lid_status(changed: impl Fn(String) + Send + 'static) {
    std::thread::spawn(move || {
        let mut shown = lid_status_line();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let line = lid_status_line();
            if line != shown {
                shown = line;
                changed(shown.clone());
            }
        }
    });
}

#[cfg(target_os = "macos")]
pub use system::{available, blink_main, clock, driven_elsewhere, recover_at_launch, switched_off};

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
    use super::{recover, watch, Connection, LidStatus, Logo, Marker, Signals, MODE_OFF};
    use crate::agents::{Activity, Poll, Poller, POLL_EVERY};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    use objc2_foundation::{ns_string, NSBundle, NSDictionary, NSNumber, NSString};
    use std::ffi::{c_char, c_void};
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
        fn CFGetTypeID(object: *const c_void) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(boolean: *const c_void) -> u8;
    }

    struct SystemLogo {
        client: Retained<AnyObject>,
        /// The keyboard backlights, for telling them apart from the logo. Empty if
        /// this macOS has no way to: the keyboard then dims with each dark beat.
        keyboards: Vec<u64>,
        /// The client can tell one display alone (`setProperty:withKey:andDisplay:`).
        per_display: bool,
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
                let per_display = class.instance_method(sel!(setProperty:withKey:andDisplay:)).is_some();
                client.map(|client| SystemLogo {
                    client,
                    keyboards,
                    per_display,
                })
            })
        }

        /// The displays the daemon has a container for (`CBDisplayList`), read
        /// each time since displays come and go. The IDs are CoreGraphics's.
        fn display_ids(&self) -> Vec<u64> {
            let Some(list) = self.property(ns_string!("CBDisplayList")) else {
                return Vec::new();
            };
            let Some(list) = list.downcast_ref::<NSDictionary>() else {
                return Vec::new();
            };
            // SAFETY: an NSDictionary answers objectForKey:, with nil for a key it
            // does not have.
            let ids: Option<Retained<AnyObject>> =
                unsafe { msg_send![list, objectForKey: ns_string!("CBDisplayDeviceIDs")] };
            ids.map_or(Vec::new(), |ids| numbers(&ids))
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
        numbers(&ids)
    }

    /// The numbers in an array, or none if it is not an array.
    fn numbers(ids: &AnyObject) -> Vec<u64> {
        // SAFETY: an array answers count and objectAtIndex: below its count; it is
        // checked to be one first.
        let is_array: Bool = unsafe { msg_send![ids, isKindOfClass: AnyClass::get(c"NSArray")] };
        if !is_array.as_bool() {
            return Vec::new();
        }
        let count: usize = unsafe { msg_send![ids, count] };
        (0..count)
            .filter_map(|i| {
                let id: Option<Retained<AnyObject>> = unsafe { msg_send![ids, objectAtIndex: i] };
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

        fn steps_aside_elsewhere(&self) -> bool {
            steps_aside_elsewhere()
        }

        fn lid_closed(&self) -> Option<bool> {
            lid_sensor()
        }

        fn lid_handled(&self) -> Option<bool> {
            autoreleasepool(|_| {
                let value = self.property(ns_string!("CBClamshellState"))?;
                Some(value.downcast_ref::<NSNumber>()?.as_bool())
            })
        }

        fn tell_lid(&self, open: bool) -> bool {
            if open && self.keyboards.is_empty() {
                return false;
            }
            autoreleasepool(|_| {
                let closed = NSNumber::new_bool(true);
                if !open {
                    return self.set(&closed, ns_string!("ClamshellUpdate"));
                }
                if !self.set(&NSNumber::new_bool(false), ns_string!("ClamshellUpdate")) {
                    return false;
                }
                // The answers below are not read: LogoLight's measured override
                // does not read them either.
                for &id in &self.keyboards {
                    // SAFETY: the method was checked in `open` (there are keyboards
                    // only if it exists). It takes an object, a string and a 64-bit
                    // keyboard ID and answers a BOOL.
                    let _: bool = unsafe {
                        msg_send![&*self.client, setProperty: &*closed, withKey: ns_string!("ClamshellUpdate"), keyboardID: id]
                    };
                }
                // Each display's own modules (brightness, True Tone) too: told the
                // lid is open, True Tone adapts an external display to the covered
                // light sensor. The logo's module is in no display's container.
                if self.per_display {
                    for id in self.display_ids() {
                        // SAFETY: the method was checked in `open`. It takes an object,
                        // a string and a 64-bit display ID and answers a BOOL.
                        let _: bool = unsafe {
                            msg_send![&*self.client, setProperty: &*closed, withKey: ns_string!("ClamshellUpdate"), andDisplay: id]
                        };
                    }
                }
                true
            })
        }

        fn lid_status(&self, status: LidStatus) {
            let text = format!("{} ({})\n{}\n", status.text(), clock(), self.describe());
            if let Some(path) = super::lid_status_path() {
                let tmp = path.with_extension("tmp");
                // Written whole and renamed, so the app never reads half of it.
                let written = path.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_ok())
                    && std::fs::write(&tmp, text).is_ok();
                if written {
                    let _ = std::fs::rename(&tmp, &path);
                }
            }
        }

        fn on_battery(&self) -> bool {
            on_battery()
        }

        fn describe(&self) -> String {
            autoreleasepool(|_| {
                format!(
                    "factor {:?}, FinalNits {:?}, lid sensor {:?}, CBClamshellState {:?}, built-in display on {}, other displays on {}, displays told {:?}, on battery {}",
                    self.pwm(ns_string!("Factor")),
                    self.pwm(ns_string!("FinalNits")),
                    lid_sensor(),
                    self.lid_handled(),
                    built_in_display_awake(),
                    other_displays_awake(),
                    self.per_display.then(|| self.display_ids()),
                    on_battery()
                )
            })
        }
    }

    /// The lid sensor: `AppleClamshellState` on the power management root, the
    /// same entry Keep This Mac Awake reads to tell a MacBook.
    fn lid_sensor() -> Option<bool> {
        let key = NSString::from_str("AppleClamshellState");
        // SAFETY: IOServiceMatching returns a dictionary that
        // IOServiceGetMatchingService consumes; the service is released below.
        // IORegistryEntryCreateCFProperty returns an owned CFTypeRef or NULL, takes
        // the NSString as its toll-free bridged CFString, and is released here; its
        // type is checked before it is read as a CFBoolean.
        unsafe {
            let matching = IOServiceMatching(c"IOPMrootDomain".as_ptr());
            if matching.is_null() {
                return None;
            }
            let root = IOServiceGetMatchingService(0, matching);
            if root == 0 {
                return None;
            }
            let value = IORegistryEntryCreateCFProperty(root, Retained::as_ptr(&key).cast(), std::ptr::null(), 0);
            IOObjectRelease(root);
            if value.is_null() {
                return None;
            }
            let closed = (CFGetTypeID(value) == CFBooleanGetTypeID()).then(|| CFBooleanGetValue(value) != 0);
            CFRelease(value);
            closed
        }
    }

    /// The local time as hours and minutes, for the status line (the lid keeper's
    /// too, lid_awake.rs).
    pub fn clock() -> String {
        // SAFETY: time(NULL) answers the time; localtime_r fills the struct it is
        // given and answers NULL on failure.
        unsafe {
            let now = libc::time(std::ptr::null_mut());
            let mut tm: libc::tm = std::mem::zeroed();
            if libc::localtime_r(&now, &mut tm).is_null() {
                return String::new();
            }
            format!("{:02}:{:02}", tm.tm_hour, tm.tm_min)
        }
    }

    /// How many displays other than the built-in one are on (an external display
    /// that sleeps does not count).
    fn other_displays_awake() -> usize {
        let mut displays = [0u32; 16];
        let mut count = 0u32;
        // SAFETY: the buffer holds 16 IDs and the call is told so.
        if unsafe { CGGetOnlineDisplayList(16, displays.as_mut_ptr(), &mut count) } != 0 {
            return 0;
        }
        displays[..(count as usize).min(displays.len())]
            .iter()
            // SAFETY: both take any display ID and answer a boolean.
            .filter(|&&display| unsafe { CGDisplayIsBuiltin(display) == 0 && CGDisplayIsAsleep(display) == 0 })
            .count()
    }

    /// "Battery Power" as the source in use; "AC Power", "UPS Power" and no
    /// answer count as the adapter. The same reading as Keep This Mac Awake's.
    fn on_battery() -> bool {
        // SAFETY: IOPSCopyPowerSourcesInfo returns an owned CFTypeRef or NULL,
        // released below. IOPSGetProvidingPowerSourceType returns a CFStringRef
        // owned by that snapshot (the Get rule), read before the release; a
        // CFString is toll-free bridged to NSString.
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

    /// Whether a LogoLight runs that drives the logo with the same fades and
    /// would fight a blink: one from before it learnt to step aside.
    pub fn driven_elsewhere() -> bool {
        logolight() == Some(false)
    }

    /// Whether a LogoLight runs that steps aside while the marker says a blink
    /// runs (`LogoLightStepsAsideForCodeman` in its Info.plist).
    pub fn steps_aside_elsewhere() -> bool {
        logolight() == Some(true)
    }

    /// LogoLight's own key for its side of the contract (its `CodemanLoan`).
    const STEPS_ASIDE_KEY: &str = "LogoLightStepsAsideForCodeman";

    /// Whether LogoLight runs (None if not), and if so whether it steps aside.
    /// Its Info.plist is read once per process: an update relaunches it.
    fn logolight() -> Option<bool> {
        static SEEN: Mutex<Option<(libc::pid_t, bool)>> = Mutex::new(None);
        let pid = find(LOGOLIGHT)?;
        if let Some((seen, answer)) = SEEN.lock().ok().and_then(|seen| *seen) {
            if seen == pid {
                return Some(answer);
            }
        }
        let answer = steps_aside(pid);
        if let Ok(mut seen) = SEEN.lock() {
            *seen = Some((pid, answer));
        }
        Some(answer)
    }

    /// Whether the app bundle this process runs from says it steps aside. Read
    /// from the file each time, never through NSBundle, which keeps what it read
    /// for a path for the life of this process.
    fn steps_aside(pid: libc::pid_t) -> bool {
        let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the buffer is as long as the call is told, and the answer is
        // how much of it the path filled.
        let len = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        let Some(path) = usize::try_from(len)
            .ok()
            .and_then(|len| std::str::from_utf8(&path[..len]).ok())
        else {
            return false;
        };
        let Some(app) = std::path::Path::new(path)
            .ancestors()
            .find(|dir| dir.extension().is_some_and(|ext| ext == "app"))
        else {
            return false;
        };
        let info = app.join("Contents").join("Info.plist");
        let Some(info) = info.to_str() else {
            return false;
        };
        autoreleasepool(|_| {
            let Some(class) = AnyClass::get(c"NSDictionary") else {
                return false;
            };
            let info = NSString::from_str(info);
            // SAFETY: NSDictionary's class method takes a path and answers the
            // property list there (XML or binary), or nil.
            let plist: Option<Retained<AnyObject>> = unsafe { msg_send![class, dictionaryWithContentsOfFile: &*info] };
            let Some(plist) = plist else { return false };
            let Some(plist) = plist.downcast_ref::<NSDictionary>() else {
                return false;
            };
            let key = NSString::from_str(STEPS_ASIDE_KEY);
            // SAFETY: an NSDictionary answers objectForKey:, with nil for a key it
            // does not have.
            let value: Option<Retained<AnyObject>> = unsafe { msg_send![plist, objectForKey: &*key] };
            value.and_then(|value| value.downcast_ref::<NSNumber>().map(|n| n.as_i64() >= 1)) == Some(true)
        })
    }

    /// The first process of this name (the name the kernel keeps, at most 32
    /// bytes, which LogoLight's is well inside).
    fn find(wanted: &[u8]) -> Option<libc::pid_t> {
        // SAFETY: with no buffer it answers how many processes there are.
        let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return None;
        }
        let mut pids = vec![0 as libc::pid_t; count as usize + 32];
        let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        // SAFETY: the buffer is `bytes` long, and the answer is how many it filled.
        let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
        pids.truncate(filled.max(0) as usize);
        pids.into_iter().find(|&pid| {
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
        slept: bool,
    }

    /// More wall-clock time than this, past the monotonic time, in one wait means
    /// the Mac slept: `Instant` stops while it sleeps, the wall clock does not.
    const SLEPT_GAP: Duration = Duration::from_secs(10);

    impl Signals for Live {
        fn wait(&mut self, time: Duration) -> bool {
            let (wall, monotonic) = (std::time::SystemTime::now(), Instant::now());
            let gone = !matches!(self.pipe_closed.recv_timeout(time), Err(RecvTimeoutError::Timeout));
            if wall.elapsed().unwrap_or_default() > monotonic.elapsed() + SLEPT_GAP {
                self.slept = true;
            }
            gone
        }

        fn slept(&mut self) -> bool {
            std::mem::take(&mut self.slept)
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

        let mut signals = Live {
            pipe_closed,
            activity,
            slept: false,
        };
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
            println!("other displays awake: {}", other_displays_awake());
            println!("on battery: {}", on_battery());
            println!("lid sensor: {:?}", lid_sensor());
            println!("clock: {}", clock());
            println!("driven elsewhere: {}", driven_elsewhere());
            println!("steps aside elsewhere: {}", steps_aside_elsewhere());
            println!("finds the shell that ran this (bash): {}", find(b"bash").is_some());
            println!("keyboard backlight IDs: {:?}", keyboard_ids());
            match SystemLogo::open() {
                Some(logo) => println!(
                    "mode {:?}, factor {:?}, lid handled {:?}, keyboards the client can reach {:?}, displays {:?} (one alone: {})",
                    logo.mode(),
                    logo.factor(),
                    logo.lid_handled(),
                    logo.keyboards,
                    logo.display_ids(),
                    logo.per_display
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
        /// `ClamshellUpdate`: true is "the lid is open" to the logo (and closed
        /// to the keyboards and the displays), false is "closed" to everything.
        Lid(bool),
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
    /// a rise from exactly dark held back by `gate`. Asleep, the logo is dark,
    /// and so it is under a closed lid unless told the lid is open, which lets
    /// it move if `through_lid`.
    struct FakeLogo {
        now: Rc<Cell<Duration>>,
        mode: Cell<i64>,
        awake: Cell<bool>,
        /// The lid sensor.
        lid: Cell<Option<bool>>,
        /// `CBClamshellState`: the daemon has handled the closed lid.
        handled: Cell<Option<bool>>,
        /// What the logo was last told about the lid (true: open).
        told_open: Cell<bool>,
        through_lid: Cell<bool>,
        statuses: RefCell<Vec<LidStatus>>,
        keyboards_reachable: Cell<bool>,
        battery: Cell<bool>,
        elsewhere: Cell<bool>,
        aside: Cell<bool>,
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
                lid: Cell::new(Some(false)),
                handled: Cell::new(Some(false)),
                told_open: Cell::new(false),
                through_lid: Cell::new(true),
                statuses: RefCell::new(Vec::new()),
                keyboards_reachable: Cell::new(true),
                battery: Cell::new(false),
                elsewhere: Cell::new(false),
                aside: Cell::new(false),
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

        /// The lid closes and the daemon handles it: the built-in display goes,
        /// and every module is told the lid is closed.
        fn close_the_lid(&self) {
            self.awake.set(false);
            self.lid.set(Some(true));
            self.handled.set(Some(true));
            self.told_open.set(false);
        }

        /// The lid opens: the daemon tells every module so, and the display is on.
        fn open_the_lid(&self) {
            self.awake.set(true);
            self.lid.set(Some(false));
            self.handled.set(Some(false));
            self.told_open.set(false);
        }

        /// The logo can be seen: the lid is open and the display on, or the lid
        /// is closed and the logo was told it is open, and that works on this Mac.
        fn shown(&self) -> bool {
            if self.lid.get() == Some(true) {
                self.told_open.get() && self.through_lid.get()
            } else {
                self.awake.get()
            }
        }

        /// The `ClamshellUpdate` writes.
        fn lid_writes(&self) -> Vec<W> {
            self.writes().into_iter().filter(|w| matches!(w, W::Lid(_))).collect()
        }

        fn statuses(&self) -> Vec<LidStatus> {
            self.statuses.borrow().clone()
        }

        /// The writes made from `from` on.
        fn writes_since(&self, from: Duration) -> Vec<W> {
            self.writes
                .borrow()
                .iter()
                .filter(|&&(at, _)| at >= from)
                .map(|&(_, w)| w)
                .collect()
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
            Some(if self.shown() && self.mode.get() == MODE_AUTO {
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
                (self.awake.get() && self.lid.get() != Some(true)) || !lit,
                "a keyboard told to light while the display sleeps or the lid is closed"
            );
            self.record(W::Keyboards(lit));
        }

        fn display_awake(&self) -> bool {
            self.awake.get()
        }

        fn driven_elsewhere(&self) -> bool {
            self.elsewhere.get()
        }

        fn steps_aside_elsewhere(&self) -> bool {
            self.aside.get()
        }

        fn lid_closed(&self) -> Option<bool> {
            self.lid.get()
        }

        fn lid_handled(&self) -> Option<bool> {
            self.handled.get()
        }

        fn tell_lid(&self, open: bool) -> bool {
            if self.refuse_writes.get() || (open && !self.keyboards_reachable.get()) {
                return false;
            }
            self.record(W::Lid(open));
            self.told_open.set(open);
            true
        }

        fn lid_status(&self, status: LidStatus) {
            self.statuses.borrow_mut().push(status);
        }

        fn on_battery(&self) -> bool {
            self.battery.get()
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
    fn an_app_that_steps_aside_is_given_the_marker_and_a_moment_first() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.aside.set(true);
        let (marker, path) = temp_marker("aside");
        let mut first = None;
        let ended = blink(&logo, &marker, &BlinkStyle::Calm.moves(), |time| {
            if first.is_none() {
                first = Some((time, logo.writes().len(), path.exists()));
            }
            logo.advance(time);
            logo.now.get() >= secs(10)
        });
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(
            first,
            Some((LOAN_GRACE, 0, true)),
            "the marker first, then the wait, then the first write"
        );
        assert!(logo.falls() >= 2, "it blinks after the wait");
        assert_eq!(logo.settled_level(), 1.0);
        assert!(!path.exists());

        // With no such app, the first write comes straight away.
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("no-aside");
        let mut first_writes = None;
        blink(&logo, &marker, &BlinkStyle::Calm.moves(), |_| {
            first_writes.get_or_insert(logo.writes().len());
            true
        });
        assert!(first_writes.is_some_and(|writes| writes > 0));
    }

    #[test]
    fn the_app_quitting_during_that_moment_leaves_the_logo_untouched() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.aside.set(true);
        let (marker, path) = temp_marker("aside-quit");
        let ended = blink(&logo, &marker, &BlinkStyle::Calm.moves(), |_| true);
        assert_eq!(ended, Ended::Stopped);
        assert_eq!(logo.writes(), []);
        assert!(!path.exists());
    }

    #[test]
    fn the_marker_names_the_blinker() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("names");
        let mut seen = Vec::new();
        run_until(&logo, &marker, BlinkStyle::Calm, secs(5), |_, _| {
            seen.push(std::fs::read_to_string(&path).ok());
        });
        let pid = format!("{}\n", std::process::id());
        assert!(!seen.is_empty());
        assert!(
            seen.iter().all(|text| text.as_deref() == Some(pid.as_str())),
            "{seen:?}"
        );
        assert!(!path.exists());
    }

    #[test]
    fn no_marker_while_the_blink_waits_for_the_display() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.awake.set(false);
        let (marker, path) = temp_marker("waits");
        let (mut while_asleep, mut once_awake) = (false, false);
        run_until(&logo, &marker, BlinkStyle::Calm, secs(10), |logo, now| {
            if logo.awake.get() {
                once_awake |= path.exists();
            } else {
                while_asleep |= path.exists();
            }
            logo.awake.set(now >= secs(4));
        });
        assert!(
            !while_asleep,
            "a LogoLight with the lid closed is not paused for nothing"
        );
        assert!(once_awake);
        assert!(!path.exists());
    }

    /// The times of the writes made from `from` to `to`.
    fn write_times(logo: &FakeLogo, from: Duration, to: Duration) -> Vec<Duration> {
        logo.writes
            .borrow()
            .iter()
            .map(|&(at, _)| at)
            .filter(|&at| at >= from && at < to)
            .collect()
    }

    #[test]
    fn a_blink_right_after_another_does_not_wait_for_logolight_again() {
        let styles = BlinkStyles {
            waiting: BlinkStyle::Fast,
            ..WORK
        };
        let logo = FakeLogo::new(MODE_AUTO);
        logo.aside.set(true);
        let (marker, path) = temp_marker("loan-linger");
        let mut script = Script::with(&logo, &[(0, 20_000, working()), (20_000, 40_000, waiting())], 45_000);
        watch(&logo, &marker, styles, &mut script);
        // The first blink waits: the work settles, the marker goes down, then the wait.
        let first = write_times(&logo, Duration::ZERO, secs(60))[0];
        assert!(first >= SETTLE + LOAN_GRACE, "first write at {first:?}");
        // The change to waiting ends it and starts the next, with LogoLight still paused.
        let around = write_times(&logo, secs(22), secs(30));
        let gap = around.windows(2).map(|w| w[1] - w[0]).max().expect("writes");
        assert!(gap < LOAN_GRACE, "a pause of {gap:?} at the change");
        assert!(!path.exists());
    }

    #[test]
    fn a_blink_after_a_rest_waits_for_logolight_again() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.aside.set(true);
        let (marker, _) = temp_marker("loan-again");
        let mut script = Script::new(&logo, &[(0, 10_000), (20_000, 30_000)], 35_000);
        watch(&logo, &marker, WORK, &mut script);
        // The first ends once the rest has settled; the second waits like the first.
        let second = write_times(&logo, secs(15), secs(60));
        assert!(
            second[0] >= secs(20) + SETTLE + LOAN_GRACE,
            "its first write at {:?}",
            second[0]
        );
    }

    #[test]
    fn under_the_closed_lid_the_marker_and_the_wait_come_before_the_logo_is_told() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.aside.set(true);
        logo.close_the_lid();
        let (marker, path) = temp_marker("loan-lid");
        let mut first = None;
        blink(&logo, &marker, &BlinkStyle::Calm.moves(), |time| {
            if first.is_none() {
                first = Some((time, logo.writes().len(), path.exists()));
            }
            logo.advance(time);
            logo.now.get() >= secs(20)
        });
        assert_eq!(first, Some((LOAN_GRACE, 0, true)));
        assert_eq!(
            logo.writes().first(),
            Some(&W::Lid(true)),
            "then the lid, then the blink"
        );
        assert_eq!(logo.statuses(), [LidStatus::Blinking]);
        assert!(!path.exists());
    }

    #[test]
    fn recover_leaves_the_closed_lid_to_a_logolight() {
        for (elsewhere, aside) in [(true, false), (false, true)] {
            let logo = FakeLogo::new(MODE_AUTO);
            logo.elsewhere.set(elsewhere);
            logo.aside.set(aside);
            let (marker, path) = temp_marker("lid-logolight");
            assert!(marker.set());
            logo.close_the_lid();
            // LogoLight lights the logo under the lid.
            logo.told_open.set(true);
            recover(&logo, &marker, &Marker(None));
            assert_eq!(logo.lid_writes(), [], "elsewhere {elsewhere}, aside {aside}");
            assert!(path.exists(), "tried again at a launch with the lid open");
        }
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

    /// Run `style` with the lid closed from the start, until `stop_at`.
    fn under_the_lid(logo: &FakeLogo, style: BlinkStyle, stop_at: Duration) -> Ended {
        logo.close_the_lid();
        let (marker, _) = temp_marker("under-lid");
        run(logo, &marker, style, stop_at)
    }

    #[test]
    fn with_the_lid_closed_it_blinks_on_and_the_keyboards_stay_dark() {
        for style in [BlinkStyle::Breathe, BlinkStyle::Calm, BlinkStyle::Alarm] {
            let logo = FakeLogo::new(MODE_AUTO);
            let (marker, path) = temp_marker("lid-blinks");
            let mut closed_at = None;
            run_until(&logo, &marker, style, secs(60), |logo, now| {
                if now >= secs(10) && closed_at.is_none() {
                    logo.close_the_lid();
                    closed_at = Some(now);
                }
            });
            let since = logo.writes_since(closed_at.unwrap());
            let told = since
                .iter()
                .position(|w| *w == W::Lid(true))
                .expect("told the lid is open");
            assert_eq!(
                since[..told].iter().filter(|w| **w == W::Keyboards(false)).count(),
                1,
                "{style:?}: the keyboards are told the display is off first"
            );
            let falls = since[told..].iter().filter(|w| **w == W::Heading(false)).count();
            assert!(falls >= 5, "{style:?}: it blinks on under the lid ({falls} Blanks)");
            assert!(
                !since[told..].contains(&W::Keyboards(true)),
                "{style:?}: no keyboard lit under the closed lid"
            );
            // Told once, and at the end: back to normal, then the lid is closed
            // again, so it goes dark.
            assert_eq!(logo.lid_writes(), [W::Lid(true), W::Lid(false)], "{style:?}");
            assert_eq!(
                &since[since.len() - 2..],
                [W::Heading(true), W::Lid(false)],
                "{style:?}"
            );
            assert_eq!(logo.statuses(), [LidStatus::Blinking], "{style:?}");
            assert_eq!(logo.last_duration(), Some(0.0));
            assert!(!path.exists(), "{style:?}");
        }
    }

    #[test]
    fn the_logo_is_told_once_the_daemon_has_handled_the_lid() {
        // The sensor says closed first; the daemon's own update would undo ours.
        let logo = FakeLogo::new(MODE_AUTO);
        logo.awake.set(false);
        logo.lid.set(Some(true));
        logo.handled.set(Some(false));
        let (marker, _) = temp_marker("lid-late");
        run_until(&logo, &marker, BlinkStyle::Calm, secs(20), |logo, now| {
            if now >= secs(1) {
                logo.handled.set(Some(true));
            }
        });
        let told_at = |logo: &FakeLogo| {
            logo.writes
                .borrow()
                .iter()
                .find(|(_, w)| *w == W::Lid(true))
                .map(|&(at, _)| at)
        };
        let first = told_at(&logo).expect("told once the daemon had it");
        assert!(first >= secs(1) && first < secs(2), "told at {first:?}");
        assert_eq!(logo.statuses(), [LidStatus::Blinking]);

        // A daemon that never says so (or cannot) does not hold the logo up for long.
        for handled in [Some(false), None] {
            let logo = FakeLogo::new(MODE_AUTO);
            logo.awake.set(false);
            logo.lid.set(Some(true));
            logo.handled.set(handled);
            let (marker, _) = temp_marker("lid-unhandled");
            run(&logo, &marker, BlinkStyle::Calm, secs(20));
            let first = told_at(&logo).expect("told anyway");
            assert!(
                first <= LOOK_EVERY * LID_HANDLED_LOOKS,
                "{handled:?}: told at {first:?}"
            );
        }
    }

    #[test]
    fn a_closed_lid_that_keeps_the_logo_dark_says_so_and_tries_again_now_and_then() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.through_lid.set(false);
        let (marker, path) = temp_marker("lid-dark");
        logo.close_the_lid();
        let mut tells_at_a_minute = None;
        run_until(&logo, &marker, BlinkStyle::Calm, secs(130), |logo, now| {
            if now >= secs(60) && tells_at_a_minute.is_none() {
                tells_at_a_minute = Some(logo.lid_writes().len());
            }
        });
        assert_eq!(logo.statuses(), [LidStatus::StayedDark]);
        let lid = logo.lid_writes();
        assert!(
            lid[..lid.len() - 1].iter().all(|w| *w == W::Lid(true)),
            "never told closed in between: {lid:?}"
        );
        assert_eq!(lid.last(), Some(&W::Lid(false)), "put back at the end");
        // Three tries in the first seconds, then one about every half minute.
        let early = tells_at_a_minute.unwrap();
        assert!(
            (LID_TRIES as usize..=LID_TRIES as usize + 2).contains(&early),
            "{early}"
        );
        let later = lid.len() - 1 - early;
        assert!((1..=3).contains(&later), "{later} more in the next 70 s");
        assert!(!path.exists());
    }

    #[test]
    fn a_dark_lid_that_lights_later_says_it_blinks() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.through_lid.set(false);
        logo.close_the_lid();
        let (marker, _) = temp_marker("lid-later");
        run_until(&logo, &marker, BlinkStyle::Calm, secs(120), |logo, now| {
            if now >= secs(20) {
                logo.through_lid.set(true);
            }
        });
        assert_eq!(logo.statuses(), [LidStatus::StayedDark, LidStatus::Blinking]);
        assert!(logo.falls() >= 10, "and blinks on from there");
    }

    #[test]
    fn a_logo_the_daemon_takes_back_is_told_again() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.close_the_lid();
        let (marker, _) = temp_marker("lid-taken");
        let mut taken = false;
        let mut back = false;
        run_until(&logo, &marker, BlinkStyle::Breathe, secs(80), |logo, now| {
            if now >= secs(30) && !taken {
                // A keyboard came up: the daemon tells every module the lid is closed.
                logo.told_open.set(false);
                taken = true;
            }
            if now >= secs(45) && logo.factor().is_some_and(|f| f > 0.5) {
                back = true;
            }
        });
        assert!(back, "lit again under the lid");
        assert_eq!(logo.lid_writes(), [W::Lid(true), W::Lid(true), W::Lid(false)]);
        assert_eq!(logo.statuses(), [LidStatus::Blinking]);
    }

    #[test]
    fn the_lid_opening_ends_it_without_a_word_to_the_lid() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.close_the_lid();
        let (marker, path) = temp_marker("lid-opens");
        run_until(&logo, &marker, BlinkStyle::Calm, secs(40), |logo, now| {
            if now >= secs(20) && !logo.awake.get() {
                logo.open_the_lid();
            }
        });
        assert_eq!(logo.lid_writes(), [W::Lid(true)], "the daemon told it the lid is open");
        assert!(
            logo.writes_since(secs(21)).contains(&W::Keyboards(true)),
            "the keyboards follow the blink again"
        );
        assert_eq!(logo.settled_level(), 1.0);
        assert!(!path.exists());
    }

    #[test]
    fn unplugged_under_the_lid_the_logo_goes_dark() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.close_the_lid();
        let (marker, _) = temp_marker("lid-unplugged");
        let mut falls_once_dark = None;
        run_until(&logo, &marker, BlinkStyle::Calm, secs(40), |logo, now| {
            logo.battery.set(now >= secs(20));
            if now >= secs(23) && falls_once_dark.is_none() {
                falls_once_dark = Some(logo.falls());
            }
        });
        assert_eq!(logo.lid_writes(), [W::Lid(true), W::Lid(false)]);
        assert_eq!(logo.statuses(), [LidStatus::Blinking, LidStatus::OnBattery]);
        assert_eq!(Some(logo.falls()), falls_once_dark, "no blink on battery");
        assert!(
            !logo.writes_since(secs(23)).contains(&W::Heading(true)),
            "and nothing lights it: the Mac is about to sleep"
        );
    }

    #[test]
    fn on_battery_or_with_keyboards_out_of_reach_a_closed_lid_stays_dark() {
        for (battery, keyboards, status) in [
            (true, true, LidStatus::OnBattery),
            (false, false, LidStatus::NoKeyboards),
        ] {
            let logo = FakeLogo::new(MODE_AUTO);
            logo.battery.set(battery);
            logo.keyboards_reachable.set(keyboards);
            under_the_lid(&logo, BlinkStyle::Calm, secs(30));
            assert_eq!(logo.lid_writes(), [], "{status:?}");
            assert!(!logo.writes().contains(&W::Heading(false)), "{status:?}");
            assert_eq!(logo.statuses(), [status]);
        }
    }

    #[test]
    fn a_display_that_only_sleeps_is_not_a_closed_lid() {
        for (lid, statuses) in [(Some(false), vec![]), (None, vec![LidStatus::NoLidSensor])] {
            let logo = FakeLogo::new(MODE_AUTO);
            logo.awake.set(false);
            logo.lid.set(lid);
            let (marker, _) = temp_marker("lid-asleep");
            run(&logo, &marker, BlinkStyle::Calm, secs(30));
            assert_eq!(logo.writes(), [], "{lid:?}");
            assert_eq!(logo.statuses(), statuses, "{lid:?}");
        }
    }

    #[test]
    fn the_lid_sensor_wins_over_a_display_list_that_still_has_the_display() {
        // What a Mac kept awake with no other display shows: the built-in display
        // stays online and is not called asleep.
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("lid-sensor");
        run_until(&logo, &marker, BlinkStyle::Calm, secs(40), |logo, now| {
            if now >= secs(10) && logo.lid.get() != Some(true) {
                logo.lid.set(Some(true));
                logo.handled.set(Some(true));
                logo.told_open.set(false);
            }
        });
        let since = logo.writes_since(secs(10));
        let told = since
            .iter()
            .position(|w| *w == W::Lid(true))
            .expect("told the lid is open");
        assert!(
            !since[told..].contains(&W::Keyboards(true)),
            "no keyboard lit under the lid"
        );
        assert_eq!(logo.statuses(), [LidStatus::Blinking]);
    }

    #[test]
    fn recover_darkens_a_logo_a_killed_child_left_lit_under_the_closed_lid() {
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, path) = temp_marker("lid-killed");
        assert!(marker.set());
        logo.close_the_lid();
        assert!(logo.tell_lid(true));
        recover(&logo, &marker, &Marker(None));
        let writes = logo.writes();
        assert_eq!(&writes[writes.len() - 2..], [W::Heading(true), W::Lid(false)]);
        assert!(!path.exists());
    }

    #[test]
    fn the_status_line_reads_like_the_menu() {
        assert_eq!(LidStatus::Blinking.text(), "blinking");
        for status in [
            LidStatus::Blinking,
            LidStatus::StayedDark,
            LidStatus::OnBattery,
            LidStatus::NoKeyboards,
            LidStatus::NoLidSensor,
            LidStatus::Idle,
            LidStatus::SwitchedOff,
            LidStatus::LogoLight,
            LidStatus::Refused,
            LidStatus::Slept,
        ] {
            let text = status.text();
            assert!(
                !text.is_empty() && text.len() < 45 && !text.contains('\n'),
                "{status:?}"
            );
        }
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
        /// When the Mac is found to have slept, once.
        slept_at: Option<u64>,
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
                slept_at: None,
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

        fn slept(&mut self) -> bool {
            let due = self.slept_at.is_some_and(|at| self.elapsed_ms() >= at);
            if due {
                self.slept_at = None;
            }
            due
        }
    }

    #[test]
    fn with_the_lid_closed_and_no_agent_at_work_the_line_says_so() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.close_the_lid();
        let (marker, _) = temp_marker("watch-lid-idle");
        let mut script = Script::new(&logo, &[], 20_000);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.statuses(), [LidStatus::Idle]);
        assert_eq!(logo.writes(), []);
    }

    #[test]
    fn with_the_lid_closed_a_declined_blink_says_why() {
        for (mode, elsewhere, why) in [
            (MODE_OFF, false, LidStatus::SwitchedOff),
            (MODE_AUTO, true, LidStatus::LogoLight),
        ] {
            let logo = FakeLogo::new(mode);
            logo.elsewhere.set(elsewhere);
            logo.close_the_lid();
            let (marker, _) = temp_marker("watch-lid-declined");
            let mut script = Script::new(&logo, &[(0, 30_000)], 30_000);
            watch(&logo, &marker, WORK, &mut script);
            // Idle while the work settles, then the reason.
            assert_eq!(logo.statuses(), [LidStatus::Idle, why]);
        }
    }

    #[test]
    fn a_sleep_under_the_closed_lid_is_the_line_too() {
        // Seen at a dark wake: the lid is still closed.
        let logo = FakeLogo::new(MODE_AUTO);
        logo.close_the_lid();
        let (marker, _) = temp_marker("watch-slept");
        let mut script = Script::new(&logo, &[], 20_000);
        script.slept_at = Some(100);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.statuses(), [LidStatus::Slept]);

        // A sleep with the lid open says nothing about the lid.
        let logo = FakeLogo::new(MODE_AUTO);
        let (marker, _) = temp_marker("watch-slept-open");
        let mut script = Script::new(&logo, &[], 20_000);
        script.slept_at = Some(5_000);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.statuses(), []);
    }

    #[test]
    fn work_then_rest_under_the_closed_lid_reads_blinking_then_idle() {
        let logo = FakeLogo::new(MODE_AUTO);
        logo.close_the_lid();
        let (marker, _) = temp_marker("watch-lid-work");
        let mut script = Script::new(&logo, &[(0, 30_000)], 50_000);
        watch(&logo, &marker, WORK, &mut script);
        assert_eq!(logo.statuses(), [LidStatus::Idle, LidStatus::Blinking, LidStatus::Idle]);
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
