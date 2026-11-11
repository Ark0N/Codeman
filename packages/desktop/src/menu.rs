//! The menu bar.

use muda::accelerator::{Accelerator, Code, Modifiers};
use muda::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

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
}

pub struct AppMenu {
    pub bar: Menu,
    pub window_menu: Submenu,
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
    let window_menu = Submenu::with_items(
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(None),
            &PredefinedMenuItem::maximize(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::close_window(None),
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
    bar.append_items(&[&app_menu, &edit, &view, &window_menu, &help_menu])?;
    Ok(AppMenu {
        bar,
        window_menu,
        help_menu,
        start_fullscreen,
        logo_switch,
        logo_styles,
        keep_awake,
        logo_lid,
    })
}
