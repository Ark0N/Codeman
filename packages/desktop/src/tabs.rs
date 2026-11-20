//! Server tabs: the pure half. One window holds a tab per Codeman server (or a
//! "New server" tab that shows the connect page), a strip across the top of
//! the window draws them (`assets/tabs.html`), and an overview of every server
//! (`assets/overview.html`) can take the place of the active tab. Everything
//! here is a decision with no window behind it, so it is unit-tested on its own:
//! names, colours, order, which data store a server's pages use, and the state
//! the two pages are sent.

use serde::Serialize;
use url::{Host, Url};

use crate::agents::{Detail, SessionState};

/// The height of the tab strip, in points. The window's other web views start
/// below it.
pub const STRIP_HEIGHT: f64 = 38.0;
/// Where the window's traffic lights go so they sit centred in the strip: the
/// close button's left edge and the buttons' centre line, in points.
pub const TRAFFIC_LIGHTS: (f64, f64) = (14.0, 19.0);
/// The longest tab name the strip accepts, in characters.
pub const MAX_NAME: usize = 40;
/// How many session rows a card of the overview gets.
pub const OVERVIEW_ROWS: usize = 4;
/// How many closed tabs Reopen Closed Tab remembers.
pub const MAX_CLOSED: usize = 10;

/// The colours a new tab is given, in turn: violet, cyan, emerald, pink,
/// amber, slate. None of them is the red, amber dot or blue of a status badge
/// at the same lightness, so a stripe never reads as an alert.
pub const PALETTE: [&str; 6] = ["#a78bfa", "#22d3ee", "#34d399", "#f472b6", "#f59e0b", "#94a3b8"];
/// The names the right-click menu gives the palette, in the same order.
pub const PALETTE_NAMES: [&str; 6] = ["Violet", "Cyan", "Green", "Pink", "Amber", "Slate"];

/// A colour the strip may draw: `#rrggbb` and nothing else, so a value read
/// from the settings file can never carry CSS.
pub fn is_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The first palette colour no open tab uses, else the palette again in turn.
pub fn next_color<'a>(used: impl IntoIterator<Item = &'a str>) -> String {
    let used: Vec<String> = used.into_iter().map(str::to_ascii_lowercase).collect();
    PALETTE
        .iter()
        .find(|c| !used.iter().any(|u| u == *c))
        .copied()
        .unwrap_or(PALETTE[used.len() % PALETTE.len()])
        .to_string()
}

/// What a tab is called until the user names it: `This Mac` for a server on
/// loopback, else the first label of its host name (`studio` for
/// `studio.example.ts.net`), or the whole address for an IP literal. A port
/// other than Codeman's 3000 (or the scheme's own) is added, so two servers on
/// one machine do not look alike.
pub fn default_name(url: &Url) -> String {
    let base = match url.host() {
        _ if crate::policy::is_loopback(url) => "This Mac".to_string(),
        Some(Host::Domain(name)) => name
            .split('.')
            .next()
            .filter(|l| !l.is_empty())
            .unwrap_or(name)
            .to_string(),
        Some(Host::Ipv4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) => format!("[{ip}]"),
        None => url.as_str().to_string(),
    };
    match url.port() {
        Some(port) if port != 3000 => format!("{base}:{port}"),
        _ => base,
    }
}

/// A name the user typed, cleaned: trimmed, control characters dropped, cut at
/// `MAX_NAME` characters. None when nothing is left, which puts the default
/// name back.
pub fn clean_name(raw: &str) -> Option<String> {
    let kept: String = raw.chars().filter(|c| !c.is_control()).collect();
    let trimmed: String = kept.trim().chars().take(MAX_NAME).collect();
    let trimmed = trimmed.trim_end().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// What a rename the strip finished does to a tab's own name: None, nothing
/// (it ended without a change: Escape, or Enter on the same text, sends the
/// name the tab shows, and kept, that would pin "New server" to a tab before
/// it has a server); `Some(None)`, back to the default name (an empty name,
/// or the default typed out); `Some(Some(name))`, that name.
pub fn renamed(typed: &str, shown: &str, default: Option<&str>) -> Option<Option<String>> {
    let Some(name) = clean_name(typed) else {
        return Some(None);
    };
    if clean_name(shown).as_deref() == Some(name.as_str()) {
        return None;
    }
    Some((default != Some(name.as_str())).then_some(name))
}

/// The identifier of the WebKit data store (cookies and local storage) that a
/// server's pages use. Each server gets one of its own, so two servers on one
/// host (a Codeman on port 3000 and a beta on 5000) never share a login cookie,
/// which carries the same name on both and is not told apart by port. Derived
/// from the server's address, so the same server finds its store, and with it
/// Codeman's per-device settings, at every launch. Two 64-bit FNV-1a hashes
/// with different starting values: stable across Rust releases, which the
/// standard library's hasher is not promised to be.
pub fn store_id(server: &str) -> [u8; 16] {
    fn fnv(bytes: &[u8], basis: u64) -> u64 {
        bytes
            .iter()
            .fold(basis, |hash, b| (hash ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3))
    }
    let bytes = server.as_bytes();
    let hi = fnv(bytes, 0xcbf2_9ce4_8422_2325);
    let lo = fnv(bytes, 0x8422_2325_cbf2_9ce4 ^ 0x5eed);
    let mut id = [0u8; 16];
    id[..8].copy_from_slice(&hi.to_be_bytes());
    id[8..].copy_from_slice(&lo.to_be_bytes());
    // A well-formed UUID: version 8 (custom), RFC 4122 variant.
    id[6] = (id[6] & 0x0f) | 0x80;
    id[8] = (id[8] & 0x3f) | 0x80;
    id
}

/// Where `from` lands when the strip asks to move it to `to`, both indexes
/// into a list of `len`. None for an index out of range or no move.
pub fn moved(len: usize, from: usize, to: usize) -> Option<usize> {
    (from < len && to < len && from != to).then_some(to)
}

/// The tab after (or before) `active` in a list of `len`, wrapping around.
pub fn neighbour(len: usize, active: usize, forward: bool) -> Option<usize> {
    match len {
        0 => None,
        _ if forward => Some((active + 1) % len),
        _ => Some((active + len - 1) % len),
    }
}

/// Which tab to show after closing the one at `closed` (of `len` before the
/// close), when it was the active one: the tab that took its place, else the
/// one before it.
pub fn after_close(len: usize, closed: usize) -> Option<usize> {
    match len {
        0 | 1 => None,
        _ if closed + 1 < len => Some(closed),
        _ => Some(closed - 1),
    }
}

/// Whether `id` can be handed to Codeman's page as a session id: what Codeman
/// makes (UUIDs) and nothing that could step out of a string.
pub fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// What a tab shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// The connect page, nothing chosen yet.
    Connect,
    /// A server's page is on its way; the connect page still shows.
    Loading,
    /// A server's page.
    Server,
}

/// What the badges of a tab are counted from: the last status read of its
/// server, and whether that server answers at all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seen {
    pub detail: Option<Detail>,
    /// The last few reads failed.
    pub offline: bool,
    /// The server refused the login: nothing is asked any more.
    pub refused: bool,
}

/// One tab as the strip and the overview see it.
#[derive(Debug, Clone)]
pub struct View<'a> {
    pub id: u64,
    pub name: String,
    pub color: &'a str,
    pub kind: Kind,
    pub url: Option<&'a Url>,
    pub version: Option<&'a str>,
    pub seen: &'a Seen,
}

#[derive(Debug, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub needs_you: usize,
    pub waiting: usize,
    pub working: usize,
    pub sessions: usize,
}

fn counts(seen: &Seen) -> Counts {
    let Some(detail) = &seen.detail else {
        return Counts::default();
    };
    let of = |state: SessionState| detail.sessions.iter().filter(|s| s.state == state).count();
    Counts {
        needs_you: of(SessionState::Needs),
        waiting: of(SessionState::Waiting),
        working: of(SessionState::Working),
        sessions: detail.sessions.len(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StripStatus {
    working: usize,
    waiting: usize,
    needs_you: usize,
    offline: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StripTab<'a> {
    id: u64,
    name: &'a str,
    color: &'a str,
    active: bool,
    kind: Kind,
    local: bool,
    url: Option<&'a str>,
    key: Option<usize>,
    status: StripStatus,
}

/// The ⌘ number of the tab at `index`: ⌘1 to ⌘8 for the first eight, ⌘9 for
/// the last one, as in Safari.
pub fn key_of(index: usize, len: usize) -> Option<usize> {
    match index {
        _ if index + 1 == len && len > 8 => Some(9),
        i if i < 8 => Some(i + 1),
        _ => None,
    }
}

/// The tab ⌘`key` selects in a list of `len`.
pub fn index_of_key(key: usize, len: usize) -> Option<usize> {
    match key {
        9 if len > 0 => Some(len - 1),
        k @ 1..=8 if k <= len => Some(k - 1),
        _ => None,
    }
}

/// The strip's whole state (`assets/tabs.html`, message `state`).
pub fn strip_state(tabs: &[View<'_>], active: Option<usize>, overview: bool, fullscreen: bool) -> serde_json::Value {
    let len = tabs.len();
    let list: Vec<StripTab<'_>> = tabs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let c = counts(t.seen);
            StripTab {
                id: t.id,
                name: &t.name,
                color: t.color,
                active: !overview && active == Some(i),
                kind: t.kind,
                local: t.url.is_some_and(crate::policy::is_loopback),
                url: t.url.map(Url::as_str),
                key: key_of(i, len),
                status: StripStatus {
                    working: c.working,
                    waiting: c.waiting,
                    needs_you: c.needs_you,
                    offline: t.kind == Kind::Server && t.seen.offline,
                },
            }
        })
        .collect();
    serde_json::json!({
        "type": "state",
        "tabs": list,
        "overviewActive": overview,
        "fullscreen": fullscreen,
    })
}

#[derive(Serialize)]
struct Row<'a> {
    id: &'a str,
    name: &'a str,
    state: SessionState,
    text: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Card<'a> {
    tab: u64,
    name: &'a str,
    color: &'a str,
    url: Option<&'a str>,
    local: bool,
    key: Option<usize>,
    version: Option<&'a str>,
    kind: Kind,
    offline: bool,
    refused: bool,
    sessions: Vec<Row<'a>>,
    counts: Counts,
}

/// The overview's whole state (`assets/overview.html`, message `state`): a
/// card per tab, the servers that need someone first, then those with an agent
/// waiting, then the rest in tab order. Each card lists its sessions most
/// urgent first, `OVERVIEW_ROWS` at most.
pub fn overview_state(tabs: &[View<'_>]) -> serde_json::Value {
    let len = tabs.len();
    let mut cards: Vec<(usize, Card<'_>)> = tabs
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let mut rows: Vec<Row<'_>> = t
                .seen
                .detail
                .iter()
                .flat_map(|d| d.sessions.iter())
                .map(|s| Row {
                    id: &s.id,
                    name: &s.name,
                    state: s.state,
                    text: &s.text,
                })
                .collect();
            rows.sort_by_key(|r| r.state.rank());
            rows.truncate(OVERVIEW_ROWS);
            (
                i,
                Card {
                    tab: t.id,
                    name: &t.name,
                    color: t.color,
                    url: t.url.map(Url::as_str),
                    local: t.url.is_some_and(crate::policy::is_loopback),
                    key: key_of(i, len),
                    version: t.version,
                    kind: t.kind,
                    offline: t.kind == Kind::Server && t.seen.offline,
                    refused: t.seen.refused,
                    sessions: rows,
                    counts: counts(t.seen),
                },
            )
        })
        .collect();
    cards.sort_by_key(|(i, card)| {
        let urgency = match (card.counts.needs_you, card.counts.waiting) {
            (n, _) if n > 0 => 0,
            (_, w) if w > 0 => 1,
            _ => 2,
        };
        (urgency, *i)
    });
    let servers: Vec<Card<'_>> = cards.into_iter().map(|(_, c)| c).collect();
    serde_json::json!({ "type": "state", "servers": servers })
}

/// The window title while a tab shows: the page's own title, else the tab's
/// name.
pub fn window_title(page_title: Option<&str>, name: &str) -> String {
    match page_title.map(str::trim) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => name.to_string(),
    }
}

/// Whether two server addresses are on the same host (scheme and port aside):
/// the case where, without a data store of their own, they would share a login
/// cookie.
pub fn same_host(a: &Url, b: &Url) -> bool {
    match (a.host_str(), b.host_str()) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::SessionRow;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn colours_are_hex_only() {
        assert!(is_color("#a78bfa"));
        assert!(is_color("#A78BFA"));
        assert!(!is_color("a78bfa"));
        assert!(!is_color("#a78bf"));
        assert!(!is_color("#a78bfg"));
        assert!(!is_color("red;background:url(x)"));
        assert!(!is_color("#a78bfa;"));
    }

    #[test]
    fn new_tabs_take_the_first_free_colour() {
        assert_eq!(next_color([]), PALETTE[0]);
        assert_eq!(next_color([PALETTE[0]]), PALETTE[1]);
        assert_eq!(next_color([PALETTE[1], "#A78BFA"]), PALETTE[2]);
        let all: Vec<&str> = PALETTE.to_vec();
        assert_eq!(next_color(all.clone()), PALETTE[0]);
        let mut seven = all;
        seven.push(PALETTE[0]);
        assert_eq!(next_color(seven), PALETTE[1]);
    }

    #[test]
    fn default_names() {
        assert_eq!(default_name(&u("http://127.0.0.1:3000/")), "This Mac");
        assert_eq!(default_name(&u("http://localhost:3000/")), "This Mac");
        assert_eq!(default_name(&u("http://127.0.0.1:5000/")), "This Mac:5000");
        assert_eq!(default_name(&u("https://studio.example.ts.net/")), "studio");
        assert_eq!(default_name(&u("http://build-01.lan:3000/")), "build-01");
        assert_eq!(default_name(&u("http://192.168.1.40:3000/")), "192.168.1.40");
        assert_eq!(
            default_name(&u("http://192.168.1.40:8080/codeman/")),
            "192.168.1.40:8080"
        );
        assert_eq!(default_name(&u("http://[fd00::1]:3000/")), "[fd00::1]");
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("  studio  ").as_deref(), Some("studio"));
        assert_eq!(clean_name("a\u{0}b\nc").as_deref(), Some("abc"));
        assert_eq!(clean_name("   "), None);
        assert_eq!(clean_name(""), None);
        let long = "x".repeat(100);
        assert_eq!(clean_name(&long).map(|n| n.chars().count()), Some(MAX_NAME));
        // Characters, not bytes: a multi-byte name is not cut inside a character.
        let wide = "ü".repeat(60);
        assert_eq!(clean_name(&wide).map(|n| n.chars().count()), Some(MAX_NAME));
    }

    #[test]
    fn renames() {
        // Escape on a new tab sends back what it shows: nothing changes.
        assert_eq!(renamed("New server", "New server", None), None);
        assert_eq!(renamed("  studio ", "studio", Some("studio")), None);
        assert_eq!(
            renamed("prod box", "studio", Some("studio")),
            Some(Some("prod box".into()))
        );
        // The default typed out, or nothing at all, is the default again.
        assert_eq!(renamed("studio", "prod box", Some("studio")), Some(None));
        assert_eq!(renamed("   ", "prod box", Some("studio")), Some(None));
        // A shown name longer than a name may be, sent back unchanged.
        let long = "x".repeat(60);
        assert_eq!(renamed(&long, &long, None), None);
    }

    #[test]
    fn store_ids_are_stable_and_distinct() {
        let a = store_id("http://127.0.0.1:3000/");
        assert_eq!(a, store_id("http://127.0.0.1:3000/"));
        assert_ne!(a, store_id("http://127.0.0.1:5000/"));
        assert_ne!(a, store_id("http://127.0.0.1:3000/x/"));
        // Version 8, RFC 4122 variant.
        assert_eq!(a[6] >> 4, 8);
        assert_eq!(a[8] >> 6, 0b10);
        // Pinned, so a change of the hash (which would cost every server its
        // local storage) fails here first.
        assert_eq!(
            store_id(""),
            [0xcb, 0xf2, 0x9c, 0xe4, 0x84, 0x22, 0x83, 0x25, 0x84, 0x22, 0x23, 0x25, 0xcb, 0xf2, 0xc2, 0x09]
        );
    }

    #[test]
    fn order_helpers() {
        assert_eq!(moved(3, 0, 2), Some(2));
        assert_eq!(moved(3, 1, 1), None);
        assert_eq!(moved(3, 3, 0), None);
        assert_eq!(moved(3, 0, 3), None);
        assert_eq!(neighbour(3, 2, true), Some(0));
        assert_eq!(neighbour(3, 0, false), Some(2));
        assert_eq!(neighbour(0, 0, true), None);
        assert_eq!(after_close(3, 0), Some(0));
        assert_eq!(after_close(3, 2), Some(1));
        assert_eq!(after_close(1, 0), None);
    }

    #[test]
    fn command_numbers() {
        assert_eq!(key_of(0, 3), Some(1));
        assert_eq!(key_of(2, 3), Some(3));
        assert_eq!(key_of(7, 12), Some(8));
        assert_eq!(key_of(8, 12), None);
        assert_eq!(key_of(11, 12), Some(9));
        assert_eq!(key_of(8, 9), Some(9));
        assert_eq!(index_of_key(1, 3), Some(0));
        assert_eq!(index_of_key(3, 3), Some(2));
        assert_eq!(index_of_key(4, 3), None);
        assert_eq!(index_of_key(9, 3), Some(2));
        assert_eq!(index_of_key(9, 0), None);
        assert_eq!(index_of_key(0, 3), None);
    }

    #[test]
    fn session_ids() {
        assert!(is_session_id("0f8d0215-661e-4a1c-bfad-d7f6fd2ed4b5"));
        assert!(!is_session_id(""));
        assert!(!is_session_id("a'b"));
        assert!(!is_session_id("a\"); alert(1); (\""));
        assert!(!is_session_id(&"a".repeat(129)));
    }

    fn row(id: &str, state: SessionState) -> SessionRow {
        SessionRow {
            id: id.into(),
            name: id.into(),
            state,
            text: String::new(),
        }
    }

    fn seen(rows: Vec<SessionRow>) -> Seen {
        Seen {
            detail: Some(Detail { sessions: rows }),
            offline: false,
            refused: false,
        }
    }

    #[test]
    fn strip_state_marks_the_active_tab_and_counts() {
        let a = u("http://127.0.0.1:3000/");
        let b = u("https://studio.example.ts.net/");
        let busy = seen(vec![
            row("1", SessionState::Working),
            row("2", SessionState::Needs),
            row("3", SessionState::Needs),
            row("4", SessionState::Waiting),
        ]);
        let none = Seen {
            offline: true,
            ..Seen::default()
        };
        let tabs = [
            View {
                id: 1,
                name: "This Mac".into(),
                color: PALETTE[0],
                kind: Kind::Server,
                url: Some(&a),
                version: None,
                seen: &busy,
            },
            View {
                id: 2,
                name: "studio".into(),
                color: PALETTE[1],
                kind: Kind::Server,
                url: Some(&b),
                version: None,
                seen: &none,
            },
        ];
        let state = strip_state(&tabs, Some(1), false, true);
        assert_eq!(state["type"], "state");
        assert_eq!(state["fullscreen"], true);
        assert_eq!(state["tabs"][0]["active"], false);
        assert_eq!(state["tabs"][1]["active"], true);
        assert_eq!(state["tabs"][0]["local"], true);
        assert_eq!(state["tabs"][0]["status"]["needsYou"], 2);
        assert_eq!(state["tabs"][0]["status"]["waiting"], 1);
        assert_eq!(state["tabs"][0]["status"]["working"], 1);
        assert_eq!(state["tabs"][1]["status"]["offline"], true);
        assert_eq!(state["tabs"][1]["key"], 2);
        // The overview takes the place of the active tab.
        let state = strip_state(&tabs, Some(1), true, false);
        assert_eq!(state["tabs"][1]["active"], false);
        assert_eq!(state["overviewActive"], true);
    }

    #[test]
    fn overview_puts_urgent_servers_and_sessions_first() {
        let a = u("http://127.0.0.1:3000/");
        let b = u("https://studio.example.ts.net/");
        let calm = seen(vec![row("w", SessionState::Working), row("i", SessionState::Idle)]);
        let urgent = seen(vec![
            row("i1", SessionState::Idle),
            row("i2", SessionState::Idle),
            row("w1", SessionState::Working),
            row("n1", SessionState::Needs),
            row("y1", SessionState::Waiting),
            row("i3", SessionState::Idle),
        ]);
        let tabs = [
            View {
                id: 10,
                name: "This Mac".into(),
                color: PALETTE[0],
                kind: Kind::Server,
                url: Some(&a),
                version: Some("1.51.0"),
                seen: &calm,
            },
            View {
                id: 11,
                name: "studio".into(),
                color: PALETTE[1],
                kind: Kind::Server,
                url: Some(&b),
                version: None,
                seen: &urgent,
            },
        ];
        let state = overview_state(&tabs);
        let servers = state["servers"].as_array().unwrap();
        assert_eq!(servers[0]["tab"], 11);
        assert_eq!(servers[0]["key"], 2);
        assert_eq!(servers[1]["tab"], 10);
        let rows: Vec<&str> = servers[0]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(rows, ["n1", "y1", "w1", "i1"]);
        assert_eq!(servers[0]["counts"]["sessions"], 6);
        assert_eq!(servers[0]["sessions"][0]["state"], "needs");
        assert_eq!(servers[1]["version"], "1.51.0");
    }

    #[test]
    fn titles_and_hosts() {
        assert_eq!(window_title(Some(" Codeman "), "atlas"), "Codeman");
        assert_eq!(window_title(Some(""), "atlas"), "atlas");
        assert_eq!(window_title(None, "atlas"), "atlas");
        assert!(same_host(&u("http://127.0.0.1:3000/"), &u("http://127.0.0.1:5000/")));
        assert!(same_host(&u("http://Studio.lan:3000/"), &u("https://studio.lan/")));
        assert!(!same_host(&u("http://127.0.0.1:3000/"), &u("http://localhost:3000/")));
    }
}
