//! The menu bar.

use muda::accelerator::{Accelerator, Code, Modifiers};
use muda::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

use crate::tabs::{PALETTE, PALETTE_NAMES};

use crate::config::Config;
use crate::keep_awake::{self, Mode};
use crate::logo::{self, BlinkStyle, Signal};
use crate::{APP_NAME, VERSION};

/// Codeman's repository and its documentation (the Help menu, About).
pub const REPO_URL: &str = "https://github.com/Ark0N/Codeman";
pub const DOCS_URL: &str = "https://github.com/Ark0N/Codeman/wiki";

pub mod menu_id {
    pub const SWITCH: &str = "switch-server";
    pub const ADD_AGENT: &str = "add-agent";
    pub const RELOAD: &str = "reload";
    pub const START_FULLSCREEN: &str = "start-fullscreen";
    pub const LOGO_BLINK: &str = "logo-blink";
    pub const DEVTOOLS: &str = "devtools";
    pub const HELP_DOCS: &str = "help-docs";
    pub const HELP_GITHUB: &str = "help-github";
    pub const TAB_NEW: &str = "tab-new";
    pub const TAB_CLOSE: &str = "tab-close";
    pub const TAB_REOPEN: &str = "tab-reopen";
    pub const TAB_OVERVIEW: &str = "tab-overview";
    pub const TAB_NEXT: &str = "tab-next";
    pub const TAB_PREVIOUS: &str = "tab-previous";
    pub const WINDOW_CLOSE: &str = "window-close";
    /// `tab-key-<n>`: the tab ⌘n selects (tabs::index_of_key).
    pub const TAB_KEY_PREFIX: &str = "tab-key-";
    /// `tab-menu:<tab>:<action>`: an item of a tab's right-click menu.
    pub const TAB_MENU_PREFIX: &str = "tab-menu:";
}

/// What a tab's right-click menu asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TabAction {
    Rename,
    /// A palette colour, by index into `tabs::PALETTE`.
    Color(usize),
    Reload,
    /// Show the connect page in this tab (another server, or the same with
    /// another login).
    Reconnect,
    Close,
    CloseOthers,
}

impl TabAction {
    fn id(self, tab: u64) -> String {
        let action = match self {
            TabAction::Rename => "rename".to_string(),
            TabAction::Color(i) => format!("color-{i}"),
            TabAction::Reload => "reload".to_string(),
            TabAction::Reconnect => "reconnect".to_string(),
            TabAction::Close => "close".to_string(),
            TabAction::CloseOthers => "close-others".to_string(),
        };
        format!("{}{tab}:{action}", menu_id::TAB_MENU_PREFIX)
    }

    /// The tab and action of a right-click menu item's id.
    pub fn parse(id: &str) -> Option<(u64, TabAction)> {
        let (tab, action) = id.strip_prefix(menu_id::TAB_MENU_PREFIX)?.split_once(':')?;
        let tab = tab.parse().ok()?;
        let action = match action {
            "rename" => TabAction::Rename,
            "reload" => TabAction::Reload,
            "reconnect" => TabAction::Reconnect,
            "close" => TabAction::Close,
            "close-others" => TabAction::CloseOthers,
            other => {
                let i: usize = other.strip_prefix("color-")?.parse().ok()?;
                (i < PALETTE.len()).then_some(TabAction::Color(i))?
            }
        };
        Some((tab, action))
    }
}

/// The ⌘ number of a `tab-key-<n>` item.
pub fn tab_key(id: &str) -> Option<usize> {
    id.strip_prefix(menu_id::TAB_KEY_PREFIX)?
        .parse()
        .ok()
        .filter(|k| (1..=9).contains(k))
}

/// The right-click menu of one tab. `server`: the tab shows a server (Reload
/// and Connect to Another Server make sense); `others`: there are other tabs.
pub fn tab_context_menu(tab: u64, color: &str, server: bool, others: bool) -> muda::Result<Menu> {
    let menu = Menu::new();
    menu.append(&MenuItem::with_id(
        TabAction::Rename.id(tab),
        "Rename Tab\u{2026}",
        true,
        None,
    ))?;
    let colors = Submenu::new("Tab Color", true);
    for (i, (value, name)) in PALETTE.iter().zip(PALETTE_NAMES).enumerate() {
        let chosen = value.eq_ignore_ascii_case(color);
        colors.append(&CheckMenuItem::with_id(
            TabAction::Color(i).id(tab),
            name,
            true,
            chosen,
            None,
        ))?;
    }
    menu.append(&colors)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&MenuItem::with_id(TabAction::Reload.id(tab), "Reload", server, None))?;
    menu.append(&MenuItem::with_id(
        TabAction::Reconnect.id(tab),
        "Connect This Tab to Another Server\u{2026}",
        server,
        None,
    ))?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&MenuItem::with_id(TabAction::Close.id(tab), "Close Tab", true, None))?;
    menu.append(&MenuItem::with_id(
        TabAction::CloseOthers.id(tab),
        "Close Other Tabs",
        others,
        None,
    ))?;
    Ok(menu)
}

pub struct AppMenu {
    pub bar: Menu,
    pub window_menu: Submenu,
    /// Server: the tab commands, then one item per tab (`set_tabs`).
    server_menu: Submenu,
    /// ⌘1 to ⌘9, made once and shown as many as there are tabs.
    tab_items: Vec<CheckMenuItem>,
    /// How many of `tab_items` are in the menu.
    tab_items_shown: usize,
    pub reopen: MenuItem,
    pub help_menu: Submenu,
    pub start_fullscreen: CheckMenuItem,
    /// The one switch for the logo. None on a Mac without a lit logo, which has no
    /// such menu.
    pub logo_switch: Option<CheckMenuItem>,
    /// One item per state and style, empty without the switch.
    pub logo_styles: Vec<(Signal, BlinkStyle, CheckMenuItem)>,
    /// What the closed lid did with the logo last, a line that cannot be
    /// clicked. None without the switch.
    pub logo_lid: Option<MenuItem>,
    /// None where the app cannot keep the Mac awake (a build for another OS).
    pub keep_awake: Option<KeepAwakeMenu>,
}

/// App menu > Keep This Mac Awake: Off / While Agents Work / Always, then on a
/// MacBook Only When Plugged In and With the Lid Closed, then one status line.
pub struct KeepAwakeMenu {
    pub modes: Vec<(Mode, CheckMenuItem)>,
    /// Only on a Mac with a lid: a desktop Mac always runs on mains and cannot close.
    pub ac_only: Option<CheckMenuItem>,
    /// No password behind it (lid_awake.rs).
    pub lid: Option<CheckMenuItem>,
    /// Only while the root helper Codeman 1.50.1 installed for the lid is still on
    /// this Mac. Removing it asks for the administrator password, hence the ellipsis.
    remove_old_helper: Option<MenuItem>,
    submenu: Submenu,
    /// What it does right now (keep_awake::status_line). Not clickable.
    pub status: MenuItem,
}

impl KeepAwakeMenu {
    /// The old helper is gone, and with it the item that removes it.
    pub fn old_helper_removed(&mut self) {
        if let Some(item) = self.remove_old_helper.take() {
            let _ = self.submenu.remove(&item);
        }
    }
}

fn build_keep_awake(config: &Config) -> muda::Result<(Submenu, KeepAwakeMenu)> {
    let settings = config.keep_awake;
    let submenu = Submenu::new("Keep This Mac Awake", true);
    let mut modes = Vec::new();
    for mode in Mode::ALL {
        let item = CheckMenuItem::with_id(mode.menu_id(), mode.label(), true, settings.mode == mode, None);
        submenu.append(&item)?;
        modes.push((mode, item));
    }
    let (mut ac_only, mut lid) = (None, None);
    if keep_awake::has_lid() {
        let ac = CheckMenuItem::with_id(
            keep_awake::AC_ONLY_ID,
            "Only When Plugged In",
            true,
            settings.ac_only,
            None,
        );
        let lid_item = CheckMenuItem::with_id(keep_awake::LID_ID, "With the Lid Closed", true, settings.lid, None);
        submenu.append_items(&[&PredefinedMenuItem::separator(), &ac, &lid_item])?;
        (ac_only, lid) = (Some(ac), Some(lid_item));
    }
    let mut remove_old_helper = None;
    if keep_awake::old_helper_installed() {
        let item = MenuItem::with_id(
            keep_awake::REMOVE_OLD_HELPER_ID,
            "Remove the Old Lid Helper\u{2026}",
            true,
            None,
        );
        if lid.is_none() {
            submenu.append(&PredefinedMenuItem::separator())?;
        }
        submenu.append(&item)?;
        remove_old_helper = Some(item);
    }
    let initial = match settings.mode {
        Mode::Off => keep_awake::OFF_TEXT,
        _ => keep_awake::NO_SERVER_TEXT,
    };
    let status = MenuItem::new(initial, false, None);
    submenu.append_items(&[&PredefinedMenuItem::separator(), &status])?;
    Ok((
        submenu.clone(),
        KeepAwakeMenu {
            modes,
            ac_only,
            lid,
            remove_old_helper,
            submenu,
            status,
        },
    ))
}

impl AppMenu {
    /// One item per tab under Server, as (name, in front), with ⌘1 to ⌘8 for
    /// the first eight and ⌘9 for the last (`tabs::key_of`). Items past nine
    /// tabs are left out, as Safari does.
    pub fn set_tabs(&mut self, tabs: &[(String, bool)]) {
        let len = tabs.len();
        let shown: Vec<(usize, &(String, bool))> = tabs
            .iter()
            .enumerate()
            .filter_map(|(i, t)| crate::tabs::key_of(i, len).map(|k| (k, t)))
            .collect();
        for item in self.tab_items.iter().take(self.tab_items_shown) {
            let _ = self.server_menu.remove(item);
        }
        self.tab_items_shown = 0;
        // Appended in key order, which is tab order.
        for (key, (name, active)) in shown {
            if let Some(item) = self.tab_items.get(key - 1) {
                item.set_text(name);
                item.set_checked(*active);
                if self.server_menu.append(item).is_ok() {
                    self.tab_items_shown = self.tab_items_shown.max(key);
                }
            }
        }
    }
}

pub fn build_menu(config: &Config) -> muda::Result<AppMenu> {
    let bar = Menu::new();
    let about = PredefinedMenuItem::about(
        Some("About Codeman"),
        Some(AboutMetadata {
            name: Some(APP_NAME.into()),
            version: Some(VERSION.into()),
            comments: Some("A native window for your Codeman server.".into()),
            website: Some(REPO_URL.into()),
            ..Default::default()
        }),
    );
    let switch = MenuItem::with_id(
        menu_id::SWITCH,
        "Switch Server\u{2026}",
        true,
        Some(Accelerator::new(Modifiers::META | Modifiers::SHIFT, Code::KeyO)),
    );
    let app_menu = Submenu::with_items(
        APP_NAME,
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(),
            &switch,
            &MenuItem::with_id(menu_id::ADD_AGENT, "Add a Coding Agent to This Mac\u{2026}", true, None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::services(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::hide(None),
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::show_all(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::quit(None),
        ],
    )?;
    // Right under "Add a Coding Agent to This Mac…".
    let keep_awake = match keep_awake::available() {
        true => {
            let (submenu, items) = build_keep_awake(config)?;
            app_menu.insert(&submenu, 4)?;
            Some(items)
        }
        false => None,
    };
    // Without these items Cmd+C / Cmd+V do nothing inside a WKWebView.
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    )?;
    let start_fullscreen = CheckMenuItem::with_id(
        menu_id::START_FULLSCREEN,
        "Always Open in Full Screen",
        true,
        config.start_fullscreen,
        None,
    );
    let view = Submenu::with_items(
        "View",
        true,
        &[
            &MenuItem::with_id(
                menu_id::RELOAD,
                "Reload",
                true,
                Some(Accelerator::new(Modifiers::META, Code::KeyR)),
            ),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::fullscreen(None),
            &start_fullscreen,
            &PredefinedMenuItem::separator(),
            &MenuItem::with_id(
                menu_id::DEVTOOLS,
                "Developer Tools",
                true,
                Some(Accelerator::new(Modifiers::META | Modifiers::ALT, Code::KeyI)),
            ),
        ],
    )?;
    // Only a Mac with a lit Apple logo has these items at all: the switch, and the
    // style for each state behind it.
    let mut logo_styles = Vec::new();
    let mut logo_switch = None;
    let mut logo_lid = None;
    if logo::available() {
        let switch = CheckMenuItem::with_id(
            menu_id::LOGO_BLINK,
            "Blink Apple Logo",
            true,
            config.logo_blink.enabled,
            None,
        );
        let submenu = Submenu::new("Apple Logo Blink Styles", true);
        for signal in Signal::ALL {
            let group = Submenu::new(signal.label(), true);
            for style in BlinkStyle::ALL {
                let chosen = style == config.logo_blink.get(signal);
                let item = CheckMenuItem::with_id(style.menu_id(signal), style.label(), true, chosen, None);
                group.append(&item)?;
                if style == BlinkStyle::Off {
                    group.append(&PredefinedMenuItem::separator())?;
                }
                logo_styles.push((signal, style, item));
            }
            submenu.append(&group)?;
        }
        // Right under "Always Open in Full Screen", before the separator.
        let lid = MenuItem::new(logo::lid_status_line(), false, None);
        view.insert(&switch, 4)?;
        view.insert(&submenu, 5)?;
        view.insert(&lid, 6)?;
        logo_switch = Some(switch);
        logo_lid = Some(lid);
    }
    let cmd = |code| Some(Accelerator::new(Modifiers::META, code));
    let cmd_shift = |code| Some(Accelerator::new(Modifiers::META | Modifiers::SHIFT, code));
    let reopen = MenuItem::with_id(menu_id::TAB_REOPEN, "Reopen Closed Tab", false, cmd_shift(Code::KeyT));
    let server_menu = Submenu::with_items(
        "Server",
        true,
        &[
            &MenuItem::with_id(menu_id::TAB_NEW, "New Server Tab", true, cmd(Code::KeyT)),
            &MenuItem::with_id(menu_id::TAB_CLOSE, "Close Tab", true, cmd(Code::KeyW)),
            &reopen,
            &PredefinedMenuItem::separator(),
            &MenuItem::with_id(menu_id::TAB_OVERVIEW, "Show All Servers", true, cmd(Code::Digit0)),
            &MenuItem::with_id(
                menu_id::TAB_PREVIOUS,
                "Show Previous Tab",
                true,
                cmd_shift(Code::BracketLeft),
            ),
            &MenuItem::with_id(menu_id::TAB_NEXT, "Show Next Tab", true, cmd_shift(Code::BracketRight)),
            &PredefinedMenuItem::separator(),
        ],
    )?;
    const DIGITS: [Code; 9] = [
        Code::Digit1,
        Code::Digit2,
        Code::Digit3,
        Code::Digit4,
        Code::Digit5,
        Code::Digit6,
        Code::Digit7,
        Code::Digit8,
        Code::Digit9,
    ];
    let tab_items = DIGITS
        .iter()
        .enumerate()
        .map(|(i, code)| {
            CheckMenuItem::with_id(
                format!("{}{}", menu_id::TAB_KEY_PREFIX, i + 1),
                "",
                true,
                false,
                cmd(*code),
            )
        })
        .collect();
    let window_menu = Submenu::with_items(
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(None),
            &PredefinedMenuItem::maximize(None),
            &PredefinedMenuItem::separator(),
            // Not the predefined Close Window: ⌘W closes a tab (Server menu),
            // as in Safari, so closing the window is ⇧⌘W.
            &MenuItem::with_id(menu_id::WINDOW_CLOSE, "Close Window", true, cmd_shift(Code::KeyW)),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::bring_all_to_front(None),
        ],
    )?;
    let help_menu = Submenu::with_items(
        "Help",
        true,
        &[
            &MenuItem::with_id(menu_id::HELP_DOCS, "Codeman Documentation", true, None),
            &MenuItem::with_id(menu_id::HELP_GITHUB, "Codeman on GitHub", true, None),
        ],
    )?;
    bar.append_items(&[&app_menu, &edit, &view, &server_menu, &window_menu, &help_menu])?;
    Ok(AppMenu {
        bar,
        window_menu,
        server_menu,
        tab_items,
        tab_items_shown: 0,
        reopen,
        help_menu,
        start_fullscreen,
        logo_switch,
        logo_styles,
        keep_awake,
        logo_lid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tab_menu_ids_round_trip() {
        for action in [
            TabAction::Rename,
            TabAction::Color(0),
            TabAction::Color(5),
            TabAction::Reload,
            TabAction::Reconnect,
            TabAction::Close,
            TabAction::CloseOthers,
        ] {
            assert_eq!(TabAction::parse(&action.id(42)), Some((42, action)));
        }
        assert_eq!(TabAction::parse("tab-menu:42:color-6"), None);
        assert_eq!(TabAction::parse("tab-menu:x:close"), None);
        assert_eq!(TabAction::parse("tab-menu:42:other"), None);
        assert_eq!(TabAction::parse("reload"), None);
        assert_eq!(tab_key("tab-key-1"), Some(1));
        assert_eq!(tab_key("tab-key-9"), Some(9));
        assert_eq!(tab_key("tab-key-0"), None);
        assert_eq!(tab_key("tab-key-10"), None);
    }
}
