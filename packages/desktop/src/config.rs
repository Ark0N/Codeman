//! The app's own settings: recent servers, two preferences and the window
//! frame. Stored as JSON next to other per-app data
//! (`~/Library/Application Support/Codeman/desktop.json` on macOS). Passwords
//! never go here; they live in the Keychain (see `credentials`).

use crate::keep_awake;
use crate::logo::BlinkStyles;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const MAX_SERVERS: usize = 8;
/// How many recovery copies of an unreadable config can sit side by side:
/// `desktop.json.corrupt`, then `desktop.json.corrupt.1` to `.9`.
const ASIDE_SLOTS: usize = 10;
pub const MIN_WIDTH: f64 = 480.0;
pub const MIN_HEIGHT: f64 = 360.0;
const MAX_EDGE: f64 = 20_000.0;

/// Height of a standard title bar, in points.
const TITLE_BAR: f64 = 28.0;
/// How far the outer top of the window lies above `WindowFrame::y`. On macOS
/// `y` is the content area's top (tao's `with_position` puts the content rect
/// there and the title bar above it); elsewhere `y` is already the outer top.
const TITLE_ABOVE_Y: f64 = if cfg!(target_os = "macos") { TITLE_BAR } else { 0.0 };
/// How much of the title bar must be on a screen to grab it.
const MIN_GRIP: f64 = 80.0;
/// Room `fitted_to` leaves when it shrinks a window. Screens are full display
/// bounds, so the menu bar and the Dock are inside them.
const FIT_MARGIN_X: f64 = 40.0;
const FIT_MARGIN_Y: f64 = 80.0;
/// Room a first-run window leaves above its content (the menu bar, taller on
/// a display with a notch, and its own title bar) and below it (a Dock of the
/// default size): `Rect` is the whole display, so neither is taken off yet.
const FIRST_RUN_ROOM_ABOVE: f64 = 66.0;
const FIRST_RUN_ROOM_BELOW: f64 = 90.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    /// Most recent first.
    pub servers: Vec<ServerEntry>,
    /// Connect to the most recent server at launch.
    pub auto_connect: bool,
    /// Always open in full screen (otherwise the last state is restored).
    pub start_fullscreen: bool,
    /// Whether the lit Apple logo shows what the agents are doing, and its style
    /// for each state (logo.rs). The menu only shows on a Mac that has one. A
    /// value this version does not know reads as off: a bad style must not make
    /// the whole file unreadable.
    #[serde(deserialize_with = "lenient_blink")]
    pub logo_blink: BlinkStyles,
    /// Keep This Mac Awake (keep_awake.rs): when, only on the power adapter, and
    /// with the lid closed too. Read field by field, like `logo_blink`.
    #[serde(deserialize_with = "lenient_keep_awake")]
    pub keep_awake: keep_awake::Settings,
    /// Anything that is not a whole frame reads as None: a bad frame must not
    /// make the whole file unreadable, which would cost the server list.
    #[serde(deserialize_with = "lenient_window")]
    pub window: Option<WindowFrame>,
}

fn lenient_window<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<WindowFrame>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value(value).ok())
}

fn lenient_blink<'de, D: serde::Deserializer<'de>>(d: D) -> Result<BlinkStyles, D::Error> {
    Ok(BlinkStyles::read(&serde_json::Value::deserialize(d)?))
}

fn lenient_keep_awake<'de, D: serde::Deserializer<'de>>(d: D) -> Result<keep_awake::Settings, D::Error> {
    Ok(keep_awake::Settings::read(&serde_json::Value::deserialize(d)?))
}

impl Default for Config {
    fn default() -> Self {
        Config {
            servers: Vec::new(),
            auto_connect: true,
            start_fullscreen: false,
            logo_blink: BlinkStyles::default(),
            keep_awake: keep_awake::Settings::default(),
            window: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default)]
    pub has_saved_password: bool,
}

/// The main window's position and inner size, in logical (point)
/// coordinates. `x`/`y` are where tao's `with_position` wants them: on macOS
/// the top-left of the CONTENT area (the title bar, about 28 pt, sits above
/// it), elsewhere the window's outer top-left. Saving the outer corner on
/// macOS and restoring it as the content corner made the window creep up by
/// a title bar on every launch.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub fullscreen: bool,
}

/// A display's full bounds in logical coordinates, as tao reports them. This
/// is the whole display, not the work area: the menu bar and the Dock are
/// inside it.
#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WindowFrame {
    /// The frame of a first-run window on `screen`: `size` or what fits, never
    /// less than `min`, centred across and in the height between the menu bar
    /// and the Dock. Centring in the whole display put the bottom of a window
    /// under the Dock on a 900 pt high one.
    pub fn first_run(screen: &Rect, size: (f64, f64), min: (f64, f64)) -> WindowFrame {
        let width = size.0.min(screen.width - FIT_MARGIN_X).max(min.0);
        let room = screen.height - FIRST_RUN_ROOM_ABOVE - FIRST_RUN_ROOM_BELOW;
        let height = size.1.min(room).max(min.1);
        WindowFrame {
            x: screen.x + (screen.width - width) / 2.0,
            y: screen.y + FIRST_RUN_ROOM_ABOVE + ((room - height) / 2.0).max(0.0),
            width,
            height,
            fullscreen: false,
        }
    }

    /// The frame clamped to sane sizes, or None when it holds junk.
    pub fn sanitized(self) -> Option<WindowFrame> {
        let vals = [self.x, self.y, self.width, self.height];
        if vals.iter().any(|v| !v.is_finite()) || self.x.abs() > MAX_EDGE || self.y.abs() > MAX_EDGE {
            return None;
        }
        Some(WindowFrame {
            width: self.width.clamp(MIN_WIDTH, MAX_EDGE),
            height: self.height.clamp(MIN_HEIGHT, MAX_EDGE),
            ..self
        })
    }

    /// The frame made to fit the screens it will open on, or None when its
    /// title bar is on none of them (the caller then falls back to a default
    /// frame). An edge that no screen covers is pulled onto the screen that
    /// holds the title bar, shrinking the window when it is too big for it:
    /// a frame saved on an external display that is gone would otherwise
    /// open with its right edge and resize corner far off screen. An edge
    /// that lands on some screen stays put, so a window spanning two
    /// displays keeps its span. `min` is the window's minimum inner size.
    pub fn fitted_to(&self, screens: &[Rect], min: (f64, f64)) -> Option<WindowFrame> {
        let home = *self.title_screen(screens)?;
        let top = self.outer_top();
        let outer_height = TITLE_BAR + self.height;
        let (x, width) = fit_axis(
            self.x,
            self.width,
            (
                covers_x(screens, self.x, top, top + outer_height),
                covers_x(screens, self.x + self.width, top, top + outer_height),
            ),
            (home.x, home.x + home.width),
            FIT_MARGIN_X,
            min.0,
        );
        let (top, outer_height) = fit_axis(
            top,
            outer_height,
            (
                covers_y(screens, top, x, x + width),
                covers_y(screens, top + outer_height, x, x + width),
            ),
            (home.y, home.y + home.height),
            FIT_MARGIN_Y - TITLE_BAR,
            min.1 + TITLE_BAR,
        );
        Some(WindowFrame {
            x,
            y: top + TITLE_ABOVE_Y,
            width,
            height: outer_height - TITLE_BAR,
            ..*self
        })
    }

    fn outer_top(&self) -> f64 {
        self.y - TITLE_ABOVE_Y
    }

    /// The screen the title bar is on, or None when no screen has enough of
    /// it to grab (a display unplugged since the last run leaves the frame off
    /// screen). The middle of the title bar must be inside the screen and at
    /// least `MIN_GRIP` of the bar's width must overlap it; when several
    /// qualify, the one holding most of the bar wins.
    fn title_screen<'a>(&self, screens: &'a [Rect]) -> Option<&'a Rect> {
        let title_y = self.outer_top() + TITLE_BAR / 2.0;
        screens
            .iter()
            .filter(|m| title_y >= m.y && title_y <= m.y + m.height)
            .map(|m| {
                let grip = (self.x + self.width).min(m.x + m.width) - self.x.max(m.x);
                (m, grip)
            })
            .filter(|(_, grip)| *grip >= MIN_GRIP)
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(m, _)| m)
    }
}

/// Whether some screen holds part of the vertical edge at `x` that runs from
/// `top` to `bottom`.
fn covers_x(screens: &[Rect], x: f64, top: f64, bottom: f64) -> bool {
    screens
        .iter()
        .any(|m| x >= m.x && x <= m.x + m.width && top < m.y + m.height && bottom > m.y)
}

/// Whether some screen holds part of the horizontal edge at `y` that runs
/// from `left` to `right`.
fn covers_y(screens: &[Rect], y: f64, left: f64, right: f64) -> bool {
    screens
        .iter()
        .any(|m| y >= m.y && y <= m.y + m.height && left < m.x + m.width && right > m.x)
}

/// One axis of `WindowFrame::fitted_to`. The window runs from `start` for
/// `len`; `covered` says whether some screen holds each end; `home` is the
/// title bar screen's range on this axis. An uncovered end is pulled onto
/// `home`, and the window shrinks (leaving `margin`, never below `min`) when
/// it does not fit; a covered end may stay where it is, on another display.
fn fit_axis(start: f64, len: f64, covered: (bool, bool), home: (f64, f64), margin: f64, min: f64) -> (f64, f64) {
    if covered.0 && covered.1 {
        return (start, len);
    }
    let lo = if covered.0 { start.min(home.0) } else { home.0 };
    let hi = if covered.1 { (start + len).max(home.1) } else { home.1 };
    let len = len.min(hi - lo - margin).max(min);
    // `max` last: a window still too big for the screen keeps its start (the
    // left edge, or the title bar) on screen rather than its end.
    let start = start.min(hi - len).max(lo);
    (start, len)
}

/// The first name an unreadable `desktop.json` can be moved to without
/// replacing an earlier recovery copy: `desktop.json.corrupt`, then
/// `desktop.json.corrupt.1` to `.9`, next to it.
/// A name is free only when nothing at all is there: a file, a directory or
/// a dangling symlink left at it is taken, and so is a name that cannot be
/// checked. None when every name is taken.
fn free_aside_name(path: &Path) -> Option<PathBuf> {
    (0..ASIDE_SLOTS)
        .map(|n| match n {
            0 => path.with_extension("json.corrupt"),
            n => path.with_extension(format!("json.corrupt.{n}")),
        })
        .find(|aside| matches!(fs::symlink_metadata(aside), Err(e) if e.kind() == io::ErrorKind::NotFound))
}

impl Config {
    /// Where the config lives, or None if the OS has no config directory.
    pub fn default_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("Codeman").join("desktop.json"))
    }

    /// Read the config, and say whether saving back to `path` is safe this
    /// run. A missing file is the default. A file that is there but cannot
    /// be read (not UTF-8, no permission, a directory, an I/O error) or does
    /// not parse is moved aside for recovery, and the defaults are used; it
    /// is never silently overwritten with them. It goes to the first free
    /// name of `desktop.json.corrupt`, `desktop.json.corrupt.1` to `.9`, so
    /// a second unreadable file never replaces the copy kept from the first.
    /// If every name is taken or the move fails, the answer is false: the
    /// original is still at `path`, and the save at exit must not replace it.
    pub fn load_from(path: &Path) -> (Config, bool) {
        let text = match fs::read_to_string(path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return (Config::default(), true),
            Err(_) => None,
        };
        if let Some(mut config) = text.and_then(|t| serde_json::from_str::<Config>(&t).ok()) {
            config.sanitize();
            return (config, true);
        }
        let Some(aside) = free_aside_name(path) else {
            eprintln!(
                "codeman-desktop: {} could not be read, and {} to .{} are all taken; settings will not be saved this run",
                path.display(),
                path.with_extension("json.corrupt").display(),
                ASIDE_SLOTS - 1
            );
            return (Config::default(), false);
        };
        match fs::rename(path, &aside) {
            Ok(()) => {
                eprintln!(
                    "codeman-desktop: {} could not be read; moved it to {} and started with defaults",
                    path.display(),
                    aside.display()
                );
                (Config::default(), true)
            }
            Err(e) => {
                eprintln!(
                    "codeman-desktop: {} could not be read or moved aside ({e}); settings will not be saved this run",
                    path.display()
                );
                (Config::default(), false)
            }
        }
    }

    /// Write via a temp file and rename, so a crash never leaves half a file.
    pub fn save_to(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        fs::write(&tmp, text)?;
        fs::rename(&tmp, path)
    }

    fn sanitize(&mut self) {
        let mut seen = std::collections::HashSet::new();
        self.servers.retain(|s| !s.url.is_empty() && seen.insert(s.url.clone()));
        self.servers.truncate(MAX_SERVERS);
        self.window = self.window.and_then(WindowFrame::sanitized);
    }

    /// Move (or add) a server to the top of the recent list. Returns the
    /// Keychain accounts, as (url, username), of the entries with a username
    /// that fall off the end of the list (it keeps `MAX_SERVERS`), for the
    /// caller to delete. A different username on `url` itself is not
    /// reported: the caller deletes that account before it saves the new
    /// one, comparing the names exactly as the Keychain account string
    /// does. A delete made after the save could take the new password with
    /// it on a Keychain that treats two spellings of a name as one item.
    #[must_use = "the returned Keychain accounts must be deleted"]
    pub fn remember(&mut self, url: &str, username: Option<&str>, saved: bool) -> Vec<(String, String)> {
        self.servers.retain(|s| s.url != url);
        self.servers.insert(
            0,
            ServerEntry {
                url: url.to_string(),
                username: username.map(str::to_string),
                has_saved_password: saved,
            },
        );
        let evicted = self.servers.split_off(self.servers.len().min(MAX_SERVERS));
        evicted.into_iter().filter_map(|s| Some((s.url, s.username?))).collect()
    }

    pub fn forget(&mut self, url: &str) -> Option<ServerEntry> {
        let idx = self.servers.iter().position(|s| s.url == url)?;
        Some(self.servers.remove(idx))
    }

    pub fn find(&self, url: &str) -> Option<&ServerEntry> {
        self.servers.iter().find(|s| s.url == url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codeman-desktop-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn frame(x: f64, y: f64, width: f64, height: f64) -> WindowFrame {
        WindowFrame {
            x,
            y,
            width,
            height,
            fullscreen: false,
        }
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    const MIN: (f64, f64) = (MIN_WIDTH, MIN_HEIGHT);

    fn reachable(f: &WindowFrame, screens: &[Rect]) -> bool {
        f.title_screen(screens).is_some()
    }

    /// The outer frame (title bar included) as left, top, right, bottom.
    fn outer(f: &WindowFrame) -> (f64, f64, f64, f64) {
        let top = f.y - TITLE_ABOVE_Y;
        (f.x, top, f.x + f.width, top + TITLE_BAR + f.height)
    }

    #[test]
    fn missing_file_is_default() {
        let dir = tmp_dir("missing");
        let (c, can_save) = Config::load_from(&dir.join("desktop.json"));
        assert_eq!(c, Config::default());
        assert!(c.auto_connect);
        assert!(can_save);
    }

    #[test]
    fn the_logo_blink_styles_round_trip_and_a_bad_one_reads_as_off() {
        use crate::logo::BlinkStyle;
        let mut c = Config::default();
        assert_eq!(c.logo_blink, BlinkStyles::default());
        assert!(!c.logo_blink.enabled, "off until the user turns it on");
        c.logo_blink.enabled = true;
        c.logo_blink.needs_you = BlinkStyle::Wink;
        let text = serde_json::to_string(&c).unwrap();
        assert!(text.contains(r#""needsYou":"wink""#), "{text}");
        assert!(text.contains(r#""enabled":true"#), "{text}");
        assert_eq!(serde_json::from_str::<Config>(&text).unwrap().logo_blink, c.logo_blink);
        for bad in [
            r#"{"logoBlink":3}"#,
            r#"{"logoBlink":null}"#,
            r#"{"logoBlink":"strobe"}"#,
        ] {
            let c: Config = serde_json::from_str(bad).unwrap();
            assert_eq!(c.logo_blink, BlinkStyles::default(), "{bad}");
        }
    }

    #[test]
    fn keep_awake_round_trips_and_a_bad_value_never_costs_the_file() {
        use crate::keep_awake::{Mode, Settings};
        let mut c = Config::default();
        assert_eq!(c.keep_awake, Settings::default());
        c.keep_awake.mode = Mode::WhileWorking;
        c.keep_awake.lid = true;
        let text = serde_json::to_string(&c).unwrap();
        assert!(
            text.contains(r#""keepAwake":{"mode":"whileWorking","acOnly":true,"lid":true}"#),
            "{text}"
        );
        assert_eq!(serde_json::from_str::<Config>(&text).unwrap().keep_awake, c.keep_awake);
        for bad in [
            r#"{"keepAwake":3}"#,
            r#"{"keepAwake":null}"#,
            r#"{"keepAwake":"always"}"#,
        ] {
            let c: Config = serde_json::from_str(bad).unwrap();
            assert_eq!(c.keep_awake, Settings::default(), "{bad}");
        }
        // A file from before the setting: every other field still reads.
        let c: Config = serde_json::from_str(r#"{"startFullscreen":true}"#).unwrap();
        assert!(c.start_fullscreen);
        assert_eq!(c.keep_awake, Settings::default());
    }

    #[test]
    fn the_style_a_mac_saved_before_there_were_states_is_kept() {
        use crate::logo::BlinkStyle;
        let c: Config = serde_json::from_str(r#"{"logoBlink":"heartbeat"}"#).unwrap();
        assert_eq!(c.logo_blink.working, BlinkStyle::Heartbeat);
        assert!(c.logo_blink.enabled);
    }

    #[test]
    fn round_trip_and_atomic_save() {
        let dir = tmp_dir("roundtrip");
        let path = dir.join("nested").join("desktop.json");
        let mut c = Config::default();
        assert!(c.remember("http://127.0.0.1:3000/", None, false).is_empty());
        assert!(c.remember("https://box.ts.net/", Some("admin"), true).is_empty());
        c.start_fullscreen = true;
        c.window = Some(WindowFrame {
            x: 10.0,
            y: 20.0,
            width: 1200.0,
            height: 800.0,
            fullscreen: true,
        });
        c.save_to(&path).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        let (back, can_save) = Config::load_from(&path);
        assert!(can_save);
        assert_eq!(back, c);
        assert_eq!(back.servers[0].url, "https://box.ts.net/");
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            !text.to_lowercase().contains("password\":\""),
            "no password values on disk"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_moved_aside() {
        let dir = tmp_dir("corrupt");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("desktop.json");
        fs::write(&path, "{ not json").unwrap();
        let (c, can_save) = Config::load_from(&path);
        assert_eq!(c, Config::default());
        assert!(can_save);
        assert!(!path.exists());
        assert!(dir.join("desktop.json.corrupt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_utf8_file_is_moved_aside() {
        let dir = tmp_dir("non-utf8");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("desktop.json");
        // Valid JSON apart from a Latin-1 "ü", which is not UTF-8.
        let bytes = b"{\"servers\":[{\"url\":\"http://a/\",\"username\":\"J\xfcrg\"}]}";
        fs::write(&path, bytes).unwrap();
        let (c, can_save) = Config::load_from(&path);
        assert_eq!(c, Config::default());
        assert!(can_save);
        assert!(!path.exists());
        assert_eq!(fs::read(dir.join("desktop.json.corrupt")).unwrap(), bytes);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_path_is_moved_aside() {
        let dir = tmp_dir("unreadable");
        let path = dir.join("desktop.json");
        // A directory where the file should be: it exists but cannot be read.
        fs::create_dir_all(path.join("inside")).unwrap();
        let (c, can_save) = Config::load_from(&path);
        assert_eq!(c, Config::default());
        assert!(can_save);
        assert!(!path.exists());
        assert!(dir.join("desktop.json.corrupt").join("inside").is_dir());
        c.save_to(&path).unwrap();
        assert_eq!(Config::load_from(&path), (Config::default(), true));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_corruption_keeps_the_first_copy() {
        let dir = tmp_dir("corrupt-twice");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("desktop.json");
        fs::write(&path, "{ first").unwrap();
        assert_eq!(Config::load_from(&path), (Config::default(), true));
        fs::write(&path, "{ second").unwrap();
        assert_eq!(Config::load_from(&path), (Config::default(), true));
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(dir.join("desktop.json.corrupt")).unwrap(), "{ first");
        assert_eq!(
            fs::read_to_string(dir.join("desktop.json.corrupt.1")).unwrap(),
            "{ second"
        );
        // A good file written afterwards loads normally and moves nothing.
        Config::default().save_to(&path).unwrap();
        assert_eq!(Config::load_from(&path), (Config::default(), true));
        assert!(!dir.join("desktop.json.corrupt.2").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn taken_aside_names_are_skipped() {
        let dir = tmp_dir("aside-taken");
        // A directory left at the first name and a file at the second: the
        // third is the first free one.
        fs::create_dir_all(dir.join("desktop.json.corrupt")).unwrap();
        fs::write(dir.join("desktop.json.corrupt.1"), "kept").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("nowhere"), dir.join("desktop.json.corrupt.2")).unwrap();
        let next = if cfg!(unix) {
            "desktop.json.corrupt.3"
        } else {
            "desktop.json.corrupt.2"
        };
        let path = dir.join("desktop.json");
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(Config::load_from(&path), (Config::default(), true));
        assert!(!path.exists());
        assert!(dir.join("desktop.json.corrupt").is_dir());
        assert_eq!(fs::read_to_string(dir.join("desktop.json.corrupt.1")).unwrap(), "kept");
        // The dangling symlink still points nowhere and still counts as taken.
        #[cfg(unix)]
        assert!(fs::symlink_metadata(dir.join("desktop.json.corrupt.2"))
            .unwrap()
            .is_symlink());
        assert_eq!(fs::read_to_string(dir.join(next)).unwrap(), "{ not json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_free_aside_name_disables_saving() {
        let dir = tmp_dir("aside-full");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("desktop.json");
        let names: Vec<PathBuf> = std::iter::once(dir.join("desktop.json.corrupt"))
            .chain((1..ASIDE_SLOTS).map(|n| dir.join(format!("desktop.json.corrupt.{n}"))))
            .collect();
        assert_eq!(names.len(), 10);
        for (n, name) in names.iter().enumerate() {
            fs::write(name, format!("copy {n}")).unwrap();
        }
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(Config::load_from(&path), (Config::default(), false));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        for (n, name) in names.iter().enumerate() {
            assert_eq!(fs::read_to_string(name).unwrap(), format!("copy {n}"));
        }
        assert!(!dir.join("desktop.json.corrupt.10").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn failed_move_aside_disables_saving() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_dir("stuck");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("desktop.json");
        fs::write(&path, "{ not json").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        // Root ignores the read-only directory, so the rename cannot fail.
        if fs::write(dir.join("probe"), "").is_ok() {
            eprintln!("skipped: the directory is still writable (running as root?)");
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
            let _ = fs::remove_dir_all(&dir);
            return;
        }
        let (c, can_save) = Config::load_from(&path);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(c, Config::default());
        assert!(!can_save);
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
        assert!(!dir.join("desktop.json.corrupt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_list_is_deduped_and_capped() {
        let mut c = Config::default();
        for i in 0..12 {
            assert!(c.remember(&format!("http://h{i}/"), None, false).is_empty());
        }
        assert!(c.remember("http://h5/", Some("me"), false).is_empty());
        assert_eq!(c.servers.len(), MAX_SERVERS);
        assert_eq!(c.servers[0].url, "http://h5/");
        assert_eq!(c.servers.iter().filter(|s| s.url == "http://h5/").count(), 1);
        assert_eq!(c.forget("http://h5/").unwrap().username.as_deref(), Some("me"));
        assert!(c.find("http://h5/").is_none());
    }

    #[test]
    fn remember_leaves_a_username_change_to_the_caller() {
        let url = "https://box.ts.net/";
        let mut c = Config::default();
        assert!(c.remember(url, Some("Alice"), true).is_empty());
        // Every change of the username on the same server, a case-only one,
        // another user, or none at all, returns nothing: the caller deletes
        // the old account before it saves the new one.
        for (user, saved) in [
            (Some("alice"), true),
            (Some(" alice "), true),
            (Some("bob"), true),
            (None, false),
            (None, false),
            (Some("dave"), true),
        ] {
            assert!(c.remember(url, user, saved).is_empty(), "{user:?}");
            let entry = c.find(url).unwrap();
            assert_eq!((entry.username.as_deref(), entry.has_saved_password), (user, saved));
            assert_eq!(c.servers.iter().filter(|s| s.url == url).count(), 1);
        }
        assert!(c.remember("http://other/", Some("carol"), true).is_empty());
        assert!(c.remember(url, Some("erin"), true).is_empty());
        assert_eq!(c.servers.len(), 2);
        assert_eq!(c.servers[0].url, url);
        assert_eq!(c.find("http://other/").unwrap().username.as_deref(), Some("carol"));
    }

    #[test]
    fn remember_returns_evicted_accounts() {
        let mut c = Config::default();
        for i in 0..MAX_SERVERS {
            let user = (i % 2 == 0).then(|| format!("u{i}"));
            assert!(c.remember(&format!("http://h{i}/"), user.as_deref(), true).is_empty());
        }
        // Moving a listed server to the top evicts nothing.
        assert!(c.remember("http://h3/", None, false).is_empty());
        assert_eq!(c.servers.len(), MAX_SERVERS);
        // A new server pushes the oldest (h0, with a username) off the end.
        assert_eq!(
            c.remember("http://new/", None, false),
            vec![("http://h0/".to_string(), "u0".to_string())]
        );
        // The next oldest is h1, which has no username: nothing to delete.
        assert!(c.remember("http://newer/", Some("x"), true).is_empty());
        assert_eq!(c.servers.len(), MAX_SERVERS);
        assert!(c.find("http://h0/").is_none() && c.find("http://h1/").is_none());
        // A username change on a listed server returns nothing; the next new
        // server evicts the oldest entry, and only that account comes back.
        let mut c = Config::default();
        for i in 0..MAX_SERVERS {
            assert!(c.remember(&format!("http://h{i}/"), Some("u"), true).is_empty());
        }
        assert!(c.remember("http://h7/", Some("v"), true).is_empty());
        assert_eq!(
            c.remember("http://h8/", Some("w"), true),
            vec![("http://h0/".to_string(), "u".to_string())]
        );
        assert_eq!(c.find("http://h7/").unwrap().username.as_deref(), Some("v"));
        assert_eq!(c.servers.len(), MAX_SERVERS);
    }

    #[test]
    fn unknown_and_missing_fields_tolerated() {
        let c: Config = serde_json::from_str(r#"{"servers":[{"url":"http://a/"}],"future":1}"#).unwrap();
        assert!(c.auto_connect);
        assert_eq!(c.servers[0].username, None);
    }

    #[test]
    fn a_bad_window_frame_keeps_the_servers() {
        for (name, window) in [
            ("missing-height", r#"{"x":1,"y":2,"width":3}"#),
            ("not-a-frame", r#""maximized""#),
            ("null-number", r#"{"x":null,"y":2,"width":3,"height":4}"#),
        ] {
            let dir = tmp_dir(&format!("bad-window-{name}"));
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join("desktop.json");
            fs::write(
                &path,
                format!(r#"{{"servers":[{{"url":"http://a/"}}],"autoConnect":false,"window":{window}}}"#),
            )
            .unwrap();
            let (c, can_save) = Config::load_from(&path);
            assert!(can_save, "{name}");
            assert_eq!(c.servers.len(), 1, "{name}");
            assert!(!c.auto_connect, "{name}");
            assert_eq!(c.window, None, "{name}");
            // The file was read, so it stays where it is.
            assert!(path.is_file(), "{name}");
            assert!(!path.with_extension("json.corrupt").exists(), "{name}");
        }
        // A whole frame and an absent one read as before.
        let c: Config =
            serde_json::from_str(r#"{"window":{"x":1,"y":2,"width":900,"height":600,"fullscreen":true}}"#).unwrap();
        assert_eq!(c.window.map(|f| (f.width, f.fullscreen)), Some((900.0, true)));
        assert_eq!(serde_json::from_str::<Config>("{}").unwrap().window, None);
        assert_eq!(
            serde_json::from_str::<Config>(r#"{"window":null}"#).unwrap().window,
            None
        );
    }

    #[test]
    fn first_run_window_sits_between_the_menu_bar_and_the_dock() {
        let screen = |width: f64, height: f64| Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        };
        let size = (1280.0, 820.0);
        let min = (480.0, 360.0);
        // A 13 inch MacBook: the window is shortened, and ends above the Dock.
        let f = WindowFrame::first_run(&screen(1440.0, 900.0), size, min);
        assert_eq!((f.width, f.height), (1280.0, 744.0));
        assert_eq!((f.x, f.y), (80.0, 66.0));
        assert!(f.y + f.height <= 900.0 - 90.0);
        // A large display: the full size, centred across and in the free height.
        let f = WindowFrame::first_run(&screen(2560.0, 1440.0), size, min);
        assert_eq!((f.width, f.height), (1280.0, 820.0));
        assert_eq!(f.x, 640.0);
        assert_eq!(f.y - 66.0, 1440.0 - 90.0 - (f.y + f.height));
        // A second display to the left of the first.
        let left = Rect {
            x: -1920.0,
            y: 120.0,
            width: 1920.0,
            height: 1080.0,
        };
        let f = WindowFrame::first_run(&left, size, min);
        assert_eq!(f.x, -1920.0 + 320.0);
        assert!(f.y >= 120.0 + 66.0 && f.y + f.height <= 120.0 + 1080.0 - 90.0);
        // Never smaller than the minimum, on a display too small for it too.
        let f = WindowFrame::first_run(&screen(500.0, 400.0), size, min);
        assert_eq!((f.width, f.height), min);
        assert!(!f.fullscreen);
    }

    #[test]
    fn frame_sanitizing_and_reachability() {
        assert!(frame(f64::NAN, 0.0, 800.0, 600.0).sanitized().is_none());
        let small = frame(0.0, 0.0, 10.0, 10.0).sanitized().unwrap();
        assert_eq!((small.width, small.height), (MIN_WIDTH, MIN_HEIGHT));
        let screen = [rect(0.0, 0.0, 1512.0, 982.0)];
        let on = frame(100.0, 50.0, 1200.0, 800.0);
        assert!(reachable(&on, &screen));
        assert_eq!(on.fitted_to(&screen, MIN), Some(on));
        let off = frame(3000.0, 50.0, 1200.0, 800.0);
        assert!(!reachable(&off, &screen));
        assert_eq!(off.fitted_to(&screen, MIN), None);
        let above = frame(100.0, -900.0, 1200.0, 800.0);
        assert!(!reachable(&above, &screen));
        assert_eq!(above.fitted_to(&screen, MIN), None);
        // Only a sliver of the title bar on screen is not enough to grab.
        let sliver = frame(-1150.0, 50.0, 1200.0, 800.0);
        assert!(!reachable(&sliver, &screen));
        assert_eq!(sliver.fitted_to(&screen, MIN), None);
        // No screens at all (none reported): nothing is reachable.
        assert_eq!(on.fitted_to(&[], MIN), None);
    }

    #[test]
    fn title_bar_is_above_y_on_macos() {
        let screen = [rect(0.0, 0.0, 1512.0, 982.0)];
        // On macOS the title bar of a content top at y = 10 is at -18..10,
        // mostly above the screen; elsewhere it is at 10..38.
        let high = frame(100.0, 10.0, 1200.0, 800.0);
        assert_eq!(reachable(&high, &screen), !cfg!(target_os = "macos"));
        // Half the bar above the top edge: still grabbable, and fitting
        // brings all of it onto the screen.
        let straddling = frame(100.0, TITLE_ABOVE_Y - 10.0, 1200.0, 800.0);
        assert!(reachable(&straddling, &screen));
        let fitted = straddling.fitted_to(&screen, MIN).unwrap();
        assert_eq!(outer(&fitted).1, 0.0);
        assert_eq!((fitted.x, fitted.width, fitted.height), (100.0, 1200.0, 800.0));
    }

    #[test]
    fn frame_from_an_unplugged_ultrawide_is_fitted() {
        // Saved on a 3440x1440 display at the origin, restored on a laptop.
        let laptop = [rect(0.0, 0.0, 1512.0, 982.0)];
        let wide = frame(0.0, 30.0, 3300.0, 1300.0);
        let fitted = wide.fitted_to(&laptop, MIN).unwrap();
        assert_eq!(
            (fitted.x, fitted.y, fitted.width, fitted.height),
            (0.0, 30.0, 1512.0 - FIT_MARGIN_X, 982.0 - FIT_MARGIN_Y)
        );
        let (left, top, right, bottom) = outer(&fitted);
        assert!(left >= 0.0 && top >= 0.0 && right <= 1512.0 && bottom <= 982.0);
        // Hanging off the right of the laptop by a bit: shifted, not shrunk.
        let fitted = frame(500.0, 100.0, 1200.0, 700.0).fitted_to(&laptop, MIN).unwrap();
        assert_eq!(
            (fitted.x, fitted.y, fitted.width, fitted.height),
            (312.0, 100.0, 1200.0, 700.0)
        );
        // Hanging off the left: shifted right.
        let fitted = frame(-1000.0, 100.0, 1200.0, 700.0).fitted_to(&laptop, MIN).unwrap();
        assert_eq!((fitted.x, fitted.width), (0.0, 1200.0));
    }

    #[test]
    fn frame_spanning_two_displays_is_left_alone() {
        let screens = [rect(0.0, 0.0, 1512.0, 982.0), rect(1512.0, -200.0, 2560.0, 1440.0)];
        let span = frame(1000.0, 100.0, 1500.0, 700.0);
        assert_eq!(span.fitted_to(&screens, MIN), Some(span));
        // Only the edge that lands on no display moves: the left edge stays
        // on the laptop, the right edge comes back onto the external one.
        let past = frame(1000.0, 100.0, 3500.0, 700.0);
        let fitted = past.fitted_to(&screens, MIN).unwrap();
        assert_eq!(fitted.x, 1000.0);
        assert_eq!(fitted.x + fitted.width, 1512.0 + 2560.0 - FIT_MARGIN_X);
        assert_eq!((fitted.y, fitted.height), (100.0, 700.0));
    }

    #[test]
    fn fitted_frame_keeps_the_minimum_size() {
        let tiny = [rect(0.0, 0.0, 400.0, 300.0)];
        let fitted = frame(0.0, 40.0, 1200.0, 800.0).fitted_to(&tiny, MIN).unwrap();
        assert_eq!((fitted.width, fitted.height), MIN);
        // Too big for the screen even at the minimum: the left edge and the
        // title bar stay on it.
        let (left, top, _, _) = outer(&fitted);
        assert_eq!((left, top), (0.0, 0.0));
        assert!(reachable(&fitted, &tiny));
        // The fullscreen flag rides along.
        let full = WindowFrame {
            fullscreen: true,
            ..frame(0.0, 40.0, 1200.0, 800.0)
        };
        assert!(full.fitted_to(&tiny, MIN).unwrap().fullscreen);
    }
}
