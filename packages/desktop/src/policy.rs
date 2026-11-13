//! Every decision the window makes about URLs and messages, as pure functions.
//!
//! Nothing here touches the UI, the network or the disk, so the whole module is
//! unit-tested on its own. That matters more than usual here: the frames inside
//! the window can show content Codeman did not write (a rendered HTML file, a
//! proxied dashboard), and these functions are what keeps that content from
//! steering the app.

use std::net::Ipv4Addr;
use std::time::Instant;

use base64::Engine as _;
use serde::Deserialize;
use url::{Host, Position, Url};

/// The custom scheme the bundled connect page is served from.
pub const APP_SCHEME: &str = "codemanapp";
/// The connect page itself (wry serves custom schemes as `<scheme>://localhost/`).
pub const CONNECT_PAGE: &str = "codemanapp://localhost/index.html";

/// Caps on what a page may hand the native side.
pub const MAX_URL_LEN: usize = 4096;
pub const MAX_FIELD_LEN: usize = 1024;
const MAX_MESSAGE_LEN: usize = 16 * 1024;

/// Where the main window is in reaching a server. The gates below take it
/// instead of "is a server set", because what may talk to the native side
/// changes when a server page COMMITS, not when the user picks a server: until
/// the load commits, the connect page is still the live document, and it has
/// to stay usable if the load never arrives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Phase {
    /// The connect page shows and no server is chosen.
    Connect,
    /// The server's URL was handed to the main web view but has not committed
    /// yet; the connect page is still the live document.
    Loading(Url),
    /// A server page committed in the main window.
    Loaded(Url),
}

impl Phase {
    /// The chosen server, loading or loaded.
    pub fn server(&self) -> Option<&Url> {
        match self {
            Phase::Connect => None,
            Phase::Loading(url) | Phase::Loaded(url) => Some(url),
        }
    }

    /// The server whose page is the main window's document.
    pub fn loaded(&self) -> Option<&Url> {
        match self {
            Phase::Loaded(url) => Some(url),
            _ => None,
        }
    }

    /// Whether the connect page is still the main window's document.
    pub fn connect_page_live(&self) -> bool {
        matches!(self, Phase::Connect | Phase::Loading(_))
    }
}

/// The phase a commit of `committed` in the main window moves to: Loaded once
/// a page from the server that is loading is the document.
pub fn loaded_on_commit(phase: &Phase, committed: &str) -> Option<Phase> {
    let Phase::Loading(server) = phase else {
        return None;
    };
    let url = Url::parse(committed).ok()?;
    same_origin(&url, server).then(|| Phase::Loaded(server.clone()))
}

/// Turn what the user typed into a server URL: scheme added when missing,
/// query and fragment dropped, and the path ending in `/` so `api/status`
/// joins below a base path. The scheme is `https` for a tailnet `.ts.net`
/// name on its own, which is `tailscale serve`, and `http` otherwise. A
/// `.ts.net` name with a port is Codeman's own listener, which speaks plain
/// http: guessing https there ended in a TLS error with no way forward, while
/// the other mistake (http to an https port) gets a button for the https
/// address (ProbeOutcome::MaybeHttps).
pub fn normalize_server_url(input: &str) -> Result<Url, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Enter the address of your Codeman server.".into());
    }
    if s.len() > MAX_URL_LEN {
        return Err("That address is too long.".into());
    }
    let with_scheme = if s.contains("://") {
        s.to_string()
    } else {
        let (host, rest) = s.split_at(s.find(['/', ':']).unwrap_or(s.len()));
        let scheme = if host.to_ascii_lowercase().ends_with(".ts.net") && !rest.starts_with(':') {
            "https"
        } else {
            "http"
        };
        format!("{scheme}://{s}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|e| format!("That address is not valid ({e})."))?;
    match url.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Use an http:// or https:// address, not {other}://.")),
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("That address has no host name.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Put the username and password in their own fields, not in the address.".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// Same scheme, host and port (the browser's notion of an origin).
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Whether `url` lies below the server's base path on the server's origin. The
/// Basic `Authorization` header goes only to such URLs, so another app sharing
/// the origin (`/grafana/` next to `/codeman/`) never receives the password.
/// `server.path()` always ends in `/` (normalize_server_url), so `/codemanx/`
/// is not below `/codeman/`. The part below the base is decoded once, as
/// is_popout_target does, and may hold no `.` or `..` segment: the url crate
/// resolves a literal `..`, but `..%2Fgrafana/` reaches a proxy that decodes
/// before it routes as a way out of the base. A path that does not decode is
/// not below it either (fail closed).
pub fn within_base(url: &Url, server: &Url) -> bool {
    same_origin(url, server)
        && below_base_decoded(url, server)
            .is_some_and(|rest| !rest.split(['/', '\\']).any(|segment| segment == "." || segment == ".."))
}

/// A server on this machine: `localhost`, `127.0.0.0/8` or `::1`.
pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Whether the app may offer to start Codeman for this address: plain HTTP to
/// `localhost` or `127.0.0.1`. `codeman web -d` binds 127.0.0.1 (start_args
/// passes no `--host`, because Codeman's hooks call the server at 127.0.0.1),
/// so for another loopback address (`::1`, `127.0.0.2`) the start would
/// succeed and the window still could not reach it. An `https://` loopback
/// server would carry Codeman's self-signed certificate, which the web view
/// refuses, so starting one would only lead to a second failure.
pub fn can_start_locally(url: &Url) -> bool {
    url.scheme() == "http"
        && is_loopback(url)
        && match url.host() {
            Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
            Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
            _ => false,
        }
}

/// The `codeman web` arguments that start a server answering at `url`.
pub fn start_args(url: &Url) -> Vec<String> {
    let port = url.port_or_known_default().unwrap_or(80);
    let mut args = vec![
        "web".to_string(),
        "-d".to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    let path = url.path().trim_end_matches('/');
    if !path.is_empty() {
        args.push("--base-url".into());
        args.push(path.to_string());
    }
    args
}

/// Whether a frame runs Codeman's own app shell, the only page allowed to use
/// `window.CodemanHost`: the dashboard (the base path itself or `index.html`)
/// and a session pop-out (`session/<id>`). An allowlist, so rendered HTML
/// files (`html-view/`), proxied dashboards (`webview/`) and any route Codeman
/// adds later stay out. The raw path must hold no `%` at all: the server routes
/// the DECODED path while this compares the raw one, so `/%68tml-view/`
/// reaches the html-view route while reading as some other path here.
pub fn trusted_frame(frame: &Url, server: &Url) -> bool {
    if !same_origin(frame, server) || frame.path().contains('%') {
        return false;
    }
    match frame.path().strip_prefix(server.path()) {
        Some("" | "index.html") => true,
        Some(rest) => rest
            .strip_prefix("session/")
            .is_some_and(|id| !id.is_empty() && !id.contains('/')),
        None => false,
    }
}

/// Whether a same-origin URL is one of the pages Codeman's frontend opens in a
/// window of its own, and so may become an app window: a session pop-out
/// (`session/<id>`), a rendered HTML file (`html-view/...`, served with a
/// sandbox CSP), a detached file preview or attachment (`api/sessions/<id>/`
/// `file-raw`, `file-preview`, `attachments/<id>/raw|preview`,
/// `folders/<id>/files/...`, and the path picker's `api/filesystem/preview`)
/// and a download (`api/download`). A script's `window.open` gets only the
/// last two kinds (new_window, Via::Script).
///
/// Everything else on the origin is refused, a proxied dashboard under
/// `webview/` above all. A browser keeps the opener frame's sandbox on a popup;
/// a fresh web view does not, so a dashboard opened here would run top-level as
/// Codeman's origin, cookie and all. The server's router matches the decoded
/// path, so the part below the base is decoded once, and anything a second
/// decoding or a path normalizer could still turn into another route (a `%`
/// left over, `.` or `..` segments, a backslash, NUL, userinfo) fails closed.
pub fn is_popout_target(url: &Url, server: &Url) -> bool {
    popout_kind(url, server).is_some()
}

/// The session id of a session pop-out (`session/<id>`), or None for any other
/// URL, a pop-out target of another kind included. Read through
/// is_popout_target's own classification, so it is Some exactly when that
/// accepts the URL as a session page. The id is decoded once, the form the
/// server's router hands the session route: `session/a%62c` and
/// `%73ession/abc` both give `abc`. Codeman opens pop-outs as
/// `session/<encodeURIComponent(id)>`, so this is the id its dashboard knows.
pub fn session_id_of(url: &Url, server: &Url) -> Option<String> {
    match popout_kind(url, server)? {
        Popout::Session(id) => Some(id),
        Popout::HtmlView | Popout::File => None,
    }
}

/// The kinds of page is_popout_target accepts. new_window tells them apart
/// by who asked (Via), session_id_of reads the session id.
#[derive(Debug, PartialEq, Eq)]
enum Popout {
    /// `session/<id>`, the id decoded once.
    Session(String),
    /// `html-view/...`: a rendered HTML file.
    HtmlView,
    /// A detached file preview, an attachment, a file in a granted folder,
    /// the path picker's preview, or a download (`api/download`).
    File,
}

/// is_popout_target, saying which kind of page it found.
fn popout_kind(url: &Url, server: &Url) -> Option<Popout> {
    if !same_origin(url, server) || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let rest = below_base_decoded(url, server)?;
    if rest.contains(['%', '\\', '\0']) {
        return None;
    }
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.iter().any(|s| *s == "." || *s == "..") {
        return None;
    }
    if let Some(tail) = rest.strip_prefix("html-view/") {
        return (!tail.is_empty()).then_some(Popout::HtmlView);
    }
    match segments.as_slice() {
        ["session", id] if !id.is_empty() => Some(Popout::Session((*id).to_string())),
        ["api", "download"] | ["api", "filesystem", "preview"] => Some(Popout::File),
        ["api", "sessions", id, "file-raw" | "file-preview"] if !id.is_empty() => Some(Popout::File),
        ["api", "sessions", id, "attachments", attachment, "raw" | "preview"]
            if !id.is_empty() && !attachment.is_empty() =>
        {
            Some(Popout::File)
        }
        ["api", "sessions", id, "folders", folder, "files", name, "raw" | "preview"]
            if !id.is_empty() && !folder.is_empty() && !name.is_empty() =>
        {
            Some(Popout::File)
        }
        _ => None,
    }
}

/// The part of `url`'s path below the server's base path, percent-decoded once
/// (the way the server's router sees it). None when the raw path is not below
/// the base, or does not decode. The base is matched on the RAW path, as the
/// server's own base-path strip does, so `/%63odeman/` is not below `/codeman/`.
fn below_base_decoded(url: &Url, server: &Url) -> Option<String> {
    percent_decode_once(url.path().strip_prefix(server.path())?)
}

/// Whether a Basic challenge whose 401 came from `failed` (the failure
/// response's URL) is Codeman's own login, the only one the app answers with
/// the saved password and the only one whose refusal sends the user back to
/// the connect screen. It has to lie below the base path on the server's
/// origin (within_base), which keeps another app on the same origin from ever
/// seeing the password, and it must not be on one of the two routes where a
/// 401 says nothing about the saved login:
///
/// - `webview/` relays a proxied dashboard's status and headers,
///   `WWW-Authenticate` included, so a Basic-protected dashboard would
///   otherwise be answered with Codeman's login and, when it refuses that,
///   read as Codeman refusing it.
/// - `html-view/` serves an agent-written page that runs in an opaque origin
///   with its capability as its only credential, so a 401 there is a dead
///   capability, never a reason to send the password.
///
/// The part below the base is decoded once with the decoder is_popout_target
/// uses, as the server's router sees it, so `%77ebview/` counts as `webview/`;
/// a path that does not decode is not ours (fail closed: WebKit's default
/// handling, never the password). What this cannot see: a dashboard asset
/// requested by a ROOT-ABSOLUTE URL (`fetch('/api/data')`), which Codeman
/// relays to the dashboard by its `Referer`, carries no `webview/` in its path,
/// so its 401 reads as in scope here.
pub fn challenge_in_scope(failed: &Url, server: &Url) -> bool {
    if !within_base(failed, server) {
        return false;
    }
    below_base_decoded(failed, server)
        .is_some_and(|rest| !rest.starts_with("webview/") && !rest.starts_with("html-view/"))
}

/// Decode `%XX` escapes once. None for a `%` that starts no escape, or for
/// bytes that are not UTF-8 (fail closed: no Codeman route needs either).
fn percent_decode_once(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = hex_value(*bytes.get(i + 1)?)?;
            let lo = hex_value(*bytes.get(i + 2)?)?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// `url` as a string NSURL accepts on every macOS the app supports. Before
/// macOS 14, `URLWithString:` parses by the old RFCs and returns nil for
/// characters the WHATWG serializer leaves raw (`| ^ [ ]` in a path, `{ }` and
/// more in a query), and wry unwraps that nil, which aborts the app. Those are
/// percent-encoded in the path, query and fragment only, never in the scheme,
/// host or port (an IPv6 literal keeps its brackets). Existing `%XX` escapes
/// stay as they are, and a `%` that starts none becomes `%25`. The first `#`
/// starts the fragment; a second one becomes `%23`.
pub fn webkit_safe_url(url: &Url) -> String {
    let head = &url[..Position::BeforePath];
    let tail = &url[Position::BeforePath..];
    let bytes = tail.as_bytes();
    let mut out = String::with_capacity(url.as_str().len() + 16);
    out.push_str(head);
    let mut in_fragment = false;
    for (i, c) in tail.char_indices() {
        let encode = match c {
            '#' if !in_fragment => {
                in_fragment = true;
                false
            }
            '%' => !(bytes.len() > i + 2 && bytes[i + 1].is_ascii_hexdigit() && bytes[i + 2].is_ascii_hexdigit()),
            ' ' | '"' | '<' | '>' | '\\' | '^' | '`' | '{' | '|' | '}' | '[' | ']' | '#' => true,
            _ => false,
        };
        if encode {
            // Every character in the set above is ASCII.
            let b = c as u8;
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            out.push('%');
            out.push(HEX[usize::from(b >> 4)] as char);
            out.push(HEX[usize::from(b & 0x0f)] as char);
        } else {
            out.push(c);
        }
    }
    out
}

/// How often the app hands a page to the default browser without the user
/// asking each time: a burst of 3, then one a second. macOS lets a page call
/// `window.open` without a click, so without a budget one script could fill
/// the browser with tabs. Openings over budget are dropped, never queued.
/// main.rs keeps a separate one of these for the app windows a script opens
/// (new_window with Via::Script), so a frame looping `window.open` on a file
/// route cannot stack windows either, and cannot use up this budget, which the
/// user's own link clicks draw on.
#[derive(Debug, Clone)]
pub struct OpenBudget {
    tokens: f64,
    last: Option<Instant>,
}

const OPEN_BURST: f64 = 3.0;
const OPEN_REFILL_PER_SEC: f64 = 1.0;

impl OpenBudget {
    pub fn new() -> Self {
        OpenBudget {
            tokens: OPEN_BURST,
            last: None,
        }
    }

    /// Spend one opening at `now` if the budget has one. The caller passes the
    /// clock, so this stays pure; a `now` earlier than the last call refills
    /// nothing.
    pub fn allow(&mut self, now: Instant) -> bool {
        if let Some(last) = self.last {
            let elapsed = now.saturating_duration_since(last).as_secs_f64();
            self.tokens = (self.tokens + elapsed * OPEN_REFILL_PER_SEC).min(OPEN_BURST);
        }
        if self.last.is_none_or(|last| now > last) {
            self.last = Some(now);
        }
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

impl Default for OpenBudget {
    fn default() -> Self {
        Self::new()
    }
}

/// What a window does once its web content process has ended: a crash, or the
/// system taking the process back under memory pressure. The window is blank
/// from then on, since nothing reloads it by itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recovery {
    /// Load the window's page again.
    Reload,
    /// Show the connect page: with the reason, when a server page was given up.
    ConnectPage { gave_up: bool },
    /// Close the pop-out.
    Close,
    /// Leave the window as it is.
    Nothing,
}

/// How a window recovers from the end of its web content process. `on_server`:
/// a server page is the main window's document (pop-outs only exist then).
/// `again`: the same window lost its process a moment ago already, so its page
/// cannot stay up and loading it once more would only repeat that.
pub fn recovery(is_main: bool, on_server: bool, again: bool) -> Recovery {
    match (is_main, on_server, again) {
        (_, true, false) => Recovery::Reload,
        (true, true, true) => Recovery::ConnectPage { gave_up: true },
        // The connect page itself, or a server load that had not committed.
        (true, false, false) => Recovery::ConnectPage { gave_up: false },
        (true, false, true) => Recovery::Nothing,
        (false, _, true) => Recovery::Close,
        // A pop-out with no server page behind it is on its way out anyway.
        (false, false, false) => Recovery::Nothing,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    Allow,
    Block,
}

/// Whether a navigation may proceed. The handler sees every frame's
/// navigations (wry does not say which frame), so this has to be safe for an
/// iframe too: anything off the server's origin is blocked, never opened in
/// the browser, or a page full of external iframes would spray browser tabs.
/// Real link clicks to other sites are routed out by the main-frame click
/// handler in the host shim instead.
///
/// The server's origin is allowed from the moment its load starts (the load
/// itself is such a navigation). The connect page is allowed until a server
/// page commits, so the app can abandon a load that never arrives and show the
/// connect page again; once a server page is the document, nothing on it can
/// pull the connect page into a frame.
pub fn navigation(target: &str, phase: &Phase) -> Navigation {
    let Ok(url) = Url::parse(target) else {
        return Navigation::Block;
    };
    match url.scheme() {
        "about" | "blob" | "data" => Navigation::Allow,
        s if s == APP_SCHEME => {
            if phase.connect_page_live() {
                Navigation::Allow
            } else {
                Navigation::Block
            }
        }
        "http" | "https" => match phase.server() {
            Some(srv) if same_origin(&url, srv) => Navigation::Allow,
            _ => Navigation::Block,
        },
        _ => Navigation::Block,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum NewWindow {
    /// One of Codeman's own pop-out pages that this path may open (see
    /// new_window): a full app window with every handler attached.
    AppWindow(Url),
    /// Another site: the default browser.
    External(Url),
    /// `window.open` returns null. Covers `window.open('')`/`about:blank`: the
    /// window WebKit would build for those carries none of the app's handlers,
    /// so a sandboxed frame could point it anywhere.
    Deny,
}

/// Who asked for a new window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// `window.open` or a `target=_blank` link, which WebKit hands the
    /// new-window handler from ANY frame without saying which: a rendered HTML
    /// file or a proxied dashboard can ask this way as easily as the dashboard.
    Script,
    /// `CodemanHost.openWindow`, which parse_ipc accepts only from a frame
    /// running Codeman's own app shell (trusted_frame).
    Host,
}

/// What to do with a request for a new window. Only a committed server page
/// opens anything (the connect page uses IPC for its links). Another origin
/// goes to the default browser. On the server's origin only pop-out targets
/// become app windows, and which ones depends on who asked:
///
/// - Via::Host: every pop-out target (is_popout_target).
/// - Via::Script: only the file and download routes, the pages Codeman itself
///   opens with `window.open`. Codeman opens session pop-outs and rendered
///   HTML files through `CodemanHost.openWindow` when it runs in the app, so a
///   script asking for `session/<id>` or `html-view/` is some other frame, and
///   gets nothing: a rendered HTML file could otherwise open copies of itself
///   as top-level windows, each passing for one of the app's own.
///
/// Every other same-origin URL is denied, never sent to the browser, where a
/// top-level `webview/<cap>/` load would escape the iframe sandbox just the
/// same.
pub fn new_window(target: &str, phase: &Phase, via: Via) -> NewWindow {
    if target.len() > MAX_URL_LEN {
        return NewWindow::Deny;
    }
    let Some(url) = external_url(target) else {
        return NewWindow::Deny;
    };
    let Some(srv) = phase.loaded() else {
        return NewWindow::Deny;
    };
    if !same_origin(&url, srv) {
        return NewWindow::External(url);
    }
    match (popout_kind(&url, srv), via) {
        (Some(Popout::File), _) | (Some(_), Via::Host) => NewWindow::AppWindow(url),
        _ => NewWindow::Deny,
    }
}

/// `Authorization` header value for HTTP Basic auth.
pub fn basic_auth_header(username: &str, password: &str) -> String {
    let raw = format!("{username}:{password}");
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(raw))
}

/// Calls the server's own page makes through `window.CodemanHost`.
#[derive(Debug, PartialEq, Eq)]
pub enum HostCmd {
    OpenWindow(String),
    CloseWindow,
    FocusWindow,
    /// A main-frame click on a link to another site.
    OpenExternal(String),
    /// The page got a 401 from its own server: the session cookie is gone (a
    /// server restart) and the page cannot recover on its own.
    SessionExpired,
}

/// Calls the bundled connect page makes.
#[derive(Debug, PartialEq, Eq)]
pub enum ConnectCmd {
    Ready,
    Connect {
        url: String,
        username: Option<String>,
        password: Option<String>,
        remember: bool,
    },
    Cancel,
    StartServer {
        url: String,
    },
    Forget {
        url: String,
    },
    SetAutoConnect(bool),
    SetStartFullscreen(bool),
    OpenExternal(String),
    /// Look at the Codeman on this Mac (setup::inspect): `quick` skips the
    /// login shell, `deep` also asks its interactive profile.
    LocalStatus {
        quick: bool,
        deep: bool,
    },
    /// Run the installer for this Mac in Terminal.
    InstallLocal {
        network: bool,
    },
    /// Fetch the installer and ask it what is on this Mac (gui_install).
    InstallPrepare,
    /// Run the graphical install. `network_password`: reachable from other
    /// devices, with this password. `ai_cli`: an id in the shape of the
    /// installer's catalogue, which checks it again.
    InstallStart {
        network_password: Option<String>,
        ai_cli: Option<String>,
    },
    /// Show the graphical install that is running already.
    InstallAttach,
    /// Stop whichever graphical run is going.
    InstallCancel,
    /// Fetch the installer to add a coding agent to a Mac that has Codeman.
    AgentPrepare,
    /// Add this agent: an id in the shape of the installer's catalogue.
    AgentStart {
        ai_cli: String,
    },
    /// Show the agent install that is running already.
    AgentAttach,
    /// Run the installer on another machine over SSH, in Terminal. `target`
    /// is what the user typed; terminal_install::SshTarget::parse checks it.
    InstallRemote {
        target: String,
    },
    /// Put the install one-liner on the clipboard.
    CopyInstallCommand,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Ipc {
    Host(HostCmd),
    Connect(ConnectCmd),
}

#[derive(Deserialize)]
#[serde(
    tag = "cmd",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum RawConnect {
    Ready,
    Connect {
        url: String,
        #[serde(default)]
        username: Option<String>,
        #[serde(default)]
        password: Option<String>,
        #[serde(default)]
        remember: bool,
    },
    Cancel,
    StartServer {
        url: String,
    },
    Forget {
        url: String,
    },
    SetAutoConnect {
        value: bool,
    },
    SetStartFullscreen {
        value: bool,
    },
    OpenExternal {
        url: String,
    },
    LocalStatus {
        #[serde(default)]
        quick: bool,
        #[serde(default)]
        deep: bool,
    },
    InstallLocal {
        #[serde(default)]
        network: bool,
    },
    InstallPrepare,
    InstallStart {
        #[serde(default)]
        network_password: Option<String>,
        #[serde(default)]
        ai_cli: Option<String>,
    },
    InstallAttach,
    InstallCancel,
    AgentPrepare,
    AgentStart {
        ai_cli: String,
    },
    AgentAttach,
    InstallRemote {
        target: String,
    },
    CopyInstallCommand,
}

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase", deny_unknown_fields)]
enum RawHost {
    OpenWindow { url: String },
    CloseWindow,
    FocusWindow,
    OpenExternal { url: String },
    SessionExpired,
}

/// The shape of a CLI catalogue id. It becomes one argument of `install.sh`,
/// so it could not be read as a flag even without this: it must start with a
/// letter.
fn is_cli_id(id: &str) -> bool {
    id.len() <= 32
        && id.starts_with(|c: char| c.is_ascii_lowercase())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn bounded(s: Option<String>, max: usize) -> Option<Option<String>> {
    match s {
        Some(v) if v.len() > max => None,
        other => Some(other),
    }
}

/// The bundled connect page's frame (assets.rs serves it at `/` and
/// `/index.html`; the query, such as `?manual=1`, does not matter).
fn is_connect_page(frame: &Url) -> bool {
    frame.scheme() == APP_SCHEME && frame.host_str() == Some("localhost") && matches!(frame.path(), "/" | "/index.html")
}

/// Parse and gate a message from a page. `frame_url` is the URL of the frame
/// that sent it (wry reports it from WebKit's frame info, so a page cannot
/// forge it), `is_main_window` whether it came from the main window.
///
/// - The connect page is listened to only in the main window and only while it
///   is still the live document (Connect, or Loading before the server page
///   commits).
/// - A server page is listened to only once it committed, and only from a
///   frame running Codeman's own app shell (trusted_frame).
pub fn parse_ipc(frame_url: &str, body: &str, phase: &Phase, is_main_window: bool) -> Option<Ipc> {
    if body.len() > MAX_MESSAGE_LEN {
        return None;
    }
    let frame = Url::parse(frame_url).ok()?;
    if frame.scheme() == APP_SCHEME {
        if !is_main_window || !phase.connect_page_live() || !is_connect_page(&frame) {
            return None;
        }
        let cmd = match serde_json::from_str::<RawConnect>(body).ok()? {
            RawConnect::Ready => ConnectCmd::Ready,
            RawConnect::Connect {
                url,
                username,
                password,
                remember,
            } if url.len() <= MAX_URL_LEN => ConnectCmd::Connect {
                url,
                username: bounded(username, MAX_FIELD_LEN)?,
                password: bounded(password, MAX_FIELD_LEN)?,
                remember,
            },
            RawConnect::Cancel => ConnectCmd::Cancel,
            RawConnect::StartServer { url } if url.len() <= MAX_URL_LEN => ConnectCmd::StartServer { url },
            RawConnect::Forget { url } if url.len() <= MAX_URL_LEN => ConnectCmd::Forget { url },
            RawConnect::SetAutoConnect { value } => ConnectCmd::SetAutoConnect(value),
            RawConnect::SetStartFullscreen { value } => ConnectCmd::SetStartFullscreen(value),
            RawConnect::OpenExternal { url } if url.len() <= MAX_URL_LEN => ConnectCmd::OpenExternal(url),
            RawConnect::LocalStatus { quick, deep } => ConnectCmd::LocalStatus { quick, deep },
            RawConnect::InstallLocal { network } => ConnectCmd::InstallLocal { network },
            RawConnect::InstallPrepare => ConnectCmd::InstallPrepare,
            RawConnect::InstallStart {
                network_password,
                ai_cli,
            } if ai_cli.as_deref().is_none_or(is_cli_id) => ConnectCmd::InstallStart {
                network_password: bounded(network_password, MAX_FIELD_LEN)?.filter(|p| !p.is_empty()),
                ai_cli,
            },
            RawConnect::InstallAttach => ConnectCmd::InstallAttach,
            RawConnect::InstallCancel => ConnectCmd::InstallCancel,
            RawConnect::AgentPrepare => ConnectCmd::AgentPrepare,
            RawConnect::AgentStart { ai_cli } if is_cli_id(&ai_cli) => ConnectCmd::AgentStart { ai_cli },
            RawConnect::AgentAttach => ConnectCmd::AgentAttach,
            RawConnect::InstallRemote { target } if target.len() <= MAX_FIELD_LEN => {
                ConnectCmd::InstallRemote { target }
            }
            RawConnect::CopyInstallCommand => ConnectCmd::CopyInstallCommand,
            _ => return None,
        };
        return Some(Ipc::Connect(cmd));
    }
    let srv = phase.loaded()?;
    if !trusted_frame(&frame, srv) {
        return None;
    }
    let cmd = match serde_json::from_str::<RawHost>(body).ok()? {
        RawHost::OpenWindow { url } if url.len() <= MAX_URL_LEN => HostCmd::OpenWindow(url),
        RawHost::CloseWindow => HostCmd::CloseWindow,
        RawHost::FocusWindow => HostCmd::FocusWindow,
        RawHost::OpenExternal { url } if url.len() <= MAX_URL_LEN => HostCmd::OpenExternal(url),
        RawHost::SessionExpired => HostCmd::SessionExpired,
        _ => return None,
    };
    Some(Ipc::Host(cmd))
}

/// Only http(s) URLs ever reach the default browser (never `file:`, a custom
/// app scheme, or anything `open` would hand to another program).
pub fn external_url(target: &str) -> Option<Url> {
    let url = Url::parse(target).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn normalize_adds_scheme_and_trailing_slash() {
        assert_eq!(
            normalize_server_url("127.0.0.1:3000").unwrap().as_str(),
            "http://127.0.0.1:3000/"
        );
        assert_eq!(
            normalize_server_url(" localhost:3000 ").unwrap().as_str(),
            "http://localhost:3000/"
        );
        assert_eq!(
            normalize_server_url("box.tailf80371.ts.net").unwrap().as_str(),
            "https://box.tailf80371.ts.net/"
        );
        assert_eq!(
            normalize_server_url("Box.Tailf80371.TS.NET/codeman").unwrap().as_str(),
            "https://box.tailf80371.ts.net/codeman/"
        );
        // With a port it is Codeman's own listener, not tailscale serve.
        assert_eq!(
            normalize_server_url("box.tailf80371.ts.net:3000").unwrap().as_str(),
            "http://box.tailf80371.ts.net:3000/"
        );
        assert_eq!(
            normalize_server_url("box.tailf80371.ts.net:8443/x").unwrap().as_str(),
            "http://box.tailf80371.ts.net:8443/x/"
        );
        // A scheme that was typed is never second-guessed.
        assert_eq!(
            normalize_server_url("https://box.tailf80371.ts.net:8443")
                .unwrap()
                .as_str(),
            "https://box.tailf80371.ts.net:8443/"
        );
        assert_eq!(
            normalize_server_url("https://host/codeman").unwrap().as_str(),
            "https://host/codeman/"
        );
        assert_eq!(
            normalize_server_url("http://host:3000/?x=1#y").unwrap().as_str(),
            "http://host:3000/"
        );
        assert_eq!(
            normalize_server_url("[::1]:3000").unwrap().as_str(),
            "http://[::1]:3000/"
        );
    }

    #[test]
    fn normalize_rejects_bad_input() {
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("ftp://host").is_err());
        assert!(normalize_server_url("file:///etc/passwd").is_err());
        assert!(normalize_server_url("http://admin:pw@host:3000").is_err());
        assert!(normalize_server_url(&format!("http://{}", "a".repeat(5000))).is_err());
    }

    #[test]
    fn origin_and_loopback() {
        assert!(same_origin(
            &u("http://127.0.0.1:3000/"),
            &u("http://127.0.0.1:3000/api/x")
        ));
        assert!(!same_origin(&u("http://127.0.0.1:3000/"), &u("http://127.0.0.1:3001/")));
        assert!(!same_origin(
            &u("http://127.0.0.1:3000/"),
            &u("https://127.0.0.1:3000/")
        ));
        assert!(same_origin(&u("https://host/"), &u("https://host:443/")));
        assert!(is_loopback(&u("http://localhost:3000/")));
        assert!(is_loopback(&u("http://127.0.0.5:3000/")));
        assert!(is_loopback(&u("http://[::1]:3000/")));
        assert!(!is_loopback(&u("http://192.168.1.2:3000/")));
        assert!(!is_loopback(&u("http://evil.localhost:3000/")));
    }

    #[test]
    fn start_locally_only_where_the_daemon_binds() {
        assert!(can_start_locally(&u("http://127.0.0.1:3000/")));
        assert!(can_start_locally(&u("http://localhost:3000/")));
        assert!(can_start_locally(&u("http://LOCALHOST:3000/codeman/")));
        // Loopback, but `codeman web -d` binds 127.0.0.1 only.
        assert!(!can_start_locally(&u("http://127.0.0.2:3000/")));
        assert!(!can_start_locally(&u("http://[::1]:3000/")));
        assert!(!can_start_locally(&u("https://127.0.0.1:3000/")));
        assert!(!can_start_locally(&u("https://localhost:3000/")));
        assert!(!can_start_locally(&u("http://box.local:3000/")));
        assert!(!can_start_locally(&u("http://evil.localhost:3000/")));
    }

    #[test]
    fn start_args_carry_port_and_base_path() {
        assert_eq!(
            start_args(&u("http://127.0.0.1:3000/")),
            vec!["web", "-d", "--port", "3000"]
        );
        assert_eq!(start_args(&u("http://localhost/")), vec!["web", "-d", "--port", "80"]);
        assert_eq!(
            start_args(&u("http://127.0.0.1:4100/codeman/")),
            vec!["web", "-d", "--port", "4100", "--base-url", "/codeman"]
        );
    }

    #[test]
    fn phase_accessors() {
        let srv = u("http://127.0.0.1:3000/");
        assert_eq!(Phase::Connect.server(), None);
        assert_eq!(Phase::Connect.loaded(), None);
        assert!(Phase::Connect.connect_page_live());
        assert_eq!(Phase::Loading(srv.clone()).server(), Some(&srv));
        assert_eq!(Phase::Loading(srv.clone()).loaded(), None);
        assert!(Phase::Loading(srv.clone()).connect_page_live());
        assert_eq!(Phase::Loaded(srv.clone()).server(), Some(&srv));
        assert_eq!(Phase::Loaded(srv.clone()).loaded(), Some(&srv));
        assert!(!Phase::Loaded(srv).connect_page_live());
    }

    #[test]
    fn a_commit_from_the_loading_server_is_the_loaded_page() {
        let server = Url::parse("https://box.ts.net/codeman/").unwrap();
        let loading = Phase::Loading(server.clone());
        assert_eq!(
            loaded_on_commit(&loading, "https://box.ts.net/codeman/"),
            Some(Phase::Loaded(server.clone()))
        );
        // Any page of that origin counts: the server may redirect within it.
        assert_eq!(
            loaded_on_commit(&loading, "https://box.ts.net/codeman/session/abc"),
            Some(Phase::Loaded(server.clone()))
        );
        // Another origin, the connect page, or junk: still loading.
        assert_eq!(loaded_on_commit(&loading, "https://other.ts.net/codeman/"), None);
        assert_eq!(loaded_on_commit(&loading, "http://box.ts.net/codeman/"), None);
        assert_eq!(loaded_on_commit(&loading, CONNECT_PAGE), None);
        assert_eq!(loaded_on_commit(&loading, "not a url"), None);
        // Only a load under way can finish.
        assert_eq!(loaded_on_commit(&Phase::Connect, "https://box.ts.net/codeman/"), None);
        assert_eq!(
            loaded_on_commit(&Phase::Loaded(server), "https://box.ts.net/codeman/"),
            None
        );
    }

    #[test]
    fn navigation_policy() {
        let srv = u("http://127.0.0.1:3000/");
        let loaded = Phase::Loaded(srv.clone());
        assert_eq!(
            navigation("http://127.0.0.1:3000/session/abc", &loaded),
            Navigation::Allow
        );
        assert_eq!(navigation("about:blank", &loaded), Navigation::Allow);
        assert_eq!(navigation("about:srcdoc", &loaded), Navigation::Allow);
        assert_eq!(navigation("blob:http://127.0.0.1:3000/x", &loaded), Navigation::Allow);
        assert_eq!(navigation("https://example.com/", &loaded), Navigation::Block);
        assert_eq!(navigation("http://127.0.0.1:3001/", &loaded), Navigation::Block);
        assert_eq!(navigation("file:///etc/passwd", &loaded), Navigation::Block);
        assert_eq!(navigation("not a url", &loaded), Navigation::Block);
        // The connect page until a server page committed.
        assert_eq!(navigation(CONNECT_PAGE, &Phase::Connect), Navigation::Allow);
        assert_eq!(navigation(CONNECT_PAGE, &loaded), Navigation::Block);
        // Disconnected: no web origin is trusted yet.
        assert_eq!(navigation("http://127.0.0.1:3000/", &Phase::Connect), Navigation::Block);
    }

    #[test]
    fn navigation_while_loading() {
        let loading = Phase::Loading(u("http://127.0.0.1:3000/codeman/"));
        // The load itself, and the connect page the app may go back to.
        assert_eq!(
            navigation("http://127.0.0.1:3000/codeman/", &loading),
            Navigation::Allow
        );
        assert_eq!(navigation(CONNECT_PAGE, &loading), Navigation::Allow);
        assert_eq!(
            navigation(&format!("{CONNECT_PAGE}?manual=1"), &loading),
            Navigation::Allow
        );
        assert_eq!(navigation("http://127.0.0.1:3001/", &loading), Navigation::Block);
        assert_eq!(navigation("https://example.com/", &loading), Navigation::Block);
    }

    #[test]
    fn new_window_policy() {
        let srv = u("https://box.tailnet.ts.net/");
        let loaded = Phase::Loaded(srv.clone());
        let loading = Phase::Loading(srv);
        let long = format!("https://github.com/{}", "a".repeat(5000));
        // The gates before the pop-out check hold whoever asked.
        for via in [Via::Host, Via::Script] {
            // window.open('') would get a window with none of the app's handlers.
            assert_eq!(new_window("", &loaded, via), NewWindow::Deny);
            assert_eq!(new_window("about:blank", &loaded, via), NewWindow::Deny);
            assert_eq!(
                new_window("https://github.com/", &loaded, via),
                NewWindow::External(u("https://github.com/"))
            );
            // Same origin but not a pop-out target: denied, never the browser.
            assert_eq!(
                new_window("https://box.tailnet.ts.net/webview/cap/x", &loaded, via),
                NewWindow::Deny
            );
            assert_eq!(new_window("https://box.tailnet.ts.net/", &loaded, via), NewWindow::Deny);
            assert_eq!(new_window("javascript:alert(1)", &loaded, via), NewWindow::Deny);
            assert_eq!(new_window("file:///tmp/x", &loaded, via), NewWindow::Deny);
            assert_eq!(new_window("mailto:a@b.c", &loaded, via), NewWindow::Deny);
            assert_eq!(
                new_window("blob:https://box.tailnet.ts.net/x", &loaded, via),
                NewWindow::Deny
            );
            assert_eq!(new_window(&long, &loaded, via), NewWindow::Deny);
            // Nothing opens before a server page committed.
            assert_eq!(new_window("https://github.com/", &Phase::Connect, via), NewWindow::Deny);
            assert_eq!(new_window("https://github.com/", &loading, via), NewWindow::Deny);
            assert_eq!(
                new_window("https://box.tailnet.ts.net/session/x", &loading, via),
                NewWindow::Deny
            );
            assert_eq!(
                new_window("https://box.tailnet.ts.net/api/download?path=x", &loading, via),
                NewWindow::Deny
            );
        }
        assert_eq!(
            new_window("https://box.tailnet.ts.net/session/x", &loaded, Via::Host),
            NewWindow::AppWindow(u("https://box.tailnet.ts.net/session/x"))
        );
    }

    #[test]
    fn new_window_by_who_asked() {
        let loaded = Phase::Loaded(u("http://127.0.0.1:3000/"));
        let script = |s: &str| new_window(s, &loaded, Via::Script);
        let host = |s: &str| new_window(s, &loaded, Via::Host);
        // What Codeman itself opens with window.open: either way.
        for s in [
            "http://127.0.0.1:3000/api/sessions/s1/file-raw?path=src%2Fa.png",
            "http://127.0.0.1:3000/api/sessions/s1/file-raw?path=a.txt&download=true",
            "http://127.0.0.1:3000/api/sessions/s1/file-preview?path=a.docx",
            "http://127.0.0.1:3000/api/sessions/s1/attachments/att1/raw",
            "http://127.0.0.1:3000/api/sessions/s1/attachments/att1/raw?download=true",
            "http://127.0.0.1:3000/api/sessions/s1/attachments/att1/preview",
            "http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/a.png/raw",
            "http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/my%20notes.md/preview",
            "http://127.0.0.1:3000/api/download?path=x",
            "http://127.0.0.1:3000/api/filesystem/preview?path=%2Fhome%2Fu%2Fa.md",
        ] {
            assert_eq!(script(s), NewWindow::AppWindow(u(s)), "{s}");
            assert_eq!(host(s), NewWindow::AppWindow(u(s)), "{s}");
        }
        // What Codeman opens only through CodemanHost: refused to a script,
        // in any spelling the pop-out check accepts.
        for s in [
            "http://127.0.0.1:3000/session/abc",
            "http://127.0.0.1:3000/%73ession/abc",
            "http://127.0.0.1:3000/html-view/cap/index.html",
            "http://127.0.0.1:3000/html-view/cap/sub/page.html",
            "http://127.0.0.1:3000/%68tml-view/cap/index.html",
        ] {
            assert_eq!(script(s), NewWindow::Deny, "{s}");
            assert_eq!(host(s), NewWindow::AppWindow(u(s)), "{s}");
        }
        // Not a pop-out target for either.
        for s in [
            "http://127.0.0.1:3000/webview/cap/x",
            "http://127.0.0.1:3000/api/sessions/s1/input",
            "http://127.0.0.1:3000/api/download/x",
            "http://127.0.0.1:3000/x/session/abc",
        ] {
            assert_eq!(script(s), NewWindow::Deny, "{s}");
            assert_eq!(host(s), NewWindow::Deny, "{s}");
        }

        let based = Phase::Loaded(u("https://host/codeman/"));
        assert_eq!(
            new_window(
                "https://host/codeman/api/sessions/s1/file-raw?path=a",
                &based,
                Via::Script
            ),
            NewWindow::AppWindow(u("https://host/codeman/api/sessions/s1/file-raw?path=a"))
        );
        assert_eq!(
            new_window("https://host/api/download?path=a", &based, Via::Script),
            NewWindow::Deny
        );
        assert_eq!(
            new_window("https://host/codeman/session/abc", &based, Via::Script),
            NewWindow::Deny
        );
        assert_eq!(
            new_window("https://host/codeman/session/abc", &based, Via::Host),
            NewWindow::AppWindow(u("https://host/codeman/session/abc"))
        );
    }

    #[test]
    fn challenges_in_scope() {
        let srv = u("http://127.0.0.1:3000/");
        let ours = |s: &str| challenge_in_scope(&u(s), &srv);
        // Codeman's own pages, API and assets.
        assert!(ours("http://127.0.0.1:3000/"));
        assert!(ours("http://127.0.0.1:3000/index.html"));
        assert!(ours("http://127.0.0.1:3000/app.js?v=1"));
        assert!(ours("http://127.0.0.1:3000/api/status"));
        assert!(ours("http://127.0.0.1:3000/session/abc"));
        assert!(ours(
            "http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/50%25.txt/raw"
        ));
        // `webview` with no capability below it is not the proxy.
        assert!(ours("http://127.0.0.1:3000/webview"));
        assert!(ours("http://127.0.0.1:3000/webviewx/cap/x"));
        // Decoded once: `%2577ebview` reaches `%77ebview`, not the proxy.
        assert!(ours("http://127.0.0.1:3000/%2577ebview/cap/x"));

        // A proxied dashboard's relayed 401, in any spelling the router decodes.
        assert!(!ours("http://127.0.0.1:3000/webview/cap/x"));
        assert!(!ours("http://127.0.0.1:3000/webview/cap/"));
        assert!(!ours("http://127.0.0.1:3000/%77ebview/cap/x"));
        assert!(!ours("http://127.0.0.1:3000/%77%65%62view/cap/x"));
        // A rendered HTML file.
        assert!(!ours("http://127.0.0.1:3000/html-view/c/x"));
        assert!(!ours("http://127.0.0.1:3000/%68tml-view/c/x"));
        // A path that does not decode.
        assert!(!ours("http://127.0.0.1:3000/a%zz"));
        assert!(!ours("http://127.0.0.1:3000/session/%ff"));
        // Another origin.
        assert!(!ours("http://127.0.0.1:3001/"));
        assert!(!ours("https://127.0.0.1:3000/"));
        assert!(!ours("http://localhost:3000/"));
        assert!(!ours("https://evil.example/"));

        let based = u("https://host/codeman/");
        let ours_based = |s: &str| challenge_in_scope(&u(s), &based);
        assert!(ours_based("https://host/codeman/"));
        assert!(ours_based("https://host/codeman/api/status"));
        assert!(ours_based("https://host:443/codeman/session/abc"));
        assert!(!ours_based("https://host/codeman/webview/cap/x"));
        assert!(!ours_based("https://host/codeman/%77ebview/cap/x"));
        assert!(!ours_based("https://host/codeman/html-view/c/x"));
        // Siblings outside the base, and Codeman answering unprefixed.
        assert!(!ours_based("https://host/grafana/"));
        assert!(!ours_based("https://host/grafana/api/x"));
        assert!(!ours_based("https://host/codemanx/"));
        assert!(!ours_based("https://host/codeman"));
        assert!(!ours_based("https://host/"));
        assert!(!ours_based("https://host/webview/cap/x"));
        assert!(!ours_based("https://host/%63odeman/api/status"));
        assert!(!ours_based("http://host/codeman/"));
    }

    #[test]
    fn session_ids_of_popouts() {
        let srv = u("http://127.0.0.1:3000/");
        let id = |s: &str| session_id_of(&u(s), &srv);
        assert_eq!(id("http://127.0.0.1:3000/session/abc").as_deref(), Some("abc"));
        assert_eq!(id("http://127.0.0.1:3000/session/abc?x=1#y").as_deref(), Some("abc"));
        assert_eq!(
            id("http://127.0.0.1:3000/session/0b7f6c2e-1").as_deref(),
            Some("0b7f6c2e-1")
        );
        // Decoded once, as is_popout_target and the server's router read it.
        assert_eq!(id("http://127.0.0.1:3000/%73ession/abc").as_deref(), Some("abc"));
        assert_eq!(id("http://127.0.0.1:3000/session/a%62c").as_deref(), Some("abc"));
        assert_eq!(id("http://127.0.0.1:3000/session/a%20b").as_deref(), Some("a b"));
        // Only exactly `session/<id>` below the base.
        assert_eq!(id("http://127.0.0.1:3000/x/session/abc"), None);
        assert_eq!(id("http://127.0.0.1:3000/session/abc/"), None);
        assert_eq!(id("http://127.0.0.1:3000/session/abc/x"), None);
        assert_eq!(id("http://127.0.0.1:3000/session/"), None);
        assert_eq!(id("http://127.0.0.1:3000/session/a%2Fb"), None);
        assert_eq!(id("http://127.0.0.1:3000/session/%2e%2e"), None);
        assert_eq!(id("http://127.0.0.1:3000/session/a%2525b"), None);
        assert_eq!(id("http://127.0.0.1:3000/Session/abc"), None);
        assert_eq!(id("http://127.0.0.1:3000/webview/cap/session/abc"), None);
        // Pop-out targets of the other kinds.
        assert_eq!(id("http://127.0.0.1:3000/html-view/c/session/abc"), None);
        assert_eq!(id("http://127.0.0.1:3000/api/sessions/abc/file-raw?path=a"), None);
        assert_eq!(id("http://127.0.0.1:3000/api/download?path=a"), None);
        // Other origins and userinfo.
        assert_eq!(id("http://127.0.0.1:3001/session/abc"), None);
        assert_eq!(id("http://admin:pw@127.0.0.1:3000/session/abc"), None);

        let based = u("https://host/codeman/");
        let idb = |s: &str| session_id_of(&u(s), &based);
        assert_eq!(idb("https://host/codeman/session/abc").as_deref(), Some("abc"));
        assert_eq!(idb("https://host/session/abc"), None);
        assert_eq!(idb("https://host/grafana/session/abc"), None);
        assert_eq!(idb("https://host/codeman/x/session/abc"), None);
        // Agrees with is_popout_target on every session-shaped URL above.
        for s in [
            "http://127.0.0.1:3000/session/abc",
            "http://127.0.0.1:3000/%73ession/abc",
            "http://127.0.0.1:3000/x/session/abc",
            "http://127.0.0.1:3000/session/a%2Fb",
        ] {
            let url = u(s);
            assert_eq!(session_id_of(&url, &srv).is_some(), is_popout_target(&url, &srv), "{s}");
        }
    }

    #[test]
    fn popout_targets_are_codemans_own_pages() {
        let srv = u("http://127.0.0.1:3000/");
        let ok = |s: &str| is_popout_target(&u(s), &srv);
        assert!(ok("http://127.0.0.1:3000/session/0b7f6c2e-1"));
        assert!(ok("http://127.0.0.1:3000/session/abc?x=1#y"));
        assert!(ok("http://127.0.0.1:3000/html-view/cap/index.html"));
        assert!(ok("http://127.0.0.1:3000/html-view/cap/sub/page.html"));
        assert!(ok("http://127.0.0.1:3000/api/sessions/s1/file-raw?path=src%2Fa.png"));
        assert!(ok(
            "http://127.0.0.1:3000/api/sessions/s1/file-raw?path=a.txt&download=true"
        ));
        assert!(ok("http://127.0.0.1:3000/api/sessions/s1/file-preview?path=a.docx"));
        assert!(ok("http://127.0.0.1:3000/api/sessions/s1/attachments/att1/raw"));
        assert!(ok("http://127.0.0.1:3000/api/sessions/s1/attachments/att1/preview"));
        assert!(ok("http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/a.png/raw"));
        assert!(ok(
            "http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/my%20notes.md/preview"
        ));
        assert!(ok("http://127.0.0.1:3000/api/download?path=x"));
        // The path picker's preview, which its Open link shows in a window.
        assert!(ok(
            "http://127.0.0.1:3000/api/filesystem/preview?path=%2Fhome%2Fu%2Fa.md&sessionId=s1"
        ));
        // A single decode is how the server's router sees the path.
        assert!(ok("http://127.0.0.1:3000/%73ession/abc"));

        // Proxied dashboards, in any spelling.
        assert!(!ok("http://127.0.0.1:3000/webview/cap/x"));
        assert!(!ok("http://127.0.0.1:3000/webview/cap/"));
        assert!(!ok("http://127.0.0.1:3000/%77ebview/cap/x"));
        assert!(!ok("http://127.0.0.1:3000/%2577ebview/cap/x"));
        // Traversal: the url crate resolves `%2e%2e` itself; encoded slashes
        // and double encoding are refused after the decode.
        assert!(!ok("http://127.0.0.1:3000/session/%2e%2e/webview/cap/"));
        assert!(!ok("http://127.0.0.1:3000/html-view/c/%2e%2e/%2e%2e/webview/cap/"));
        assert!(!ok("http://127.0.0.1:3000/html-view%2F..%2Fwebview%2Fcap%2F"));
        assert!(!ok("http://127.0.0.1:3000/html-view/c/%252e%252e/x"));
        assert!(!ok("http://127.0.0.1:3000/html-view/c/..%5C..%5Cwebview%5Cx"));
        assert!(!ok("http://127.0.0.1:3000/session/a%00b"));
        assert!(!ok("http://127.0.0.1:3000/session/a%zzb"));
        assert!(!ok("http://127.0.0.1:3000/session/a%2"));
        assert!(!ok("http://127.0.0.1:3000/session/%ff"));
        // Near misses of the allowlist.
        assert!(!ok("http://127.0.0.1:3000/"));
        assert!(!ok("http://127.0.0.1:3000/index.html"));
        assert!(!ok("http://127.0.0.1:3000/session/"));
        assert!(!ok("http://127.0.0.1:3000/session/abc/"));
        assert!(!ok("http://127.0.0.1:3000/session/a%2Fb"));
        assert!(!ok("http://127.0.0.1:3000/Session/abc"));
        assert!(!ok("http://127.0.0.1:3000/html-view/"));
        assert!(!ok("http://127.0.0.1:3000/api/sessions"));
        assert!(!ok("http://127.0.0.1:3000/api/sessions/s1/input"));
        assert!(!ok("http://127.0.0.1:3000/api/sessions//file-raw"));
        assert!(!ok("http://127.0.0.1:3000/api/sessions/s1/attachments/att1/delete"));
        assert!(!ok("http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/"));
        assert!(!ok("http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/a.png"));
        assert!(!ok(
            "http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/a.png/thumbnail"
        ));
        assert!(!ok(
            "http://127.0.0.1:3000/api/sessions/s1/folders/f1/files/a.png/raw/x"
        ));
        assert!(!ok("http://127.0.0.1:3000/api/download/x"));
        // The picker's other routes list and create folders: never a window.
        assert!(!ok("http://127.0.0.1:3000/api/filesystem/browse?path=%2F"));
        assert!(!ok("http://127.0.0.1:3000/api/filesystem/mkdir"));
        assert!(!ok("http://127.0.0.1:3000/api/filesystem/preview/x"));
        assert!(!ok("http://127.0.0.1:3000/api/status"));
        // Other origins and userinfo.
        assert!(!ok("http://127.0.0.1:3001/session/abc"));
        assert!(!ok("https://127.0.0.1:3000/session/abc"));
        assert!(!ok("http://admin:pw@127.0.0.1:3000/session/abc"));
    }

    #[test]
    fn popout_targets_below_a_base_path() {
        let srv = u("https://host/codeman/");
        let ok = |s: &str| is_popout_target(&u(s), &srv);
        assert!(ok("https://host/codeman/session/abc"));
        assert!(ok("https://host/codeman/html-view/c/x.html"));
        assert!(ok("https://host/codeman/api/sessions/s1/attachments/a1/raw"));
        // Outside the base: another app on the same origin, or Codeman's
        // routes answering unprefixed.
        assert!(!ok("https://host/session/abc"));
        assert!(!ok("https://host/grafana/session/abc"));
        assert!(!ok("https://host/codemanx/session/abc"));
        assert!(!ok("https://host/codeman/../webview/c/"));
        assert!(!ok("https://host/codeman/%2e%2e/webview/c/"));
        assert!(!ok("https://host/%63odeman/session/abc"));
        assert!(!ok("https://host/codeman/webview/c/x"));
        assert!(!ok("https://host/codeman/%77ebview/c/x"));
    }

    #[test]
    fn trusted_frames() {
        let srv = u("http://127.0.0.1:3000/");
        let t = |s: &str| trusted_frame(&u(s), &srv);
        assert!(t("http://127.0.0.1:3000/"));
        assert!(t("http://127.0.0.1:3000/?x=1"));
        assert!(t("http://127.0.0.1:3000/index.html"));
        assert!(t("http://127.0.0.1:3000/session/abc"));
        assert!(t("http://127.0.0.1:3000/session/abc#frag"));
        // The server routes the decoded path: any `%` is untrusted.
        assert!(!t("http://127.0.0.1:3000/%73ession/abc"));
        assert!(!t("http://127.0.0.1:3000/%68tml-view/c/x.html"));
        assert!(!t("http://127.0.0.1:3000/%77ebview/c/"));
        assert!(!t("http://127.0.0.1:3000/session/a%62c"));
        assert!(!t("http://127.0.0.1:3000/html-view/c/x.html"));
        assert!(!t("http://127.0.0.1:3000/webview/c/"));
        assert!(!t("http://127.0.0.1:3000/some/relayed/dashboard/path"));
        assert!(!t("http://127.0.0.1:3000/session/"));
        assert!(!t("http://127.0.0.1:3000/session/abc/x"));
        assert!(!t("http://127.0.0.1:3000/api/status"));
        assert!(!t("http://127.0.0.1:3001/"));
        assert!(!t("https://127.0.0.1:3000/"));
        assert!(!t("codemanapp://localhost/index.html"));

        let based = u("http://127.0.0.1:3000/codeman/");
        let tb = |s: &str| trusted_frame(&u(s), &based);
        assert!(tb("http://127.0.0.1:3000/codeman/"));
        assert!(tb("http://127.0.0.1:3000/codeman/index.html"));
        assert!(tb("http://127.0.0.1:3000/codeman/session/x"));
        assert!(!tb("http://127.0.0.1:3000/codeman/html-view/c/"));
        // Outside the base path is untrusted (fail closed).
        assert!(!tb("http://127.0.0.1:3000/"));
        assert!(!tb("http://127.0.0.1:3000/session/x"));
        assert!(!tb("http://127.0.0.1:3000/codeman"));
        assert!(!tb("http://127.0.0.1:3000/codemanx/"));
    }

    #[test]
    fn authorization_stays_within_the_base_path() {
        let srv = u("https://host/codeman/");
        assert!(within_base(&u("https://host/codeman/"), &srv));
        assert!(within_base(&u("https://host/codeman/session/x?y=1"), &srv));
        assert!(!within_base(&u("https://host/codemanx/"), &srv));
        assert!(!within_base(&u("https://host/grafana/"), &srv));
        assert!(!within_base(&u("https://host/"), &srv));
        assert!(!within_base(&u("https://host/codeman/../grafana/"), &srv));
        // The same way out, spelled so that only a decoder sees it.
        for escape in [
            "https://host/codeman/..%2Fgrafana/",
            "https://host/codeman/..%2fgrafana/x",
            "https://host/codeman/%2e%2e%2Fgrafana/",
            "https://host/codeman/..%5Cgrafana/",
            "https://host/codeman/a/%2E%2E%2F%2E%2E%2Fgrafana/",
            "https://host/codeman/session/a%zz",
        ] {
            assert!(!within_base(&u(escape), &srv), "{escape}");
            assert!(!challenge_in_scope(&u(escape), &srv), "{escape}");
        }
        // Encoded characters that are part of a name stay inside.
        for inside in [
            "https://host/codeman/api/sessions/s1/folders/f1/files/50%25.txt/raw",
            "https://host/codeman/api/sessions/s1/file-raw?path=..%2Fx",
            "https://host/codeman/session/a%20b",
            "https://host/codeman/a..b/c",
        ] {
            assert!(within_base(&u(inside), &srv), "{inside}");
        }
        assert!(!within_base(&u("http://host/codeman/"), &srv));
        assert!(!within_base(&u("https://other/codeman/"), &srv));
        let root = u("http://127.0.0.1:3000/");
        assert!(within_base(&u("http://127.0.0.1:3000/anything"), &root));
        assert!(!within_base(&u("http://127.0.0.1:3001/"), &root));
    }

    #[test]
    fn webkit_safe_urls() {
        // The url crate leaves these raw; pre-14 NSURL rejects them.
        assert_eq!(
            webkit_safe_url(&u("http://127.0.0.1:3000/a|b^c[d]/x?q={x}|^[]`\\")),
            "http://127.0.0.1:3000/a%7Cb%5Ec%5Bd%5D/x?q=%7Bx%7D%7C%5E%5B%5D%60%5C"
        );
        assert_eq!(webkit_safe_url(&u("http://h/p#a{b}#c")), "http://h/p#a%7Bb%7D%23c");
        // Host and port untouched: an IPv6 literal keeps its brackets.
        assert_eq!(
            webkit_safe_url(&u("http://[::1]:3000/x[1]?a[]=1")),
            "http://[::1]:3000/x%5B1%5D?a%5B%5D=1"
        );
        // Existing escapes stay; a `%` that starts none is escaped itself.
        assert_eq!(
            webkit_safe_url(&u("http://h/%7Bx%7d?q=%7B%41")),
            "http://h/%7Bx%7d?q=%7B%41"
        );
        assert_eq!(webkit_safe_url(&u("http://h/a%zz?b=5%")), "http://h/a%25zz?b=5%25");
        // Ordinary URLs pass through unchanged.
        for s in [
            CONNECT_PAGE,
            "codemanapp://localhost/index.html?manual=1",
            "http://127.0.0.1:3000/",
            "https://box.tailnet.ts.net/codeman/session/abc",
            "http://h/api/sessions/s/file-raw?path=src%2Fa%20b.png&download=true",
        ] {
            assert_eq!(webkit_safe_url(&u(s)), s);
        }
        // The result still parses to the same resource.
        let messy = u("http://h/a|b?q={x}#f[1]");
        assert_eq!(u(&webkit_safe_url(&messy)).host_str(), Some("h"));
        assert_eq!(u(&webkit_safe_url(&messy)).path(), "/a%7Cb");
    }

    #[test]
    fn open_budget_bursts_then_refills() {
        let t0 = Instant::now();
        let mut b = OpenBudget::new();
        assert!(b.allow(t0));
        assert!(b.allow(t0));
        assert!(b.allow(t0));
        assert!(!b.allow(t0));
        assert!(!b.allow(t0 + Duration::from_millis(500)));
        assert!(b.allow(t0 + Duration::from_millis(1000)));
        assert!(!b.allow(t0 + Duration::from_millis(1000)));
        // A clock going backwards refills nothing.
        assert!(!b.allow(t0));
        assert!(b.allow(t0 + Duration::from_millis(2000)));
        // A long pause refills to the burst, never beyond it.
        let later = t0 + Duration::from_secs(60);
        assert!(b.allow(later));
        assert!(b.allow(later));
        assert!(b.allow(later));
        assert!(!b.allow(later));
    }

    #[test]
    fn a_window_recovers_from_a_lost_content_process_once() {
        // The first time, every window that shows a server page loads it again.
        assert_eq!(recovery(true, true, false), Recovery::Reload);
        assert_eq!(recovery(false, true, false), Recovery::Reload);
        // The connect page is shown anew, which also ends a load under way.
        assert_eq!(recovery(true, false, false), Recovery::ConnectPage { gave_up: false });
        // A second time in a row never reloads: that would loop.
        assert_eq!(recovery(true, true, true), Recovery::ConnectPage { gave_up: true });
        assert_eq!(recovery(false, true, true), Recovery::Close);
        assert_eq!(recovery(true, false, true), Recovery::Nothing);
        for is_main in [true, false] {
            for on_server in [true, false] {
                assert_ne!(recovery(is_main, on_server, true), Recovery::Reload);
            }
        }
    }

    #[test]
    fn basic_auth() {
        assert_eq!(basic_auth_header("admin", "secret"), "Basic YWRtaW46c2VjcmV0");
    }

    #[test]
    fn ipc_from_server_page() {
        let srv = u("http://127.0.0.1:3000/");
        let loaded = Phase::Loaded(srv.clone());
        let main = "http://127.0.0.1:3000/";
        assert_eq!(
            parse_ipc(
                main,
                r#"{"cmd":"openWindow","url":"http://127.0.0.1:3000/session/1"}"#,
                &loaded,
                true
            ),
            Some(Ipc::Host(HostCmd::OpenWindow("http://127.0.0.1:3000/session/1".into())))
        );
        assert_eq!(
            parse_ipc(
                "http://127.0.0.1:3000/session/1",
                r#"{"cmd":"closeWindow"}"#,
                &loaded,
                false
            ),
            Some(Ipc::Host(HostCmd::CloseWindow))
        );
        assert_eq!(
            parse_ipc(
                main,
                r#"{"cmd":"openExternal","url":"https://github.com/"}"#,
                &loaded,
                true
            ),
            Some(Ipc::Host(HostCmd::OpenExternal("https://github.com/".into())))
        );
        assert_eq!(
            parse_ipc(main, r#"{"cmd":"sessionExpired"}"#, &loaded, true),
            Some(Ipc::Host(HostCmd::SessionExpired))
        );
        assert_eq!(
            parse_ipc(
                "http://127.0.0.1:3000/session/1",
                r#"{"cmd":"sessionExpired"}"#,
                &loaded,
                false
            ),
            Some(Ipc::Host(HostCmd::SessionExpired))
        );
        // Untrusted surfaces, other origins, connect commands: refused.
        for frame in [
            "http://127.0.0.1:3000/html-view/c/x.html",
            "http://127.0.0.1:3000/%68tml-view/c/x.html",
            "http://127.0.0.1:3000/webview/c/",
            "http://127.0.0.1:3000/%77ebview/c/",
            "http://127.0.0.1:3000/some/relayed/dashboard/path",
            "https://evil.example/",
            "about:blank",
        ] {
            assert_eq!(parse_ipc(frame, r#"{"cmd":"focusWindow"}"#, &loaded, true), None);
            assert_eq!(parse_ipc(frame, r#"{"cmd":"sessionExpired"}"#, &loaded, true), None);
        }
        assert_eq!(
            parse_ipc(main, r#"{"cmd":"startServer","url":"x"}"#, &loaded, true),
            None
        );
        assert_eq!(parse_ipc(main, r#"{"cmd":"focusWindow"}"#, &Phase::Connect, true), None);
        assert_eq!(
            parse_ipc(main, r#"{"cmd":"runShell","line":"rm -rf ~"}"#, &loaded, true),
            None
        );
        assert_eq!(parse_ipc(main, r#"{"cmd":"openWindow"}"#, &loaded, true), None);
        assert_eq!(parse_ipc(main, "not json", &loaded, true), None);
        // serde ignores extra keys on a no-argument command even with
        // deny_unknown_fields; harmless, the command itself is still checked.
        assert_eq!(
            parse_ipc(main, r#"{"cmd":"focusWindow","extra":1}"#, &loaded, true),
            Some(Ipc::Host(HostCmd::FocusWindow))
        );
    }

    #[test]
    fn ipc_from_a_based_server_page() {
        let loaded = Phase::Loaded(u("https://host/codeman/"));
        assert_eq!(
            parse_ipc("https://host/codeman/", r#"{"cmd":"focusWindow"}"#, &loaded, true),
            Some(Ipc::Host(HostCmd::FocusWindow))
        );
        assert_eq!(
            parse_ipc("https://host/grafana/", r#"{"cmd":"focusWindow"}"#, &loaded, true),
            None
        );
        assert_eq!(
            parse_ipc("https://host/", r#"{"cmd":"focusWindow"}"#, &loaded, true),
            None
        );
    }

    #[test]
    fn ipc_while_loading() {
        let loading = Phase::Loading(u("http://127.0.0.1:3000/"));
        let page = "codemanapp://localhost/index.html";
        // The connect page is still the document: it stays usable.
        assert_eq!(
            parse_ipc(page, r#"{"cmd":"cancel"}"#, &loading, true),
            Some(Ipc::Connect(ConnectCmd::Cancel))
        );
        assert_eq!(
            parse_ipc(page, r#"{"cmd":"connect","url":"127.0.0.1:3001"}"#, &loading, true),
            Some(Ipc::Connect(ConnectCmd::Connect {
                url: "127.0.0.1:3001".into(),
                username: None,
                password: None,
                remember: false
            }))
        );
        // The server page has not committed: nothing it says is heard yet.
        assert_eq!(
            parse_ipc("http://127.0.0.1:3000/", r#"{"cmd":"focusWindow"}"#, &loading, true),
            None
        );
        assert_eq!(
            parse_ipc("http://127.0.0.1:3000/", r#"{"cmd":"sessionExpired"}"#, &loading, true),
            None
        );
        assert_eq!(
            parse_ipc(
                "http://127.0.0.1:3000/",
                r#"{"cmd":"openExternal","url":"https://github.com/"}"#,
                &loading,
                true
            ),
            None
        );
    }

    #[test]
    fn ipc_install_commands() {
        let page = "codemanapp://localhost/index.html";
        let c = |body: &str| parse_ipc(page, body, &Phase::Connect, true);
        assert_eq!(
            c(r#"{"cmd":"localStatus","quick":true}"#),
            Some(Ipc::Connect(ConnectCmd::LocalStatus {
                quick: true,
                deep: false
            }))
        );
        assert_eq!(
            c(r#"{"cmd":"localStatus","deep":true}"#),
            Some(Ipc::Connect(ConnectCmd::LocalStatus {
                quick: false,
                deep: true
            }))
        );
        assert_eq!(
            c(r#"{"cmd":"localStatus"}"#),
            Some(Ipc::Connect(ConnectCmd::LocalStatus {
                quick: false,
                deep: false
            }))
        );
        assert_eq!(
            c(r#"{"cmd":"installLocal","network":true}"#),
            Some(Ipc::Connect(ConnectCmd::InstallLocal { network: true }))
        );
        assert_eq!(
            c(r#"{"cmd":"installLocal"}"#),
            Some(Ipc::Connect(ConnectCmd::InstallLocal { network: false }))
        );
        assert_eq!(
            c(r#"{"cmd":"installRemote","target":"kay@box"}"#),
            Some(Ipc::Connect(ConnectCmd::InstallRemote {
                target: "kay@box".into()
            }))
        );
        assert_eq!(
            c(r#"{"cmd":"copyInstallCommand"}"#),
            Some(Ipc::Connect(ConnectCmd::CopyInstallCommand))
        );
        // Nothing else rides along: no script, flags or command from the page.
        assert_eq!(c(r#"{"cmd":"installLocal","args":["--yes"]}"#), None);
        assert_eq!(
            c(r#"{"cmd":"installRemote","target":"kay@box","command":"rm -rf ~"}"#),
            None
        );
        assert_eq!(c(r#"{"cmd":"installRemote"}"#), None);
        assert_eq!(c(r#"{"cmd":"localStatus","quick":"yes"}"#), None);
        let long = format!(
            r#"{{"cmd":"installRemote","target":"{}"}}"#,
            "a".repeat(MAX_FIELD_LEN + 1)
        );
        assert_eq!(c(&long), None);
        // Only the connect page, only in the main window, never a server page.
        assert_eq!(
            parse_ipc(page, r#"{"cmd":"copyInstallCommand"}"#, &Phase::Connect, false),
            None
        );
        let loaded = Phase::Loaded(u("http://127.0.0.1:3000/"));
        assert_eq!(
            parse_ipc("http://127.0.0.1:3000/", r#"{"cmd":"installLocal"}"#, &loaded, true),
            None
        );
        assert_eq!(parse_ipc(page, r#"{"cmd":"installLocal"}"#, &loaded, true), None);
    }

    #[test]
    fn ipc_graphical_install_commands() {
        let page = "codemanapp://localhost/index.html";
        let c = |body: &str| parse_ipc(page, body, &Phase::Connect, true);
        assert_eq!(
            c(r#"{"cmd":"installPrepare"}"#),
            Some(Ipc::Connect(ConnectCmd::InstallPrepare))
        );
        assert_eq!(
            c(r#"{"cmd":"installAttach"}"#),
            Some(Ipc::Connect(ConnectCmd::InstallAttach))
        );
        assert_eq!(
            c(r#"{"cmd":"installCancel"}"#),
            Some(Ipc::Connect(ConnectCmd::InstallCancel))
        );
        // The spelling connect.html sends (test/desktop-connect-install.test.ts
        // pins the page's side).
        assert_eq!(
            c(r#"{"cmd":"installStart","networkPassword":"s3cret","aiCli":"claude"}"#),
            Some(Ipc::Connect(ConnectCmd::InstallStart {
                network_password: Some("s3cret".into()),
                ai_cli: Some("claude".into()),
            }))
        );
        assert_eq!(
            c(r#"{"cmd":"installStart"}"#),
            Some(Ipc::Connect(ConnectCmd::InstallStart {
                network_password: None,
                ai_cli: None,
            }))
        );
        // An empty password is no password: never a network install without one.
        assert_eq!(
            c(r#"{"cmd":"installStart","networkPassword":""}"#),
            Some(Ipc::Connect(ConnectCmd::InstallStart {
                network_password: None,
                ai_cli: None,
            }))
        );
        // Only the shape of an id: nothing that could read as a flag or more.
        for id in ["--yes", "-y", "Claude", "a b", "a;b", "", "a/b"] {
            assert_eq!(c(&format!(r#"{{"cmd":"installStart","aiCli":"{id}"}}"#)), None, "{id}");
        }
        let long = "a".repeat(33);
        assert_eq!(c(&format!(r#"{{"cmd":"installStart","aiCli":"{long}"}}"#)), None);
        let long = "a".repeat(MAX_FIELD_LEN + 1);
        assert_eq!(
            c(&format!(r#"{{"cmd":"installStart","networkPassword":"{long}"}}"#)),
            None
        );
        // Nothing else rides along.
        assert_eq!(c(r#"{"cmd":"installStart","args":["--yes"]}"#), None);
        assert_eq!(c(r#"{"cmd":"installStart","ai_cli":"claude"}"#), None);
        // Only the connect page, only in the main window, never a server page.
        assert_eq!(
            parse_ipc(page, r#"{"cmd":"installStart"}"#, &Phase::Connect, false),
            None
        );
        let loaded = Phase::Loaded(u("http://127.0.0.1:3000/"));
        assert_eq!(
            parse_ipc("http://127.0.0.1:3000/", r#"{"cmd":"installStart"}"#, &loaded, true),
            None
        );
        assert_eq!(parse_ipc(page, r#"{"cmd":"installCancel"}"#, &loaded, true), None);
    }

    #[test]
    fn ipc_adding_a_coding_agent() {
        let page = "codemanapp://localhost/index.html";
        let c = |body: &str| parse_ipc(page, body, &Phase::Connect, true);
        assert_eq!(
            c(r#"{"cmd":"agentPrepare"}"#),
            Some(Ipc::Connect(ConnectCmd::AgentPrepare))
        );
        assert_eq!(
            c(r#"{"cmd":"agentAttach"}"#),
            Some(Ipc::Connect(ConnectCmd::AgentAttach))
        );
        assert_eq!(
            c(r#"{"cmd":"agentStart","aiCli":"codex"}"#),
            Some(Ipc::Connect(ConnectCmd::AgentStart { ai_cli: "codex".into() }))
        );
        // It names one agent, in the shape of an id, and nothing else.
        assert_eq!(c(r#"{"cmd":"agentStart"}"#), None);
        for id in ["--service", "-y", "Codex", "a b", "a;b", "", "a/b"] {
            assert_eq!(c(&format!(r#"{{"cmd":"agentStart","aiCli":"{id}"}}"#)), None, "{id}");
        }
        assert_eq!(c(r#"{"cmd":"agentStart","aiCli":"codex","port":3000}"#), None);
        assert_eq!(
            parse_ipc(page, r#"{"cmd":"agentStart","aiCli":"codex"}"#, &Phase::Connect, false),
            None
        );
        let loaded = Phase::Loaded(u("http://127.0.0.1:3000/"));
        assert_eq!(
            parse_ipc(
                "http://127.0.0.1:3000/",
                r#"{"cmd":"agentStart","aiCli":"codex"}"#,
                &loaded,
                true
            ),
            None
        );
    }

    #[test]
    fn ipc_from_connect_page() {
        let page = "codemanapp://localhost/index.html";
        assert_eq!(
            parse_ipc(page, r#"{"cmd":"ready"}"#, &Phase::Connect, true),
            Some(Ipc::Connect(ConnectCmd::Ready))
        );
        assert_eq!(
            parse_ipc(
                "codemanapp://localhost/index.html?manual=1",
                r#"{"cmd":"ready"}"#,
                &Phase::Connect,
                true
            ),
            Some(Ipc::Connect(ConnectCmd::Ready))
        );
        assert_eq!(
            parse_ipc(
                page,
                r#"{"cmd":"connect","url":"127.0.0.1:3000","username":"admin","password":"pw","remember":true}"#,
                &Phase::Connect,
                true
            ),
            Some(Ipc::Connect(ConnectCmd::Connect {
                url: "127.0.0.1:3000".into(),
                username: Some("admin".into()),
                password: Some("pw".into()),
                remember: true
            }))
        );
        assert_eq!(
            parse_ipc(
                page,
                r#"{"cmd":"setStartFullscreen","value":true}"#,
                &Phase::Connect,
                true
            ),
            Some(Ipc::Connect(ConnectCmd::SetStartFullscreen(true)))
        );
        // Not from a pop-out window, not once a server page committed, never
        // host commands, and only from the connect page itself.
        assert_eq!(parse_ipc(page, r#"{"cmd":"ready"}"#, &Phase::Connect, false), None);
        let loaded = Phase::Loaded(u("http://127.0.0.1:3000/"));
        assert_eq!(parse_ipc(page, r#"{"cmd":"ready"}"#, &loaded, true), None);
        assert_eq!(
            parse_ipc(page, r#"{"cmd":"openWindow","url":"x"}"#, &Phase::Connect, true),
            None
        );
        assert_eq!(
            parse_ipc(page, r#"{"cmd":"sessionExpired"}"#, &Phase::Connect, true),
            None
        );
        assert_eq!(
            parse_ipc(
                "codemanapp://localhost/icon.png",
                r#"{"cmd":"ready"}"#,
                &Phase::Connect,
                true
            ),
            None
        );
        assert_eq!(
            parse_ipc(
                "codemanapp://elsewhere/index.html",
                r#"{"cmd":"ready"}"#,
                &Phase::Connect,
                true
            ),
            None
        );
        let long = "p".repeat(2000);
        assert_eq!(
            parse_ipc(
                page,
                &format!(r#"{{"cmd":"connect","url":"h","password":"{long}"}}"#),
                &Phase::Connect,
                true
            ),
            None
        );
    }

    #[test]
    fn external_urls_are_http_only() {
        assert!(external_url("https://github.com/Ark0N/Codeman").is_some());
        assert!(external_url("file:///Applications/Calculator.app").is_none());
        assert!(external_url("codemanapp://localhost/").is_none());
        assert!(external_url("vscode://file/x").is_none());
    }
}
