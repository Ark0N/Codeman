//! Codeman Desktop: a native window around Codeman servers, one tab each.
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
//! The main window holds a tab per server (`tabs`): a strip across the top that
//! draws them (`assets/tabs.html`), and below it each tab's own web views, of
//! which only the tab in front is visible. The others stay loaded, so a switch
//! is instant, and the strip's badges come from a status read the app makes of
//! each server itself (`agents::Poller::detail`), since WebKit stalls a hidden
//! page. An overview of every server (`assets/overview.html`) can take the
//! place of the tab in front (⌘0).
//!
//! Every URL and message decision is in `policy` (pure, unit-tested); this file
//! only wires those decisions to windows. Each tab moves through
//! `policy::Phase`: the connect page (Connect), a server load that has not
//! committed yet (Loading, abandoned after `LOAD_TIMEOUT` or on Cancel; the
//! server's page loads in a second, hidden web view behind the connect page),
//! and a committed server page (Loaded). A tab's phase is shared with its web
//! views' handlers, which run on this same thread; no `RefCell` borrow of it
//! is ever held across a call into wry or tao. Each server's pages use a
//! WebKit data store of their own (`tabs::store_id`, macOS 14 and later), so
//! two servers never share a login cookie, and the challenge handler answers
//! each tab with that tab's login (`macos::set_credentials`).

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
mod tabs;
mod terminal_install;

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
use wry::{NewWindowResponse, PageLoadEvent, PermissionResponse, Rect as ViewRect, WebView, WebViewBuilder};

use agents::{Detail, DetailPoll, Poller};
use config::{Config, Rect, TabEntry, WindowFrame};
use credentials::Keychain;
use login::{choose_login, update_keychain, KeychainUpdate, ProbedLogin};
use logo::{BlinkStyle, Signal};
use menu::{build_menu, menu_id, AppMenu, TabAction};
use policy::{
    ConnectCmd, HostCmd, Ipc, Navigation, NewWindow, OpenBudget, OverviewCmd, Phase, Recovery, StripCmd, Via,
};
use probe::ProbeOutcome;

const APP_NAME: &str = "Codeman";
const VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_SIZE: (f64, f64) = (1280.0, 820.0);
const POPOUT_SIZE: (f64, f64) = (960.0, 680.0);
const MIN_SIZE: (f64, f64) = (config::MIN_WIDTH, config::MIN_HEIGHT);
const MAX_POPOUTS: usize = 24;
/// How many tabs the window holds at most (as many as are saved).
const MAX_TABS: usize = config::MAX_TABS;
/// How far a pop-out opens down and to the right of the window in use, per
/// pop-out already open (it starts over after eight).
const POPOUT_STEP: f64 = 28.0;
const SAVE_DEBOUNCE: Duration = Duration::from_secs(1);
/// How long a server load may take to commit before the app gives up on it
/// and brings the connect page back.
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);
/// A view reloads itself with the login at most once in this long after its
/// page reported that its session is gone, so a login the server keeps
/// refusing can never turn into a reload loop.
const SESSION_RELOAD_COOLDOWN: Duration = Duration::from_secs(60);
/// A view loads its page again at most once in this long after its web
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
/// How many status reads of a server in a row must fail before its tab says
/// it is not answering.
const OFFLINE_AFTER: u32 = 2;
/// How long a tab's status read waits after a 429 before it asks again.
const RATE_LIMITED_BACKOFF: Duration = Duration::from_secs(60);

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
const ALREADY_OPEN: &str = "That server is already open in another tab.";
/// Before macOS 14 every page shares one data store, and Codeman's login
/// cookie has the same name on every port of a host.
const SAME_HOST_NEEDS_MACOS_14: &str = "Another tab is open on a Codeman of the same machine. On this version of macOS \
the two would share one login cookie and log each other out, so close that tab first (macOS 14 and later keep them apart).";
const TOO_MANY_TABS: &str = "The window holds 24 tabs at most. Close one to open another.";
/// The name of a tab that has no server yet.
const NEW_TAB_NAME: &str = "New server";
const OVERVIEW_TITLE: &str = "All Servers";

enum UserEvent {
    Menu(MenuEvent),
    /// A message from a tab's connect page, its server page or a pop-out.
    Ipc {
        view: ViewId,
        msg: Ipc,
    },
    Strip(StripCmd),
    Overview(OverviewCmd),
    ProbeDone(Box<ProbeDone>),
    ServerStartDone {
        tab: TabId,
        generation: u64,
        url: Url,
        result: Result<String, String>,
    },
    /// A `window.open` or `target=_blank` asked for one of the file or
    /// download pages Codeman opens that way (policy::new_window, Via::Script).
    /// Any frame can ask like this, so the window opens without taking the
    /// keyboard, only while the script window budget allows, and nothing is
    /// reported back when it does not open.
    OpenAppWindow {
        tab: TabId,
        url: Url,
    },
    /// A page opened another site (window.open); it goes to the browser if the
    /// open budget allows.
    OpenExternal(Url),
    /// A server's cookies were cleared before its load (begin_loading).
    CookiesCleared {
        tab: TabId,
        generation: u64,
        url: Url,
    },
    /// What the server said to the login the challenge handler had sent when
    /// it reported a refusal (recheck_login).
    LoginChecked {
        tab: TabId,
        generation: u64,
        outcome: ProbeOutcome,
    },
    Title {
        view: ViewId,
        title: String,
    },
    /// A main-frame navigation committed (wry's PageLoadEvent::Started, from
    /// WebKit's didCommitNavigation): `url` is the view's document now.
    PageCommitted {
        view: ViewId,
        url: String,
    },
    DownloadStarted {
        view: ViewId,
        url: String,
        /// The file name wry chose in ~/Downloads (de-duplicated). wry passes
        /// no path when the download ends, so this is the toast's only source.
        file_name: Option<String>,
    },
    DownloadDone {
        view: ViewId,
        url: String,
        path: Option<PathBuf>,
        ok: bool,
    },
    /// The challenge handler sent a tab's login and got challenged again
    /// (macOS). Not trusted on its own: recheck_login asks the server first.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    AuthRejected(TabId),
    /// The web content process of a view ended (macOS): a crash, or the
    /// system taking it back under memory pressure. The view is blank until
    /// something loads in it again (on_content_process_gone).
    ContentProcessGone {
        view: ViewId,
    },
    /// A background step for a tab's connect page finished (This Mac status,
    /// an install opened in Terminal, the install command copied): the message
    /// goes to that page if it is still the one choosing a server.
    ToConnectPage {
        tab: TabId,
        msg: serde_json::Value,
    },
    /// A status read of a tab's server (watch_status), for the login numbered
    /// `generation`.
    TabStatus {
        tab: TabId,
        generation: u64,
        status: StatusUpdate,
    },
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

/// What a status read of a server found.
enum StatusUpdate {
    Seen(Detail),
    /// Several reads in a row failed.
    Offline,
    /// The server refused the login; nothing is asked any more.
    Refused,
}

struct ProbeDone {
    tab: TabId,
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

type TabId = u64;

/// The app's own number for each web view it builds. A tab's views share the
/// main window, so the window's id does not tell them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct ViewId(u64);

/// What a web view is for: it decides its handlers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Part {
    Strip,
    Overview,
    Connect,
    Server,
    Popout,
}

/// Who owns a web view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Owner {
    Strip,
    Overview,
    Connect(TabId),
    Server(TabId),
    Popout(WindowId, TabId),
}

/// A web view inside the main window.
struct ChildView {
    id: ViewId,
    webview: WebView,
    /// The view's last committed URL. Never read from wry's `url()`: that
    /// unwraps WKWebView.URL, which is nil until a load commits, and the app
    /// would abort.
    committed: Option<Url>,
    /// When the view last reloaded itself because its session expired.
    session_reload_at: Option<Instant>,
    /// When the view's web content process last ended.
    gone_at: Option<Instant>,
}

impl ChildView {
    fn new(id: ViewId, webview: WebView) -> Self {
        ChildView {
            id,
            webview,
            committed: None,
            session_reload_at: None,
            gone_at: None,
        }
    }
}

/// One server tab.
struct Tab {
    id: TabId,
    /// The connect page: shows in Connect and Loading, dropped once the
    /// server's page commits.
    connect: Option<ChildView>,
    /// The server's page: loads hidden behind the connect page (Loading), then
    /// is the tab (Loaded).
    server: Option<ChildView>,
    /// Shared with the web view handlers of this tab's views and pop-outs.
    phase: Rc<RefCell<Phase>>,
    /// The server this tab is for: saved for the next launch, kept while the
    /// connect page shows again after a refused login.
    home: Option<Url>,
    /// The name the user gave the tab, else a default (tabs::default_name).
    name: Option<String>,
    color: String,
    /// The server's Codeman version, from the probe.
    version: Option<String>,
    /// The page's own title, for the window title.
    page_title: Option<String>,
    /// The data store of the server view and its pop-outs.
    store: Option<[u8; 16]>,
    /// While Loading: when to give up on the load.
    loading_deadline: Option<Instant>,
    /// Basic-auth header for (re)loading server pages; the server answers a
    /// load with its session cookie, which carries the requests after it.
    auth: Option<String>,
    /// The username and password behind `auth`, which the challenge handler
    /// answers with (set_login).
    login: Option<(String, String)>,
    /// Counts the logins handed to the challenge handler, so a recheck or a
    /// status read that comes back after another connect does nothing.
    login_generation: u64,
    /// The login generation a recheck is running for, if any.
    login_recheck: Option<u64>,
    probe_generation: u64,
    start_generation: u64,
    /// The generation of the Start Codeman run still going, if any.
    starting_server: Option<u64>,
    /// Shown by the next connect page that asks for its init.
    notice: Option<String>,
    /// The connect page opens the agent chooser when it next loads.
    add_agent_on_load: bool,
    /// What the connect page does when it asks for its init: show this server,
    /// and connect to it when the flag says so (a tab opened again at launch).
    connect_to: Option<(String, bool)>,
    /// The last status reads of the server.
    seen: tabs::Seen,
    /// The thread that reads the server's status (watch_status).
    watch: Option<StatusWatch>,
    /// Whether the login of this connect can read the server's status. Not
    /// for a one-time password that Codeman's own page has the user change
    /// first: the server answers every other request 403 until then, and the
    /// new password is never seen by the app.
    status_login: bool,
}

impl Tab {
    fn kind(&self) -> tabs::Kind {
        match &*self.phase.borrow() {
            Phase::Connect => tabs::Kind::Connect,
            Phase::Loading(_) => tabs::Kind::Loading,
            Phase::Loaded(_) => tabs::Kind::Server,
        }
    }

    /// The server the tab is about: loaded or loading, else its home.
    fn shown_url(&self) -> Option<Url> {
        self.phase.borrow().server().cloned().or_else(|| self.home.clone())
    }

    fn display_name(&self) -> String {
        match (&self.name, self.shown_url()) {
            (Some(name), _) => name.clone(),
            (None, Some(url)) => tabs::default_name(&url),
            (None, None) => NEW_TAB_NAME.to_string(),
        }
    }

    /// The view that shows when this tab is in front.
    fn front(&self) -> Option<&ChildView> {
        match (self.phase.borrow().loaded(), &self.server, &self.connect) {
            (Some(_), Some(server), _) => Some(server),
            (_, _, Some(connect)) => Some(connect),
            (_, server, None) => server.as_ref(),
        }
    }

    fn views(&self) -> impl Iterator<Item = &ChildView> {
        self.connect.iter().chain(self.server.iter())
    }

    fn entry(&self) -> Option<TabEntry> {
        Some(TabEntry {
            url: self.home.as_ref()?.to_string(),
            name: self.name.clone(),
            color: Some(self.color.clone()),
        })
    }
}

/// Stops its status thread when dropped.
struct StatusWatch {
    stop: Arc<AtomicBool>,
}

impl Drop for StatusWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Reads a server's agent sessions every `agents::POLL_EVERY` on a thread of
/// its own, for a tab's badges and the overview. Ends when the watch is
/// dropped or the server refuses the login.
fn watch_status(
    proxy: &EventLoopProxy<UserEvent>,
    tab: TabId,
    generation: u64,
    server: &Url,
    authorization: Option<String>,
) -> Option<StatusWatch> {
    let mut poller = Poller::new(server, authorization, true)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let proxy = proxy.clone();
    std::thread::Builder::new()
        .name("tab-status".into())
        .spawn(move || {
            let mut failures = 0u32;
            while !stopped.load(Ordering::SeqCst) {
                let status = match poller.detail() {
                    DetailPoll::Seen(detail) => {
                        failures = 0;
                        Some(StatusUpdate::Seen(detail))
                    }
                    DetailPoll::Failed => {
                        failures += 1;
                        (failures == OFFLINE_AFTER).then_some(StatusUpdate::Offline)
                    }
                    DetailPoll::Refused => Some(StatusUpdate::Refused),
                    // Too many failed logins from this address (other clients'
                    // too, on a multi-user server): ask again much later, and
                    // keep what the tab shows meanwhile.
                    DetailPoll::RateLimited => {
                        sleep_unless_stopped(&stopped, RATE_LIMITED_BACKOFF);
                        None
                    }
                };
                let refused = matches!(status, Some(StatusUpdate::Refused));
                if let Some(status) = status {
                    if stopped.load(Ordering::SeqCst)
                        || proxy
                            .send_event(UserEvent::TabStatus {
                                tab,
                                generation,
                                status,
                            })
                            .is_err()
                    {
                        return;
                    }
                }
                if refused {
                    return;
                }
                sleep_unless_stopped(&stopped, agents::POLL_EVERY);
            }
        })
        .ok()?;
    Some(StatusWatch { stop })
}

/// Sleeps `total`, a second at a time, and stops early once `stopped` is set.
fn sleep_unless_stopped(stopped: &AtomicBool, total: Duration) {
    let step = Duration::from_secs(1);
    let mut left = total;
    while !left.is_zero() && !stopped.load(Ordering::SeqCst) {
        let nap = left.min(step);
        std::thread::sleep(nap);
        left -= nap;
    }
}

/// A pop-out: an app window of its own, for one of the tab's server pages.
struct Popout {
    // Declared first so it is dropped before its window.
    webview: WebView,
    window: Window,
    view: ViewId,
    tab: TabId,
    /// The URL the pop-out was opened with, as handed to wry
    /// (`policy::webkit_safe_url`), which is also the form WebKit reports for
    /// a download.
    opened_url: String,
    hidden_for_download: bool,
    committed: Option<Url>,
    session_reload_at: Option<Instant>,
    gone_at: Option<Instant>,
}

enum Load<'a> {
    /// The connect page; `manual` keeps it from connecting by itself.
    ConnectPage {
        manual: bool,
    },
    /// One of the app's other pages (the strip, the overview).
    Bundled(&'static str),
    Server {
        url: &'a str,
        auth: Option<&'a str>,
    },
    /// Nothing yet: a server view waits for its cookies to be cleared.
    Nothing,
}

/// Where a web view goes and what it is.
struct ViewSpec<'a> {
    id: ViewId,
    part: Part,
    tab: TabId,
    /// The tab's phase (connect, server and pop-out views).
    phase: Option<Rc<RefCell<Phase>>>,
    load: Load<'a>,
    /// The data store: None for WebKit's default one.
    store: Option<[u8; 16]>,
    /// For a view inside the main window: its frame, in points. None fills a
    /// window of its own (a pop-out).
    bounds: Option<(f64, f64, f64, f64)>,
    visible: bool,
    /// The view takes the keyboard and brings the app to the front (wry's
    /// default). False for a window a script opened, and every hidden view.
    focused: bool,
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
    main_window: Window,
    strip: ChildView,
    /// Built the first time it is asked for.
    overview: Option<ChildView>,
    overview_shown: bool,
    tabs: Vec<Tab>,
    /// The tab in front, an index into `tabs`.
    active: usize,
    next_tab: TabId,
    next_view: u64,
    /// Tabs closed this run, newest last, for Reopen Closed Tab.
    closed: Vec<TabEntry>,
    popouts: HashMap<WindowId, Popout>,
    /// The strip, the overview and the Server menu need drawing again; done
    /// once per turn of the event loop.
    strip_dirty: bool,
    overview_dirty: bool,
    menu_dirty: bool,
    /// What hands pages to the default browser draws on.
    open_budget: OpenBudget,
    /// What the app windows a script opens draw on (UserEvent::OpenAppWindow),
    /// apart from `open_budget`, so a frame cannot use up the user's links.
    script_window_budget: OpenBudget,
    /// File names of downloads under way, per view and URL, oldest first.
    downloads: HashMap<(ViewId, String), VecDeque<String>>,
    menu: AppMenu,
    /// The one Keychain worker; every Keychain job goes through its queue.
    keychain: Keychain,
    /// Which reader of the install's output is the current one.
    install_reader: Arc<AtomicU64>,
    /// While the main window may still have to be put into the full screen it
    /// asked for at launch: when to look next, and how many retries were made.
    fullscreen_retry: Option<(Instant, u8)>,
    /// What the strip was last told about full screen.
    fullscreen: bool,
    /// The child that watches the open servers and blinks the logo.
    logo_watch: logo::Watcher,
    /// The worker that keeps this Mac awake while its agents work.
    keep_awake: keep_awake::KeepAwake,
    /// The administrator prompt for removing the old lid helper is open.
    old_helper_busy: bool,
    /// Shown by the first connect page that asks for its init.
    launch_notice: Option<String>,
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
        macos::set_auth_rejected_handler(Box::new(move |tab| {
            let _ = auth_proxy.send_event(UserEvent::AuthRejected(tab));
        }));
    }

    let config_path = Config::default_path();
    let (mut config, can_save) = match config_path.as_deref() {
        Some(path) => Config::load_from(path),
        None => (Config::default(), true),
    };
    let config_path = config_path.filter(|_| can_save);
    let launch_notice = (!can_save).then(|| SETTINGS_UNREADABLE.to_string());
    // Before any tab opens: which server keeps the store it had before tabs.
    let store_settled = config.settle_default_store();
    logo::recover_at_launch();
    // A lid keeper that was killed left lid sleep off; and 1.50.1's helper, where
    // it is still installed, gets nothing to act on.
    lid_awake::heal();
    keep_awake::forget_legacy_request();
    let menu = build_menu(&config).unwrap_or_else(|e| fatal(&format!("Could not build the menu: {e}")));
    // Started once: the probe workers and the event loop share this queue,
    // and a second one would not keep its jobs in order with the first.
    let keychain = Keychain::spawn();

    let (window, wants_fullscreen) =
        create_main_window(&event_loop, &config).unwrap_or_else(|e| fatal(&format!("Could not open a window: {e}")));
    let (width, _) = content_size(&window);
    let strip_spec = ViewSpec {
        id: ViewId(0),
        part: Part::Strip,
        tab: 0,
        phase: None,
        load: Load::Bundled(policy::STRIP_PAGE),
        store: None,
        bounds: Some((0.0, 0.0, width, tabs::STRIP_HEIGHT)),
        visible: true,
        focused: false,
    };
    let strip = build_webview(&window, strip_spec, &proxy)
        .unwrap_or_else(|e| fatal(&format!("Could not create the web view: {e}")));

    let keep_awake_proxy = proxy.clone();
    let mut app = App {
        proxy,
        config,
        config_path,
        config_dirty: store_settled,
        save_held_since: Instant::now(),
        main_window: window,
        strip: ChildView::new(ViewId(0), strip),
        overview: None,
        overview_shown: false,
        tabs: Vec::new(),
        active: 0,
        next_tab: 1,
        next_view: 1,
        closed: Vec::new(),
        popouts: HashMap::new(),
        strip_dirty: true,
        overview_dirty: false,
        menu_dirty: true,
        open_budget: OpenBudget::new(),
        script_window_budget: OpenBudget::new(),
        downloads: HashMap::new(),
        menu,
        keychain,
        install_reader: Arc::new(AtomicU64::new(0)),
        fullscreen_retry: wants_fullscreen.then(|| (Instant::now() + FULLSCREEN_FIRST_CHECK, 0)),
        fullscreen: wants_fullscreen,
        logo_watch: logo::Watcher::default(),
        keep_awake: keep_awake::KeepAwake::new(move |generation, text| {
            let _ = keep_awake_proxy.send_event(UserEvent::KeepAwakeStatus { generation, text });
        }),
        old_helper_busy: false,
        launch_notice,
    };
    app.open_launch_tabs();

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
    let builder = WindowBuilder::new()
        .with_title(APP_NAME)
        .with_theme(Some(Theme::Dark))
        .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1));
    // The app has tabs of its own: macOS's automatic window tabbing would
    // merge pop-outs into a tab bar of the system's (in full screen above all).
    #[cfg(target_os = "macos")]
    let builder = {
        use tao::platform::macos::WindowBuilderExtMacOS;
        builder.with_automatic_window_tabbing(false)
    };
    builder
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

/// The main window's content area in points. On macOS the content runs under
/// the transparent title bar, so this is the whole window.
fn content_size(window: &Window) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    if let Some(size) = macos::content_size(window) {
        return size;
    }
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    (size.width, size.height)
}

/// The main window, and whether it was asked into full screen (App's
/// `fullscreen_retry` then makes sure it gets there). On macOS its content runs
/// under a transparent title bar: the tab strip is the title bar, with the
/// traffic lights moved down to sit centred in it.
fn create_main_window(
    target: &EventLoopWindowTarget<UserEvent>,
    config: &Config,
) -> Result<(Window, bool), tao::error::OsError> {
    let mut builder = window_builder();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::WindowBuilderExtMacOS;
        builder = builder
            .with_titlebar_transparent(true)
            .with_fullsize_content_view(true)
            .with_title_hidden(true)
            .with_traffic_light_inset(LogicalPosition::new(tabs::TRAFFIC_LIGHTS.0, tabs::TRAFFIC_LIGHTS.1));
    }
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

/// Give the native challenge handler tab `tab`'s login for the server at `url`
/// (its base path included: the handler answers only below it), or take it
/// away (None). It answers HTTP Basic challenges from that server only, so the
/// page recovers by itself when the server restarted and forgot its session.
/// Also re-arms the tab's refusal report.
fn set_challenge_login(tab: TabId, login: Option<(&Url, &str, &str)>) {
    #[cfg(target_os = "macos")]
    macos::set_credentials(
        tab,
        login.map(|(url, username, password)| macos::BasicCredentials {
            server: url.clone(),
            username: username.to_string(),
            password: password.to_string(),
        }),
    );
    #[cfg(not(target_os = "macos"))]
    let _ = (tab, login);
}

/// Remove the server's cookies from the store its pages use, then post
/// CookiesCleared for this load. On macOS the clear is asynchronous and `done`
/// runs later on the main thread; elsewhere the event is posted at once.
fn clear_cookies_then_load(
    proxy: &EventLoopProxy<UserEvent>,
    tab: TabId,
    generation: u64,
    url: Url,
    store: Option<[u8; 16]>,
) {
    let host = url.host_str().unwrap_or_default().to_string();
    let proxy = proxy.clone();
    let done = move || {
        let _ = proxy.send_event(UserEvent::CookiesCleared { tab, generation, url });
    };
    #[cfg(target_os = "macos")]
    macos::clear_cookies(store, host, Box::new(done));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (store, host);
        done();
    }
}

/// Whether each server can have a data store of its own here (macOS 14 and
/// later). Without it every page shares WebKit's default store.
fn own_stores() -> bool {
    #[cfg(target_os = "macos")]
    return macos::own_stores_available();
    #[cfg(not(target_os = "macos"))]
    return false;
}

/// Build a web view with every handler its part needs (`spec.part`): the
/// strip and the overview listen only to their own page and go nowhere else;
/// a tab's connect page and server page, and a pop-out, go through `policy`
/// with the tab's phase.
fn build_webview(window: &Window, spec: ViewSpec<'_>, proxy: &EventLoopProxy<UserEvent>) -> wry::Result<WebView> {
    let ViewSpec {
        id,
        part,
        tab,
        phase,
        load,
        store,
        bounds,
        visible,
        focused,
    } = spec;
    let phase = phase.unwrap_or_else(|| Rc::new(RefCell::new(Phase::Connect)));
    let mut builder = WebViewBuilder::new()
        .with_devtools(true)
        .with_focused(focused)
        .with_visible(visible)
        .with_accept_first_mouse(true)
        .with_back_forward_navigation_gestures(false)
        // false = let WebKit take the drop, so Codeman's own HTML5 drop
        // (prompt uploads) and <input type=file> drops keep working.
        .with_drag_drop_handler(|_| false)
        // Ask the user per page instead of wry's default of granting the
        // microphone and camera to every frame, sandboxed previews included.
        .with_permission_handler(|_| PermissionResponse::Default);
    if matches!(part, Part::Server | Part::Popout) {
        builder = builder.with_initialization_script(assets::HOST_SHIM);
    }
    if let Some((x, y, w, h)) = bounds {
        builder = builder.with_bounds(ViewRect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(w, h).into(),
        });
    }
    #[cfg(target_os = "macos")]
    if let Some(store) = store {
        use wry::WebViewBuilderExtDarwin;
        builder = builder.with_data_store_identifier(store);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = store;
    // The app's own pages come from its own scheme; a server's pages and
    // pop-outs never load from it.
    if matches!(part, Part::Strip | Part::Overview | Part::Connect) {
        builder = builder.with_custom_protocol(policy::APP_SCHEME.into(), |_id, request| assets::respond(request));
    }

    // The handlers below read the phase with try_borrow and fail closed: the
    // app never holds a borrow across a call into wry, so it cannot fail, but
    // a panic here would abort the app.
    let nav_phase = phase.clone();
    builder = builder.with_navigation_handler(move |target| match part {
        Part::Strip => policy::bundled_navigation(&target, policy::STRIP_PAGE) == Navigation::Allow,
        Part::Overview => policy::bundled_navigation(&target, policy::OVERVIEW_PAGE) == Navigation::Allow,
        // The connect page goes nowhere: its links leave through IPC.
        Part::Connect => nav_phase.try_borrow().is_ok_and(|phase| {
            phase.connect_page_live()
                && Url::parse(&target).is_ok_and(|u| u.scheme() == policy::APP_SCHEME)
                && policy::navigation(&target, &phase) == Navigation::Allow
        }),
        Part::Server | Part::Popout => nav_phase.try_borrow().is_ok_and(|phase| {
            !target.starts_with(policy::APP_SCHEME) && policy::navigation(&target, &phase) == Navigation::Allow
        }),
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
        if matches!(part, Part::Server | Part::Popout) {
            let decision = match nw_phase.try_borrow() {
                Ok(phase) => policy::new_window(&target, &phase, Via::Script),
                Err(_) => NewWindow::Deny,
            };
            let event = match decision {
                NewWindow::AppWindow(url) => Some(UserEvent::OpenAppWindow { tab, url }),
                NewWindow::External(url) => Some(UserEvent::OpenExternal(url)),
                NewWindow::Deny => None,
            };
            if let Some(event) = event {
                let _ = nw_proxy.send_event(event);
            }
        }
        NewWindowResponse::Deny
    });

    let ipc_phase = phase.clone();
    let ipc_proxy = proxy.clone();
    builder = builder.with_ipc_handler(move |request| {
        let frame_url = request.uri().to_string();
        let event = match part {
            Part::Strip => policy::parse_strip_ipc(&frame_url, request.body()).map(UserEvent::Strip),
            Part::Overview => policy::parse_overview_ipc(&frame_url, request.body()).map(UserEvent::Overview),
            Part::Connect | Part::Server | Part::Popout => {
                let is_tab_view = part != Part::Popout;
                let msg = match ipc_phase.try_borrow() {
                    Ok(phase) => policy::parse_ipc(&frame_url, request.body(), &phase, is_tab_view),
                    Err(_) => None,
                };
                // A server page speaks only as a server page, the connect page
                // only as the connect page.
                msg.filter(|msg| match msg {
                    Ipc::Connect(_) => part == Part::Connect,
                    Ipc::Host(_) => part != Part::Connect,
                })
                .map(|msg| UserEvent::Ipc { view: id, msg })
            }
        };
        if let Some(event) = event {
            let _ = ipc_proxy.send_event(event);
        }
    });

    let load_phase = phase.clone();
    let load_proxy = proxy.clone();
    builder = builder.with_on_page_load_handler(move |event, url| {
        if !matches!(event, PageLoadEvent::Started) || matches!(part, Part::Strip | Part::Overview) {
            return;
        }
        // Started is didCommitNavigation. A server view's phase moves to
        // Loaded right here, so the gates change in the same instant the
        // server page becomes the document. App repeats the step when the
        // event arrives, in case the borrow was not free.
        if part == Part::Server {
            if let Ok(mut phase) = load_phase.try_borrow_mut() {
                if let Some(next) = policy::loaded_on_commit(&phase, &url) {
                    *phase = next;
                }
            }
        }
        let _ = load_proxy.send_event(UserEvent::PageCommitted { view: id, url });
    });

    if matches!(part, Part::Server | Part::Popout) {
        let title_proxy = proxy.clone();
        builder = builder.with_document_title_changed_handler(move |title| {
            let _ = title_proxy.send_event(UserEvent::Title { view: id, title });
        });

        let dl_proxy = proxy.clone();
        builder = builder.with_download_started_handler(move |url, destination| {
            // wry already picked ~/Downloads/<suggested name>, de-duplicated; it
            // stays as it is. Only its name is passed on, for the toast.
            let file_name = file_name_of(destination);
            let _ = dl_proxy.send_event(UserEvent::DownloadStarted {
                view: id,
                url,
                file_name,
            });
            true
        });
        let done_proxy = proxy.clone();
        builder = builder.with_download_completed_handler(move |url, path, ok| {
            let _ = done_proxy.send_event(UserEvent::DownloadDone {
                view: id,
                url,
                path,
                ok,
            });
        });
    } else {
        // The app's own pages download nothing.
        builder = builder.with_download_started_handler(|_, _| false);
    }

    // wry answers WebKit's "web content process ended" notice itself, which
    // turns WebKit's own reload off: without a handler the view stays blank.
    #[cfg(target_os = "macos")]
    {
        use wry::WebViewBuilderExtDarwin;
        let gone_proxy = proxy.clone();
        builder = builder.with_on_web_content_process_terminate_handler(move || {
            let _ = gone_proxy.send_event(UserEvent::ContentProcessGone { view: id });
        });
    }

    builder = match load {
        Load::ConnectPage { manual } => builder.with_url(connect_page_url(manual)),
        Load::Bundled(page) => builder.with_url(page),
        Load::Server { url, auth: Some(auth) } => builder.with_url_and_headers(url, auth_headers(auth)),
        Load::Server { url, auth: None } => builder.with_url(url),
        Load::Nothing => builder,
    };
    let webview = match bounds {
        Some(_) => builder.build_as_child(window)?,
        None => builder.build(window)?,
    };
    #[cfg(target_os = "macos")]
    {
        macos::install(&webview);
        // Only a server page or pop-out ever gets a login, and only its tab's.
        if matches!(part, Part::Server | Part::Popout) {
            macos::bind_view(&webview, tab);
        }
    }
    Ok(webview)
}

/// The connect page's address; `manual` keeps it from connecting by itself.
fn connect_page_url(manual: bool) -> String {
    if manual {
        format!("{}?manual=1", policy::CONNECT_PAGE)
    } else {
        policy::CONNECT_PAGE.to_string()
    }
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
            Event::UserEvent(event) => self.on_user_event(event, target, control_flow),
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
        let timed_out: Vec<TabId> = self
            .tabs
            .iter_mut()
            .filter_map(|t| {
                if !matches!(*t.phase.borrow(), Phase::Loading(_)) {
                    t.loading_deadline = None;
                }
                t.loading_deadline.is_some_and(|due| now >= due).then_some(t.id)
            })
            .collect();
        for tab in timed_out {
            self.show_connect_page(tab, Some(LOAD_TIMED_OUT.into()), false);
        }
        if self.fullscreen_retry.is_some_and(|(due, _)| now >= due) {
            self.retry_fullscreen(now);
        }
        self.flush();
        if matches!(*control_flow, ControlFlow::ExitWithCode(_)) {
            return;
        }
        let save_due = self.config_dirty.then(|| self.save_held_since + SAVE_DEBOUNCE);
        let fullscreen_due = self.fullscreen_retry.map(|(due, _)| due);
        let loading_due = self.tabs.iter().filter_map(|t| t.loading_deadline).min();
        *control_flow = match [save_due, loading_due, fullscreen_due].into_iter().flatten().min() {
            Some(due) => ControlFlow::WaitUntil(due),
            None => ControlFlow::Wait,
        };
    }

    /// Draws again what changed this turn: the strip, the overview while it
    /// shows, the Server menu's tab items.
    fn flush(&mut self) {
        let fullscreen = self.main_window.fullscreen().is_some();
        if fullscreen != self.fullscreen {
            self.fullscreen = fullscreen;
            self.strip_dirty = true;
        }
        if std::mem::take(&mut self.strip_dirty) {
            let msg = {
                let views = self.tab_views();
                tabs::strip_state(&views, Some(self.active), self.overview_shown, self.fullscreen)
            };
            let _ = self
                .strip
                .webview
                .evaluate_script(&assets::native_message_script("__codemanTabs", &msg));
        }
        if std::mem::take(&mut self.overview_dirty) {
            if let Some(overview) = &self.overview {
                let msg = tabs::overview_state(&self.tab_views());
                let _ = overview
                    .webview
                    .evaluate_script(&assets::native_message_script("__codemanOverview", &msg));
            }
        }
        if std::mem::take(&mut self.menu_dirty) {
            let items: Vec<(String, bool)> = self
                .tabs
                .iter()
                .enumerate()
                .map(|(i, t)| (t.display_name(), !self.overview_shown && i == self.active))
                .collect();
            self.menu.set_tabs(&items);
            self.menu.reopen.set_enabled(!self.closed.is_empty());
        }
    }

    /// Every tab as the strip and the overview see it.
    fn tab_views(&self) -> Vec<tabs::View<'_>> {
        self.tabs
            .iter()
            .map(|t| tabs::View {
                id: t.id,
                name: t.display_name(),
                color: &t.color,
                kind: t.kind(),
                url: t.home.as_ref(),
                version: t.version.as_deref(),
                seen: &t.seen,
            })
            .collect()
    }

    /// The tabs that change, drawn again at the end of this turn.
    fn tabs_changed(&mut self) {
        self.strip_dirty = true;
        self.overview_dirty = true;
        self.menu_dirty = true;
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
        let w = &self.main_window;
        if w.fullscreen().is_some() || w.is_minimized() || attempts >= FULLSCREEN_ATTEMPTS {
            return;
        }
        w.set_fullscreen(Some(Fullscreen::Borderless(None)));
        self.fullscreen_retry = Some((now + FULLSCREEN_RETRY_EVERY, attempts + 1));
    }

    fn on_window_event(
        &mut self,
        id: WindowId,
        event: WindowEvent,
        target: &EventLoopWindowTarget<UserEvent>,
        control_flow: &mut ControlFlow,
    ) {
        let main = id == self.main_window.id();
        match event {
            WindowEvent::CloseRequested if !main => self.remove_popout(id),
            WindowEvent::CloseRequested => self.close_main_window(target, control_flow),
            WindowEvent::Moved(_) if main => self.record_main_frame(),
            WindowEvent::Resized(_) if main => {
                self.record_main_frame();
                self.layout();
                self.strip_dirty = true;
            }
            _ => {}
        }
    }

    /// The red button or Close Window on the main window.
    fn close_main_window(&mut self, target: &EventLoopWindowTarget<UserEvent>, control_flow: &mut ControlFlow) {
        self.record_main_frame();
        self.save_config();
        let mode = self.config.keep_awake.mode;
        let local = self.local_server();
        if keep_awake::available() && keep_awake::close_hides_app(mode, local.as_ref(), keep_awake::local_addresses) {
            // Keep This Mac Awake ends with the app, so closing the window
            // while it watches a Codeman on this Mac hides Codeman instead, as
            // Cmd+H does (full screen and pop-outs included): the Mac stays
            // awake, a click on the Dock icon brings it back, and Cmd+Q still
            // quits.
            hide_app(target);
        } else {
            // Closing the main window quits; the servers and their sessions
            // keep running, so nothing is lost.
            self.keep_awake.shutdown();
            *control_flow = ControlFlow::Exit;
        }
    }

    fn on_user_event(
        &mut self,
        event: UserEvent,
        target: &EventLoopWindowTarget<UserEvent>,
        control_flow: &mut ControlFlow,
    ) {
        match event {
            UserEvent::Menu(e) => self.on_menu(e.id.0.as_str(), target, control_flow),
            UserEvent::Ipc { view, msg } => match (self.owner(view), msg) {
                (Some(Owner::Connect(tab)), Ipc::Connect(cmd)) => self.on_connect_cmd(tab, cmd),
                (Some(owner @ (Owner::Server(_) | Owner::Popout(..))), Ipc::Host(cmd)) => {
                    self.on_host_cmd(view, owner, cmd, target)
                }
                _ => {}
            },
            UserEvent::Strip(cmd) => self.on_strip_cmd(cmd),
            UserEvent::Overview(cmd) => self.on_overview_cmd(cmd),
            UserEvent::ProbeDone(done) => self.on_probe_done(*done),
            UserEvent::ToConnectPage { tab, msg } => {
                if self.choosing(tab) {
                    self.to_connect_page(tab, msg);
                }
            }
            UserEvent::LogoLidStatus(line) => self.show_lid_status(line),
            UserEvent::ServerStartDone {
                tab,
                generation,
                url,
                result,
            } => {
                let Some(t) = self.tab_mut(tab) else {
                    return;
                };
                t.starting_server = None;
                if generation != t.start_generation {
                    return; // cancelled
                }
                let ok = result.is_ok();
                let output = result.unwrap_or_else(|e| e);
                self.to_connect_page(
                    tab,
                    json!({
                        "type": "serverStartResult",
                        "ok": ok,
                        "output": output,
                        "url": url.as_str(),
                    }),
                );
            }
            UserEvent::OpenAppWindow { tab, url } => {
                if self.script_window_budget.allow(Instant::now()) {
                    // Built without focus: it comes to the front, but the
                    // keyboard stays with the window the user is typing in.
                    self.build_popout(target, tab, &url, false);
                } else {
                    eprintln!("codeman-desktop: too many windows opened by a page at once; dropped one");
                }
            }
            UserEvent::OpenExternal(url) => {
                self.open_external_budgeted(&url);
            }
            UserEvent::CookiesCleared { tab, generation, url } => {
                // Only the load this clear was for, and only while it is
                // still wanted: a Cancel, a timeout, a closed tab or another
                // connect in between moved the generation or the phase on.
                let Some(t) = self.tab(tab) else {
                    return;
                };
                let current = generation == t.probe_generation
                    && matches!(&*t.phase.borrow(), Phase::Loading(loading) if *loading == url);
                if current {
                    if let Some(view) = t.server.as_ref().map(|v| v.id) {
                        self.load_in(view, &policy::webkit_safe_url(&url), true);
                    }
                }
            }
            UserEvent::LoginChecked {
                tab,
                generation,
                outcome,
            } => self.on_login_checked(tab, generation, outcome),
            UserEvent::Title { view, title } => self.on_title(view, title),
            UserEvent::PageCommitted { view, url } => self.on_page_committed(view, url),
            UserEvent::DownloadStarted { view, url, file_name } => {
                // A pop-out opened only to fetch a file would sit empty: hide
                // it now, drop it when the download ends (dropping it sooner
                // could cancel the download with its web view).
                if let Some(Owner::Popout(window, _)) = self.owner(view) {
                    if let Some(p) = self.popouts.get_mut(&window) {
                        if p.opened_url == url {
                            p.hidden_for_download = true;
                            p.window.set_visible(false);
                        }
                    }
                }
                self.downloads
                    .entry((view, url))
                    .or_default()
                    .push_back(file_name.unwrap_or_else(|| UNNAMED_FILE.into()));
            }
            UserEvent::DownloadDone { view, url, path, ok } => self.on_download_done(view, url, path, ok),
            UserEvent::AuthRejected(tab) => self.recheck_login(tab),
            UserEvent::ContentProcessGone { view } => self.on_content_process_gone(view),
            UserEvent::TabStatus {
                tab,
                generation,
                status,
            } => self.on_tab_status(tab, generation, status),
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

    // ---- tabs and views ----

    fn tab_index(&self, id: TabId) -> Option<usize> {
        self.tabs.iter().position(|t| t.id == id)
    }

    fn tab(&self, id: TabId) -> Option<&Tab> {
        self.tabs.iter().find(|t| t.id == id)
    }

    fn tab_mut(&mut self, id: TabId) -> Option<&mut Tab> {
        self.tabs.iter_mut().find(|t| t.id == id)
    }

    fn active_tab(&self) -> Option<&Tab> {
        self.tabs.get(self.active)
    }

    /// Who a web view belongs to.
    fn owner(&self, view: ViewId) -> Option<Owner> {
        if view == self.strip.id {
            return Some(Owner::Strip);
        }
        if self.overview.as_ref().is_some_and(|o| o.id == view) {
            return Some(Owner::Overview);
        }
        for t in &self.tabs {
            if t.connect.as_ref().is_some_and(|v| v.id == view) {
                return Some(Owner::Connect(t.id));
            }
            if t.server.as_ref().is_some_and(|v| v.id == view) {
                return Some(Owner::Server(t.id));
            }
        }
        self.popouts
            .iter()
            .find(|(_, p)| p.view == view)
            .map(|(w, p)| Owner::Popout(*w, p.tab))
    }

    /// The web view `view` is, wherever it lives.
    fn webview(&self, view: ViewId) -> Option<&WebView> {
        if view == self.strip.id {
            return Some(&self.strip.webview);
        }
        if let Some(o) = self.overview.as_ref().filter(|o| o.id == view) {
            return Some(&o.webview);
        }
        self.tabs
            .iter()
            .flat_map(Tab::views)
            .find(|v| v.id == view)
            .map(|v| &v.webview)
            .or_else(|| self.popouts.values().find(|p| p.view == view).map(|p| &p.webview))
    }

    fn child_view_mut(&mut self, view: ViewId) -> Option<&mut ChildView> {
        self.tabs
            .iter_mut()
            .flat_map(|t| t.connect.iter_mut().chain(t.server.iter_mut()))
            .find(|v| v.id == view)
    }

    fn next_view_id(&mut self) -> ViewId {
        let id = ViewId(self.next_view);
        self.next_view += 1;
        id
    }

    /// Where a tab's views and the overview go: everything below the strip.
    fn content_bounds(&self) -> (f64, f64, f64, f64) {
        let (width, height) = content_size(&self.main_window);
        (0.0, tabs::STRIP_HEIGHT, width, (height - tabs::STRIP_HEIGHT).max(0.0))
    }

    /// Build a view inside the main window, below the strip, hidden.
    fn build_child(
        &mut self,
        part: Part,
        tab: TabId,
        phase: Option<Rc<RefCell<Phase>>>,
        load: Load<'_>,
        store: Option<[u8; 16]>,
    ) -> Option<ChildView> {
        let id = self.next_view_id();
        let spec = ViewSpec {
            id,
            part,
            tab,
            phase,
            load,
            store,
            bounds: Some(self.content_bounds()),
            visible: false,
            focused: false,
        };
        match build_webview(&self.main_window, spec, &self.proxy) {
            Ok(webview) => Some(ChildView::new(id, webview)),
            Err(e) => {
                eprintln!("codeman-desktop: could not create a web view: {e}");
                None
            }
        }
    }

    /// Every view in its place after the window changed size.
    fn layout(&self) {
        let (x, y, w, h) = self.content_bounds();
        let rect = |x: f64, y: f64, w: f64, h: f64| ViewRect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(w, h).into(),
        };
        let _ = self.strip.webview.set_bounds(rect(0.0, 0.0, w, tabs::STRIP_HEIGHT));
        for view in self.tabs.iter().flat_map(Tab::views).chain(self.overview.iter()) {
            let _ = view.webview.set_bounds(rect(x, y, w, h));
        }
    }

    /// Show the view of the tab in front (or the overview) and hide the rest.
    /// `focus`: the shown view takes the keyboard.
    fn show_front(&mut self, focus: bool) {
        let front = match self.overview_shown {
            true => self.overview.as_ref().map(|o| o.id),
            false => self.active_tab().and_then(Tab::front).map(|v| v.id),
        };
        for view in self.tabs.iter().flat_map(Tab::views).chain(self.overview.iter()) {
            let _ = view.webview.set_visible(Some(view.id) == front);
        }
        if focus {
            if let Some(webview) = front.and_then(|id| self.webview(id)) {
                let _ = webview.focus();
            }
        }
        self.update_title();
        self.tabs_changed();
    }

    fn update_title(&self) {
        let title = match (self.overview_shown, self.active_tab()) {
            (true, _) => OVERVIEW_TITLE.to_string(),
            (false, Some(t)) if t.kind() == tabs::Kind::Server => {
                tabs::window_title(t.page_title.as_deref(), &t.display_name())
            }
            _ => APP_NAME.to_string(),
        };
        self.main_window.set_title(&title);
    }

    /// The tabs of the last run, or one tab with the connect page.
    fn open_launch_tabs(&mut self) {
        let saved = self.config.tabs.clone();
        let auto = self.config.auto_connect;
        for entry in saved {
            self.create_tab(Some(entry), auto, true);
        }
        if self.tabs.is_empty() {
            // Before tabs, and on a first run: the connect page as it always
            // was, connecting to the server used last on its own.
            self.create_tab(None, false, false);
        }
        self.active = self.config.active_tab.min(self.tabs.len().saturating_sub(1));
        if let Some(t) = self.tabs.first_mut() {
            t.notice = self.launch_notice.take();
        }
        self.show_front(true);
    }

    /// A new tab with the connect page. `entry`: a server it is for (a tab
    /// opened again), shown on the page and connected to when `connect_now`.
    /// `manual`: the page does not connect on its own.
    fn create_tab(&mut self, entry: Option<TabEntry>, connect_now: bool, manual: bool) -> Option<TabId> {
        if self.tabs.len() >= MAX_TABS {
            return None;
        }
        let id = self.next_tab;
        self.next_tab += 1;
        let phase = Rc::new(RefCell::new(Phase::Connect));
        let connect = self.build_child(
            Part::Connect,
            id,
            Some(phase.clone()),
            Load::ConnectPage { manual },
            None,
        )?;
        let home = entry.as_ref().and_then(|e| Url::parse(&e.url).ok());
        let color = entry
            .as_ref()
            .and_then(|e| e.color.clone())
            .filter(|c| tabs::is_color(c))
            .unwrap_or_else(|| tabs::next_color(self.tabs.iter().map(|t| t.color.as_str())));
        self.tabs.push(Tab {
            id,
            connect: Some(connect),
            server: None,
            phase,
            connect_to: entry.as_ref().map(|e| (e.url.clone(), connect_now)),
            home,
            name: entry.and_then(|e| e.name),
            color,
            version: None,
            page_title: None,
            store: None,
            loading_deadline: None,
            auth: None,
            login: None,
            login_generation: 0,
            login_recheck: None,
            probe_generation: 0,
            start_generation: 0,
            starting_server: None,
            notice: None,
            add_agent_on_load: false,
            seen: tabs::Seen::default(),
            watch: None,
            status_login: true,
        });
        self.tabs_changed();
        Some(id)
    }

    /// ⌘T, the + button, Switch Server: a new tab with the connect page, in
    /// front.
    fn new_tab(&mut self) -> Option<TabId> {
        let Some(id) = self.create_tab(None, false, true) else {
            if let Some(t) = self.active_tab().map(|t| t.id) {
                self.toast_in_tab(t, TOO_MANY_TABS, "warning");
            }
            return None;
        };
        self.select_tab(self.tabs.len() - 1);
        Some(id)
    }

    /// Bring the tab at `index` to the front, the overview out of the way,
    /// with the keyboard in its page.
    fn select_tab(&mut self, index: usize) {
        if index >= self.tabs.len() {
            return;
        }
        self.active = index;
        self.overview_shown = false;
        self.show_front(true);
        self.save_tabs();
        self.sync_keep_awake();
    }

    fn select_tab_id(&mut self, id: TabId) {
        if let Some(index) = self.tab_index(id) {
            self.select_tab(index);
        }
    }

    /// ⌘0 and the grid button: the overview in front, or the tab again.
    fn toggle_overview(&mut self) {
        if self.overview_shown {
            self.overview_shown = false;
            self.show_front(true);
            return;
        }
        if self.overview.is_none() {
            self.overview = self.build_child(Part::Overview, 0, None, Load::Bundled(policy::OVERVIEW_PAGE), None);
        }
        if self.overview.is_some() {
            self.overview_shown = true;
            self.show_front(true);
        }
    }

    /// Close a tab: its pop-outs, its views, its status thread and its login
    /// go. Its server and sessions keep running. The last tab gives way to a
    /// new tab with the connect page, never an empty window.
    fn close_tab(&mut self, id: TabId) {
        let Some(index) = self.tab_index(id) else {
            return;
        };
        if self.lone_blank_tab() {
            return; // it would only come back
        }
        self.close_popouts_of(id);
        set_challenge_login(id, None);
        #[cfg(target_os = "macos")]
        macos::forget_tab(id);
        let tab = self.tabs.remove(index);
        if let Some(entry) = tab.entry() {
            self.closed.push(entry);
            if self.closed.len() > tabs::MAX_CLOSED {
                self.closed.remove(0);
            }
        }
        let views: Vec<ViewId> = tab.views().map(|v| v.id).collect();
        self.downloads.retain(|(view, _), _| !views.contains(view));
        drop(tab);
        let before = self.tabs.len() + 1;
        if index < self.active {
            self.active -= 1;
        } else if index == self.active {
            self.active = tabs::after_close(before, index).unwrap_or(0);
        }
        if self.tabs.is_empty() {
            self.create_tab(None, false, true);
            self.active = 0;
        }
        self.show_front(!self.overview_shown);
        self.save_tabs();
        self.sync_logo_watch();
        self.sync_keep_awake();
    }

    /// The window holds one tab, and it is a new tab with nothing in it.
    fn lone_blank_tab(&self) -> bool {
        matches!(self.tabs.as_slice(), [t] if t.home.is_none() && t.kind() == tabs::Kind::Connect)
    }

    fn close_popouts_of(&mut self, tab: TabId) {
        let windows: Vec<WindowId> = self
            .popouts
            .iter()
            .filter(|(_, p)| p.tab == tab)
            .map(|(w, _)| *w)
            .collect();
        for window in windows {
            self.remove_popout(window);
        }
    }

    /// Reopen Closed Tab: the last tab closed, connected again.
    fn reopen_closed(&mut self) {
        let Some(entry) = self.closed.pop() else {
            return;
        };
        if let Some(index) = self
            .tabs
            .iter()
            .position(|t| t.home.as_ref().is_some_and(|h| h.as_str() == entry.url))
        {
            self.select_tab(index);
            return;
        }
        if self.create_tab(Some(entry), true, true).is_some() {
            self.select_tab(self.tabs.len() - 1);
        }
    }

    /// The tabs to open at the next launch: those that belong to a server.
    fn save_tabs(&mut self) {
        let entries: Vec<TabEntry> = self.tabs.iter().filter_map(Tab::entry).collect();
        let active = self
            .tabs
            .iter()
            .take(self.active + 1)
            .filter(|t| t.home.is_some())
            .count()
            .saturating_sub(1);
        if self.config.tabs != entries || self.config.active_tab != active {
            self.config.tabs = entries;
            self.config.active_tab = active;
            self.config_dirty = true;
        }
    }

    fn on_strip_cmd(&mut self, cmd: StripCmd) {
        match cmd {
            StripCmd::Ready => self.strip_dirty = true,
            StripCmd::Select(id) => {
                let Some(index) = self.tab_index(id) else {
                    return;
                };
                if index == self.active && !self.overview_shown {
                    // Already in front: only the keyboard goes back to its
                    // page (a click made the strip the first responder). A
                    // double-click that starts a rename asks for the strip
                    // again afterwards (StripCmd::Editing).
                    self.focus_front();
                    return;
                }
                self.select_tab(index);
            }
            StripCmd::Close(id) => self.close_tab(id),
            StripCmd::New => {
                self.new_tab();
            }
            StripCmd::Overview => self.toggle_overview(),
            StripCmd::Menu(id) => self.show_tab_menu(id),
            StripCmd::Rename { id, name } => {
                if let Some(t) = self.tab_mut(id) {
                    let default = t.shown_url().map(|u| tabs::default_name(&u));
                    if let Some(name) = tabs::renamed(&name, &t.display_name(), default.as_deref()) {
                        t.name = name;
                    }
                }
                self.tabs_changed();
                self.save_tabs();
                self.update_title();
                self.focus_front();
            }
            StripCmd::Move { id, to } => {
                let Some(from) = self.tab_index(id) else {
                    return;
                };
                let Some(to) = tabs::moved(self.tabs.len(), from, to) else {
                    return;
                };
                let active = self.tabs.get(self.active).map(|t| t.id);
                let tab = self.tabs.remove(from);
                self.tabs.insert(to, tab);
                if let Some(index) = active.and_then(|id| self.tab_index(id)) {
                    self.active = index;
                }
                self.tabs_changed();
                self.save_tabs();
                self.focus_front();
            }
            StripCmd::Editing => {
                let _ = self.strip.webview.focus();
            }
            StripCmd::Drag => {
                let _ = self.main_window.drag_window();
                self.focus_front();
            }
            StripCmd::Zoom => {
                let w = &self.main_window;
                if w.fullscreen().is_none() {
                    w.set_maximized(!w.is_maximized());
                }
                self.focus_front();
            }
        }
    }

    /// The keyboard back in the page in front (after a click on the strip).
    fn focus_front(&self) {
        let front = match self.overview_shown {
            true => self.overview.as_ref().map(|o| o.id),
            false => self.active_tab().and_then(Tab::front).map(|v| v.id),
        };
        if let Some(webview) = front.and_then(|id| self.webview(id)) {
            let _ = webview.focus();
        }
    }

    /// The right-click menu of a tab, at the pointer.
    fn show_tab_menu(&mut self, id: TabId) {
        let Some(t) = self.tab(id) else {
            return;
        };
        let server = t.kind() == tabs::Kind::Server;
        let Ok(menu) = menu::tab_context_menu(id, &t.color, server, self.tabs.len() > 1) else {
            return;
        };
        #[cfg(target_os = "macos")]
        {
            use muda::ContextMenu;
            use tao::platform::macos::WindowExtMacOS;
            // SAFETY: tao's live NSView of the main window; the menu runs its
            // tracking loop now and is done with the view when this returns.
            unsafe { menu.show_context_menu_for_nsview(self.main_window.ns_view(), None) };
        }
        // The right-click made the strip the first responder. The item chosen,
        // if any, arrives after this (Rename takes the strip again then).
        self.focus_front();
        #[cfg(not(target_os = "macos"))]
        drop(menu);
    }

    fn on_tab_menu(&mut self, id: TabId, action: TabAction) {
        match action {
            TabAction::Rename => {
                // The strip takes the keyboard for the name field.
                let _ = self.strip.webview.focus();
                let msg = json!({ "type": "rename", "id": id });
                let _ = self
                    .strip
                    .webview
                    .evaluate_script(&assets::native_message_script("__codemanTabs", &msg));
            }
            TabAction::Color(i) => {
                if let (Some(t), Some(color)) = (self.tab_mut(id), tabs::PALETTE.get(i)) {
                    t.color = (*color).to_string();
                }
                self.tabs_changed();
                self.save_tabs();
                self.focus_front();
            }
            TabAction::Reload => {
                if let Some(view) = self.tab(id).and_then(|t| t.server.as_ref()).map(|v| v.id) {
                    if let Some((url, with_auth)) = self.reload_target(view) {
                        self.load_in(view, &url, with_auth);
                    }
                }
            }
            TabAction::Reconnect => self.show_connect_page(id, None, true),
            TabAction::Close => self.close_tab(id),
            TabAction::CloseOthers => {
                let others: Vec<TabId> = self.tabs.iter().map(|t| t.id).filter(|t| *t != id).collect();
                for other in others {
                    self.close_tab(other);
                }
            }
        }
    }

    fn on_overview_cmd(&mut self, cmd: OverviewCmd) {
        match cmd {
            OverviewCmd::Ready => self.overview_dirty = true,
            OverviewCmd::Open(tab) => self.select_tab_id(tab),
            OverviewCmd::OpenSession { tab, session } => {
                self.select_tab_id(tab);
                if !tabs::is_session_id(&session) {
                    return;
                }
                let loaded = self.tab(tab).filter(|t| t.kind() == tabs::Kind::Server);
                if let Some(server) = loaded.and_then(|t| t.server.as_ref()) {
                    let _ = server.webview.evaluate_script(&assets::select_session_script(&session));
                }
            }
            OverviewCmd::New => {
                self.new_tab();
            }
            OverviewCmd::Retry(tab) => {
                let view = self.tab(tab).and_then(|t| t.server.as_ref()).map(|v| v.id);
                match view.and_then(|v| self.reload_target(v).map(|r| (v, r))) {
                    Some((view, (url, with_auth))) => self.load_in(view, &url, with_auth),
                    None => self.select_tab_id(tab),
                }
            }
        }
    }

    fn on_tab_status(&mut self, tab: TabId, generation: u64, status: StatusUpdate) {
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        if generation != t.login_generation {
            return;
        }
        match status {
            StatusUpdate::Seen(detail) => {
                t.seen.detail = Some(detail);
                t.seen.offline = false;
            }
            StatusUpdate::Offline => t.seen.offline = true,
            StatusUpdate::Refused => {
                t.seen.refused = true;
                t.watch = None;
            }
        }
        self.strip_dirty = true;
        self.overview_dirty = true;
    }

    fn on_title(&mut self, view: ViewId, title: String) {
        match self.owner(view) {
            Some(Owner::Server(tab)) => {
                if let Some(t) = self.tab_mut(tab) {
                    t.page_title = Some(title);
                }
                self.update_title();
            }
            Some(Owner::Popout(window, _)) => {
                if let Some(p) = self.popouts.get(&window) {
                    let title = title.trim();
                    p.window.set_title(if title.is_empty() { APP_NAME } else { title });
                }
            }
            _ => {}
        }
    }

    fn on_page_committed(&mut self, view: ViewId, url: String) {
        match self.owner(view) {
            Some(Owner::Server(tab)) => {
                let Some(t) = self.tab(tab) else {
                    return;
                };
                let next = policy::loaded_on_commit(&t.phase.borrow(), &url);
                if let Some(next) = next {
                    *t.phase.borrow_mut() = next;
                }
                if let Some(v) = self.child_view_mut(view) {
                    v.committed = Url::parse(&url).ok();
                }
                // The connect page is still there the first time the server's
                // page commits: the load got through.
                let first = self
                    .tab(tab)
                    .is_some_and(|t| t.connect.is_some() && t.phase.borrow().loaded().is_some());
                if first {
                    self.on_server_loaded(tab);
                }
            }
            Some(Owner::Connect(_)) => {
                if let Some(v) = self.child_view_mut(view) {
                    v.committed = Url::parse(&url).ok();
                }
            }
            Some(Owner::Popout(window, _)) => {
                if let Some(p) = self.popouts.get_mut(&window) {
                    p.committed = Url::parse(&url).ok();
                }
            }
            _ => {}
        }
    }

    /// A tab's server page committed: it replaces the connect page, the tab
    /// is for this server from now on, and its status is read.
    fn on_server_loaded(&mut self, tab: TabId) {
        let proxy = self.proxy.clone();
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        t.connect = None;
        let server = t.phase.borrow().loaded().cloned();
        if let Some(server) = server {
            t.home = Some(server.clone());
            t.seen = tabs::Seen::default();
            t.watch = t
                .status_login
                .then(|| watch_status(&proxy, tab, t.login_generation, &server, t.auth.clone()))
                .flatten();
        }
        // The server page takes the keyboard from the connect page it replaces,
        // when this tab is the one in front.
        let in_front = self.active_tab().is_some_and(|t| t.id == tab) && !self.overview_shown;
        self.show_front(in_front);
        self.save_tabs();
        self.sync_logo_watch();
        self.sync_keep_awake();
    }

    fn on_download_done(&mut self, view: ViewId, url: String, path: Option<PathBuf>, ok: bool) {
        let key = (view, url);
        let started = self.downloads.get_mut(&key).and_then(VecDeque::pop_front);
        if self.downloads.get(&key).is_some_and(VecDeque::is_empty) {
            self.downloads.remove(&key);
        }
        let name = started
            .or_else(|| path.as_deref().and_then(file_name_of))
            .unwrap_or_else(|| UNNAMED_FILE.into());
        // The toast goes where the download was started when that view still
        // shows Codeman's own app (a session pop-out has it too), else to the
        // tab's server page. Chosen before a hidden pop-out is dropped.
        let owner = self.owner(view);
        let tab = match owner {
            Some(Owner::Server(tab) | Owner::Popout(_, tab)) => tab,
            _ => return,
        };
        let server = self.tab(tab).and_then(|t| t.phase.borrow().loaded().cloned());
        let shows_app = |committed: Option<&Url>| {
            server
                .as_ref()
                .zip(committed)
                .is_some_and(|(server, url)| policy::trusted_frame(url, server))
        };
        let toast_in = match owner {
            Some(Owner::Popout(window, _)) => {
                let p = self.popouts.get(&window);
                let here = p.is_some_and(|p| !p.hidden_for_download && shows_app(p.committed.as_ref()));
                if p.is_some_and(|p| p.hidden_for_download) {
                    self.remove_popout(window);
                }
                here.then_some(view)
            }
            _ => None,
        };
        let toast_in = toast_in.or_else(|| self.tab(tab).and_then(|t| t.server.as_ref()).map(|v| v.id));
        if let Some(webview) = toast_in.and_then(|id| self.webview(id)) {
            let _ = webview.evaluate_script(&assets::download_toast_script(&name, ok));
        }
    }

    /// A toast in a tab's server page, if it shows one.
    fn toast_in_tab(&self, tab: TabId, text: &str, kind: &str) {
        let loaded = self.tab(tab).filter(|t| t.kind() == tabs::Kind::Server);
        if let Some(server) = loaded.and_then(|t| t.server.as_ref()) {
            let _ = server.webview.evaluate_script(&assets::toast_script(text, kind));
        }
    }

    /// The web content process of `view` ended, so the view is blank
    /// (policy::recovery decides what it does about it). A second end within
    /// CRASH_RELOAD_COOLDOWN counts as the same page failing again.
    fn on_content_process_gone(&mut self, view: ViewId) {
        let now = Instant::now();
        let again_after =
            |at: Option<Instant>| at.is_some_and(|at| now.saturating_duration_since(at) < CRASH_RELOAD_COOLDOWN);
        match self.owner(view) {
            Some(Owner::Strip) => {
                let _ = self.strip.webview.load_url(policy::STRIP_PAGE);
            }
            Some(Owner::Overview) => {
                if let Some(o) = &self.overview {
                    let _ = o.webview.load_url(policy::OVERVIEW_PAGE);
                }
            }
            Some(Owner::Connect(tab)) => {
                let again = self.child_view_mut(view).map(|v| again_after(v.gone_at.replace(now)));
                if again == Some(false) {
                    if let Some(webview) = self.webview(view) {
                        let _ = webview.load_url(&connect_page_url(true));
                    }
                } else {
                    eprintln!("codeman-desktop: tab {tab}'s connect page stopped again and was left as it is");
                }
            }
            Some(Owner::Server(tab)) => {
                let Some(again) = self.child_view_mut(view).map(|v| again_after(v.gone_at.replace(now))) else {
                    return;
                };
                let on_server = self.tab(tab).is_some_and(|t| t.phase.borrow().loaded().is_some());
                match policy::recovery(true, on_server, again) {
                    Recovery::Reload => {
                        if let Some((url, with_auth)) = self.reload_target(view) {
                            self.load_in(view, &url, with_auth);
                        }
                    }
                    Recovery::ConnectPage { gave_up } => {
                        self.show_connect_page(tab, gave_up.then(|| PAGE_KEEPS_STOPPING.to_string()), false);
                    }
                    Recovery::Close => {}
                    Recovery::Nothing => eprintln!("codeman-desktop: a page stopped again and was left as it is"),
                }
            }
            Some(Owner::Popout(window, tab)) => {
                let Some(p) = self.popouts.get_mut(&window) else {
                    return;
                };
                // A pop-out hidden for its download shows no page, and the
                // download does not run in that process: loading again would
                // fetch it twice.
                if p.hidden_for_download {
                    return;
                }
                let again = again_after(p.gone_at.replace(now));
                let on_server = self.tab(tab).is_some_and(|t| t.phase.borrow().loaded().is_some());
                match policy::recovery(false, on_server, again) {
                    Recovery::Reload => {
                        if let Some((url, with_auth)) = self.reload_target(view) {
                            self.load_in(view, &url, with_auth);
                        }
                    }
                    Recovery::Close => self.remove_popout(window),
                    Recovery::ConnectPage { .. } | Recovery::Nothing => {
                        eprintln!("codeman-desktop: a page stopped again and was left as it is")
                    }
                }
            }
            None => {}
        }
    }

    /// The challenge handler reported that a tab's server refused its login.
    /// That is not taken on trust: a 401 the handler reads as Codeman's can
    /// still come from something Codeman relays (a dashboard asset a web tab
    /// fetches by a root-absolute URL). So the login is checked once against
    /// the server's own status API, off the event loop, and on_login_checked
    /// decides.
    fn recheck_login(&mut self, tab: TabId) {
        let proxy = self.proxy.clone();
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        let Some(server) = t.phase.borrow().server().cloned() else {
            return; // the connect page: nothing to recheck
        };
        let Some(auth) = t.auth.clone() else {
            return;
        };
        let generation = t.login_generation;
        if t.login_recheck == Some(generation) {
            return;
        }
        t.login_recheck = Some(generation);
        std::thread::spawn(move || {
            let outcome = probe::probe(&server, Some(&auth));
            let _ = proxy.send_event(UserEvent::LoginChecked {
                tab,
                generation,
                outcome,
            });
        });
    }

    /// The server's answer to recheck_login. A refused login brings the tab's
    /// connect page back (without taking focus from another app). So does a
    /// 429: the page's own requests then get 429 too, which carries no
    /// challenge, so nothing else would ever notice, and re-arming would send
    /// the refused login again once the limit lapses. Any other answer, a
    /// network error included, leaves the page as it is and hands the handler
    /// the same login again, which also re-arms its report, so a later real
    /// refusal is noticed.
    fn on_login_checked(&mut self, tab: TabId, generation: u64, outcome: ProbeOutcome) {
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        if t.login_recheck == Some(generation) {
            t.login_recheck = None;
        }
        if generation != t.login_generation {
            return; // another login, or none, since the recheck started
        }
        let Some(server) = t.phase.borrow().server().cloned() else {
            return;
        };
        match outcome {
            ProbeOutcome::BadCredentials | ProbeOutcome::NeedsLogin => {
                self.show_connect_page(tab, Some(AUTH_REJECTED.into()), false);
            }
            ProbeOutcome::RateLimited { .. } => {
                self.show_connect_page(tab, Some(AUTH_RATE_LIMITED.into()), false);
            }
            _ => {
                if let Some((username, password)) = &t.login {
                    set_challenge_login(tab, Some((&server, username, password)));
                }
            }
        }
    }

    /// The servers of every tab that shows one, with their logins.
    fn loaded_servers(&self) -> Vec<(Url, Option<String>)> {
        self.tabs
            .iter()
            .filter_map(|t| t.phase.borrow().loaded().cloned().map(|url| (url, t.auth.clone())))
            .collect()
    }

    /// The logo is watched while the switch is on, a state has a style and a
    /// server is open, for every open server together.
    fn sync_logo_watch(&mut self) {
        let styles = self.config.logo_blink;
        let want = (styles.active() && logo::available()).then(|| {
            let servers = self
                .loaded_servers()
                .into_iter()
                .map(|(url, authorization)| logo::Target {
                    server: url.to_string(),
                    authorization,
                })
                .collect();
            (servers, styles)
        });
        self.logo_watch.sync(want);
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
        if let Some(t) = self.active_tab().map(|t| t.id) {
            self.toast_in_tab(t, warning, "warning");
        }
    }

    /// The Codeman on this Mac among the open tabs, if any: the tab in front
    /// when it is one, else the first. Keep This Mac Awake watches it.
    fn local_server(&self) -> Option<Url> {
        let servers = self.loaded_servers();
        if servers.is_empty() {
            return None;
        }
        let addresses = keep_awake::local_addresses();
        let active = self.active_tab().and_then(|t| t.phase.borrow().loaded().cloned());
        active
            .into_iter()
            .chain(servers.into_iter().map(|(url, _)| url))
            .find(|url| keep_awake::is_this_mac(url, &addresses))
    }

    /// Keep-awake watches the Codeman on this Mac among the tabs while a mode
    /// is chosen. With none, it says so.
    fn sync_keep_awake(&mut self) {
        let mut settings = self.config.keep_awake;
        // The lid item only exists on a Mac with a lid; a setting copied from one
        // does nothing elsewhere.
        settings.lid &= keep_awake::has_lid();
        let watch = (settings.mode != keep_awake::Mode::Off)
            .then(|| self.local_server())
            .flatten()
            .map(|server| {
                let authorization = self
                    .tabs
                    .iter()
                    .find(|t| t.phase.borrow().loaded() == Some(&server))
                    .and_then(|t| t.auth.clone());
                keep_awake::Watch {
                    server,
                    authorization,
                    settings,
                }
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

    fn on_menu(&mut self, id: &str, target: &EventLoopWindowTarget<UserEvent>, control_flow: &mut ControlFlow) {
        if let Some((signal, style)) = BlinkStyle::from_menu_id(id) {
            self.choose_logo_blink(signal, style);
            return;
        }
        if let Some(mode) = keep_awake::Mode::from_menu_id(id) {
            self.choose_keep_awake_mode(mode);
            return;
        }
        if let Some((tab, action)) = TabAction::parse(id) {
            self.on_tab_menu(tab, action);
            return;
        }
        if let Some(key) = menu::tab_key(id) {
            if let Some(index) = tabs::index_of_key(key, self.tabs.len()) {
                self.select_tab(index);
            }
            return;
        }
        match id {
            keep_awake::AC_ONLY_ID => self.toggle_keep_awake_ac_only(),
            keep_awake::LID_ID => self.toggle_keep_awake_lid(),
            keep_awake::REMOVE_OLD_HELPER_ID => self.remove_old_helper(),
            menu_id::SWITCH | menu_id::TAB_NEW => {
                self.new_tab();
            }
            menu_id::TAB_CLOSE => match self.focused_popout() {
                Some(window) => self.remove_popout(window),
                None if self.overview_shown => self.toggle_overview(),
                // As in Safari: ⌘W on the last tab closes the window.
                None if self.lone_blank_tab() => self.close_main_window(target, control_flow),
                None => {
                    if let Some(t) = self.active_tab().map(|t| t.id) {
                        self.close_tab(t);
                    }
                }
            },
            menu_id::WINDOW_CLOSE => match self.focused_popout() {
                Some(window) => self.remove_popout(window),
                None => self.close_main_window(target, control_flow),
            },
            menu_id::TAB_REOPEN => self.reopen_closed(),
            menu_id::TAB_OVERVIEW => self.toggle_overview(),
            menu_id::TAB_NEXT | menu_id::TAB_PREVIOUS => {
                let forward = id == menu_id::TAB_NEXT;
                if let Some(index) = tabs::neighbour(self.tabs.len(), self.active, forward) {
                    self.select_tab(index);
                }
            }
            menu_id::ADD_AGENT => self.add_agent(),
            menu_id::RELOAD => self.reload_focused(),
            menu_id::LOGO_BLINK => self.toggle_logo_blink(),
            menu_id::START_FULLSCREEN => {
                let value = self.menu.start_fullscreen.is_checked();
                self.config.start_fullscreen = value;
                self.config_dirty = true;
                self.to_every_connect_page(json!({ "type": "prefs", "startFullscreen": value }));
            }
            menu_id::DEVTOOLS => {
                if let Some(window) = self.focused_popout() {
                    if let Some(p) = self.popouts.get(&window) {
                        p.webview.open_devtools();
                    }
                } else if self.main_window.is_focused() {
                    let front = match self.overview_shown {
                        true => self.overview.as_ref().map(|o| o.id),
                        false => self.active_tab().and_then(Tab::front).map(|v| v.id),
                    };
                    if let Some(webview) = front.and_then(|id| self.webview(id)) {
                        webview.open_devtools();
                    }
                }
            }
            // The Help items are the user's own click, so they skip the budget.
            menu_id::HELP_DOCS => open_external(&Url::parse(menu::DOCS_URL).expect("static url")),
            menu_id::HELP_GITHUB => open_external(&Url::parse(menu::REPO_URL).expect("static url")),
            _ => {}
        }
    }

    fn on_host_cmd(&mut self, view: ViewId, owner: Owner, cmd: HostCmd, target: &EventLoopWindowTarget<UserEvent>) {
        let tab = match owner {
            Owner::Server(tab) | Owner::Popout(_, tab) => tab,
            _ => return,
        };
        match cmd {
            HostCmd::OpenWindow(raw) => {
                // The page's openWindow already answered true, so every way
                // this can fail (refused, the pop-out limit, a window that
                // did not build, the browser budget) is reported back to it.
                // This request comes only from Codeman's own app shell
                // (parse_ipc), so a session it asked for gets its tab back.
                let Some(phase) = self.tab(tab).map(|t| t.phase.clone()) else {
                    return;
                };
                let session = phase.borrow().loaded().and_then(|server| {
                    Url::parse(&raw)
                        .ok()
                        .and_then(|url| policy::session_id_of(&url, server))
                });
                let decision = policy::new_window(&raw, &phase.borrow(), Via::Host);
                let opened = match decision {
                    NewWindow::AppWindow(url) => self.build_popout(target, tab, &url, true),
                    NewWindow::External(url) => self.open_external_budgeted(&url),
                    NewWindow::Deny => false,
                };
                if !opened {
                    self.tell_refused(view, session.as_deref());
                }
            }
            HostCmd::CloseWindow => {
                if let Owner::Popout(window, _) = owner {
                    self.remove_popout(window);
                }
            }
            HostCmd::FocusWindow => match owner {
                Owner::Popout(window, _) => {
                    if let Some(p) = self.popouts.get(&window) {
                        p.window.set_visible(true);
                        p.window.set_minimized(false);
                        p.window.set_focus();
                    }
                }
                _ => {
                    self.select_tab_id(tab);
                    self.show_main_window();
                }
            },
            HostCmd::OpenExternal(raw) => self.open_external_raw(&raw),
            HostCmd::SessionExpired => self.on_session_expired(view, tab),
        }
    }

    fn on_connect_cmd(&mut self, tab: TabId, cmd: ConnectCmd) {
        // The connect page is still live while a server loads, but only
        // Cancel and the settings make sense then.
        let choosing = self.choosing(tab);
        let loading = self
            .tab(tab)
            .is_some_and(|t| matches!(*t.phase.borrow(), Phase::Loading(_)));
        match cmd {
            ConnectCmd::Ready => self.send_init(tab),
            ConnectCmd::Connect {
                url,
                username,
                password,
                remember,
            } => {
                if choosing {
                    self.start_probe(tab, url, username, password, remember);
                }
            }
            ConnectCmd::Cancel => {
                if let Some(t) = self.tab_mut(tab) {
                    t.probe_generation += 1;
                    t.start_generation += 1;
                }
                // Only a load that has not committed yet: once the server page
                // is up, a Cancel that was still on its way changes nothing.
                if loading {
                    self.show_connect_page(tab, Some(LOAD_CANCELLED.into()), true);
                }
            }
            ConnectCmd::StartServer { url } => {
                if choosing {
                    self.start_server(tab, url);
                }
            }
            ConnectCmd::Forget { url } => {
                if let Some(entry) = self.config.forget(&url) {
                    if let Some(user) = entry.username {
                        self.keychain.delete(&credentials::account(&url, &user));
                    }
                    self.config_dirty = true;
                }
                self.to_every_connect_page(json!({ "type": "servers", "servers": self.config.servers }));
            }
            ConnectCmd::SetAutoConnect(v) => {
                self.config.auto_connect = v;
                self.config_dirty = true;
                self.to_every_connect_page(json!({ "type": "prefs", "autoConnect": v }));
            }
            ConnectCmd::SetStartFullscreen(v) => {
                self.config.start_fullscreen = v;
                self.menu.start_fullscreen.set_checked(v);
                self.config_dirty = true;
                self.to_every_connect_page(json!({ "type": "prefs", "startFullscreen": v }));
            }
            ConnectCmd::OpenExternal(raw) => self.open_external_raw(&raw),
            ConnectCmd::LocalStatus { quick, deep } => {
                if choosing {
                    let depth = match (quick, deep) {
                        (true, _) => setup::Depth::Quick,
                        (false, false) => setup::Depth::Login,
                        (false, true) => setup::Depth::Interactive,
                    };
                    self.in_background(
                        tab,
                        move || json!({ "type": "localStatus", "status": setup::inspect(depth) }),
                    );
                }
            }
            ConnectCmd::InstallLocal { network } => {
                if choosing {
                    self.in_background(tab, move || {
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
                    self.in_background(tab, || plan_message(gui_install::prepare()));
                }
            }
            ConnectCmd::InstallStart {
                network_password,
                ai_cli,
            } => {
                if choosing {
                    let send = self.page_sender(tab);
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
                    self.attach_to_run(tab, gui_install::Run::Codeman);
                }
            }
            ConnectCmd::InstallCancel => {
                std::thread::spawn(gui_install::cancel);
            }
            ConnectCmd::AgentPrepare => {
                if choosing {
                    self.in_background(tab, || plan_message(gui_install::prepare_agent()));
                }
            }
            ConnectCmd::AgentStart { ai_cli } => {
                if choosing {
                    let send = self.page_sender(tab);
                    let stale = self.next_install_reader();
                    std::thread::spawn(move || match gui_install::start_agent(&ai_cli) {
                        Ok(()) => gui_install::follow(gui_install::Run::Agent, stale, send),
                        Err(message) => send(json!({ "type": "installStartFailed", "message": message })),
                    });
                }
            }
            ConnectCmd::AgentAttach => {
                if choosing {
                    self.attach_to_run(tab, gui_install::Run::Agent);
                }
            }
            ConnectCmd::InstallRemote { target } => {
                if choosing {
                    match terminal_install::SshTarget::parse(&target) {
                        Err(message) => self.to_connect_page(tab, remote_install_failed(message)),
                        Ok(target) => self.in_background(tab, move || {
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
                self.in_background(tab, || {
                    match terminal_install::copy_to_clipboard(setup::INSTALL_ONE_LINER) {
                        Ok(()) => json!({ "type": "copied" }),
                        Err(message) => remote_install_failed(message),
                    }
                });
            }
        }
    }

    /// Report a run that is going already to the tab's page, from its first line.
    fn attach_to_run(&self, tab: TabId, run: gui_install::Run) {
        let send = self.page_sender(tab);
        let stale = self.next_install_reader();
        std::thread::spawn(move || gui_install::follow(run, stale, send));
    }

    /// The agent chooser lives on the connect page: the tab in front shows it
    /// when that is a connect page, else a new tab does.
    fn add_agent(&mut self) {
        let front = self.active_tab().map(|t| t.id).filter(|_| !self.overview_shown);
        if let Some(tab) = front.filter(|t| self.choosing(*t)) {
            self.show_main_window();
            self.to_connect_page(tab, json!({ "type": "addAgent" }));
            return;
        }
        if let Some(tab) = self.new_tab() {
            if let Some(t) = self.tab_mut(tab) {
                t.add_agent_on_load = true;
            }
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
    /// Terminal or a probe) and hand what it returns to the tab's connect page.
    fn in_background(&self, tab: TabId, work: impl FnOnce() -> serde_json::Value + Send + 'static) {
        let send = self.page_sender(tab);
        std::thread::spawn(move || send(work()));
    }

    /// Hands a message to a tab's connect page from another thread
    /// (UserEvent::ToConnectPage).
    fn page_sender(&self, tab: TabId) -> impl Fn(serde_json::Value) + Send + 'static {
        let proxy = self.proxy.clone();
        move |msg| {
            let _ = proxy.send_event(UserEvent::ToConnectPage { tab, msg });
        }
    }

    fn send_init(&mut self, tab: TabId) {
        let starting = self.start_running(tab);
        let servers = self.config.servers.clone();
        let auto_connect = self.config.auto_connect;
        let start_fullscreen = self.config.start_fullscreen;
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        let notice = t.notice.take();
        let add_agent = std::mem::take(&mut t.add_agent_on_load);
        let (target, connect_now) = match t.connect_to.take() {
            Some((url, now)) => (Some(url), now),
            None => (None, false),
        };
        self.to_connect_page(
            tab,
            json!({
                "type": "init",
                "servers": servers,
                "autoConnect": auto_connect,
                "startFullscreen": start_fullscreen,
                "version": VERSION,
                "starting": starting,
                "notice": notice,
                "addAgent": add_agent,
                "target": target,
                "connectNow": connect_now,
            }),
        );
    }

    /// Whether a tab's connect page is up with no server chosen: the only
    /// time it may run anything.
    fn choosing(&self, tab: TabId) -> bool {
        self.tab(tab)
            .is_some_and(|t| matches!(*t.phase.borrow(), Phase::Connect) && t.connect.is_some())
    }

    /// Whether a Start Codeman run is going whose result the tab's page will get.
    fn start_running(&self, tab: TabId) -> bool {
        self.tab(tab)
            .is_some_and(|t| t.starting_server.is_some() && t.starting_server == Some(t.start_generation))
    }

    /// Why this tab cannot open `url` while the other tabs are as they are:
    /// another tab has it already (that tab), or, before macOS 14, a server on
    /// the same machine is open in another tab (a message).
    fn conflict(&self, tab: TabId, url: &Url) -> Option<Result<TabId, &'static str>> {
        let others = self.tabs.iter().filter(|t| t.id != tab);
        for other in others {
            if other.shown_url().as_ref() == Some(url) {
                return Some(Ok(other.id));
            }
            // Only a server another tab has reached or is loading shares the
            // cookie: a tab opened again at launch that has not connected
            // yet must not keep this one from connecting, or two of them
            // would keep each other out for good.
            let live = other.phase.borrow().server().cloned();
            if !own_stores() && live.is_some_and(|theirs| tabs::same_host(&theirs, url)) {
                return Some(Err(SAME_HOST_NEEDS_MACOS_14));
            }
        }
        None
    }

    /// Whether `tab` must not open `url` (`conflict`), having dealt with it:
    /// one tab per server, so the tab that has it comes to the front (a new
    /// tab with nothing in it gives way), or the page says why not.
    fn refuse_conflict(&mut self, tab: TabId, url: &Url) -> bool {
        match self.conflict(tab, url) {
            Some(Ok(other)) => {
                let blank = self.tab(tab).is_some_and(|t| t.home.is_none());
                self.select_tab_id(other);
                if blank {
                    self.close_tab(tab);
                } else {
                    self.to_connect_page(tab, json!({ "type": "error", "message": ALREADY_OPEN }));
                }
                true
            }
            Some(Err(message)) => {
                self.to_connect_page(tab, json!({ "type": "error", "message": message }));
                true
            }
            None => false,
        }
    }

    fn start_probe(
        &mut self,
        tab: TabId,
        raw: String,
        username: Option<String>,
        password: Option<String>,
        remember: bool,
    ) {
        let url = match policy::normalize_server_url(&raw) {
            Ok(u) => u,
            Err(message) => {
                self.to_connect_page(tab, json!({ "type": "error", "message": message }));
                return;
            }
        };
        if self.refuse_conflict(tab, &url) {
            return;
        }
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

        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        t.probe_generation += 1;
        let generation = t.probe_generation;
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
                tab,
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
        let current = self
            .tab(done.tab)
            .is_some_and(|t| t.probe_generation == done.generation);
        if !current || !self.choosing(done.tab) {
            // Cancelled, superseded, the tab closed, or a server is already
            // loading. What the worker did to the Keychain stands all the
            // same, so an entry whose password it deleted stops claiming one.
            self.note_deleted_passwords(&key, &done.deleted);
            return;
        }
        let tab = done.tab;
        match done.result {
            ProbeResult::SavedPasswordUnreadable => {
                // needsPassword: the page shows the login fields, which the
                // This Mac tab does not have.
                self.to_connect_page(
                    tab,
                    json!({ "type": "error", "message": KEYCHAIN_UNREADABLE, "needsPassword": true }),
                );
            }
            ProbeResult::Probed(ProbeOutcome::Ok { .. } | ProbeOutcome::PasswordChangeRequired)
                if self.refuse_conflict(tab, &done.url) =>
            {
                // Another tab got to the same server (or, before macOS 14, the
                // same machine) while this probe was out.
                self.note_deleted_passwords(&key, &done.deleted);
            }
            ProbeResult::Probed(outcome @ (ProbeOutcome::Ok { .. } | ProbeOutcome::PasswordChangeRequired)) => {
                let password_change = outcome == ProbeOutcome::PasswordChangeRequired;
                let (opening, saved, version) = match outcome {
                    ProbeOutcome::Ok { version } => (
                        json!({ "type": "opening", "version": version }),
                        done.saved,
                        Some(version),
                    ),
                    // The worker already deleted the one-time password and any
                    // older one saved for the account (update_keychain).
                    _ => (
                        json!({ "type": "opening", "version": null, "passwordChange": true }),
                        false,
                        None,
                    ),
                };
                let orphans = self.config.remember(&key, done.username.as_deref(), saved);
                self.delete_accounts(&orphans);
                self.config_dirty = true;
                if let Some(t) = self.tab_mut(tab) {
                    t.version = version;
                    t.status_login = !password_change;
                }
                self.to_connect_page(tab, opening);
                self.begin_loading(tab, done.url, done.username, done.password);
            }
            ProbeResult::Probed(outcome) => {
                let can_start = outcome == ProbeOutcome::Refused && policy::can_start_locally(&done.url);
                self.to_connect_page(
                    tab,
                    json!({
                        "type": "probeResult",
                        "url": done.url.as_str(),
                        "outcome": outcome,
                        "canStart": can_start,
                    }),
                );
            }
        }
    }

    /// Point a tab at the server: a server view of its own data store is built
    /// hidden behind the connect page, the server's cookies are cleared from
    /// that store first (an earlier login's session cookie, another user, a
    /// Forget, a password changed since, would win over this login's
    /// Authorization header, since Codeman checks the cookie first), and the
    /// load starts once the clear is done (UserEvent::CookiesCleared). The
    /// connect page stays in front until the server page commits;
    /// on_events_cleared gives up after LOAD_TIMEOUT, which counts from here,
    /// so it covers the clear too.
    fn begin_loading(&mut self, tab: TabId, url: Url, username: Option<String>, password: Option<String>) {
        let store = self.config.store_for(url.as_str());
        let Some(phase) = self.tab(tab).map(|t| t.phase.clone()) else {
            return;
        };
        // Before the view is built and loads: the navigation handler allows
        // the server's origin only once the phase names it.
        *phase.borrow_mut() = Phase::Loading(url.clone());
        let view = self.build_child(Part::Server, tab, Some(phase), Load::Nothing, store);
        let auth = basic_auth(username.as_deref(), password.as_deref());
        let proxy = self.proxy.clone();
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        t.server = view;
        t.store = store;
        t.auth = auth;
        t.loading_deadline = Some(Instant::now() + LOAD_TIMEOUT);
        let generation = t.probe_generation;
        // Set before the load: its first response may already be a challenge.
        self.set_login(tab, username.zip(password).map(|(u, p)| (&url, u, p)));
        self.tabs_changed();
        clear_cookies_then_load(&proxy, tab, generation, url, store);
    }

    /// Hand the challenge handler a tab's new login, as (server, username,
    /// password), or none, and start a new login generation for the tab, so a
    /// recheck or a status read of the one before it is ignored when it comes
    /// back.
    fn set_login(&mut self, tab: TabId, login: Option<(&Url, String, String)>) {
        set_challenge_login(
            tab,
            login.as_ref().map(|(server, u, p)| (*server, u.as_str(), p.as_str())),
        );
        if let Some(t) = self.tab_mut(tab) {
            t.login = login.map(|(_, u, p)| (u, p));
            t.login_generation += 1;
        }
    }

    fn start_server(&mut self, tab: TabId, raw: String) {
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        if let Some(running) = t.starting_server {
            // A start is still going, maybe one the page cancelled: its result
            // goes to the page that asked again.
            t.start_generation = running;
            self.to_connect_page(tab, json!({ "type": "serverStarting" }));
            return;
        }
        let url = match policy::normalize_server_url(&raw) {
            Ok(u) if policy::can_start_locally(&u) => u,
            Ok(_) => {
                self.to_connect_page(tab, json!({ "type": "error", "message": START_REFUSED }));
                return;
            }
            Err(message) => {
                self.to_connect_page(tab, json!({ "type": "error", "message": message }));
                return;
            }
        };
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        t.start_generation += 1;
        let generation = t.start_generation;
        t.starting_server = Some(generation);
        self.to_connect_page(tab, json!({ "type": "serverStarting" }));
        let proxy = self.proxy.clone();
        std::thread::spawn(move || {
            let result = setup::start_local(&url);
            let _ = proxy.send_event(UserEvent::ServerStartDone {
                tab,
                generation,
                url,
                result,
            });
        });
    }

    /// Leave whatever a tab shows for its connect page: Connect This Tab to
    /// Another Server, a load that failed or was cancelled, or a refused
    /// login. `notice` is shown by that page once it asks for its init.
    ///
    /// `front` is for what the user just did (the menu item, Cancel): the tab
    /// comes forward and takes the keyboard. A timeout or a refused login can
    /// happen while the user works elsewhere, so then the tab stays where it
    /// is and the Dock icon bounces once instead, unless the window is the one
    /// in use.
    fn show_connect_page(&mut self, tab: TabId, notice: Option<String>, front: bool) {
        self.close_popouts_of(tab);
        self.set_login(tab, None);
        let needs_view = self.tab(tab).is_some_and(|t| t.connect.is_none());
        let phase = self.tab(tab).map(|t| t.phase.clone());
        let Some(phase) = phase else {
            return;
        };
        // Before the load: the navigation handler allows the connect page
        // only while the phase says it is live.
        *phase.borrow_mut() = Phase::Connect;
        let built = needs_view
            .then(|| {
                self.build_child(
                    Part::Connect,
                    tab,
                    Some(phase),
                    Load::ConnectPage { manual: true },
                    None,
                )
            })
            .flatten();
        let Some(t) = self.tab_mut(tab) else {
            return;
        };
        t.probe_generation += 1;
        t.loading_deadline = None;
        t.auth = None;
        t.notice = notice;
        t.connect_to = None;
        t.server = None;
        t.watch = None;
        t.seen = tabs::Seen::default();
        t.page_title = None;
        match built {
            Some(view) => t.connect = Some(view),
            None => {
                if let Some(connect) = &t.connect {
                    let _ = connect.webview.load_url(&connect_page_url(true));
                }
            }
        }
        if front {
            self.select_tab_id(tab);
            self.show_main_window();
        } else {
            let in_front = self.active_tab().is_some_and(|t| t.id == tab);
            self.show_front(in_front && self.main_window.is_focused());
            if !self.main_window.is_focused() || self.main_window.is_minimized() {
                self.main_window
                    .request_user_attention(Some(UserAttentionType::Informational));
            }
        }
        self.save_tabs();
        self.sync_logo_watch();
        self.sync_keep_awake();
    }

    fn show_main_window(&self) {
        let w = &self.main_window;
        w.set_minimized(false);
        w.set_visible(true);
        w.set_focus();
    }

    /// The URL a server view or pop-out reloads, handed to wry as is, and
    /// whether the login goes with it. A tab's server view: its committed page
    /// if that is Codeman's own app shell, else the server root (a raw file
    /// that replaced the page, for example). A pop-out: its committed page, or
    /// the URL it was opened with when nothing committed yet. The login goes
    /// only below the server's base path.
    fn reload_target(&self, view: ViewId) -> Option<(String, bool)> {
        let (tab, target) = match self.owner(view)? {
            Owner::Server(tab) => {
                let t = self.tab(tab)?;
                let server = t.phase.borrow().loaded().cloned()?;
                let committed = t.server.as_ref()?.committed.clone();
                let target = match committed {
                    Some(current) if policy::trusted_frame(&current, &server) => current,
                    _ => server,
                };
                (tab, target)
            }
            Owner::Popout(window, tab) => {
                let p = self.popouts.get(&window)?;
                let target = p.committed.clone().or_else(|| Url::parse(&p.opened_url).ok())?;
                (tab, target)
            }
            _ => return None,
        };
        let server = self.tab(tab)?.phase.borrow().loaded().cloned()?;
        let with_auth = policy::within_base(&target, &server);
        Some((policy::webkit_safe_url(&target), with_auth))
    }

    /// Load `url` in `view`, with its tab's login when `with_auth` and there
    /// is one.
    fn load_in(&self, view: ViewId, url: &str, with_auth: bool) {
        let tab = match self.owner(view) {
            Some(Owner::Server(tab) | Owner::Popout(_, tab) | Owner::Connect(tab)) => tab,
            _ => return,
        };
        let Some(webview) = self.webview(view) else {
            return;
        };
        let auth = self.tab(tab).and_then(|t| t.auth.clone()).filter(|_| with_auth);
        let result = match auth {
            Some(auth) => webview.load_url_with_headers(url, auth_headers(&auth)),
            None => webview.load_url(url),
        };
        if let Err(e) = result {
            eprintln!("codeman-desktop: could not load a page: {e}");
        }
    }

    /// Reload: the pop-out in use, or the tab in front. A tab that has not
    /// reached its server yet starts over on its connect page.
    fn reload_focused(&mut self) {
        if let Some(window) = self.focused_popout() {
            let view = self.popouts.get(&window).map(|p| p.view);
            if let Some((view, (url, with_auth))) = view.and_then(|v| self.reload_target(v).map(|r| (v, r))) {
                self.load_in(view, &url, with_auth);
            }
            return;
        }
        if !self.main_window.is_focused() {
            return;
        }
        if self.overview_shown {
            if let Some(o) = &self.overview {
                let _ = o.webview.load_url(policy::OVERVIEW_PAGE);
            }
            return;
        }
        let Some(t) = self.active_tab() else {
            return;
        };
        let tab = t.id;
        let server_view = t
            .server
            .as_ref()
            .map(|v| v.id)
            .filter(|_| t.kind() == tabs::Kind::Server);
        match server_view {
            Some(view) => {
                if let Some((url, with_auth)) = self.reload_target(view) {
                    self.load_in(view, &url, with_auth);
                }
            }
            None => self.show_connect_page(tab, None, true),
        }
    }

    /// The page in `view` got a 401 from its own server (the HOST_SHIM
    /// fallback for when the challenge handler did not recover it): reload it
    /// once with the login, never again within SESSION_RELOAD_COOLDOWN.
    fn on_session_expired(&mut self, view: ViewId, tab: TabId) {
        if self.tab(tab).is_none_or(|t| t.auth.is_none()) {
            return;
        }
        let now = Instant::now();
        let recent =
            |at: Option<Instant>| at.is_some_and(|at| now.saturating_duration_since(at) < SESSION_RELOAD_COOLDOWN);
        let last = match self.owner(view) {
            Some(Owner::Server(_)) => self.child_view_mut(view).map(|v| v.session_reload_at),
            Some(Owner::Popout(window, _)) => self.popouts.get(&window).map(|p| p.session_reload_at),
            _ => None,
        };
        let Some(last) = last else {
            return;
        };
        if recent(last) {
            return;
        }
        let Some((url, true)) = self.reload_target(view) else {
            return;
        };
        match self.owner(view) {
            Some(Owner::Server(_)) => {
                if let Some(v) = self.child_view_mut(view) {
                    v.session_reload_at = Some(now);
                }
            }
            Some(Owner::Popout(window, _)) => {
                if let Some(p) = self.popouts.get_mut(&window) {
                    p.session_reload_at = Some(now);
                }
            }
            _ => {}
        }
        self.load_in(view, &url, true);
    }

    /// Open one of Codeman's pop-out pages of a tab's server in an app window.
    /// False when it did not open: the pop-out limit, no server loaded, a URL
    /// that is not a pop-out page, or a window or web view that failed to
    /// build. `focused`: the window takes the keyboard; otherwise it comes to
    /// the front without it.
    fn build_popout(
        &mut self,
        target: &EventLoopWindowTarget<UserEvent>,
        tab: TabId,
        url: &Url,
        focused: bool,
    ) -> bool {
        let Some(t) = self.tab(tab) else {
            return false;
        };
        let Some(server) = t.phase.borrow().loaded().cloned() else {
            return false;
        };
        // The callers only pass what policy::new_window made an AppWindow;
        // checked again here, where the window is built, so no other path
        // can ever open a proxied dashboard or another page top-level.
        if !policy::is_popout_target(url, &server) {
            return false;
        }
        let popouts = self.popouts.len();
        if popouts >= MAX_POPOUTS {
            return false;
        }
        let phase = t.phase.clone();
        let store = t.store;
        let opened_url = policy::webkit_safe_url(url);
        let auth = t.auth.clone().filter(|_| policy::within_base(url, &server));
        // tao centres a window that is given no position, so every pop-out
        // would open exactly on top of the one before. Each one steps off the
        // window in use instead.
        let anchor = self
            .focused_popout()
            .and_then(|w| self.popouts.get(&w))
            .map(|p| &p.window)
            .unwrap_or(&self.main_window);
        let position = placed_position(anchor).ok().map(|p| {
            let p = p.to_logical::<f64>(anchor.scale_factor());
            let step = POPOUT_STEP * (1 + popouts % 8) as f64;
            LogicalPosition::new(p.x + step, p.y + step)
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
        let view = self.next_view_id();
        let spec = ViewSpec {
            id: view,
            part: Part::Popout,
            tab,
            phase: Some(phase),
            load: Load::Server {
                url: &opened_url,
                auth: auth.as_deref(),
            },
            store,
            bounds: None,
            visible: true,
            focused,
        };
        let webview = match build_webview(&window, spec, &self.proxy) {
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
        self.popouts.insert(
            window.id(),
            Popout {
                webview,
                window,
                view,
                tab,
                opened_url,
                hidden_for_download: false,
                committed: None,
                session_reload_at: None,
                gone_at: None,
            },
        );
        true
    }

    /// Tell the page in `view` that the window it asked for through
    /// CodemanHost.openWindow was not opened (assets::refused_script), with
    /// the session id when that was a session pop-out, so the dashboard takes
    /// the session's tab back. Only for that request, which parse_ipc takes
    /// from Codeman's own app shell alone.
    fn tell_refused(&self, view: ViewId, session_id: Option<&str>) {
        if let Some(webview) = self.webview(view) {
            let _ = webview.evaluate_script(&assets::refused_script(session_id));
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

    /// Close a pop-out and forget its downloads.
    fn remove_popout(&mut self, window: WindowId) {
        if let Some(p) = self.popouts.remove(&window) {
            self.downloads.retain(|(view, _), _| *view != p.view);
        }
    }

    /// The pop-out that is key, if one is.
    fn focused_popout(&self) -> Option<WindowId> {
        self.popouts
            .iter()
            .find(|(_, p)| p.window.is_focused())
            .map(|(id, _)| *id)
    }

    /// Message a tab's connect page (only while it is that tab's live page).
    fn to_connect_page(&self, tab: TabId, msg: serde_json::Value) {
        let Some(t) = self.tab(tab) else {
            return;
        };
        if !t.phase.borrow().connect_page_live() {
            return;
        }
        if let Some(connect) = &t.connect {
            let _ = connect
                .webview
                .evaluate_script(&assets::native_message_script("__codemanDesktop", &msg));
        }
    }

    fn to_every_connect_page(&self, msg: serde_json::Value) {
        for t in &self.tabs {
            self.to_connect_page(t.id, msg.clone());
        }
    }

    fn record_main_frame(&mut self) {
        let w = &self.main_window;
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
            // The content size in points, which (under the transparent title
            // bar) is the whole window, and is what `with_inner_size` takes
            // back at the next launch.
            let (width, height) = content_size(w);
            frame.width = width;
            frame.height = height;
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
