//! Codeman Desktop: a native window around a Codeman server.
//!
//! Codeman is a web app, so the app is a thin shell: the OS web view (WKWebView
//! on macOS) shows the server's own page, and the native side adds what a
//! browser tab cannot: a connect screen that remembers servers (`config`,
//! `login`), runs or installs Codeman on this machine (`setup`,
//! `local_server`, `gui_install`) and installs it on another one over SSH
//! (`terminal_install`), real full screen, native menus (`menu`), pop-outs as
//! app windows (Codeman's `window.CodemanHost` bridge), downloads to
//! ~/Downloads, passwords in the Keychain (`credentials`), on macOS the
//! JavaScript dialogs and HTTP Basic challenges wry leaves out (`macos`), and
//! on a MacBook Pro with a lit Apple logo a blink that says what the agents
//! are doing (`logo`, `agents`).
//!
//! Every URL and message decision is in `policy` (pure, unit-tested); this file
//! only wires those decisions to windows. The main window moves through
//! `policy::Phase`: the connect page (Connect), a server load that has not
//! committed yet (Loading, abandoned after `LOAD_TIMEOUT` or on Cancel), and a
//! committed server page (Loaded). The phase is shared with the web view
//! handlers, which run on this same thread; no `RefCell` borrow of it is ever
//! held across a call into wry or tao.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agents;
mod assets;
mod config;
mod credentials;
mod gui_install;
mod keep_awake;
// The pure half is only used by the macOS half and the tests.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod lid_awake;
mod local_server;
mod login;
mod logo;
#[cfg(target_os = "macos")]
mod macos;
mod menu;
mod policy;
mod probe;
mod setup;
mod terminal_install;

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use muda::MenuEvent;
use serde_json::json;
use tao::dpi::{LogicalPosition, LogicalSize, PhysicalPosition};
use tao::error::NotSupportedError;
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Fullscreen, Theme, UserAttentionType, Window, WindowBuilder, WindowId};
use url::Url;
use wry::http::header::AUTHORIZATION;
use wry::http::{HeaderMap, HeaderValue};
use wry::{NewWindowResponse, PageLoadEvent, PermissionResponse, WebView, WebViewBuilder};

use config::{Config, Rect, WindowFrame};
use credentials::Keychain;
use login::{choose_login, update_keychain, KeychainUpdate, ProbedLogin};
use logo::{BlinkStyle, Signal};
use menu::{build_menu, menu_id, AppMenu};
use policy::{ConnectCmd, HostCmd, Ipc, Navigation, NewWindow, OpenBudget, Phase, Recovery, Via};
use probe::ProbeOutcome;

const APP_NAME: &str = "Codeman";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_SIZE: (f64, f64) = (1280.0, 820.0);
const POPOUT_SIZE: (f64, f64) = (960.0, 680.0);
const MIN_SIZE: (f64, f64) = (config::MIN_WIDTH, config::MIN_HEIGHT);
const MAX_POPOUTS: usize = 24;
/// How far a pop-out opens down and to the right of the window in use, per
/// pop-out already open (it starts over after eight).
const POPOUT_STEP: f64 = 28.0;
const SAVE_DEBOUNCE: Duration = Duration::from_secs(1);
/// How long a server load may take to commit before the app gives up on it
/// and brings the connect page back.
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);
/// A window reloads itself with the login at most once in this long after its
/// page reported that its session is gone, so a login the server keeps
/// refusing can never turn into a reload loop.
const SESSION_RELOAD_COOLDOWN: Duration = Duration::from_secs(60);
/// A window loads its page again at most once in this long after its web
/// content process ended, so a page that cannot stay up never becomes a reload
/// loop.
const CRASH_RELOAD_COOLDOWN: Duration = Duration::from_secs(30);
/// When the app first looks whether the main window made it into the full
/// screen it asked for at launch, how often it asks again, and how many times.
/// tao retries a failed entry only for a window BUILT in full screen, which
/// this one is not (create_main_window), and entering fails while macOS is
/// still switching away from another app's full-screen Space.
const FULLSCREEN_FIRST_CHECK: Duration = Duration::from_millis(700);
const FULLSCREEN_RETRY_EVERY: Duration = Duration::from_millis(500);
const FULLSCREEN_ATTEMPTS: u8 = 6;

const SETTINGS_UNREADABLE: &str = "Settings could not be read, so changes will not be saved this time.";
const LOAD_TIMED_OUT: &str = "Codeman did not open. Check that the server is still running, then connect again.";
const LOAD_CANCELLED: &str = "Opening was cancelled.";
const AUTH_REJECTED: &str = "The server did not accept the saved login. Enter the password again.";
/// A recheck that got 429. The recheck always sends the login, and a
/// single-user Codeman accepts a matching login before its rate limit, so this
/// almost always means the login is wrong; a multi-user Codeman can also refuse
/// a correct one from a busy address, so the text does not say which.
const AUTH_RATE_LIMITED: &str = "Too many failed logins from this address. The saved password may be wrong: \
enter it again (a single-user Codeman accepts the right password at once), or wait up to 15 minutes.";
const KEYCHAIN_UNREADABLE: &str = "The saved password could not be read from the Keychain. Enter it again.";
const PAGE_KEEPS_STOPPING: &str = "Codeman's page stopped twice in a row, so it was closed. Connect again.";
const LOGO_SWITCHED_OFF: &str = "The Apple logo is switched off on this Mac, so it cannot blink.";
const LOGO_DRIVEN_ELSEWHERE: &str = "An older LogoLight is driving the Apple logo, so Codeman leaves it alone. Update LogoLight to 1.3 or later (or quit it) to see your agents on it.";
/// What a download's toast calls a file whose name is not known.
const UNNAMED_FILE: &str = "the file";
const START_REFUSED: &str = "Codeman can only be started here for an http://127.0.0.1 or http://localhost address.";

enum UserEvent {
    Menu(MenuEvent),
    Ipc {
        window: WindowId,
        msg: Ipc,
    },
    ProbeDone(Box<ProbeDone>),
    ServerStartDone {
        generation: u64,
        url: Url,
        result: Result<String, String>,
    },
    /// A `window.open` or `target=_blank` asked for one of the file or
    /// download pages Codeman opens that way (policy::new_window, Via::Script).
    /// Any frame can ask like this, so the window opens without taking the
    /// keyboard, only while the script window budget allows, and nothing is
    /// reported back when it does not open.
    OpenAppWindow(Url),
    /// A page opened another site (window.open); it goes to the browser if the
    /// open budget allows.
    OpenExternal(Url),
    /// The cookies were cleared before a server load (begin_loading).
    CookiesCleared {
        generation: u64,
        url: Url,
    },
    /// What the server said to the login the challenge handler had sent when
    /// it reported a refusal (recheck_login).
    LoginChecked {
        generation: u64,
        outcome: ProbeOutcome,
    },
    Title {
        window: WindowId,
        title: String,
    },
    /// A main-frame navigation committed (wry's PageLoadEvent::Started, from
    /// WebKit's didCommitNavigation): `url` is the window's document now.
    PageCommitted {
        window: WindowId,
        url: String,
    },
    DownloadStarted {
        window: WindowId,
        url: String,
        /// The file name wry chose in ~/Downloads (de-duplicated). wry passes
        /// no path when the download ends, so this is the toast's only source.
        file_name: Option<String>,
    },
    DownloadDone {
        window: WindowId,
        url: String,
        path: Option<PathBuf>,
        ok: bool,
    },
    /// The challenge handler sent its login and got challenged again (macOS).
    /// Not trusted on its own: recheck_login asks the server first.
    AuthRejected,
    /// The web content process of a window ended (macOS): a crash, or the
    /// system taking it back under memory pressure. The window is blank until
    /// something loads in it again (on_content_process_gone).
    ContentProcessGone {
        window: WindowId,
    },
    /// A background step for the connect page finished (This Mac status, an
    /// install opened in Terminal, the install command copied): the message
    /// goes to the page if it is still the one choosing a server.
    ToConnectPage(serde_json::Value),
    /// The keep-awake worker's status line, for the value numbered `generation`
    /// (keep_awake::KeepAwake::is_current).
    KeepAwakeStatus {
        generation: u64,
        text: String,
    },
    /// The administrator prompt for removing the lid helper of 1.50.1 was answered,
    /// and its command ran (keep_awake::remove_old_helper).
    OldHelperRemoved(keep_awake::AdminOutcome),
    /// What the closed lid did with the logo last (logo::watch_lid_status).
    LogoLidStatus(String),
}

struct ProbeDone {
    generation: u64,
    url: Url,
    result: ProbeResult,
    /// The username the probe sent, when it sent a password.
    username: Option<String>,
    /// The password the probe sent: typed, from the Keychain, or the local
    /// Codeman's own login.
    password: Option<String>,
    /// Whether the Keychain holds `password` for `username` now, after the
    /// worker's own save or delete (update_keychain).
    saved: bool,
    /// The usernames whose Keychain items for this server the worker deleted.
    deleted: Vec<String>,
}

enum ProbeResult {
    Probed(ProbeOutcome),
    /// The config says a password is saved for this user, but the Keychain
    /// gave none (access denied, or the item is gone). No probe was sent: an
    /// unauthenticated one would only come back as "needs login".
    SavedPasswordUnreadable,
}

enum Kind {
    Main,
    Popout {
        /// The URL the pop-out was opened with, as handed to wry
        /// (`policy::webkit_safe_url`), which is also the form WebKit reports
        /// for a download.
        opened_url: String,
        hidden_for_download: bool,
    },
}

struct AppWindow {
    // Declared first so it is dropped before its window.
    webview: WebView,
    window: Window,
    kind: Kind,
    /// The window's last committed URL. Never read from wry's `url()`: that
    /// unwraps WKWebView.URL, which is nil until a load commits, and the app
    /// would abort.
    committed: Option<Url>,
    /// When the window last reloaded itself because its session expired.
    session_reload_at: Option<Instant>,
    /// When the window's web content process last ended.
    content_process_gone_at: Option<Instant>,
}

impl AppWindow {
    fn new(webview: WebView, window: Window, kind: Kind) -> Self {
        AppWindow {
            webview,
            window,
            kind,
            committed: None,
            session_reload_at: None,
            content_process_gone_at: None,
        }
    }

    /// A pop-out hidden because it only fetched a file (DownloadStarted).
    fn hidden_for_download(&self) -> bool {
        matches!(
            self.kind,
            Kind::Popout {
                hidden_for_download: true,
                ..
            }
        )
    }
}

enum Load<'a> {
    ConnectPage,
    Server { url: &'a str, auth: Option<&'a str> },
}

struct App {
    proxy: EventLoopProxy<UserEvent>,
    config: Config,
    /// None: no config directory, or the file could not be read or moved
    /// aside, in which case it must not be overwritten.
    config_path: Option<PathBuf>,
    config_dirty: bool,
    /// The settings are written SAVE_DEBOUNCE after this: the last write, or
    /// the last move or resize of the main window, so a drag writes the file
    /// once when it ends, not once a second while it goes on.
    save_held_since: Instant,
    /// Where the main window is in reaching a server. Shared with the web view
    /// handlers, which run on this same thread.
    phase: Rc<RefCell<Phase>>,
    /// While Loading: when to give up on the load.
    loading_deadline: Option<Instant>,
    /// Basic-auth header for (re)loading server pages; the server answers a
    /// load with its session cookie, which carries the requests after it.
    auth: Option<String>,
    /// The username and password behind `auth`, which the challenge handler
    /// answers with (set_login).
    login: Option<(String, String)>,
    /// Counts the logins handed to the challenge handler, so a recheck that
    /// comes back after Switch Server or another connect does nothing.
    login_generation: u64,
    /// The login generation a recheck is running for, if any.
    login_recheck: Option<u64>,
    windows: HashMap<WindowId, AppWindow>,
    main_id: WindowId,
    probe_generation: u64,
    start_generation: u64,
    /// The generation of the Start Codeman run still going, if any.
    starting_server: Option<u64>,
    /// Shown by the next connect page that asks for its init.
    notice: Option<String>,
    /// What hands pages to the default browser draws on.
    open_budget: OpenBudget,
    /// What the app windows a script opens draw on (UserEvent::OpenAppWindow),
    /// apart from `open_budget`, so a frame cannot use up the user's links.
    script_window_budget: OpenBudget,
    /// File names of downloads under way, per window and URL, oldest first.
    downloads: HashMap<(WindowId, String), VecDeque<String>>,
    menu: AppMenu,
    /// The one Keychain worker; every Keychain job goes through its queue.
    keychain: Keychain,
    /// Which reader of the install's output is the current one.
    install_reader: Arc<AtomicU64>,
    /// The connect page opens the agent chooser when it next loads: the menu
    /// asked for it from a Codeman page.
    add_agent_on_load: bool,
    /// While the main window may still have to be put into the full screen it
    /// asked for at launch: when to look next, and how many retries were made.
    fullscreen_retry: Option<(Instant, u8)>,
    /// The child that watches the connected server and blinks the logo.
    logo_watch: logo::Watcher,
    /// The worker that keeps this Mac awake while its agents work.
    keep_awake: keep_awake::KeepAwake,
    /// The administrator prompt for removing the old lid helper is open.
    old_helper_busy: bool,
}

fn main() {
    // The blinker is this binary without a window (logo.rs).
    if std::env::args().nth(1).as_deref() == Some(logo::BLINK_ARG) {
        logo::blink_main();
    }
    // So is the lid keeper (lid_awake.rs).
    if std::env::args().nth(1).as_deref() == Some(lid_awake::LID_ARG) {
        lid_awake::child_main();
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    {
        let menu_proxy = Mutex::new(proxy.clone());
        MenuEvent::set_event_handler(Some(move |event| {
            if let Ok(p) = menu_proxy.lock() {
                let _ = p.send_event(UserEvent::Menu(event));
            }
        }));
    }

    #[cfg(target_os = "macos")]
    {
        // Runs inside a WebKit callback: only post an event.
        let auth_proxy = proxy.clone();
        macos::set_auth_rejected_handler(Box::new(move || {
            let _ = auth_proxy.send_event(UserEvent::AuthRejected);
        }));
    }

    let config_path = Config::default_path();
    let (config, can_save) = match config_path.as_deref() {
        Some(path) => Config::load_from(path),
        None => (Config::default(), true),
    };
    let config_path = config_path.filter(|_| can_save);
    let notice = (!can_save).then(|| SETTINGS_UNREADABLE.to_string());
    logo::recover_at_launch();
    // A lid keeper that was killed left lid sleep off; and 1.50.1's helper, where
    // it is still installed, gets nothing to act on.
    lid_awake::heal();
    keep_awake::forget_legacy_request();
    let menu = build_menu(&config).unwrap_or_else(|e| fatal(&format!("Could not build the menu: {e}")));
    let phase = Rc::new(RefCell::new(Phase::Connect));
    // Started once: the probe workers and the event loop share this queue,
    // and a second one would not keep its jobs in order with the first.
    let keychain = Keychain::spawn();

    let (window, wants_fullscreen) =
        create_main_window(&event_loop, &config).unwrap_or_else(|e| fatal(&format!("Could not open a window: {e}")));
    let webview = build_webview(&window, true, true, Load::ConnectPage, &proxy, &phase)
        .unwrap_or_else(|e| fatal(&format!("Could not create the web view: {e}")));
    let main_id = window.id();

    let mut windows = HashMap::new();
    windows.insert(main_id, AppWindow::new(webview, window, Kind::Main));

    let keep_awake_proxy = proxy.clone();
    let mut app = App {
        proxy,
        config,
        config_path,
        config_dirty: false,
        save_held_since: Instant::now(),
        phase,
        loading_deadline: None,
        auth: None,
        login: None,
        login_generation: 0,
        login_recheck: None,
        windows,
        main_id,
        probe_generation: 0,
        start_generation: 0,
        starting_server: None,
        notice,
        open_budget: OpenBudget::new(),
        script_window_budget: OpenBudget::new(),
        downloads: HashMap::new(),
        menu,
        keychain,
        install_reader: Arc::new(AtomicU64::new(0)),
        add_agent_on_load: false,
        fullscreen_retry: wants_fullscreen.then(|| (Instant::now() + FULLSCREEN_FIRST_CHECK, 0)),
        logo_watch: logo::Watcher::default(),
        keep_awake: keep_awake::KeepAwake::new(move |generation, text| {
            let _ = keep_awake_proxy.send_event(UserEvent::KeepAwakeStatus { generation, text });
        }),
        old_helper_busy: false,
    };

    if app.menu.logo_lid.is_some() {
        let lid_proxy = app.proxy.clone();
        logo::watch_lid_status(move |line| {
            let _ = lid_proxy.send_event(UserEvent::LogoLidStatus(line));
        });
    }

    event_loop.run(move |event, target, control_flow| app.handle(event, target, control_flow));
}

fn fatal(message: &str) -> ! {
    eprintln!("codeman-desktop: {message}");
    std::process::exit(1);
}

/// A display's whole area in points (the menu bar and the Dock are inside it).
fn display_rect(monitor: &tao::monitor::MonitorHandle) -> Rect {
    let sf = monitor.scale_factor();
    let p = monitor.position().to_logical::<f64>(sf);
    let s = monitor.size().to_logical::<f64>(sf);
    Rect {
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
    }
}

fn monitors(target: &EventLoopWindowTarget<UserEvent>) -> Vec<Rect> {
    target.available_monitors().map(|m| display_rect(&m)).collect()
}

/// What every app window starts from.
fn window_builder() -> WindowBuilder {
    WindowBuilder::new()
        .with_title(APP_NAME)
        .with_theme(Some(Theme::Dark))
        .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1))
}

/// The corner of `window` that tao's `with_position` places: on macOS the
/// CONTENT area's top-left, elsewhere the outer one. So it is the corner that
/// is saved, and the one a pop-out steps off from.
fn placed_position(window: &Window) -> Result<PhysicalPosition<i32>, NotSupportedError> {
    if cfg!(target_os = "macos") {
        window.inner_position()
    } else {
        window.outer_position()
    }
}

/// The main window, and whether it was asked into full screen (App's
/// `fullscreen_retry` then makes sure it gets there).
fn create_main_window(
    target: &EventLoopWindowTarget<UserEvent>,
    config: &Config,
) -> Result<(Window, bool), tao::error::OsError> {
    let mut builder = window_builder();
    let screens = monitors(target);
    match config.window.and_then(|f| f.fitted_to(&screens, MIN_SIZE)) {
        Some(f) => {
            builder = builder
                .with_inner_size(LogicalSize::new(f.width, f.height))
                .with_position(LogicalPosition::new(f.x, f.y));
        }
        None => {
            builder = builder.with_inner_size(LogicalSize::new(DEFAULT_SIZE.0, DEFAULT_SIZE.1));
            if let Some(m) = target.primary_monitor() {
                let f = WindowFrame::first_run(&display_rect(&m), DEFAULT_SIZE, MIN_SIZE);
                builder = builder
                    .with_inner_size(LogicalSize::new(f.width, f.height))
                    .with_position(LogicalPosition::new(f.x, f.y));
            }
        }
    }
    let window = builder.build(target)?;
    // Full screen is entered after the window exists at its windowed frame,
    // not set on the builder: a window built straight into full screen gets
    // the whole screen as its frame, and that is the frame AppKit puts back
    // when the user leaves full screen.
    let fullscreen = config.start_fullscreen || config.window.is_some_and(|f| f.fullscreen);
    if fullscreen {
        window.set_fullscreen(Some(Fullscreen::Borderless(None)));
    }
    Ok((window, fullscreen))
}

/// The Authorization header for a login, when there is a password.
fn basic_auth(username: Option<&str>, password: Option<&str>) -> Option<String> {
    username.zip(password).map(|(u, p)| policy::basic_auth_header(u, p))
}

/// A download's file name, for its toast.
fn file_name_of(path: &Path) -> Option<String> {
    path.file_name().map(|n| n.to_string_lossy().into_owned())
}

fn auth_headers(auth: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(auth) {
        headers.insert(AUTHORIZATION, v);
    }
    headers
}

/// The connect page's answer to a prepare: the installer's plan, or why not.
fn plan_message(prepared: Result<gui_install::Preflight, String>) -> serde_json::Value {
    match prepared {
        Ok(plan) => json!({ "type": "installPlan", "plan": plan }),
        Err(message) => json!({ "type": "installPrepareFailed", "message": message }),
    }
}

/// The connect page's answer to an install on another machine (or a copy of
/// its command) that did not get going.
fn remote_install_failed(message: String) -> serde_json::Value {
    json!({ "type": "installFailed", "remote": true, "message": message })
}

/// Hand an http(s) URL to the default browser.
fn open_external(url: &Url) {
    #[cfg(target_os = "macos")]
    let child = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let child = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let child = Command::new("xdg-open").arg(url.as_str()).spawn();
    if let Ok(mut child) = child {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// Give the native challenge handler the login for the server at `url` (its
/// base path included: the handler answers only below it), or take it away
/// (None). It answers HTTP Basic challenges from that server only, so the page
/// recovers by itself when the server restarted and forgot its session. Also
/// re-arms the handler's refusal report.
fn set_challenge_login(login: Option<(&Url, &str, &str)>) {
    #[cfg(target_os = "macos")]
    macos::set_credentials(login.map(|(url, username, password)| macos::BasicCredentials {
        server: url.clone(),
        username: username.to_string(),
        password: password.to_string(),
    }));
    #[cfg(not(target_os = "macos"))]
    let _ = login;
}

/// Empty the web views' cookie jar, then post CookiesCleared for this load.
/// On macOS the clear is asynchronous and `done` runs later on the main
/// thread; elsewhere the event is posted at once.
fn clear_cookies_then_load(proxy: &EventLoopProxy<UserEvent>, generation: u64, url: Url) {
    let proxy = proxy.clone();
    let done = move || {
        let _ = proxy.send_event(UserEvent::CookiesCleared { generation, url });
    };
    #[cfg(target_os = "macos")]
    macos::clear_cookies(Box::new(done));
    #[cfg(not(target_os = "macos"))]
    done();
}

/// `focused`: the web view takes the keyboard and brings the app to the front
/// (wry's default). False for a window a script opened: it comes up without
/// pulling the user out of the app they are typing in.
fn build_webview(
    window: &Window,
    is_main: bool,
    focused: bool,
    load: Load<'_>,
    proxy: &EventLoopProxy<UserEvent>,
    phase: &Rc<RefCell<Phase>>,
) -> wry::Result<WebView> {
    let id = window.id();
    let mut builder = WebViewBuilder::new()
        .with_initialization_script(assets::HOST_SHIM)
        .with_devtools(true)
        .with_focused(focused)
        .with_accept_first_mouse(true)
        .with_back_forward_navigation_gestures(false)
        // false = let WebKit take the drop, so Codeman's own HTML5 drop
        // (prompt uploads) and <input type=file> drops keep working.
        .with_drag_drop_handler(|_| false)
        // Ask the user per page instead of wry's default of granting the
        // microphone and camera to every frame, sandboxed previews included.
        .with_permission_handler(|_| PermissionResponse::Default);

    if is_main {
        builder = builder.with_custom_protocol(policy::APP_SCHEME.into(), |_id, request| assets::respond(request));
    }

    // The handlers below read the phase with try_borrow and fail closed: the
    // app never holds a borrow across a call into wry, so it cannot fail, but
    // a panic here would abort the app.
    let nav_phase = phase.clone();
    builder = builder.with_navigation_handler(move |target| {
        nav_phase
            .try_borrow()
            .is_ok_and(|phase| policy::navigation(&target, &phase) == Navigation::Allow)
    });

    // Every answer to WebKit is Deny: the window WebKit would build carries
    // none of the app's handlers. What the page asked for is done through the
    // event loop. A refusal is not reported back: this path takes requests
    // from any frame (wry does not say which), and a report would run in the
    // dashboard. Codeman's own pop-outs, the ones it wants to hear about, come
    // through CodemanHost.openWindow (on_host_cmd).
    let nw_phase = phase.clone();
    let nw_proxy = proxy.clone();
    builder = builder.with_new_window_req_handler(move |target, _features| {
        let decision = match nw_phase.try_borrow() {
            Ok(phase) => policy::new_window(&target, &phase, Via::Script),
            Err(_) => NewWindow::Deny,
        };
        let event = match decision {
            NewWindow::AppWindow(url) => Some(UserEvent::OpenAppWindow(url)),
            NewWindow::External(url) => Some(UserEvent::OpenExternal(url)),
            NewWindow::Deny => None,
        };
        if let Some(event) = event {
            let _ = nw_proxy.send_event(event);
        }
        NewWindowResponse::Deny
    });

    let ipc_phase = phase.clone();
    let ipc_proxy = proxy.clone();
    builder = builder.with_ipc_handler(move |request| {
        let frame_url = request.uri().to_string();
        let msg = match ipc_phase.try_borrow() {
            Ok(phase) => policy::parse_ipc(&frame_url, request.body(), &phase, is_main),
            Err(_) => None,
        };
        if let Some(msg) = msg {
            let _ = ipc_proxy.send_event(UserEvent::Ipc { window: id, msg });
        }
    });

    let load_phase = phase.clone();
    let load_proxy = proxy.clone();
    builder = builder.with_on_page_load_handler(move |event, url| {
        if !matches!(event, PageLoadEvent::Started) {
            return;
        }
        // Started is didCommitNavigation. The main window's phase moves to
        // Loaded right here, so the gates change in the same instant the
        // server page becomes the document. App repeats the step when the
        // event arrives, in case the borrow was not free.
        if is_main {
            if let Ok(mut phase) = load_phase.try_borrow_mut() {
                if let Some(next) = policy::loaded_on_commit(&phase, &url) {
                    *phase = next;
                }
            }
        }
        let _ = load_proxy.send_event(UserEvent::PageCommitted { window: id, url });
    });

    let title_proxy = proxy.clone();
    builder = builder.with_document_title_changed_handler(move |title| {
        let _ = title_proxy.send_event(UserEvent::Title { window: id, title });
    });

    let dl_proxy = proxy.clone();
    builder = builder.with_download_started_handler(move |url, destination| {
        // wry already picked ~/Downloads/<suggested name>, de-duplicated; it
        // stays as it is. Only its name is passed on, for the toast.
        let file_name = file_name_of(destination);
        let _ = dl_proxy.send_event(UserEvent::DownloadStarted {
            window: id,
            url,
            file_name,
        });
        true
    });
    let done_proxy = proxy.clone();
    builder = builder.with_download_completed_handler(move |url, path, ok| {
        let _ = done_proxy.send_event(UserEvent::DownloadDone {
            window: id,
            url,
            path,
            ok,
        });
    });

    // wry answers WebKit's "web content process ended" notice itself, which
    // turns WebKit's own reload off: without a handler the window stays blank.
    #[cfg(target_os = "macos")]
    {
        use wry::WebViewBuilderExtDarwin;
        let gone_proxy = proxy.clone();
        builder = builder.with_on_web_content_process_terminate_handler(move || {
            let _ = gone_proxy.send_event(UserEvent::ContentProcessGone { window: id });
        });
    }

    builder = match load {
        Load::ConnectPage => builder.with_url(policy::CONNECT_PAGE),
        Load::Server { url, auth: Some(auth) } => builder.with_url_and_headers(url, auth_headers(auth)),
        Load::Server { url, auth: None } => builder.with_url(url),
    };
    let webview = builder.build(window)?;
    #[cfg(target_os = "macos")]
    macos::install(&webview);
    Ok(webview)
}

/// Hides the whole app, as Cmd+H does. A click on the Dock icon (or Cmd+Tab)
/// shows it again with every window as it was, a full-screen one included,
/// which hiding the main window alone would not do.
#[cfg(target_os = "macos")]
fn hide_app(target: &EventLoopWindowTarget<UserEvent>) {
    use tao::platform::macos::EventLoopWindowTargetExtMacOS;
    target.hide_application();
}

#[cfg(not(target_os = "macos"))]
fn hide_app(_target: &EventLoopWindowTarget<UserEvent>) {}

impl App {
    fn handle(
        &mut self,
        event: Event<UserEvent>,
        target: &EventLoopWindowTarget<UserEvent>,
        control_flow: &mut ControlFlow,
    ) {
        match event {
            Event::NewEvents(StartCause::Init) => {
                #[cfg(target_os = "macos")]
                {
                    self.menu.bar.init_for_nsapp();
                    self.menu.window_menu.set_as_windows_menu_for_nsapp();
                    self.menu.help_menu.set_as_help_menu_for_nsapp();
                }
            }
            Event::WindowEvent { window_id, event, .. } => self.on_window_event(window_id, event, target, control_flow),
            Event::UserEvent(event) => self.on_user_event(event, target),
            // A click on the Dock icon while no window is visible, which is
            // the main window minimized: tao only reports it, so bring the
            // window back here. An app hidden by closing its window
            // (`hide_app`) needs nothing here: AppKit unhides it, with every
            // window as it was, before it reports the click.
            Event::Reopen {
                has_visible_windows: false,
                ..
            } => self.show_main_window(),
            Event::MainEventsCleared => self.on_events_cleared(control_flow),
            Event::LoopDestroyed => {
                self.keep_awake.shutdown();
                self.record_main_frame();
                self.save_config();
            }
            _ => {}
        }
    }

    /// The end of a loop iteration: run what is due, then sleep until the next
    /// deadline. tao reads the control flow after this iteration's last event,
    /// so it is only decided here, never reset per event.
    fn on_events_cleared(&mut self, control_flow: &mut ControlFlow) {
        let now = Instant::now();
        if self.config_dirty && now >= self.save_held_since + SAVE_DEBOUNCE {
            self.save_config();
        }
        let loading = matches!(*self.phase.borrow(), Phase::Loading(_));
        if !loading {
            self.loading_deadline = None;
        } else if self.loading_deadline.is_some_and(|due| now >= due) {
            self.show_connect_page(Some(LOAD_TIMED_OUT.into()), false);
        }
        if self.fullscreen_retry.is_some_and(|(due, _)| now >= due) {
            self.retry_fullscreen(now);
        }
        if matches!(*control_flow, ControlFlow::ExitWithCode(_)) {
            return;
        }
        let save_due = self.config_dirty.then(|| self.save_held_since + SAVE_DEBOUNCE);
        let fullscreen_due = self.fullscreen_retry.map(|(due, _)| due);
        *control_flow = match [save_due, self.loading_deadline, fullscreen_due]
            .into_iter()
            .flatten()
            .min()
        {
            Some(due) => ControlFlow::WaitUntil(due),
            None => ControlFlow::Wait,
        };
    }

    /// The main window asked for full screen at launch: if it is not there
    /// yet, ask again, a few times at most. tao reports a window as full
    /// screen from the moment it is asked and puts that back only when the
    /// entry fails, so `fullscreen()` being None means it failed. Stops once
    /// the window is in full screen or minimized, so a user who leaves full
    /// screen later is never pulled back.
    fn retry_fullscreen(&mut self, now: Instant) {
        let Some((_, attempts)) = self.fullscreen_retry else {
            return;
        };
        self.fullscreen_retry = None;
        let Some(main) = self.windows.get(&self.main_id) else {
            return;
        };
        if main.window.fullscreen().is_some() || main.window.is_minimized() || attempts >= FULLSCREEN_ATTEMPTS {
            return;
        }
        main.window.set_fullscreen(Some(Fullscreen::Borderless(None)));
        self.fullscreen_retry = Some((now + FULLSCREEN_RETRY_EVERY, attempts + 1));
    }

    fn on_window_event(
        &mut self,
        id: WindowId,
        event: WindowEvent,
        target: &EventLoopWindowTarget<UserEvent>,
        control_flow: &mut ControlFlow,
    ) {
        match event {
            WindowEvent::CloseRequested if id != self.main_id => self.remove_window(id),
            WindowEvent::CloseRequested => {
                self.record_main_frame();
                self.save_config();
                let server = self.phase.borrow().loaded().cloned();
                let mode = self.config.keep_awake.mode;
                if keep_awake::available()
                    && keep_awake::close_hides_app(mode, server.as_ref(), keep_awake::local_addresses)
                {
                    // Keep This Mac Awake ends with the app, so closing the
                    // window while it watches a Codeman on this Mac hides
                    // Codeman instead, as Cmd+H does (full screen and pop-outs
                    // included): the Mac stays awake, a click on the Dock icon
                    // brings it back, and Cmd+Q still quits.
                    hide_app(target);
                } else {
                    // Closing the main window quits; the server and its
                    // sessions keep running, so nothing is lost.
                    self.keep_awake.shutdown();
                    *control_flow = ControlFlow::Exit;
                }
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) if id == self.main_id => self.record_main_frame(),
            _ => {}
        }
    }

    fn on_user_event(&mut self, event: UserEvent, target: &EventLoopWindowTarget<UserEvent>) {
        match event {
            UserEvent::Menu(e) => self.on_menu(e.id.0.as_str()),
            UserEvent::Ipc { window, msg } => match msg {
                Ipc::Host(cmd) => self.on_host_cmd(window, cmd, target),
                Ipc::Connect(cmd) => self.on_connect_cmd(cmd),
            },
            UserEvent::ProbeDone(done) => self.on_probe_done(*done),
            UserEvent::ToConnectPage(msg) => {
                if self.choosing() {
                    self.to_connect_page(msg);
                }
            }
            UserEvent::LogoLidStatus(line) => self.show_lid_status(line),
            UserEvent::ServerStartDone {
                generation,
                url,
                result,
            } => {
                self.starting_server = None;
                if generation != self.start_generation {
                    return; // cancelled
                }
                let ok = result.is_ok();
                let output = result.unwrap_or_else(|e| e);
                self.to_connect_page(json!({
                    "type": "serverStartResult",
                    "ok": ok,
                    "output": output,
                    "url": url.as_str(),
                }));
            }
            UserEvent::OpenAppWindow(url) => {
                if self.script_window_budget.allow(Instant::now()) {
                    // Built without focus: it comes to the front, but the
                    // keyboard stays with the window the user is typing in.
                    self.build_popout(target, &url, false);
                } else {
                    eprintln!("codeman-desktop: too many windows opened by a page at once; dropped one");
                }
            }
            UserEvent::OpenExternal(url) => {
                self.open_external_budgeted(&url);
            }
            UserEvent::CookiesCleared { generation, url } => {
                // Only the load this clear was for, and only while it is
                // still wanted: a Cancel, Switch Server, timeout or another
                // connect in between moved the generation or the phase on.
                let current = generation == self.probe_generation
                    && matches!(&*self.phase.borrow(), Phase::Loading(loading) if *loading == url);
                if current {
                    self.load_in(self.main_id, &policy::webkit_safe_url(&url), true);
                }
            }
            UserEvent::LoginChecked { generation, outcome } => self.on_login_checked(generation, outcome),
            UserEvent::Title { window, title } => {
                if let Some(w) = self.windows.get(&window) {
                    let title = title.trim();
                    w.window.set_title(if title.is_empty() { APP_NAME } else { title });
                }
            }
            UserEvent::PageCommitted { window, url } => {
                if window == self.main_id {
                    let next = policy::loaded_on_commit(&self.phase.borrow(), &url);
                    if let Some(next) = next {
                        *self.phase.borrow_mut() = next;
                    }
                    self.sync_logo_watch();
                    self.sync_keep_awake();
                }
                if let Some(w) = self.windows.get_mut(&window) {
                    w.committed = Url::parse(&url).ok();
                }
            }
            UserEvent::DownloadStarted { window, url, file_name } => {
                // A pop-out opened only to fetch a file would sit empty: hide
                // it now, drop it when the download ends (dropping it sooner
                // could cancel the download with its web view).
                if let Some(w) = self.windows.get_mut(&window) {
                    if let Kind::Popout {
                        opened_url,
                        hidden_for_download,
                    } = &mut w.kind
                    {
                        if *opened_url == url {
                            *hidden_for_download = true;
                            w.window.set_visible(false);
                        }
                    }
                    self.downloads
                        .entry((window, url))
                        .or_default()
                        .push_back(file_name.unwrap_or_else(|| UNNAMED_FILE.into()));
                }
            }
            UserEvent::DownloadDone { window, url, path, ok } => {
                let key = (window, url);
                let started = self.downloads.get_mut(&key).and_then(VecDeque::pop_front);
                if self.downloads.get(&key).is_some_and(VecDeque::is_empty) {
                    self.downloads.remove(&key);
                }
                let name = started
                    .or_else(|| path.as_deref().and_then(file_name_of))
                    .unwrap_or_else(|| UNNAMED_FILE.into());
                let server = self.phase.borrow().loaded().cloned();
                // The toast goes where the download was started when that
                // window still shows Codeman's own app (a session pop-out has
                // it too), else to the main window. Chosen before the hidden
                // pop-out below is dropped.
                let toast_in = server.as_ref().map(|server| {
                    let shows_app = self.windows.get(&window).is_some_and(|w| {
                        !w.hidden_for_download()
                            && w.committed
                                .as_ref()
                                .is_some_and(|url| policy::trusted_frame(url, server))
                    });
                    if shows_app {
                        window
                    } else {
                        self.main_id
                    }
                });
                if self.windows.get(&window).is_some_and(AppWindow::hidden_for_download) {
                    self.remove_window(window);
                }
                if let Some(w) = toast_in.and_then(|id| self.windows.get(&id)) {
                    let _ = w.webview.evaluate_script(&assets::download_toast_script(&name, ok));
                }
            }
            UserEvent::AuthRejected => self.recheck_login(),
            UserEvent::ContentProcessGone { window } => self.on_content_process_gone(window),
            UserEvent::KeepAwakeStatus { generation, text } => {
                if self.keep_awake.is_current(generation) {
                    if let Some(items) = &self.menu.keep_awake {
                        items.status.set_text(&text);
                    }
                }
            }
            UserEvent::OldHelperRemoved(outcome) => self.on_old_helper_removed(outcome),
        }
    }

    /// The web content process of `window` ended, so the window is blank
    /// (policy::recovery decides what it does about it). A second end within
    /// CRASH_RELOAD_COOLDOWN counts as the same page failing again.
    fn on_content_process_gone(&mut self, window: WindowId) {
        let now = Instant::now();
        let Some(w) = self.windows.get_mut(&window) else {
            return;
        };
        // A pop-out hidden for its download shows no page, and the download
        // does not run in that process: loading again would fetch it twice.
        if w.hidden_for_download() {
            return;
        }
        let again = w
            .content_process_gone_at
            .is_some_and(|at| now.saturating_duration_since(at) < CRASH_RELOAD_COOLDOWN);
        w.content_process_gone_at = Some(now);
        let on_server = self.phase.borrow().loaded().is_some();
        match policy::recovery(window == self.main_id, on_server, again) {
            Recovery::Reload => {
                if let Some((url, with_auth)) = self.reload_target(window) {
                    self.load_in(window, &url, with_auth);
                }
            }
            Recovery::ConnectPage { gave_up } => {
                self.show_connect_page(gave_up.then(|| PAGE_KEEPS_STOPPING.to_string()), false);
            }
            Recovery::Close => self.remove_window(window),
            Recovery::Nothing => eprintln!("codeman-desktop: a page stopped again and was left as it is"),
        }
    }

    /// The challenge handler reported that the server refused its login. That
    /// is not taken on trust: a 401 the handler reads as Codeman's can still
    /// come from something Codeman relays (a dashboard asset a web tab fetches
    /// by a root-absolute URL). So the login is checked once against the
    /// server's own status API, off the event loop, and on_login_checked
    /// decides.
    fn recheck_login(&mut self) {
        let Some(server) = self.phase.borrow().server().cloned() else {
            return; // the connect page: nothing to recheck
        };
        let Some(auth) = self.auth.clone() else {
            return;
        };
        let generation = self.login_generation;
        if self.login_recheck == Some(generation) {
            return;
        }
        self.login_recheck = Some(generation);
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let outcome = probe::probe(&server, Some(&auth));
            let _ = proxy.send_event(UserEvent::LoginChecked { generation, outcome });
        });
    }

    /// The server's answer to recheck_login. A refused login brings the
    /// connect page back (without taking focus from another app). So does a
    /// 429: the page's own requests then get 429 too, which carries no
    /// challenge, so nothing else would ever notice, and re-arming would send
    /// the refused login again once the limit lapses. Any other answer, a
    /// network error included, leaves the page as it is and hands the handler
    /// the same login again, which also re-arms its report, so a later real
    /// refusal is noticed.
    fn on_login_checked(&mut self, generation: u64, outcome: ProbeOutcome) {
        if self.login_recheck == Some(generation) {
            self.login_recheck = None;
        }
        if generation != self.login_generation {
            return; // another login, or none, since the recheck started
        }
        let Some(server) = self.phase.borrow().server().cloned() else {
            return;
        };
        match outcome {
            ProbeOutcome::BadCredentials | ProbeOutcome::NeedsLogin => {
                self.show_connect_page(Some(AUTH_REJECTED.into()), false);
            }
            ProbeOutcome::RateLimited { .. } => {
                self.show_connect_page(Some(AUTH_RATE_LIMITED.into()), false);
            }
            _ => {
                if let Some((username, password)) = &self.login {
                    set_challenge_login(Some((&server, username, password)));
                }
            }
        }
    }

    /// The logo is watched while the switch is on, a state has a style and a
    /// server is open.
    fn sync_logo_watch(&mut self) {
        let styles = self.config.logo_blink;
        let phase = self.phase.borrow();
        let server = phase.loaded().filter(|_| styles.active() && logo::available());
        self.logo_watch
            .sync(server.map(|url| (url.as_str(), self.auth.as_deref(), styles)));
        drop(phase);
        self.show_lid_status(logo::lid_status_line());
    }

    /// The line under the logo's styles: what the closed lid did last, or that
    /// nothing watches it now.
    fn show_lid_status(&self, line: String) {
        if let Some(item) = &self.menu.logo_lid {
            if self.logo_watch.watching() {
                item.set_text(line);
            } else {
                item.set_text(logo::LID_NOT_WATCHED);
            }
        }
    }

    fn choose_logo_blink(&mut self, signal: Signal, style: BlinkStyle) {
        let was_active = self.config.logo_blink.active();
        self.config.logo_blink.set(signal, style);
        // Picking a style is asking for the logo to show it.
        if style != BlinkStyle::Off {
            self.config.logo_blink.enabled = true;
        }
        self.logo_blink_changed(was_active);
    }

    /// The one switch. Turned on with every state off, it brings the recommended
    /// styles, so that on always shows something.
    fn toggle_logo_blink(&mut self) {
        let was_active = self.config.logo_blink.active();
        let on = !self.config.logo_blink.enabled;
        self.config.logo_blink.enabled = on;
        if on && !self.config.logo_blink.any_style() {
            self.config.logo_blink = logo::BlinkStyles::RECOMMENDED;
        }
        self.logo_blink_changed(was_active);
    }

    fn logo_blink_changed(&mut self, was_active: bool) {
        // A click flips the item it landed on, so every item is set from the
        // settings, the clicked one included.
        let styles = self.config.logo_blink;
        if let Some(switch) = &self.menu.logo_switch {
            switch.set_checked(styles.enabled);
        }
        for (signal, style, item) in &self.menu.logo_styles {
            item.set_checked(styles.get(*signal) == *style);
        }
        self.config_dirty = true;
        self.sync_logo_watch();
        // Only from off: with a blink running, a dark logo may be our own.
        if was_active || !styles.active() {
            return;
        }
        let warning = if logo::switched_off() {
            LOGO_SWITCHED_OFF
        } else if logo::driven_elsewhere() {
            LOGO_DRIVEN_ELSEWHERE
        } else {
            return;
        };
        if let Some(main) = self.windows.get(&self.main_id) {
            let _ = main.webview.evaluate_script(&assets::toast_script(warning, "warning"));
        }
    }

    /// Keep-awake watches the open server while a mode is chosen. Whether that
    /// server is this Mac is the worker's to find out.
    fn sync_keep_awake(&mut self) {
        let mut settings = self.config.keep_awake;
        // The lid item only exists on a Mac with a lid; a setting copied from one
        // does nothing elsewhere.
        settings.lid &= keep_awake::has_lid();
        let server = self.phase.borrow().loaded().cloned();
        let watch = server
            .filter(|_| settings.mode != keep_awake::Mode::Off)
            .map(|server| keep_awake::Watch {
                server,
                authorization: self.auth.clone(),
                settings,
            });
        let idle = match (settings.mode, &watch) {
            (keep_awake::Mode::Off, _) => Some(keep_awake::OFF_TEXT),
            (_, None) => Some(keep_awake::NO_SERVER_TEXT),
            _ => None,
        };
        self.keep_awake.sync(watch);
        if let (Some(text), Some(items)) = (idle, &self.menu.keep_awake) {
            items.status.set_text(text);
        }
    }

    fn choose_keep_awake_mode(&mut self, mode: keep_awake::Mode) {
        if let Some(items) = &self.menu.keep_awake {
            // A click flips the item it landed on, the chosen one included.
            for (item_mode, item) in &items.modes {
                item.set_checked(*item_mode == mode);
            }
        }
        self.config.keep_awake.mode = mode;
        self.config_dirty = true;
        self.sync_keep_awake();
    }

    fn toggle_keep_awake_ac_only(&mut self) {
        let Some(item) = self.menu.keep_awake.as_ref().and_then(|items| items.ac_only.as_ref()) else {
            return;
        };
        self.config.keep_awake.ac_only = item.is_checked();
        self.config_dirty = true;
        self.sync_keep_awake();
    }

    fn toggle_keep_awake_lid(&mut self) {
        let Some(item) = self.menu.keep_awake.as_ref().and_then(|items| items.lid.as_ref()) else {
            return;
        };
        self.config.keep_awake.lid = item.is_checked();
        self.config_dirty = true;
        self.sync_keep_awake();
    }

    /// Codeman 1.50.1 kept the lid awake through a root helper. Nothing uses it any
    /// more, and taking it away is the one thing left that asks for the
    /// administrator password. The prompt runs off the event loop.
    fn remove_old_helper(&mut self) {
        if self.old_helper_busy {
            return;
        }
        self.old_helper_busy = true;
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let _ = proxy.send_event(UserEvent::OldHelperRemoved(keep_awake::remove_old_helper()));
        });
    }

    fn on_old_helper_removed(&mut self, outcome: keep_awake::AdminOutcome) {
        use keep_awake::AdminOutcome;
        self.old_helper_busy = false;
        let failure = match (outcome, keep_awake::old_helper_installed()) {
            (AdminOutcome::Cancelled, _) => None,
            (AdminOutcome::Failed(error), _) => Some(error),
            (AdminOutcome::Done, false) => {
                if let Some(items) = &mut self.menu.keep_awake {
                    items.old_helper_removed();
                }
                None
            }
            (AdminOutcome::Done, true) => Some("The removal ran, but the helper's files are still there.".to_owned()),
        };
        if let Some(detail) = failure {
            let title = "The old lid helper could not be removed.";
            eprintln!("codeman-desktop: {title} {detail}");
            #[cfg(target_os = "macos")]
            macos::show_message(title, &detail);
        }
    }

    fn on_menu(&mut self, id: &str) {
        if let Some((signal, style)) = BlinkStyle::from_menu_id(id) {
            self.choose_logo_blink(signal, style);
            return;
        }
        if let Some(mode) = keep_awake::Mode::from_menu_id(id) {
            self.choose_keep_awake_mode(mode);
            return;
        }
        match id {
            keep_awake::AC_ONLY_ID => self.toggle_keep_awake_ac_only(),
            keep_awake::LID_ID => self.toggle_keep_awake_lid(),
            keep_awake::REMOVE_OLD_HELPER_ID => self.remove_old_helper(),
            menu_id::SWITCH => self.show_connect_page(None, true),
            menu_id::ADD_AGENT => self.add_agent(),
            menu_id::RELOAD => self.reload_focused(),
            menu_id::LOGO_BLINK => self.toggle_logo_blink(),
            menu_id::START_FULLSCREEN => {
                let value = self.menu.start_fullscreen.is_checked();
                self.config.start_fullscreen = value;
                self.config_dirty = true;
                self.to_connect_page(json!({ "type": "prefs", "startFullscreen": value }));
            }
            menu_id::DEVTOOLS => {
                if let Some(w) = self.focused_window_id().and_then(|id| self.windows.get(&id)) {
                    w.webview.open_devtools();
                }
            }
            // The Help items are the user's own click, so they skip the budget.
            menu_id::HELP_DOCS => open_external(&Url::parse(menu::DOCS_URL).expect("static url")),
            menu_id::HELP_GITHUB => open_external(&Url::parse(menu::REPO_URL).expect("static url")),
            _ => {}
        }
    }

    fn on_host_cmd(&mut self, window: WindowId, cmd: HostCmd, target: &EventLoopWindowTarget<UserEvent>) {
        match cmd {
            HostCmd::OpenWindow(raw) => {
                // The page's openWindow already answered true, so every way
                // this can fail (refused, the pop-out limit, a window that
                // did not build, the browser budget) is reported back to it.
                // This request comes only from Codeman's own app shell
                // (parse_ipc), so a session it asked for gets its tab back.
                let session = self.phase.borrow().loaded().and_then(|server| {
                    Url::parse(&raw)
                        .ok()
                        .and_then(|url| policy::session_id_of(&url, server))
                });
                let decision = policy::new_window(&raw, &self.phase.borrow(), Via::Host);
                let opened = match decision {
                    NewWindow::AppWindow(url) => self.build_popout(target, &url, true),
                    NewWindow::External(url) => self.open_external_budgeted(&url),
                    NewWindow::Deny => false,
                };
                if !opened {
                    self.tell_refused(window, session.as_deref());
                }
            }
            HostCmd::CloseWindow => self.remove_window(window),
            HostCmd::FocusWindow => {
                if let Some(w) = self.windows.get(&window) {
                    w.window.set_visible(true);
                    w.window.set_minimized(false);
                    w.window.set_focus();
                }
            }
            HostCmd::OpenExternal(raw) => self.open_external_raw(&raw),
            HostCmd::SessionExpired => self.on_session_expired(window),
        }
    }

    fn on_connect_cmd(&mut self, cmd: ConnectCmd) {
        // The connect page is still live while a server loads, but only
        // Cancel and the settings make sense then.
        let choosing = self.choosing();
        let loading = matches!(*self.phase.borrow(), Phase::Loading(_));
        match cmd {
            ConnectCmd::Ready => self.send_init(),
            ConnectCmd::Connect {
                url,
                username,
                password,
                remember,
            } => {
                if choosing {
                    self.start_probe(url, username, password, remember);
                }
            }
            ConnectCmd::Cancel => {
                self.probe_generation += 1;
                self.start_generation += 1;
                // Only a load that has not committed yet: once the server page
                // is up, a Cancel that was still on its way changes nothing.
                if loading {
                    self.show_connect_page(Some(LOAD_CANCELLED.into()), true);
                }
            }
            ConnectCmd::StartServer { url } => {
                if choosing {
                    self.start_server(url);
                }
            }
            ConnectCmd::Forget { url } => {
                if let Some(entry) = self.config.forget(&url) {
                    if let Some(user) = entry.username {
                        self.keychain.delete(&credentials::account(&url, &user));
                    }
                    self.config_dirty = true;
                }
                self.to_connect_page(json!({ "type": "servers", "servers": self.config.servers }));
            }
            ConnectCmd::SetAutoConnect(v) => {
                self.config.auto_connect = v;
                self.config_dirty = true;
            }
            ConnectCmd::SetStartFullscreen(v) => {
                self.config.start_fullscreen = v;
                self.menu.start_fullscreen.set_checked(v);
                self.config_dirty = true;
            }
            ConnectCmd::OpenExternal(raw) => self.open_external_raw(&raw),
            ConnectCmd::LocalStatus { quick, deep } => {
                if choosing {
                    let depth = match (quick, deep) {
                        (true, _) => setup::Depth::Quick,
                        (false, false) => setup::Depth::Login,
                        (false, true) => setup::Depth::Interactive,
                    };
                    self.in_background(move || json!({ "type": "localStatus", "status": setup::inspect(depth) }));
                }
            }
            ConnectCmd::InstallLocal { network } => {
                if choosing {
                    self.in_background(move || {
                        let port = setup::pick_install_port();
                        let script =
                            terminal_install::local_install_script(terminal_install::LocalInstall { port, network });
                        match terminal_install::open_in_terminal(terminal_install::LOCAL_SCRIPT_NAME, &script) {
                            Ok(()) => json!({ "type": "installStarted", "port": port }),
                            Err(message) => json!({ "type": "installFailed", "message": message }),
                        }
                    });
                }
            }
            ConnectCmd::InstallPrepare => {
                if choosing {
                    self.in_background(|| plan_message(gui_install::prepare()));
                }
            }
            ConnectCmd::InstallStart {
                network_password,
                ai_cli,
            } => {
                if choosing {
                    let send = self.page_sender();
                    let stale = self.next_install_reader();
                    std::thread::spawn(move || {
                        let plan = gui_install::Plan {
                            port: setup::pick_install_port(),
                            network_password,
                            ai_cli,
                        };
                        match gui_install::start(&plan) {
                            Ok(()) => {
                                send(json!({ "type": "installRunning", "port": plan.port }));
                                gui_install::follow(gui_install::Run::Codeman, stale, send);
                            }
                            Err(message) => send(json!({ "type": "installStartFailed", "message": message })),
                        }
                    });
                }
            }
            ConnectCmd::InstallAttach => {
                if choosing {
                    self.attach_to_run(gui_install::Run::Codeman);
                }
            }
            ConnectCmd::InstallCancel => {
                std::thread::spawn(gui_install::cancel);
            }
            ConnectCmd::AgentPrepare => {
                if choosing {
                    self.in_background(|| plan_message(gui_install::prepare_agent()));
                }
            }
            ConnectCmd::AgentStart { ai_cli } => {
                if choosing {
                    let send = self.page_sender();
                    let stale = self.next_install_reader();
                    std::thread::spawn(move || match gui_install::start_agent(&ai_cli) {
                        Ok(()) => gui_install::follow(gui_install::Run::Agent, stale, send),
                        Err(message) => send(json!({ "type": "installStartFailed", "message": message })),
                    });
                }
            }
            ConnectCmd::AgentAttach => {
                if choosing {
                    self.attach_to_run(gui_install::Run::Agent);
                }
            }
            ConnectCmd::InstallRemote { target } => {
                if choosing {
                    match terminal_install::SshTarget::parse(&target) {
                        Err(message) => self.to_connect_page(remote_install_failed(message)),
                        Ok(target) => self.in_background(move || {
                            let script = terminal_install::remote_install_script(&target);
                            match terminal_install::open_in_terminal(terminal_install::REMOTE_SCRIPT_NAME, &script) {
                                Ok(()) => json!({
                                    "type": "remoteInstallStarted",
                                    "host": target.host,
                                    "url": target.suggested_url(),
                                }),
                                Err(message) => remote_install_failed(message),
                            }
                        }),
                    }
                }
            }
            ConnectCmd::CopyInstallCommand => {
                self.in_background(|| match terminal_install::copy_to_clipboard(setup::INSTALL_ONE_LINER) {
                    Ok(()) => json!({ "type": "copied" }),
                    Err(message) => remote_install_failed(message),
                });
            }
        }
    }

    /// Report a run that is going already to the page, from its first line.
    fn attach_to_run(&self, run: gui_install::Run) {
        let send = self.page_sender();
        let stale = self.next_install_reader();
        std::thread::spawn(move || gui_install::follow(run, stale, send));
    }

    /// The agent chooser lives on the connect page: from a Codeman page, this
    /// leaves it the way Switch Server does.
    fn add_agent(&mut self) {
        if self.choosing() {
            if let Some(main) = self.windows.get(&self.main_id) {
                main.window.set_visible(true);
                main.window.set_focus();
            }
            self.to_connect_page(json!({ "type": "addAgent" }));
        } else {
            self.add_agent_on_load = true;
            self.show_connect_page(None, true);
        }
    }

    /// A new reader of the install's output replaces the one before it: the
    /// answer is how that new reader learns it was replaced in turn.
    fn next_install_reader(&self) -> impl Fn() -> bool + Send + 'static {
        let generation = self.install_reader.clone();
        let mine = generation.fetch_add(1, Ordering::SeqCst) + 1;
        move || generation.load(Ordering::SeqCst) != mine
    }

    /// Run `work` off the event loop (it may run a login shell, plutil,
    /// Terminal or a probe) and hand what it returns to the connect page.
    fn in_background(&self, work: impl FnOnce() -> serde_json::Value + Send + 'static) {
        let send = self.page_sender();
        std::thread::spawn(move || send(work()));
    }

    /// Hands a message to the connect page from another thread
    /// (UserEvent::ToConnectPage).
    fn page_sender(&self) -> impl Fn(serde_json::Value) + Send + 'static {
        let proxy = self.proxy.clone();
        move |msg| {
            let _ = proxy.send_event(UserEvent::ToConnectPage(msg));
        }
    }

    fn send_init(&mut self) {
        let notice = self.notice.take();
        let add_agent = std::mem::take(&mut self.add_agent_on_load);
        self.to_connect_page(json!({
            "type": "init",
            "servers": self.config.servers,
            "autoConnect": self.config.auto_connect,
            "startFullscreen": self.config.start_fullscreen,
            "version": VERSION,
            "starting": self.start_running(),
            "notice": notice,
            "addAgent": add_agent,
        }));
    }

    /// Whether the connect page is up with no server chosen: the only time it
    /// may run anything.
    fn choosing(&self) -> bool {
        matches!(*self.phase.borrow(), Phase::Connect)
    }

    /// Whether a Start Codeman run is going whose result the page will get.
    fn start_running(&self) -> bool {
        self.starting_server == Some(self.start_generation)
    }

    fn start_probe(&mut self, raw: String, username: Option<String>, password: Option<String>, remember: bool) {
        let url = match policy::normalize_server_url(&raw) {
            Ok(u) => u,
            Err(message) => {
                self.to_connect_page(json!({ "type": "error", "message": message }));
                return;
            }
        };
        let key = url.to_string();
        let typed_user = username.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
        let typed_password = password.filter(|p| !p.is_empty());
        let entry = self.config.find(&key);
        // The user the config names for this server now. Its Keychain item
        // goes once the probe accepts another one (update_keychain).
        let previous_user = entry.and_then(|e| e.username.clone());
        let user = typed_user.or_else(|| previous_user.clone());
        // The config says the Keychain holds this user's password.
        let expect_saved = typed_password.is_none()
            && user.is_some()
            && entry.is_some_and(|e| e.has_saved_password && e.username == user);

        self.probe_generation += 1;
        let generation = self.probe_generation;
        let proxy = self.proxy.clone();
        let keychain = self.keychain.clone();
        // Every Keychain call for the connect happens here, never on the
        // event loop: any of them can bring up the system's access prompt,
        // which must not hold up the window.
        std::thread::spawn(move || {
            let saved = match typed_password {
                Some(_) => None,
                None => user
                    .as_ref()
                    .and_then(|u| keychain.load_blocking(&credentials::account(&key, u))),
            };
            let (user, password, source) =
                choose_login(user, typed_password, saved, expect_saved, || setup::local_login(&url));
            // Codeman's default username when only a password was given.
            let username = password
                .as_ref()
                .map(|_| user.clone().unwrap_or_else(|| setup::DEFAULT_USERNAME.into()));
            let auth = basic_auth(username.as_deref(), password.as_deref());
            let (result, update) = if expect_saved && password.is_none() {
                (ProbeResult::SavedPasswordUnreadable, KeychainUpdate::default())
            } else {
                let outcome = probe::probe(&url, auth.as_deref());
                let login = ProbedLogin {
                    server: &key,
                    previous_user: previous_user.as_deref(),
                    username: username.as_deref(),
                    password: password.as_deref(),
                    source,
                    remember,
                };
                let update = update_keychain(&keychain, &outcome, &login);
                (ProbeResult::Probed(outcome), update)
            };
            let _ = proxy.send_event(UserEvent::ProbeDone(Box::new(ProbeDone {
                generation,
                url,
                result,
                username,
                password,
                saved: update.saved,
                deleted: update.deleted,
            })));
        });
    }

    fn on_probe_done(&mut self, done: ProbeDone) {
        let key = done.url.to_string();
        if done.generation != self.probe_generation || !self.choosing() {
            // Cancelled, superseded, or a server is already loading. What the
            // worker did to the Keychain stands all the same, so an entry
            // whose password it deleted stops claiming one.
            self.note_deleted_passwords(&key, &done.deleted);
            return;
        }
        match done.result {
            ProbeResult::SavedPasswordUnreadable => {
                // needsPassword: the page shows the login fields, which the
                // This Mac tab does not have.
                self.to_connect_page(json!({ "type": "error", "message": KEYCHAIN_UNREADABLE, "needsPassword": true }));
            }
            ProbeResult::Probed(outcome @ (ProbeOutcome::Ok { .. } | ProbeOutcome::PasswordChangeRequired)) => {
                let (opening, saved) = match outcome {
                    ProbeOutcome::Ok { version } => (json!({ "type": "opening", "version": version }), done.saved),
                    // The worker already deleted the one-time password and any
                    // older one saved for the account (update_keychain).
                    _ => (
                        json!({ "type": "opening", "version": null, "passwordChange": true }),
                        false,
                    ),
                };
                let orphans = self.config.remember(&key, done.username.as_deref(), saved);
                self.delete_accounts(&orphans);
                self.config_dirty = true;
                self.to_connect_page(opening);
                self.begin_loading(done.url, done.username, done.password);
            }
            ProbeResult::Probed(outcome) => {
                let can_start = outcome == ProbeOutcome::Refused && policy::can_start_locally(&done.url);
                self.to_connect_page(json!({
                    "type": "probeResult",
                    "url": done.url.as_str(),
                    "outcome": outcome,
                    "canStart": can_start,
                }));
            }
        }
    }

    /// Point the main window at the server. The cookies go first: a session
    /// cookie an earlier login left (another user, a Forget, a password
    /// changed since) would win over this login's Authorization header, since
    /// Codeman checks the cookie first, and the first load mints a fresh one
    /// from the header anyway. The load itself starts once the clear is done
    /// (UserEvent::CookiesCleared). The connect page stays the live document
    /// until the server page commits; on_events_cleared gives up after
    /// LOAD_TIMEOUT, which counts from here, so it covers the clear too.
    fn begin_loading(&mut self, url: Url, username: Option<String>, password: Option<String>) {
        self.auth = basic_auth(username.as_deref(), password.as_deref());
        // Set before the load: its first response may already be a challenge.
        self.set_login(username.zip(password).map(|(u, p)| (&url, u, p)));
        // Before the load: the navigation handler allows the server's origin
        // only once the phase names it.
        *self.phase.borrow_mut() = Phase::Loading(url.clone());
        self.loading_deadline = Some(Instant::now() + LOAD_TIMEOUT);
        clear_cookies_then_load(&self.proxy, self.probe_generation, url);
    }

    /// Hand the challenge handler a new login, as (server, username,
    /// password), or none, and start a new login generation, so a recheck of
    /// the one before it is ignored when it comes back.
    fn set_login(&mut self, login: Option<(&Url, String, String)>) {
        set_challenge_login(login.as_ref().map(|(server, u, p)| (*server, u.as_str(), p.as_str())));
        self.login = login.map(|(_, u, p)| (u, p));
        self.login_generation += 1;
    }

    fn start_server(&mut self, raw: String) {
        if let Some(running) = self.starting_server {
            // A start is still going, maybe one the page cancelled: its result
            // goes to the page that asked again.
            self.start_generation = running;
            self.to_connect_page(json!({ "type": "serverStarting" }));
            return;
        }
        let url = match policy::normalize_server_url(&raw) {
            Ok(u) if policy::can_start_locally(&u) => u,
            Ok(_) => {
                self.to_connect_page(json!({ "type": "error", "message": START_REFUSED }));
                return;
            }
            Err(message) => {
                self.to_connect_page(json!({ "type": "error", "message": message }));
                return;
            }
        };
        self.start_generation += 1;
        let generation = self.start_generation;
        self.starting_server = Some(generation);
        self.to_connect_page(json!({ "type": "serverStarting" }));
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let result = setup::start_local(&url);
            let _ = proxy.send_event(UserEvent::ServerStartDone {
                generation,
                url,
                result,
            });
        });
    }

    /// Leave whatever the main window shows for the connect page: Switch
    /// Server, a load that failed or was cancelled, or a refused login.
    /// `notice` is shown by that page once it asks for its init.
    ///
    /// `front` is for what the user just did (Switch Server, Reload, Cancel):
    /// the main window comes forward and takes the keyboard. A timeout or a
    /// refused login can happen while the user works in another app, so then
    /// the window stays where it is and the Dock icon bounces once instead,
    /// unless the window is already the one in use.
    fn show_connect_page(&mut self, notice: Option<String>, front: bool) {
        self.probe_generation += 1;
        let popouts: Vec<WindowId> = self.windows.keys().copied().filter(|id| *id != self.main_id).collect();
        for id in popouts {
            self.remove_window(id);
        }
        // Before the load: the navigation handler allows the connect page
        // only while the phase says it is live.
        *self.phase.borrow_mut() = Phase::Connect;
        self.loading_deadline = None;
        self.auth = None;
        self.set_login(None);
        self.notice = notice;
        if let Some(main) = self.windows.get_mut(&self.main_id) {
            main.session_reload_at = None;
            let _ = main.webview.load_url(&format!("{}?manual=1", policy::CONNECT_PAGE));
            main.window.set_title(APP_NAME);
            if front {
                main.window.set_visible(true);
                main.window.set_focus();
            } else if !main.window.is_focused() || main.window.is_minimized() {
                main.window
                    .request_user_attention(Some(UserAttentionType::Informational));
            }
        }
    }

    fn show_main_window(&self) {
        if let Some(main) = self.windows.get(&self.main_id) {
            main.window.set_minimized(false);
            main.window.set_visible(true);
            main.window.set_focus();
        }
    }

    /// The URL a server window reloads, handed to wry as is, and whether the
    /// login goes with it. Main window: its committed page if that is
    /// Codeman's own app shell, else the server root (a raw file that
    /// replaced the window, for example). Pop-out: its committed page, or the
    /// URL it was opened with when nothing committed yet. The login goes only
    /// below the server's base path.
    fn reload_target(&self, id: WindowId) -> Option<(String, bool)> {
        let server = self.phase.borrow().loaded().cloned()?;
        let w = self.windows.get(&id)?;
        let target = match &w.kind {
            Kind::Main => match &w.committed {
                Some(current) if policy::trusted_frame(current, &server) => current.clone(),
                _ => server.clone(),
            },
            Kind::Popout { opened_url, .. } => w.committed.clone().or_else(|| Url::parse(opened_url).ok())?,
        };
        let with_auth = policy::within_base(&target, &server);
        Some((policy::webkit_safe_url(&target), with_auth))
    }

    /// Load `url` in window `id`, with the login when `with_auth` and there is
    /// one.
    fn load_in(&self, id: WindowId, url: &str, with_auth: bool) {
        let Some(w) = self.windows.get(&id) else {
            return;
        };
        let result = match self.auth.as_deref().filter(|_| with_auth) {
            Some(auth) => w.webview.load_url_with_headers(url, auth_headers(auth)),
            None => w.webview.load_url(url),
        };
        if let Err(e) = result {
            eprintln!("codeman-desktop: could not load a page: {e}");
        }
    }

    fn reload_focused(&mut self) {
        let Some(id) = self.focused_window_id() else {
            return;
        };
        let loaded = self.phase.borrow().loaded().is_some();
        if id == self.main_id && !loaded {
            // The connect page, or a server load that has not committed:
            // start over on the connect page.
            self.show_connect_page(None, true);
            return;
        }
        if let Some((url, with_auth)) = self.reload_target(id) {
            self.load_in(id, &url, with_auth);
        }
    }

    /// The page in `window` got a 401 from its own server (the HOST_SHIM
    /// fallback for when the challenge handler did not recover it): reload it
    /// once with the login, never again within SESSION_RELOAD_COOLDOWN.
    fn on_session_expired(&mut self, window: WindowId) {
        if self.auth.is_none() {
            return;
        }
        let now = Instant::now();
        let recent = self.windows.get(&window).is_some_and(|w| {
            w.session_reload_at
                .is_some_and(|at| now.saturating_duration_since(at) < SESSION_RELOAD_COOLDOWN)
        });
        if recent {
            return;
        }
        let Some((url, true)) = self.reload_target(window) else {
            return;
        };
        if let Some(w) = self.windows.get_mut(&window) {
            w.session_reload_at = Some(now);
        }
        self.load_in(window, &url, true);
    }

    /// Open one of Codeman's pop-out pages in an app window. False when it
    /// did not open: the pop-out limit, no server loaded, a URL that is not a
    /// pop-out page, or a window or web view that failed to build. `focused`:
    /// the window takes the keyboard; otherwise it comes to the front without
    /// it.
    fn build_popout(&mut self, target: &EventLoopWindowTarget<UserEvent>, url: &Url, focused: bool) -> bool {
        let Some(server) = self.phase.borrow().loaded().cloned() else {
            return false;
        };
        // The callers only pass what policy::new_window made an AppWindow;
        // checked again here, where the window is built, so no other path
        // can ever open a proxied dashboard or another page top-level.
        if !policy::is_popout_target(url, &server) {
            return false;
        }
        let popouts = self
            .windows
            .values()
            .filter(|w| matches!(w.kind, Kind::Popout { .. }))
            .count();
        if popouts >= MAX_POPOUTS {
            return false;
        }
        let opened_url = policy::webkit_safe_url(url);
        let auth = self.auth.clone().filter(|_| policy::within_base(url, &server));
        // tao centres a window that is given no position, so every pop-out
        // would open exactly on top of the one before. Each one steps off the
        // window in use instead.
        let anchor = self.focused_window_id().unwrap_or(self.main_id);
        let position = self.windows.get(&anchor).and_then(|w| {
            let p = placed_position(&w.window)
                .ok()?
                .to_logical::<f64>(w.window.scale_factor());
            let step = POPOUT_STEP * (1 + popouts % 8) as f64;
            Some(LogicalPosition::new(p.x + step, p.y + step))
        });
        let mut builder = window_builder()
            .with_inner_size(LogicalSize::new(POPOUT_SIZE.0, POPOUT_SIZE.1))
            .with_focused(focused);
        if let Some(position) = position {
            builder = builder.with_position(position);
        }
        let window = match builder.build(target) {
            Ok(window) => window,
            Err(e) => {
                eprintln!("codeman-desktop: could not open a window: {e}");
                return false;
            }
        };
        let load = Load::Server {
            url: &opened_url,
            auth: auth.as_deref(),
        };
        let webview = match build_webview(&window, false, focused, load, &self.proxy, &self.phase) {
            Ok(webview) => {
                // Still the one that takes the keys once the user comes to
                // this window: first responder in its own window only.
                if !focused {
                    let _ = webview.focus();
                }
                webview
            }
            Err(e) => {
                eprintln!("codeman-desktop: could not create a web view: {e}");
                return false;
            }
        };
        let kind = Kind::Popout {
            opened_url,
            hidden_for_download: false,
        };
        self.windows.insert(window.id(), AppWindow::new(webview, window, kind));
        true
    }

    /// Tell the page in `window` that the window it asked for through
    /// CodemanHost.openWindow was not opened (assets::refused_script), with
    /// the session id when that was a session pop-out, so the dashboard takes
    /// the session's tab back. Only for that request, which parse_ipc takes
    /// from Codeman's own app shell alone.
    fn tell_refused(&self, window: WindowId, session_id: Option<&str>) {
        if let Some(w) = self.windows.get(&window) {
            let _ = w.webview.evaluate_script(&assets::refused_script(session_id));
        }
    }

    /// Hand a URL to the default browser if the open budget allows; a page
    /// can call window.open without a click, so openings over budget are
    /// dropped.
    fn open_external_budgeted(&mut self, url: &Url) -> bool {
        if !self.open_budget.allow(Instant::now()) {
            eprintln!(
                "codeman-desktop: too many outside links at once; dropped one to {}",
                url.host_str().unwrap_or("?")
            );
            return false;
        }
        open_external(url);
        true
    }

    /// A link a page asked to open in the browser, if it is one
    /// (policy::external_url) and the budget allows.
    fn open_external_raw(&mut self, raw: &str) {
        if let Some(url) = policy::external_url(raw) {
            self.open_external_budgeted(&url);
        }
    }

    /// Close a pop-out (never the main window) and forget its downloads.
    fn remove_window(&mut self, id: WindowId) {
        if id == self.main_id {
            return;
        }
        self.windows.remove(&id);
        self.downloads.retain(|(window, _), _| *window != id);
    }

    /// The app window that is key. None while a window that is not ours is
    /// (the About panel, a detached inspector): Reload and Developer Tools
    /// then do nothing rather than act on a window behind it.
    fn focused_window_id(&self) -> Option<WindowId> {
        self.windows
            .iter()
            .find(|(_, w)| w.window.is_focused())
            .map(|(id, _)| *id)
    }

    /// Message the connect page (only while it is the main window's live
    /// document).
    fn to_connect_page(&self, msg: serde_json::Value) {
        if !self.phase.borrow().connect_page_live() {
            return;
        }
        if let Some(main) = self.windows.get(&self.main_id) {
            let _ = main.webview.evaluate_script(&format!(
                "window.__codemanDesktop && window.__codemanDesktop.onNative({msg})"
            ));
        }
    }

    fn record_main_frame(&mut self) {
        let Some(main) = self.windows.get(&self.main_id) else {
            return;
        };
        let w = &main.window;
        let fullscreen = w.fullscreen().is_some();
        let mut frame = self.config.window.unwrap_or(WindowFrame {
            x: 0.0,
            y: 0.0,
            width: DEFAULT_SIZE.0,
            height: DEFAULT_SIZE.1,
            fullscreen,
        });
        // In full screen or minimized the live geometry is not the windowed
        // frame; the saved one is kept for the next launch.
        if !fullscreen && !w.is_minimized() {
            let sf = w.scale_factor();
            if let Ok(pos) = placed_position(w) {
                let p = pos.to_logical::<f64>(sf);
                frame.x = p.x;
                frame.y = p.y;
            }
            // Not tao's inner_size(): wry replaced the window's content view,
            // and tao reads the size of its own view, which stays at the
            // creation size. On macOS not the web view's bounds either: a
            // docked Web Inspector shrinks the web view, not the window. The
            // content size is in points already.
            #[cfg(target_os = "macos")]
            let size = macos::content_size(w);
            #[cfg(not(target_os = "macos"))]
            let size = None;
            let size = size.or_else(|| {
                let bounds = main.webview.bounds().ok()?;
                let s = bounds.size.to_logical::<f64>(sf);
                Some((s.width, s.height))
            });
            if let Some((width, height)) = size {
                frame.width = width;
                frame.height = height;
            }
        }
        // While the launch's full screen may still be retried, a window not
        // in full screen yet keeps the flag that was saved (or asked for).
        frame.fullscreen = if self.fullscreen_retry.is_some() && !fullscreen {
            self.config.window.is_none_or(|f| f.fullscreen)
        } else {
            fullscreen
        };
        if self.config.window != Some(frame) {
            self.config.window = Some(frame);
            self.config_dirty = true;
            self.save_held_since = Instant::now();
        }
    }

    fn save_config(&mut self) {
        self.save_held_since = Instant::now();
        self.config_dirty = false;
        if let Some(path) = &self.config_path {
            if let Err(e) = self.config.save_to(path) {
                eprintln!("codeman-desktop: could not save {}: {e}", path.display());
            }
        }
    }

    /// Queue the deletion of the Keychain items of accounts the config no
    /// longer lists, as (server url, username).
    fn delete_accounts(&self, accounts: &[(String, String)]) {
        for (url, user) in accounts {
            self.keychain.delete(&credentials::account(url, user));
        }
    }

    /// The probe worker deleted the Keychain items of `users` for the server
    /// `url`: an entry that names one of them no longer has a password saved.
    fn note_deleted_passwords(&mut self, url: &str, users: &[String]) {
        for entry in self.config.servers.iter_mut().filter(|s| s.url == url) {
            if entry.has_saved_password && entry.username.as_ref().is_some_and(|u| users.contains(u)) {
                entry.has_saved_password = false;
                self.config_dirty = true;
            }
        }
    }
}
