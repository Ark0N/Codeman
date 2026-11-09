//! The menu bar.

use muda::accelerator::{Accelerator, Code, Modifiers};
use muda::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

use crate::config::Config;
use crate::keep_awake::{self, HelperState, Mode};
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
    pub const DEVTOOLS: &str = "devtools";
    pub const HELP_DOCS: &str = "help-docs";
    pub const HELP_GITHUB: &str = "help-github";
}

pub struct AppMenu {
    pub bar: Menu,
    pub window_menu: Submenu,
    pub help_menu: Submenu,
    pub start_fullscreen: CheckMenuItem,
    /// One item per state and style. Empty on a Mac without a lit logo, which has no
    /// such menu.
    pub logo_styles: Vec<(Signal, BlinkStyle, CheckMenuItem)>,
    /// None where the app cannot keep the Mac awake (a build for another OS).
    pub keep_awake: Option<KeepAwakeMenu>,
}

/// App menu > Keep This Mac Awake.
pub struct KeepAwakeMenu {
    pub modes: Vec<(Mode, CheckMenuItem)>,
    /// Only on a Mac with a lid: a desktop Mac always runs on mains and cannot close.
    pub ac_only: Option<CheckMenuItem>,
    pub lid: Option<CheckMenuItem>,
    pub remove_helper: Option<MenuItem>,
    /// What it does right now (keep_awake::status_line). Not clickable.
    pub status: MenuItem,
}

impl KeepAwakeMenu {
    /// The lid items as the helper now is. The lid item ends in an ellipsis while
    /// choosing it asks for the administrator password first.
    pub fn show_helper(&self, state: HelperState, lid_on: bool) {
        if let Some(item) = &self.lid {
            item.set_text(lid_label(state));
            item.set_checked(lid_on && state == HelperState::Installed);
        }
        if let Some(item) = &self.remove_helper {
            item.set_enabled(state != HelperState::Missing);
        }
    }
}

fn lid_label(state: HelperState) -> &'static str {
    match state {
        HelperState::Installed => "Also With the Lid Closed",
        _ => "Also With the Lid Closed\u{2026}",
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
    let (mut ac_only, mut lid, mut remove_helper) = (None, None, None);
    if keep_awake::has_lid() {
        let state =
            keep_awake::request_path().map_or(HelperState::Missing, |request| keep_awake::helper_state(&request));
        let ac = CheckMenuItem::with_id(
            keep_awake::AC_ONLY_ID,
            "Only on Power Adapter",
            true,
            settings.ac_only,
            None,
        );
        let lid_item = CheckMenuItem::with_id(
            keep_awake::LID_ID,
            lid_label(state),
            true,
            settings.lid && state == HelperState::Installed,
            None,
        );
        let remove = MenuItem::with_id(
            keep_awake::REMOVE_HELPER_ID,
            "Remove the Lid Helper\u{2026}",
            state != HelperState::Missing,
            None,
        );
        submenu.append_items(&[&PredefinedMenuItem::separator(), &ac, &lid_item, &remove])?;
        (ac_only, lid, remove_helper) = (Some(ac), Some(lid_item), Some(remove));
    }
    let initial = match settings.mode {
        Mode::Off => keep_awake::OFF_TEXT,
        _ => keep_awake::NO_SERVER_TEXT,
    };
    let status = MenuItem::new(initial, false, None);
    submenu.append_items(&[&PredefinedMenuItem::separator(), &status])?;
    Ok((
        submenu,
        KeepAwakeMenu {
            modes,
            ac_only,
            lid,
            remove_helper,
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
    // Only a Mac with a lit Apple logo has this menu at all.
    let mut logo_styles = Vec::new();
    if logo::available() {
        let submenu = Submenu::new("Blink Apple Logo", true);
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
        view.insert(&submenu, 4)?;
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
        logo_styles,
        keep_awake,
    })
}
