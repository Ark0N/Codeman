//! With the Lid Closed: keeping a closed MacBook awake, with no password.
//!
//! macOS sleeps when the lid closes whatever power assertions an app holds. What
//! stops it is one switch in the kernel's power management root (`IOPMrootDomain`):
//! lid sleep off (`kPMSetClamshellSleepState`, a call any process may make). With it
//! set a closed lid changes nothing: the Mac stays at full wake, which is also what
//! lets the Apple logo go on blinking under the lid (logo.rs). It is the method
//! LogoLight ships as Lit with Lid Closed, measured there on a MacBook Pro. Codeman
//! 1.50.1 did the same job with a root helper and `pmset disablesleep`, behind the
//! administrator password.
//!
//! The switch has no owner, which is what the rest of this file is about (read from
//! Apple's open sources, `IOPMrootDomain.cpp` and powerd's `PMAssertions.c`):
//!
//! - The kernel keeps it after the process that set it has gone, and honours it on
//!   battery too. Left set, a Mac in a bag stays awake.
//! - It is one bit, shared. macOS's own power daemon writes it when its own reasons
//!   change, and LogoLight writes it for its feature. Whoever writes last wins.
//! - On an Apple silicon Mac it is also what keeps a docked MacBook awake with its
//!   lid closed: the window server tells the power daemon about the external
//!   display, and the daemon sets this bit, once, when that changes. A zero written
//!   by anyone else then stays until the display or the power adapter next changes.
//! - Clearing it while the lid is closed puts the Mac to sleep at once.
//!
//! So a child process holds it (this same binary with `LID_ARG`), and does nothing
//! else. The app's keep-awake worker starts it when the lid is to be covered and
//! writes a byte down a pipe on every look. The child:
//!
//! - sets the switch again every second, so a write by anyone else is undone within
//!   a second, and holds two power assertions with it (against system sleep and
//!   idle sleep), the three LogoLight measured together;
//! - reads the power source itself and holds nothing on battery, whatever the app
//!   says;
//! - writes nothing at all while an external display is connected: macOS's own
//!   closed-lid mode holds the switch then, and a zero from here would put a docked
//!   Mac to sleep, or leave it without that mode until the display is plugged in
//!   again. The Mac is kept awake by the assertions meanwhile, and what the child
//!   set before the display came is cleared once the display has been gone for
//!   `SETTLE`, for which the child outlives the app if it has to;
//! - lets go when the pipe closes, however the app ended (quit, crash, Force Quit),
//!   and when the app has not written for `STALE` (an app that hangs): the
//!   assertions first, then the switch, so a closed Mac goes straight to sleep;
//! - leaves the switch alone on its way out while LogoLight holds it for itself
//!   (LogoLight sets it once and would not notice it gone), and LogoLight's own
//!   release turns it off;
//! - ignores the signals that arrive together with the app's end, as the logo child
//!   does, so the pipe is its one way out.
//!
//! One child at a time may hold it: a lock on a file next to the app's settings
//! (`lid-awake`), taken before the first write. The file is non-empty while the
//! switch may be set, so a child that was killed leaves a file that is marked and
//! unlocked: the app turns lid sleep back on when it sees a child end, and at its next
//! launch (`heal`). Until then the Mac stays awake under a closed lid, which only a
//! SIGKILL of the child together with the app, or a kernel that stops answering, can
//! cause; a restart of the Mac clears the switch as well.
//!
//! The child tells the app what it did in lines on its standard output (`Said`):
//! that the kernel took the call, that a display is connected and nothing was
//! written, that the Mac is on battery, that the call was refused, and that the Mac
//! slept all the same (wall-clock time that passed while the monotonic clock stood
//! still), which the menu's status line then says. A display has its own word on
//! purpose: a Mac that sleeps although the line said the lid was covered would leave
//! nothing to go by.

use std::time::{Duration, Instant};

/// The argument that makes this binary the lid keeper instead of the app.
pub const LID_ARG: &str = "--keep-awake-lid";

/// How often the child sets the switch again and reads the power source.
const TICK: Duration = Duration::from_secs(1);
/// The app writes on every look of its worker (every 2 seconds, longer while the
/// server is slow to answer). Without a word for this long the app hangs, and the
/// child lets go.
const STALE: Duration = Duration::from_secs(60);
/// How long no external display must have been seen before the switch is cleared.
/// The display list is short for a moment while displays are being rearranged.
const SETTLE: Duration = Duration::from_secs(5);
/// How often a child looks that only waits for the display to go, so it can clear
/// what it set.
const LINGER: Duration = Duration::from_secs(5);

/// What the app knows about the lid, for the status line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lid {
    /// Not asked for.
    Off,
    /// A child was started and has not said anything yet.
    Starting,
    /// The kernel took the call. `slept`: the Mac slept all the same, until this
    /// time of day.
    Held { slept: Option<String> },
    /// An external display is connected: macOS's own closed-lid mode has the switch,
    /// and the child writes nothing. `slept` as for `Held`.
    Docked { slept: Option<String> },
    /// The child reads the power source as the battery.
    OnBattery,
    /// The kernel turned the call down.
    Refused,
    /// The child could not start, or could not keep its file.
    Failed,
}

/// A line from the child to the app.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Said {
    Held,
    /// Nothing is written: an external display is connected.
    Docked,
    OnBattery,
    Refused,
    Failed,
    /// The Mac slept while the child held, until this time of day.
    Slept(String),
}

impl Said {
    fn line(&self) -> String {
        match self {
            Said::Held => "held".into(),
            Said::Docked => "docked".into(),
            Said::OnBattery => "battery".into(),
            Said::Refused => "refused".into(),
            Said::Failed => "failed".into(),
            Said::Slept(until) => format!("slept {until}"),
        }
    }

    fn parse(line: &str) -> Option<Said> {
        match line.trim() {
            "held" => Some(Said::Held),
            "docked" => Some(Said::Docked),
            "battery" => Some(Said::OnBattery),
            "refused" => Some(Said::Refused),
            "failed" => Some(Said::Failed),
            other => other
                .strip_prefix("slept ")
                .map(|until| Said::Slept(until.trim().to_owned())),
        }
    }
}

/// What the app's reader has heard from one child.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Heard {
    /// The last state line.
    said: Option<Said>,
    slept: Option<String>,
    /// The child has exited.
    gone: bool,
}

impl Heard {
    fn hear(&mut self, said: Said) {
        match said {
            Said::Slept(until) => self.slept = Some(until),
            state => self.said = Some(state),
        }
    }

    /// What a running child's last word means. `slept` is the app's own note, which
    /// outlives one child.
    fn lid(&self, slept: Option<String>) -> Lid {
        match self.said {
            None | Some(Said::Slept(_)) => Lid::Starting,
            Some(Said::Held) => Lid::Held { slept },
            Some(Said::Docked) => Lid::Docked { slept },
            Some(Said::OnBattery) => Lid::OnBattery,
            Some(Said::Refused) => Lid::Refused,
            Some(Said::Failed) => Lid::Failed,
        }
    }
}

/// What the app said while the child waited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Told {
    Nothing,
    /// The app wrote: it is alive and still wants the lid covered.
    Beat,
    /// The pipe closed: the app stopped asking, or is gone.
    Closed,
}

/// Whether the lock on the file was had.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Taken {
    Yes,
    /// Another child holds it.
    Busy,
    /// The file cannot be opened or locked: without it nothing could undo the
    /// switch after a kill, so nothing is held.
    Broken,
}

/// What the child does to the Mac, so tests can stand in for it.
trait Kernel {
    /// Turn lid sleep off, or back on. Whether the kernel took it.
    fn set_lid_sleep_disabled(&mut self, disabled: bool) -> bool;
    /// Hold or release the assertions against system sleep and idle sleep.
    fn assert_awake(&mut self, hold: bool);
    fn on_battery(&mut self) -> bool;
    /// An external display is connected: macOS's own closed-lid mode has the switch.
    fn docked(&mut self) -> bool;
    /// Another app (LogoLight) holds lid sleep off for itself right now.
    fn held_elsewhere(&mut self) -> bool;
}

/// The file next to the app's settings: locked while a child lives, non-empty while
/// the switch may be set.
trait Claim {
    fn try_take(&mut self) -> Taken;
    fn marked(&mut self) -> bool;
    /// Mark the file or empty it. False when it could not be written.
    fn mark(&mut self, held: bool) -> bool;
}

/// The child's clock, pipe and voice.
trait Signals {
    /// Waits up to `time` for a word from the app.
    fn wait(&mut self, time: Duration) -> Told;
    fn now(&self) -> Instant;
    /// The time of day, when the last wait spanned a sleep of the Mac. Asked once
    /// per wait.
    fn slept(&mut self) -> Option<String>;
    fn say(&mut self, said: &Said);
    /// Waits `time` with nothing to listen for (the pipe has closed).
    fn pause(&mut self, time: Duration);
}

/// Why the child ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ended {
    /// The pipe closed.
    Released,
    /// The app stopped writing.
    Stale,
    Refused,
    Failed,
}

/// Says a state once, not on every tick.
fn tell(signals: &mut impl Signals, last: &mut Option<Said>, said: Said) {
    if last.as_ref() != Some(&said) {
        signals.say(&said);
        *last = Some(said);
    }
}

/// What the child knows about its file and the display between ticks.
#[derive(Default)]
struct Ours {
    /// This child has the lock.
    claimed: bool,
    /// The switch may be set by a Codeman child: this one, or one that was killed
    /// and left the file marked.
    marked: bool,
    /// Since when no external display has been seen.
    undocked_since: Option<Instant>,
}

impl Ours {
    fn see(&mut self, docked: bool, now: Instant) {
        match docked {
            true => self.undocked_since = None,
            false => self.undocked_since = self.undocked_since.or(Some(now)),
        }
    }

    /// Clears what a Codeman child set, once no display has been seen for `SETTLE`:
    /// until then the switch may be what keeps a docked Mac awake. It also stays
    /// while LogoLight holds it for itself. The caller has let go of the assertions
    /// first: with the lid closed, clearing the switch is what puts the Mac to
    /// sleep, and an assertion still held then would make that a dark wake.
    fn settle(&mut self, kernel: &mut impl Kernel, claim: &mut impl Claim, now: Instant) {
        let undocked = self
            .undocked_since
            .is_some_and(|since| now.duration_since(since) >= SETTLE);
        if self.marked && undocked {
            if !kernel.held_elsewhere() {
                kernel.set_lid_sleep_disabled(false);
            }
            claim.mark(false);
            self.marked = false;
        }
    }
}

/// The child's whole life.
fn keep(kernel: &mut impl Kernel, claim: &mut impl Claim, signals: &mut impl Signals) -> Ended {
    let mut ours = Ours::default();
    // The Mac is meant to stay awake under a closed lid: by this child's switch, or
    // at a display by macOS's own closed-lid mode.
    let mut awake = false;
    let mut last = None;
    let mut last_beat = signals.now();
    let ended = loop {
        let told = signals.wait(TICK);
        // Only a sleep that happened while the Mac was meant to stay awake is worth a
        // word: at a display too, where a sleep says this is not macOS's closed-lid
        // mode after all.
        let slept = signals.slept().filter(|_| awake);
        match told {
            Told::Closed => break Ended::Released,
            Told::Beat => last_beat = signals.now(),
            Told::Nothing => {}
        }
        let now = signals.now();
        if now.duration_since(last_beat) >= STALE {
            break Ended::Stale;
        }
        if !ours.claimed {
            match claim.try_take() {
                Taken::Yes => {
                    ours.claimed = true;
                    // A child that was killed left its mark: this one's to clear now.
                    ours.marked = claim.marked();
                }
                // The child before this one still has the file.
                Taken::Busy => {}
                Taken::Broken => break Ended::Failed,
            }
        }
        let battery = kernel.on_battery();
        let docked = kernel.docked();
        ours.see(docked, now);
        if battery || docked {
            // Not this child's to hold. On battery nothing keeps the Mac awake.
            // Docked, macOS's own closed-lid mode does, with the same switch, so it
            // is neither set nor cleared here, and the assertions do the rest.
            awake = !battery;
            kernel.assert_awake(awake);
            ours.settle(kernel, claim, now);
            if let Some(until) = slept.filter(|_| awake) {
                signals.say(&Said::Slept(until));
            }
            tell(signals, &mut last, if battery { Said::OnBattery } else { Said::Docked });
            continue;
        }
        if !ours.claimed {
            continue;
        }
        if !ours.marked {
            // Marked before the first write, so a kill right after it is seen.
            if !claim.mark(true) {
                break Ended::Failed;
            }
            ours.marked = true;
        }
        kernel.assert_awake(true);
        awake = true;
        // Every tick: macOS's power daemon and LogoLight write the same switch.
        if !kernel.set_lid_sleep_disabled(true) {
            break Ended::Refused;
        }
        if let Some(until) = slept {
            signals.say(&Said::Slept(until));
        }
        tell(signals, &mut last, Said::Held);
    };
    kernel.assert_awake(false);
    match ended {
        Ended::Refused => signals.say(&Said::Refused),
        Ended::Failed => signals.say(&Said::Failed),
        Ended::Released | Ended::Stale => {}
    }
    // What is left of this child's goes at once, unless a display is connected (or
    // was a moment ago): then the child waits for it to go, however long.
    loop {
        ours.settle(kernel, claim, signals.now());
        if !ours.marked {
            break ended;
        }
        signals.pause(LINGER);
        let docked = kernel.docked();
        ours.see(docked, signals.now());
    }
}

/// Turns lid sleep back on after a child that was killed: its file is marked and
/// nobody holds the lock. Not while a display is connected: the next child to take
/// the file finds the mark and clears it once the display has gone. Whether there
/// was anything to undo.
fn heal_with(kernel: &mut impl Kernel, claim: &mut impl Claim) -> bool {
    if claim.try_take() != Taken::Yes || !claim.marked() || kernel.docked() {
        return false;
    }
    if !kernel.held_elsewhere() {
        kernel.set_lid_sleep_disabled(false);
    }
    claim.mark(false);
    true
}

#[cfg(target_os = "macos")]
pub use system::{child_main, heal, Holder};

#[cfg(not(target_os = "macos"))]
pub fn child_main() -> ! {
    std::process::exit(0)
}

#[cfg(not(target_os = "macos"))]
pub fn heal() {}

#[cfg(target_os = "macos")]
mod system {
    use super::{heal_with, keep, Claim, Ended, Heard, Kernel, Lid, Said, Signals, Taken, Told, LID_ARG};
    use objc2::msg_send;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSString;
    use std::ffi::{c_char, c_void};
    use std::fs::{File, OpenOptions, TryLockError};
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
    use std::path::PathBuf;
    use std::process::{ChildStdin, Command, Stdio};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime};

    /// `kPMSetClamshellSleepState` (IOKit/pwr_mgt/IOPMLibDefs.h).
    const SET_CLAMSHELL_SLEEP_STATE: u32 = 12;
    /// `kIOPMAssertionLevelOn`.
    const LEVEL_ON: u32 = 255;
    /// What `pmset -g assertions` and Activity Monitor show for the child.
    const HOLDING: &str = "Codeman keeps this Mac awake with the lid closed";
    /// The name LogoLight (1.3.1) gives the assertions it holds exactly while it has
    /// lid sleep off for its own Lit with Lid Closed. It sets the switch once, so a
    /// write of ours under it would end its feature until it is toggled.
    const LOGOLIGHT_HOLDING: &str = "LogoLight keeps the logo lit with the lid closed";
    /// More wall-clock time than this, past the monotonic time, in one wait means
    /// the Mac slept (the logo child's reading, logo.rs).
    const SLEPT_GAP: Duration = Duration::from_secs(10);
    /// Next to `desktop.json`.
    const CLAIM_FILE: &str = "lid-awake";

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGGetOnlineDisplayList(max_displays: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayIsBuiltin(display: u32) -> u32;
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOServiceMatching(name: *const c_char) -> *mut c_void;
        fn IOServiceGetMatchingService(main_port: u32, matching: *mut c_void) -> u32;
        fn IOObjectRelease(object: u32) -> i32;
        fn IOServiceOpen(service: u32, owning_task: u32, kind: u32, connect: *mut u32) -> i32;
        fn IOServiceClose(connect: u32) -> i32;
        fn IOConnectCallScalarMethod(
            connection: u32,
            selector: u32,
            input: *const u64,
            input_count: u32,
            output: *mut u64,
            output_count: *mut u32,
        ) -> i32;
        fn IOPMAssertionCreateWithName(kind: *const c_void, level: u32, name: *const c_void, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
        fn IOPMCopyAssertionsByProcess(by_process: *mut *const c_void) -> i32;
    }

    extern "C" {
        /// What the C macro `mach_task_self()` reads.
        static mach_task_self_: u32;
    }

    /// The power management root, through the user client any process may open.
    pub(super) struct RootDomain {
        /// Kept for the child's life: one call a second needs no new connection.
        connection: Option<u32>,
        assertions: Vec<u32>,
    }

    impl RootDomain {
        pub(super) fn new() -> Self {
            RootDomain {
                connection: None,
                assertions: Vec::new(),
            }
        }

        fn open() -> Option<u32> {
            // SAFETY: IOServiceMatching returns a dictionary that
            // IOServiceGetMatchingService consumes; the service is released once the
            // connection is open. IOServiceOpen fills `connection` on success.
            unsafe {
                let matching = IOServiceMatching(c"IOPMrootDomain".as_ptr());
                if matching.is_null() {
                    return None;
                }
                let root = IOServiceGetMatchingService(0, matching);
                if root == 0 {
                    return None;
                }
                let mut connection = 0u32;
                let opened = IOServiceOpen(root, mach_task_self_, 0, &mut connection);
                IOObjectRelease(root);
                (opened == 0 && connection != 0).then_some(connection)
            }
        }

        fn close(&mut self) {
            if let Some(connection) = self.connection.take() {
                // SAFETY: a connection IOServiceOpen returned, closed once.
                unsafe { IOServiceClose(connection) };
            }
        }
    }

    impl Kernel for RootDomain {
        fn set_lid_sleep_disabled(&mut self, disabled: bool) -> bool {
            let input = u64::from(disabled);
            // A connection that stopped working is opened again, once.
            for _ in 0..2 {
                if self.connection.is_none() {
                    self.connection = Self::open();
                }
                let Some(connection) = self.connection else {
                    return false;
                };
                // SAFETY: one scalar in, as the selector takes, and no output.
                let taken = unsafe {
                    IOConnectCallScalarMethod(
                        connection,
                        SET_CLAMSHELL_SLEEP_STATE,
                        &input,
                        1,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if taken == 0 {
                    return true;
                }
                self.close();
            }
            false
        }

        fn assert_awake(&mut self, hold: bool) {
            if !hold {
                for id in self.assertions.drain(..) {
                    // SAFETY: an ID IOPMAssertionCreateWithName returned, released once.
                    unsafe { IOPMAssertionRelease(id) };
                }
                return;
            }
            if !self.assertions.is_empty() {
                return;
            }
            for kind in ["PreventSystemSleep", "PreventUserIdleSystemSleep"] {
                self.assertions.extend(assertion(kind, HOLDING));
            }
        }

        fn on_battery(&mut self) -> bool {
            crate::keep_awake::on_battery()
        }

        fn docked(&mut self) -> bool {
            external_display_connected()
        }

        fn held_elsewhere(&mut self) -> bool {
            assertion_named(LOGOLIGHT_HOLDING)
        }
    }

    impl Drop for RootDomain {
        fn drop(&mut self) {
            self.close();
        }
    }

    /// Whether a display other than the built-in one is connected, asleep or not: the
    /// nearest an app gets to what the window server tells the power daemon. The
    /// built-in display stays on this list under a closed lid while the Mac is kept
    /// awake without another display. If the list cannot be had the answer is yes,
    /// and nothing is written.
    fn external_display_connected() -> bool {
        // For the tests, on a Mac that has no display to plug in or pull out
        // ("1" or "0"). Not in a release build.
        #[cfg(debug_assertions)]
        if let Some(pretend) = std::env::var_os("CODEMAN_LID_TEST_DISPLAY") {
            return pretend == "1";
        }
        let mut displays = [0u32; 16];
        let mut count = 0u32;
        // SAFETY: the buffer holds 16 IDs and the call is told so.
        if unsafe { CGGetOnlineDisplayList(16, displays.as_mut_ptr(), &mut count) } != 0 {
            return true;
        }
        displays[..(count as usize).min(displays.len())]
            .iter()
            // SAFETY: takes any display ID and answers a boolean.
            .any(|&display| unsafe { CGDisplayIsBuiltin(display) } == 0)
    }

    /// A power assertion of this kind under this name, held until it is released.
    fn assertion(kind: &str, name: &str) -> Option<u32> {
        let (kind, name) = (NSString::from_str(kind), NSString::from_str(name));
        let mut id = 0u32;
        // SAFETY: both are NSStrings, toll-free bridged to the CFStrings the call
        // takes, and alive for the call; `id` is filled on success.
        let created = unsafe {
            IOPMAssertionCreateWithName(
                Retained::as_ptr(&kind).cast(),
                LEVEL_ON,
                Retained::as_ptr(&name).cast(),
                &mut id,
            )
        };
        (created == 0).then_some(id)
    }

    /// Whether any process holds a power assertion of this name. Read from the
    /// description of what `IOPMCopyAssertionsByProcess` answers (a dictionary of
    /// arrays of dictionaries, printed in full), where the name stands as it was
    /// given. Anything unreadable is a no: the switch is then cleared, the safe way.
    fn assertion_named(name: &str) -> bool {
        let mut by_process: *const c_void = std::ptr::null();
        // SAFETY: the call fills the pointer with an owned CFDictionary, or leaves
        // it NULL.
        if unsafe { IOPMCopyAssertionsByProcess(&mut by_process) } != 0 || by_process.is_null() {
            return false;
        }
        autoreleasepool(|_| {
            // SAFETY: an owned CFDictionary is a toll-free bridged NSDictionary, and
            // `from_raw` takes over the reference the call handed out.
            let Some(dictionary) = (unsafe { Retained::from_raw(by_process.cast_mut().cast::<AnyObject>()) }) else {
                return false;
            };
            // SAFETY: every NSObject answers `description` with an NSString.
            let text: Option<Retained<NSString>> = unsafe { msg_send![&*dictionary, description] };
            text.is_some_and(|text| text.to_string().contains(name))
        })
    }

    /// The file and its lock (`flock`, which the kernel drops with the process).
    pub(super) struct FileClaim {
        path: Option<PathBuf>,
        file: Option<File>,
    }

    impl FileClaim {
        pub(super) fn at(path: Option<PathBuf>) -> Self {
            FileClaim { path, file: None }
        }

        fn default_location() -> Self {
            Self::at(crate::config::Config::default_path().map(|path| path.with_file_name(CLAIM_FILE)))
        }
    }

    impl Claim for FileClaim {
        fn try_take(&mut self) -> Taken {
            if self.file.is_some() {
                return Taken::Yes;
            }
            let Some(path) = &self.path else {
                return Taken::Broken;
            };
            if path.parent().is_some_and(|dir| std::fs::create_dir_all(dir).is_err()) {
                return Taken::Broken;
            }
            // Never removed and never truncated on open: its content is the mark.
            let file = match OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(path)
            {
                Ok(file) => file,
                Err(_) => return Taken::Broken,
            };
            match file.try_lock() {
                Ok(()) => {
                    self.file = Some(file);
                    Taken::Yes
                }
                Err(TryLockError::WouldBlock) => Taken::Busy,
                Err(TryLockError::Error(_)) => Taken::Broken,
            }
        }

        fn marked(&mut self) -> bool {
            self.file
                .as_ref()
                .and_then(|file| file.metadata().ok())
                .is_some_and(|data| data.len() > 0)
        }

        fn mark(&mut self, held: bool) -> bool {
            let Some(file) = &mut self.file else {
                return false;
            };
            let write = |file: &mut File| -> std::io::Result<()> {
                file.set_len(0)?;
                if held {
                    file.seek(SeekFrom::Start(0))?;
                    file.write_all(format!("{}\n", std::process::id()).as_bytes())?;
                    file.sync_data()?;
                }
                Ok(())
            };
            write(file).is_ok()
        }
    }

    struct Live {
        told: Receiver<Told>,
        slept: bool,
    }

    impl Signals for Live {
        fn wait(&mut self, time: Duration) -> Told {
            let (wall, monotonic) = (SystemTime::now(), Instant::now());
            let told = match self.told.recv_timeout(time) {
                Ok(told) => told,
                Err(RecvTimeoutError::Timeout) => Told::Nothing,
                Err(RecvTimeoutError::Disconnected) => Told::Closed,
            };
            if wall.elapsed().unwrap_or_default() > monotonic.elapsed() + SLEPT_GAP {
                self.slept = true;
            }
            told
        }

        fn now(&self) -> Instant {
            Instant::now()
        }

        fn slept(&mut self) -> Option<String> {
            std::mem::take(&mut self.slept).then(crate::logo::clock)
        }

        fn say(&mut self, said: &Said) {
            // Never `println!`: it panics once the app has gone, and a panic aborts
            // the child before it has let go.
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{}", said.line());
            let _ = out.flush();
        }

        fn pause(&mut self, time: Duration) {
            std::thread::sleep(time);
        }
    }

    /// The child process. It ends when the pipe from the app closes or goes quiet,
    /// and the signals that would end it sooner are ignored: they arrive together
    /// with the app's own end (a logout, Ctrl-C on a terminal that started the app),
    /// and a child they killed would leave lid sleep off.
    pub fn child_main() -> ! {
        // SAFETY: `signal` with SIG_IGN, before any other thread exists.
        unsafe {
            for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM] {
                libc::signal(signal, libc::SIG_IGN);
            }
        }
        let (tell, told) = mpsc::channel();
        let reader = std::thread::Builder::new().name("lid-pipe".into()).spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 64];
            loop {
                let told = match stdin.read(&mut buf) {
                    Ok(0) => Told::Closed,
                    Ok(_) => Told::Beat,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => Told::Closed,
                };
                if tell.send(told).is_err() || told == Told::Closed {
                    return;
                }
            }
        });
        if reader.is_err() {
            // Nothing would hear the app go.
            std::process::exit(4);
        }
        let mut signals = Live { told, slept: false };
        let ended = keep(&mut RootDomain::new(), &mut FileClaim::default_location(), &mut signals);
        std::process::exit(match ended {
            Ended::Released | Ended::Stale => 0,
            Ended::Refused => 3,
            Ended::Failed => 4,
        })
    }

    /// Turns lid sleep back on if a child of an earlier run was killed before it
    /// could. Called at launch and whenever a child ends.
    pub fn heal() {
        heal_with(&mut RootDomain::new(), &mut FileClaim::default_location());
    }

    struct Running {
        stdin: ChildStdin,
        heard: Arc<Mutex<Heard>>,
    }

    /// The app's side: the pipe to the child, and what it said.
    #[derive(Default)]
    pub struct Holder {
        child: Option<Running>,
        /// The child gave up for good (refused, or no file): not started again until
        /// the lid is asked for anew.
        ended: Option<Lid>,
        /// The Mac slept while a child of this asking held.
        slept: Option<String>,
        /// The app's binary, where the test binary stands in for the app.
        #[cfg(test)]
        exe: Option<PathBuf>,
    }

    impl Holder {
        /// Ask for the lid, or stop asking. Called on every look of the worker: with
        /// `wanted` it is also the word the child waits for.
        pub fn hold(&mut self, wanted: bool) -> Lid {
            if !wanted {
                // Dropping the pipe is the release, the same one a crash takes.
                self.child = None;
                self.ended = None;
                self.slept = None;
                return Lid::Off;
            }
            if let Some(ended) = &self.ended {
                return ended.clone();
            }
            if let Some(running) = &mut self.child {
                let heard = running.heard.lock().map(|heard| heard.clone()).unwrap_or(Heard {
                    gone: true,
                    ..Heard::default()
                });
                if heard.slept.is_some() {
                    self.slept = heard.slept.clone();
                }
                let lid = heard.lid(self.slept.clone());
                let alive = !heard.gone && running.stdin.write_all(b"\n").is_ok() && running.stdin.flush().is_ok();
                if alive {
                    return lid;
                }
                self.child = None;
                if matches!(lid, Lid::Refused | Lid::Failed) {
                    self.ended = Some(lid.clone());
                    return lid;
                }
                // It let go because the app was slow, or was killed: start another.
            }
            self.child = self.exe().and_then(|exe| spawn(&exe));
            match self.child {
                Some(_) => Lid::Starting,
                None => Lid::Failed,
            }
        }
    }

    impl Holder {
        /// The child is this same binary.
        fn exe(&self) -> Option<PathBuf> {
            #[cfg(test)]
            if let Some(exe) = &self.exe {
                return Some(exe.clone());
            }
            std::env::current_exe().ok()
        }
    }

    fn spawn(exe: &std::path::Path) -> Option<Running> {
        let mut child = Command::new(exe)
            .arg(LID_ARG)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        let heard = Arc::new(Mutex::new(Heard::default()));
        let shared = heard.clone();
        std::thread::Builder::new()
            .name("lid-child".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let (Some(said), Ok(mut heard)) = (Said::parse(&line), shared.lock()) {
                        heard.hear(said);
                    }
                }
                let _ = child.wait();
                if let Ok(mut heard) = shared.lock() {
                    heard.gone = true;
                }
                // A child that was killed could not turn lid sleep back on.
                heal();
            })
            .ok()?;
        Some(Running { stdin, heard })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp(name: &str) -> PathBuf {
            let dir = std::env::temp_dir().join(format!("lid-awake-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            dir.join(CLAIM_FILE)
        }

        #[test]
        fn the_file_is_locked_by_one_and_keeps_its_mark_for_the_next() {
            let path = temp("claim");
            let mut first = FileClaim::at(Some(path.clone()));
            assert_eq!(first.try_take(), Taken::Yes, "creates the folder and the file");
            assert_eq!(first.try_take(), Taken::Yes, "taken stays taken");
            assert!(!first.marked());
            let mut second = FileClaim::at(Some(path.clone()));
            assert_eq!(second.try_take(), Taken::Busy);
            assert!(!second.mark(true), "only the holder writes");
            assert!(first.mark(true));
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                format!("{}\n", std::process::id())
            );
            // The holder dies without emptying it: the lock goes, the mark stays.
            drop(first);
            // Not always at once in a test run. Another test that starts a process at
            // this moment hands it a copy of every open file of this one until its
            // exec, and the lock lives as long as the last copy of the file.
            let free = (0..400).any(|_| {
                second.try_take() == Taken::Yes || {
                    std::thread::sleep(Duration::from_millis(5));
                    false
                }
            });
            assert!(free, "the lock outlived its holder");
            assert!(second.marked());
            assert!(second.mark(false));
            assert!(!second.marked());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "");
            drop(second);
            let _ = std::fs::remove_dir_all(path.parent().unwrap());
        }

        #[test]
        fn a_file_that_cannot_be_had_is_broken_not_busy() {
            assert_eq!(FileClaim::at(None).try_take(), Taken::Broken);
            // A folder where the file should be.
            let path = temp("broken");
            std::fs::create_dir_all(&path).unwrap();
            assert_eq!(FileClaim::at(Some(path.clone())).try_take(), Taken::Broken);
            let _ = std::fs::remove_dir_all(path.parent().unwrap());
        }

        /// This process's lines in `pmset -g assertions`.
        fn own_assertions() -> String {
            let out = Command::new("/usr/bin/pmset")
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

        /// The two assertions under their name, and LogoLight's found by its name,
        /// on a real Mac (it reads what the power daemon holds for every process,
        /// so not in the gate): `cargo test --locked the_assertions_are_held -- --ignored --nocapture`.
        #[test]
        #[ignore]
        fn the_assertions_are_held_under_their_name_and_logolights_are_found() {
            let mut root = RootDomain::new();
            root.assert_awake(true);
            root.assert_awake(true);
            let held = own_assertions();
            println!("while it holds:\n{held}");
            assert!(held.contains("PreventSystemSleep"), "{held}");
            assert!(held.contains("PreventUserIdleSystemSleep"), "{held}");
            assert_eq!(held.matches(HOLDING).count(), 2, "held once each: {held}");
            assert!(assertion_named(HOLDING));
            root.assert_awake(false);
            assert!(own_assertions().is_empty());

            // What LogoLight holds while it has lid sleep off for itself.
            let before = root.held_elsewhere();
            let theirs = assertion("PreventSystemSleep", LOGOLIGHT_HOLDING).unwrap();
            assert!(root.held_elsewhere());
            // SAFETY: the ID the call above returned, released once.
            unsafe { IOPMAssertionRelease(theirs) };
            assert_eq!(root.held_elsewhere(), before, "gone with its release");
        }

        /// The app's side against the real child, on a real Mac: start, hold, a kill
        /// of the child and the start of another, and the release. Needs the app
        /// built next to the tests:
        /// `cargo build --locked && cargo test --locked the_holder_drives -- --ignored --nocapture`.
        /// It sets lid sleep off and back on, like `the_kernel_takes_the_call`.
        #[test]
        #[ignore]
        fn the_holder_drives_a_real_child() {
            let exe = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/codeman-desktop");
            assert!(exe.exists(), "build the app first: {}", exe.display());
            let file = FileClaim::default_location().path.unwrap();
            let pid_in_file = || std::fs::read_to_string(&file).unwrap_or_default().trim().to_owned();
            let mut holder = Holder {
                exe: Some(exe),
                ..Holder::default()
            };
            // Looks as the worker makes them, until the child says it holds.
            let until_held = |holder: &mut Holder| {
                (0..20).any(|_| {
                    std::thread::sleep(Duration::from_millis(500));
                    holder.hold(true) == Lid::Held { slept: None }
                })
            };
            assert_eq!(holder.hold(true), Lid::Starting);
            assert!(until_held(&mut holder), "the child never said it holds");
            assert!(assertion_named(HOLDING));
            let first = pid_in_file();
            println!("held by child {first}");

            // Killed: the app sees it gone, starts another, and that one holds.
            let pid: libc::pid_t = first.parse().unwrap();
            // SAFETY: the process ID the child wrote to its file a moment ago.
            unsafe { libc::kill(pid, libc::SIGKILL) };
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(holder.hold(true), Lid::Starting, "a new child for the killed one");
            assert!(until_held(&mut holder), "the second child never said it holds");
            let second = pid_in_file();
            println!("held by child {second} after the kill");
            assert_ne!(first, second);

            // Let go: the pipe closes, the child ends, nothing is left. A child this
            // young first makes sure no display is connected (`SETTLE`).
            assert_eq!(holder.hold(false), Lid::Off);
            let gone = (0..48).any(|_| {
                std::thread::sleep(Duration::from_millis(250));
                !assertion_named(HOLDING) && pid_in_file().is_empty()
            });
            assert!(gone, "assertions or the mark are still there");
            println!("let go: no assertion, file empty");
        }

        /// `heal` on this Mac, for a look by hand after a child was killed with
        /// SIGKILL (its file is then marked and unlocked):
        /// `cargo test --locked heal_by_hand -- --ignored --nocapture`.
        #[test]
        #[ignore]
        fn heal_by_hand() {
            let mut claim = FileClaim::default_location();
            println!("before: lock {:?}, marked {}", claim.try_take(), claim.marked());
            drop(claim);
            heal();
            let mut claim = FileClaim::default_location();
            println!("after heal: lock {:?}, marked {}", claim.try_take(), claim.marked());
            assert!(!claim.marked());
        }

        /// What this Mac's kernel answers to the call itself, for a look by hand:
        /// `cargo test --locked the_kernel_takes_the_call -- --ignored --nocapture`.
        /// It sets lid sleep off and back on, as an unprivileged process. On a Mac
        /// without a lid that changes nothing; on a MacBook, keep the lid open.
        #[test]
        #[ignore]
        fn the_kernel_takes_the_call() {
            let mut root = RootDomain::new();
            let off = root.set_lid_sleep_disabled(true);
            println!("lid sleep off: taken = {off}");
            let on = root.set_lid_sleep_disabled(false);
            println!("lid sleep back on: taken = {on}");
            println!("on battery: {}", root.on_battery());
            println!("an external display is connected: {}", root.docked());
            println!("LogoLight holds it: {}", root.held_elsewhere());
            assert!(off && on);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Did {
        LidSleepOff,
        LidSleepOn,
        Assert,
        Release,
        Mark,
        Unmark,
    }

    #[derive(Default)]
    struct FakeMac {
        did: Vec<Did>,
        battery: bool,
        /// An external display is connected.
        docked: bool,
        /// How often the child waited with the pipe closed.
        pauses: usize,
        /// The kernel turns the call down from this many writes on.
        refuses_after: Option<usize>,
        elsewhere: bool,
        /// What the lock answers, one per try; `Yes` once they run out.
        takes: VecDeque<Taken>,
        marked: bool,
        unwritable: bool,
        asserted: bool,
        disabled: bool,
    }

    impl FakeMac {
        fn writes(&self) -> usize {
            self.did
                .iter()
                .filter(|did| matches!(did, Did::LidSleepOff | Did::LidSleepOn))
                .count()
        }
    }

    /// One fake for both traits would need two `&mut`; the claim borrows the Mac's
    /// state through a pointer-free split instead.
    struct Split<'a>(&'a std::cell::RefCell<FakeMac>);

    impl Kernel for Split<'_> {
        fn set_lid_sleep_disabled(&mut self, disabled: bool) -> bool {
            let mut mac = self.0.borrow_mut();
            if mac.refuses_after.is_some_and(|after| mac.writes() >= after) {
                return false;
            }
            mac.did.push(if disabled { Did::LidSleepOff } else { Did::LidSleepOn });
            mac.disabled = disabled;
            true
        }
        fn assert_awake(&mut self, hold: bool) {
            let mut mac = self.0.borrow_mut();
            if mac.asserted != hold {
                mac.asserted = hold;
                mac.did.push(if hold { Did::Assert } else { Did::Release });
            }
        }
        fn on_battery(&mut self) -> bool {
            self.0.borrow().battery
        }
        fn docked(&mut self) -> bool {
            self.0.borrow().docked
        }
        fn held_elsewhere(&mut self) -> bool {
            self.0.borrow().elsewhere
        }
    }

    impl Claim for Split<'_> {
        fn try_take(&mut self) -> Taken {
            self.0.borrow_mut().takes.pop_front().unwrap_or(Taken::Yes)
        }
        fn marked(&mut self) -> bool {
            self.0.borrow().marked
        }
        fn mark(&mut self, held: bool) -> bool {
            let mut mac = self.0.borrow_mut();
            if mac.unwritable {
                return false;
            }
            mac.marked = held;
            mac.did.push(if held { Did::Mark } else { Did::Unmark });
            true
        }
    }

    /// The app's words, one per wait, each with what the fake Mac is like from then
    /// on. The pipe closes when they run out. A wait with the pipe closed takes the
    /// next step for what the Mac is like, if there is one.
    struct Script<'a> {
        mac: &'a std::cell::RefCell<FakeMac>,
        steps: VecDeque<Step>,
        now: Instant,
        slept: Option<String>,
        said: Vec<Said>,
    }

    type Change = Box<dyn Fn(&mut FakeMac)>;

    struct Step {
        told: Told,
        /// How long the wait took.
        took: Duration,
        slept: Option<&'static str>,
        change: Option<Change>,
    }

    fn step(told: Told) -> Step {
        Step {
            told,
            took: TICK,
            slept: None,
            change: None,
        }
    }

    impl Step {
        fn then(mut self, change: impl Fn(&mut FakeMac) + 'static) -> Self {
            self.change = Some(Box::new(change));
            self
        }
        fn slept(mut self, until: &'static str) -> Self {
            self.slept = Some(until);
            self
        }
        fn took(mut self, took: Duration) -> Self {
            self.took = took;
            self
        }
    }

    impl Signals for Script<'_> {
        fn wait(&mut self, _time: Duration) -> Told {
            let Some(step) = self.steps.pop_front() else {
                return Told::Closed;
            };
            self.now += step.took;
            self.slept = step.slept.map(str::to_owned);
            if let Some(change) = step.change {
                change(&mut self.mac.borrow_mut());
            }
            step.told
        }
        fn now(&self) -> Instant {
            self.now
        }
        fn slept(&mut self) -> Option<String> {
            self.slept.take()
        }
        fn say(&mut self, said: &Said) {
            self.said.push(said.clone());
        }
        fn pause(&mut self, time: Duration) {
            self.now += time;
            let mut mac = self.mac.borrow_mut();
            mac.pauses += 1;
            assert!(mac.pauses < 1000, "the child waits for a display that never goes");
            if let Some(change) = self.steps.pop_front().and_then(|step| step.change) {
                change(&mut mac);
            }
        }
    }

    /// As many words from the app, a tick apart.
    fn beats(count: usize) -> Vec<Step> {
        (0..count).map(|_| step(Told::Beat)).collect()
    }

    /// Something for the fake Mac to become, with the pipe open or closed.
    fn becomes(change: impl Fn(&mut FakeMac) + 'static) -> Step {
        step(Told::Beat).then(change)
    }

    /// Runs the child against a fake Mac. What it ended with, what it did, what it
    /// said.
    fn run(mac: FakeMac, steps: Vec<Step>) -> (Ended, FakeMac, Vec<Said>) {
        let mac = std::cell::RefCell::new(mac);
        let mut script = Script {
            mac: &mac,
            steps: steps.into(),
            now: Instant::now(),
            slept: None,
            said: Vec::new(),
        };
        let ended = keep(&mut Split(&mac), &mut Split(&mac), &mut script);
        let said = script.said;
        (ended, mac.into_inner(), said)
    }

    use Did::*;

    #[test]
    fn it_marks_asserts_and_sets_the_switch_then_sets_it_again_every_tick() {
        let (ended, mac, said) = run(
            FakeMac::default(),
            vec![step(Told::Beat), step(Told::Nothing), step(Told::Beat)],
        );
        assert_eq!(ended, Ended::Released);
        assert_eq!(
            mac.did,
            [
                // Marked before the first write: a kill right after it is seen.
                Mark,
                Assert,
                LidSleepOff,
                // macOS's power daemon and LogoLight write the same switch.
                LidSleepOff,
                LidSleepOff,
                // The pipe closed: the assertions first, then the switch.
                Release,
                LidSleepOn,
                Unmark,
            ]
        );
        assert_eq!(said, [Said::Held], "said once, not on every tick");
        assert!(!mac.marked && !mac.asserted && !mac.disabled);
        // It had not watched the displays for `SETTLE` yet, so it looked once more.
        assert_eq!(mac.pauses, 1);

        // One that has held for a while lets go at once.
        let (_, mac, _) = run(FakeMac::default(), beats(SETTLE.as_secs() as usize + 2));
        assert_eq!(mac.did[mac.did.len() - 3..], [Release, LidSleepOn, Unmark]);
        assert_eq!(mac.pauses, 0);
    }

    #[test]
    fn a_pipe_that_closes_before_anything_was_held_writes_nothing() {
        let (ended, mac, said) = run(FakeMac::default(), vec![]);
        assert_eq!(ended, Ended::Released);
        assert!(mac.did.is_empty(), "{:?}", mac.did);
        assert!(said.is_empty());
    }

    #[test]
    fn an_app_that_stops_writing_is_let_go_of() {
        // Quiet waits only: the app hangs.
        let quiet = STALE.as_secs() as usize + 5;
        let (ended, mac, _) = run(FakeMac::default(), (0..quiet).map(|_| step(Told::Nothing)).collect());
        assert_eq!(ended, Ended::Stale);
        assert_eq!(mac.did.last(), Some(&Unmark));
        assert!(!mac.disabled && !mac.asserted && !mac.marked);
        // It held until then: just under a minute of ticks.
        assert_eq!(
            mac.did.iter().filter(|did| **did == LidSleepOff).count(),
            STALE.as_secs() as usize - 1
        );

        // A word now and then keeps it, however long.
        let steps = (0..quiet * 2)
            .map(|tick| step(if tick % 20 == 0 { Told::Beat } else { Told::Nothing }))
            .collect();
        let (ended, _, _) = run(FakeMac::default(), steps);
        assert_eq!(ended, Ended::Released, "ended by the pipe, not by the clock");
    }

    #[test]
    fn one_slow_look_of_the_app_is_not_a_hang() {
        let slow = step(Told::Beat).took(STALE - Duration::from_secs(1));
        let (ended, mac, _) = run(FakeMac::default(), vec![step(Told::Beat), slow, step(Told::Beat)]);
        assert_eq!(ended, Ended::Released);
        assert_eq!(mac.did.iter().filter(|did| **did == LidSleepOff).count(), 3);
    }

    #[test]
    fn on_battery_nothing_is_held_whatever_the_app_says() {
        let battery = FakeMac {
            battery: true,
            ..FakeMac::default()
        };
        let (ended, mac, said) = run(battery, vec![step(Told::Beat), step(Told::Beat)]);
        assert_eq!(ended, Ended::Released);
        assert!(mac.did.is_empty(), "{:?}", mac.did);
        assert_eq!(said, [Said::OnBattery]);
    }

    #[test]
    fn unplugging_lets_go_and_plugging_in_holds_again() {
        let held = SETTLE.as_secs() as usize + 1;
        let mut steps = beats(held);
        steps.extend([
            becomes(|mac| mac.battery = true),
            step(Told::Beat),
            becomes(|mac| mac.battery = false),
        ]);
        let (ended, mac, said) = run(FakeMac::default(), steps);
        assert_eq!(ended, Ended::Released);
        let mut expected = vec![Mark, Assert];
        expected.extend(std::iter::repeat_n(LidSleepOff, held));
        expected.extend([
            // Unplugged: a Mac in a bag sleeps.
            Release,
            LidSleepOn,
            Unmark,
            // Plugged in again.
            Mark,
            Assert,
            LidSleepOff,
            Release,
            LidSleepOn,
            Unmark,
        ]);
        assert_eq!(mac.did, expected);
        assert_eq!(said, [Said::Held, Said::OnBattery, Said::Held]);
        assert_eq!(mac.pauses, 0);
    }

    #[test]
    fn docked_it_writes_nothing_and_the_assertions_keep_the_mac_awake() {
        let docked = FakeMac {
            docked: true,
            ..FakeMac::default()
        };
        let (ended, mac, said) = run(docked, beats(SETTLE.as_secs() as usize + 3));
        assert_eq!(ended, Ended::Released);
        // macOS's own closed-lid mode has the switch: a zero from here would put a
        // docked Mac to sleep.
        assert_eq!(mac.did, [Assert, Release]);
        // Its own word, so the menu does not read as if Codeman held the lid.
        assert_eq!(said, [Said::Docked]);
        assert_eq!(mac.pauses, 0, "nothing of its own to wait for");
        assert!(!mac.marked);

        // Docked on battery: nothing at all.
        let battery = FakeMac {
            docked: true,
            battery: true,
            ..FakeMac::default()
        };
        let (_, mac, said) = run(battery, beats(3));
        assert!(mac.did.is_empty(), "{:?}", mac.did);
        assert_eq!(said, [Said::OnBattery]);
    }

    /// What a child that held undocked for a while did up to then.
    fn held_for(ticks: usize) -> Vec<Did> {
        let mut did = vec![Mark, Assert];
        did.extend(std::iter::repeat_n(LidSleepOff, ticks));
        did
    }

    #[test]
    fn a_display_that_comes_while_it_holds_keeps_its_switch_until_the_display_goes() {
        let held = SETTLE.as_secs() as usize + 1;
        let mut steps = beats(held);
        steps.extend([
            // Plugged into a display: macOS takes the switch over.
            becomes(|mac| mac.docked = true),
            step(Told::Beat),
            // The app lets go with the display still there.
            step(Told::Closed),
            // Looks with the pipe closed: still there, still there, gone.
            step(Told::Nothing),
            step(Told::Nothing),
            becomes(|mac| mac.docked = false),
        ]);
        let (ended, mac, said) = run(FakeMac::default(), steps);
        assert_eq!(ended, Ended::Released);
        let mut expected = held_for(held);
        expected.extend([
            // Nothing is written while the display is there. The assertions go
            // with the app's asking.
            Release, // The display has gone and stayed gone: what this child set is cleared.
            LidSleepOn, Unmark,
        ]);
        assert_eq!(mac.did, expected);
        assert_eq!(said, [Said::Held, Said::Docked]);
        assert_eq!(mac.pauses, 4, "three looks, and one more for the display to stay gone");
    }

    #[test]
    fn a_display_list_that_is_short_for_a_moment_clears_nothing() {
        let held = SETTLE.as_secs() as usize + 1;
        let mut steps = beats(held);
        steps.extend([
            becomes(|mac| mac.docked = true),
            step(Told::Closed),
            // Gone at one look, back at the next: displays being rearranged.
            becomes(|mac| mac.docked = false),
            becomes(|mac| mac.docked = true),
            step(Told::Nothing),
            becomes(|mac| mac.docked = false),
        ]);
        let (_, mac, _) = run(FakeMac::default(), steps);
        let mut expected = held_for(held);
        expected.extend([Release, LidSleepOn, Unmark]);
        assert_eq!(mac.did, expected);
        assert_eq!(mac.pauses, 5, "not cleared at the first look without a display");
    }

    #[test]
    fn on_battery_at_a_display_its_switch_waits_for_the_display_to_go() {
        let held = SETTLE.as_secs() as usize + 1;
        let gone_for = |ticks: usize| {
            let mut steps = beats(held);
            steps.extend([
                becomes(|mac| mac.docked = true),
                becomes(|mac| mac.battery = true),
                step(Told::Beat),
                becomes(|mac| mac.docked = false),
            ]);
            steps.extend(beats(ticks));
            run(FakeMac::default(), steps)
        };
        let mut expected = held_for(held);
        expected.extend([Release, LidSleepOn, Unmark]);
        // The display has been gone for `SETTLE` while the app still asks.
        let (_, mac, said) = gone_for(SETTLE.as_secs() as usize);
        assert_eq!(mac.did, expected);
        assert_eq!(said, [Said::Held, Said::Docked, Said::OnBattery]);
        assert_eq!(mac.pauses, 0, "cleared while the pipe was open");
        // Not before.
        let (_, mac, _) = gone_for(SETTLE.as_secs() as usize - 1);
        assert_eq!(mac.did, expected);
        assert_eq!(mac.pauses, 1, "not yet cleared when the pipe closed");
    }

    #[test]
    fn a_mark_a_killed_child_left_is_cleared_by_the_next_one() {
        let left = || FakeMac {
            marked: true,
            disabled: true,
            ..FakeMac::default()
        };
        let long = SETTLE.as_secs() as usize + 2;
        // On battery, so it holds nothing of its own.
        let battery = FakeMac {
            battery: true,
            ..left()
        };
        let (_, mac, _) = run(battery, beats(long));
        assert_eq!(mac.did, [LidSleepOn, Unmark]);
        assert_eq!(mac.pauses, 0);

        // At a display, not while the display is there.
        let docked = FakeMac {
            battery: true,
            docked: true,
            ..left()
        };
        let mut steps = beats(long);
        steps.extend([
            step(Told::Closed),
            step(Told::Nothing),
            becomes(|mac| mac.docked = false),
        ]);
        let (_, mac, _) = run(docked, steps);
        assert_eq!(mac.did, [LidSleepOn, Unmark]);
        assert_eq!(mac.pauses, 3);

        // Plugged in and undocked it holds, and the mark is already there.
        let (_, mac, _) = run(left(), beats(2));
        assert_eq!(mac.did, [Assert, LidSleepOff, LidSleepOff, Release, LidSleepOn, Unmark]);
    }

    #[test]
    fn a_kernel_that_refuses_ends_it_with_nothing_left_held() {
        let refusing = FakeMac {
            refuses_after: Some(0),
            ..FakeMac::default()
        };
        let (ended, mac, said) = run(refusing, vec![step(Told::Beat), step(Told::Beat)]);
        assert_eq!(ended, Ended::Refused);
        assert_eq!(mac.did, [Mark, Assert, Release, Unmark]);
        assert_eq!(said, [Said::Refused]);
        assert!(!mac.marked && !mac.asserted);

        // Refused later (a connection that died for good): the same end.
        let later = FakeMac {
            refuses_after: Some(2),
            ..FakeMac::default()
        };
        let (ended, mac, said) = run(later, (0..5).map(|_| step(Told::Beat)).collect());
        assert_eq!(ended, Ended::Refused);
        assert_eq!(mac.did, [Mark, Assert, LidSleepOff, LidSleepOff, Release, Unmark]);
        assert_eq!(said, [Said::Held, Said::Refused]);
    }

    #[test]
    fn the_switch_is_left_to_a_logolight_that_holds_it() {
        let (ended, mac, _) = run(
            FakeMac::default(),
            vec![step(Told::Beat), step(Told::Beat).then(|mac| mac.elsewhere = true)],
        );
        assert_eq!(ended, Ended::Released);
        assert_eq!(
            mac.did,
            [Mark, Assert, LidSleepOff, LidSleepOff, Release, Unmark],
            "our assertions and our mark go, the switch stays LogoLight's"
        );
        assert!(mac.disabled);
    }

    #[test]
    fn it_waits_for_the_child_before_it_and_touches_nothing_until_then() {
        let busy = FakeMac {
            takes: VecDeque::from([Taken::Busy, Taken::Busy]),
            ..FakeMac::default()
        };
        let (ended, mac, said) = run(busy, vec![step(Told::Beat), step(Told::Beat), step(Told::Beat)]);
        assert_eq!(ended, Ended::Released);
        assert_eq!(mac.did, [Mark, Assert, LidSleepOff, Release, LidSleepOn, Unmark]);
        assert_eq!(said, [Said::Held]);

        // The pipe closes while it still waits: the other child's switch and mark
        // are not this one's to undo.
        let never = FakeMac {
            takes: VecDeque::from([Taken::Busy, Taken::Busy]),
            marked: true,
            disabled: true,
            ..FakeMac::default()
        };
        let (ended, mac, said) = run(never, vec![step(Told::Beat), step(Told::Beat)]);
        assert_eq!(ended, Ended::Released);
        assert!(mac.did.is_empty(), "{:?}", mac.did);
        assert!(mac.marked && mac.disabled);
        assert!(said.is_empty());
    }

    #[test]
    fn without_its_file_it_holds_nothing() {
        // No lock to be had: nothing could undo the switch after a kill.
        let broken = FakeMac {
            takes: VecDeque::from([Taken::Broken]),
            ..FakeMac::default()
        };
        let (ended, mac, said) = run(broken, vec![step(Told::Beat), step(Told::Beat)]);
        assert_eq!(ended, Ended::Failed);
        assert!(mac.did.is_empty(), "{:?}", mac.did);
        assert_eq!(said, [Said::Failed]);

        // The lock, but the mark cannot be written.
        let unwritable = FakeMac {
            unwritable: true,
            ..FakeMac::default()
        };
        let (ended, mac, said) = run(unwritable, vec![step(Told::Beat), step(Told::Beat)]);
        assert_eq!(ended, Ended::Failed);
        assert!(mac.did.is_empty(), "{:?}", mac.did);
        assert_eq!(said, [Said::Failed]);
    }

    #[test]
    fn a_sleep_while_it_held_is_said_and_one_before_it_held_is_not() {
        let (_, _, said) = run(
            FakeMac::default(),
            vec![step(Told::Beat), step(Told::Beat).slept("07:42"), step(Told::Beat)],
        );
        assert_eq!(said, [Said::Held, Said::Slept("07:42".into())]);

        // Asleep on battery in a bag, then plugged in: that sleep was the point.
        let battery = FakeMac {
            battery: true,
            ..FakeMac::default()
        };
        let (_, _, said) = run(
            battery,
            vec![
                step(Told::Beat),
                step(Told::Beat).slept("07:42").then(|mac| mac.battery = false),
                step(Told::Beat),
            ],
        );
        assert_eq!(said, [Said::OnBattery, Said::Held]);

        // At a display the Mac is meant to stay awake too, by macOS's own mode. A
        // sleep there says it is not that mode after all.
        let docked = FakeMac {
            docked: true,
            ..FakeMac::default()
        };
        let (_, _, said) = run(docked, vec![step(Told::Beat), step(Told::Beat).slept("07:42")]);
        assert_eq!(said, [Said::Docked, Said::Slept("07:42".into())]);
    }

    #[test]
    fn healing_undoes_only_what_a_dead_child_left() {
        let heal = |mac: FakeMac| {
            let mac = std::cell::RefCell::new(mac);
            let healed = heal_with(&mut Split(&mac), &mut Split(&mac));
            (healed, mac.into_inner())
        };
        // Marked and unlocked: a child was killed.
        let (healed, mac) = heal(FakeMac {
            marked: true,
            disabled: true,
            ..FakeMac::default()
        });
        assert!(healed);
        assert_eq!(mac.did, [LidSleepOn, Unmark]);
        // A clean end left nothing.
        let (healed, mac) = heal(FakeMac::default());
        assert!(!healed);
        assert!(mac.did.is_empty());
        // A child lives (this app's, or another copy's): its switch.
        let (healed, mac) = heal(FakeMac {
            marked: true,
            disabled: true,
            takes: VecDeque::from([Taken::Busy]),
            ..FakeMac::default()
        });
        assert!(!healed);
        assert!(mac.did.is_empty() && mac.marked && mac.disabled);
        // LogoLight holds the switch for itself: only the mark goes.
        let (healed, mac) = heal(FakeMac {
            marked: true,
            disabled: true,
            elsewhere: true,
            ..FakeMac::default()
        });
        assert!(healed);
        assert_eq!(mac.did, [Unmark]);
        assert!(mac.disabled);
        // At a display the switch may be macOS's: the mark stays for the next child.
        let (healed, mac) = heal(FakeMac {
            marked: true,
            disabled: true,
            docked: true,
            ..FakeMac::default()
        });
        assert!(!healed);
        assert!(mac.did.is_empty() && mac.marked && mac.disabled);
    }

    #[test]
    fn a_line_reads_back_as_what_was_said() {
        for said in [
            Said::Held,
            Said::Docked,
            Said::OnBattery,
            Said::Refused,
            Said::Failed,
            Said::Slept("07:42".into()),
        ] {
            assert_eq!(Said::parse(&said.line()), Some(said));
        }
        assert_eq!(Said::parse("held\r\n"), Some(Said::Held));
        assert_eq!(Said::parse(""), None);
        assert_eq!(Said::parse("something else"), None);
    }

    #[test]
    fn what_the_app_heard_is_what_the_status_line_gets() {
        let mut heard = Heard::default();
        assert_eq!(heard.lid(None), Lid::Starting);
        heard.hear(Said::Held);
        assert_eq!(heard.lid(None), Lid::Held { slept: None });
        // A sleep is a note, not a state: the lid is still held after it.
        heard.hear(Said::Slept("07:42".into()));
        assert_eq!(heard.slept.as_deref(), Some("07:42"));
        assert_eq!(
            heard.lid(heard.slept.clone()),
            Lid::Held {
                slept: Some("07:42".into())
            }
        );
        heard.hear(Said::Docked);
        assert_eq!(heard.lid(None), Lid::Docked { slept: None });
        heard.hear(Said::OnBattery);
        assert_eq!(heard.lid(None), Lid::OnBattery);
        heard.hear(Said::Refused);
        assert_eq!(heard.lid(None), Lid::Refused);
        heard.hear(Said::Failed);
        assert_eq!(heard.lid(None), Lid::Failed);
    }
}
