//! Full screen over the whole display, the strip beside the camera included.
//!
//! On a MacBook with a camera housing (the notch), macOS's own full screen
//! never uses the top of the display: the window ends below the housing and a
//! black bar covers the strip beside it. No setting changes that, the system
//! letterboxes every native full-screen Space. What an app can do is the older
//! kind of full screen: take the title bar off the window, hide the Dock and
//! the menu bar, and give the window the display's whole frame, which reaches
//! under the housing. Terminals offer it for the same reason (Ghostty's
//! `macos-non-native-fullscreen`, WezTerm's
//! `macos_fullscreen_extend_behind_notch`, iTerm2's and kitty's traditional
//! full screen).
//!
//! **View > Full Screen Uses the Area Beside the Camera** turns it on, and from
//! then on every way into full screen takes it on a display that has a
//! housing: the green button, the menu item, its shortcut, and the app's own
//! launch into full screen. They all end in `-[NSWindow toggleFullScreen:]`,
//! so `install` adds an override of that one method to tao's window class and
//! `toggle` decides there: leave this mode, hand over to macOS (a display
//! without a housing, the option off, a window already in a native Space), or
//! enter this mode. One more override keeps the window usable without its title
//! bar: `performClose:` asks the delegate directly (AppKit's version beeps for
//! a window with no close button). The menu item keeps the one title it has in
//! both kinds of full screen, "Toggle Full Screen": muda turns menu validation
//! off, so AppKit never renames it either.
//!
//! The two kinds of full screen must not overlap. A window that is changing
//! into or out of macOS's full screen is animating for most of a second, and
//! taking its title bar off in the middle leaves it with the wrong frame and
//! the wrong options. AppKit says when such a change begins and ends
//! (`NSWindowWill…`/`Did…FullScreenNotification`), and `NativeTransition`
//! keeps that per window: while one is under way a toggle is left to macOS,
//! this mode is not entered (`Entry::Busy`, the caller asks again), and the
//! app does not save the window's frame.
//!
//! The housing hides whatever is drawn behind it, so the page has to keep out
//! of its way. Codeman's page does (`src/web/public/host-cutout.js`): it says
//! so through `CodemanHost.cutoutReady()`, and is then told where the housing
//! is (`page_script`). Until a page has said so, and for every page that never
//! does (an older Codeman server, the connect page, a raw file), the web view
//! is kept below the housing and the strip stays black, which is what macOS's
//! own full screen looks like. So an old server never ends up with its tabs
//! behind the camera.
//!
//! What this mode gives up: it is not a Space. The window covers the desktop it
//! is on, there is no slide animation, and other apps' windows on that desktop
//! come up in front of it. That is why it is an option and not the default.
//!
//! The decisions are pure and unit-tested here; `imp` only reads AppKit and
//! applies them. Like `macos`, it never panics on purpose (the release build
//! aborts on panic): thread-locals go through `try_with`/`try_borrow`, and no
//! borrow is held across a call into AppKit, which posts notifications (the
//! ones above) from inside the call that causes them.

/// The camera housing of a display: a rectangle at its top edge, in points
/// from the display's top-left corner.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cutout {
    pub left: f64,
    pub width: f64,
    pub height: f64,
}

/// What a display says about its camera housing.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Housing {
    /// How far the housing reaches down (the display's top safe-area inset).
    pub height: f64,
    /// Where the housing is in that strip. None when the display does not
    /// say, or leaves no usable room beside it: nothing is drawn in the strip
    /// then.
    pub cutout: Option<Cutout>,
}

/// The least room beside the housing that is worth drawing in.
const MIN_SIDE: f64 = 120.0;
/// A housing taller than this is not one (the real ones are 32 to 38 points).
const MAX_HOUSING_HEIGHT: f64 = 200.0;

/// A display's housing from what `NSScreen` reports: the width of its frame,
/// the top of `safeAreaInsets`, and the widths of `auxiliaryTopLeftArea` and
/// `auxiliaryTopRightArea`. None for a display without one.
pub fn housing(screen_width: f64, safe_top: f64, left_area: f64, right_area: f64) -> Option<Housing> {
    if !safe_top.is_finite() || !(1.0..=MAX_HOUSING_HEIGHT).contains(&safe_top) {
        return None;
    }
    let width = screen_width - left_area - right_area;
    let usable = [screen_width, left_area, right_area].iter().all(|v| v.is_finite())
        && left_area >= MIN_SIDE
        && right_area >= MIN_SIDE
        && width >= 1.0;
    Some(Housing {
        height: safe_top,
        cutout: usable.then_some(Cutout {
            left: left_area,
            width,
            height: safe_top,
        }),
    })
}

/// What a request to toggle full screen does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Toggle {
    /// The window is in this mode: back to its windowed frame.
    LeaveWhole,
    /// macOS's own full screen, in or out.
    Native,
    /// Take the whole display.
    EnterWhole,
}

/// `whole`: the window is in this mode. `native`: it is in (or on its way
/// through) macOS's full screen. `enabled`: the option. `housing`: the display
/// it is on has a camera housing; without one macOS's full screen already
/// uses every pixel, and keeps its Space.
pub fn toggle(whole: bool, native: bool, enabled: bool, housing: bool) -> Toggle {
    if whole {
        Toggle::LeaveWhole
    } else if native || !enabled || !housing {
        Toggle::Native
    } else {
        Toggle::EnterWhole
    }
}

/// What a window shows at the top of the display.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Layout {
    /// How far the web view is kept below the top of the window, in points.
    pub inset: f64,
    /// The housing the page is told about, when it draws beside it.
    pub cutout: Option<Cutout>,
}

/// `active`: the window is in this mode. `housing`: the display it is on.
/// `page_ready`: its page said it keeps clear of a housing. The web view goes
/// under the housing only for such a page on a display that says where the
/// housing is; otherwise it stays below it.
pub fn layout(active: bool, housing: Option<Housing>, page_ready: bool) -> Layout {
    match housing.filter(|_| active) {
        Some(Housing {
            cutout: Some(cutout), ..
        }) if page_ready => Layout {
            inset: 0.0,
            cutout: Some(cutout),
        },
        Some(housing) => Layout {
            inset: housing.height,
            cutout: None,
        },
        None => Layout {
            inset: 0.0,
            cutout: None,
        },
    }
}

/// Tells the page where the housing is (`None`: nowhere any more). Run in the
/// main frame; it does nothing in a page without Codeman's cutout module.
pub fn page_script(cutout: Option<Cutout>) -> String {
    let arg = match cutout {
        Some(c) => format!("{{left:{:.1},width:{:.1},height:{:.1}}}", c.left, c.width, c.height),
        None => "null".to_string(),
    };
    format!(
        "window.CodemanHostCutout&&typeof window.CodemanHostCutout.apply==='function'&&window.CodemanHostCutout.apply({arg});"
    )
}

// NSApplicationPresentationOptions, as plain bits so the rule below is tested
// on any host (`imp` asserts they match AppKit's).
const AUTO_HIDE_DOCK: usize = 1 << 0;
const HIDE_DOCK: usize = 1 << 1;
const AUTO_HIDE_MENU_BAR: usize = 1 << 2;
const HIDE_MENU_BAR: usize = 1 << 3;
const PRESENTATION_FULL_SCREEN: usize = 1 << 10;

/// The presentation options to set when a window enters this mode, and the
/// bits of them that were not set before (to take off again on the way out).
/// None when they must be left alone: inside a native full-screen Space AppKit
/// owns them, and setting them there throws.
///
/// AppKit also throws for a combination it does not allow (an auto-hidden menu
/// bar needs a hidden or auto-hidden Dock, and each pair excludes itself), so
/// only what is missing is added, to options that were valid before.
pub fn presentation_for_entry(before: usize) -> Option<(usize, usize)> {
    if before & PRESENTATION_FULL_SCREEN != 0 {
        return None;
    }
    let mut after = before;
    if after & (AUTO_HIDE_DOCK | HIDE_DOCK) == 0 {
        after |= AUTO_HIDE_DOCK;
    }
    if after & (AUTO_HIDE_MENU_BAR | HIDE_MENU_BAR) == 0 {
        after |= AUTO_HIDE_MENU_BAR;
    }
    Some((after, after & !before))
}

/// The options to go back to when the last window leaves this mode: `current`
/// without what `presentation_for_entry` added. None inside a native
/// full-screen Space, or when nothing was added.
pub fn presentation_for_exit(current: usize, added: usize) -> Option<usize> {
    if current & PRESENTATION_FULL_SCREEN != 0 || added == 0 {
        return None;
    }
    let mut after = current & !added;
    // The menu bar cannot stay (auto-)hidden once the Dock shows again.
    if after & (AUTO_HIDE_DOCK | HIDE_DOCK) == 0 {
        after &= !(AUTO_HIDE_MENU_BAR | HIDE_MENU_BAR);
    }
    (after != current).then_some(after)
}

/// What to do so the presentation options match `wanted` (some window is in
/// this mode), given the ones in force and the bits this module `added` so
/// far: the options to set, if they have to change, and the bits it will have
/// added from then on. None while AppKit owns the options (a native
/// full-screen Space is in front): nothing is set and nothing forgotten, and
/// the caller asks again when that changes, so what was added is taken off
/// later rather than never.
pub fn presentation_step(current: usize, added: usize, wanted: bool) -> Option<(Option<usize>, usize)> {
    if current & PRESENTATION_FULL_SCREEN != 0 {
        return None;
    }
    if wanted {
        let (after, new) = presentation_for_entry(current)?;
        return Some(((after != current).then_some(after), added | new));
    }
    Some((presentation_for_exit(current, added), 0))
}

/// How long a change into or out of macOS's full screen may take before it is
/// taken to have ended without AppKit saying so (an entry that failed says
/// nothing). The animation takes well under a second.
const TRANSITION_CEILING: std::time::Duration = std::time::Duration::from_secs(5);
/// How long after such a change ended the window is still left alone: tao
/// puts its style back in a block it queues when the change ends, and this
/// mode must not get in before that.
const TRANSITION_SETTLE: std::time::Duration = std::time::Duration::from_millis(300);

/// Where a window is in a change into or out of macOS's own full screen.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct NativeTransition {
    /// A change began and has not ended: until when it counts as under way.
    until: Option<std::time::Instant>,
    /// A change ended: until when the window is still settling.
    settling: Option<std::time::Instant>,
}

impl NativeTransition {
    /// AppKit said the window will enter or leave full screen.
    pub fn began(&mut self, now: std::time::Instant) {
        self.until = Some(now + TRANSITION_CEILING);
        self.settling = None;
    }

    /// AppKit said the window did enter or leave full screen.
    pub fn ended(&mut self, now: std::time::Instant) {
        self.until = None;
        self.settling = Some(now + TRANSITION_SETTLE);
    }

    /// The window is animating between windowed and macOS's full screen.
    pub fn under_way(&self, now: std::time::Instant) -> bool {
        self.until.is_some_and(|until| now < until)
    }

    /// Under way, or only just over: not the moment to restyle the window.
    pub fn busy(&self, now: std::time::Instant) -> bool {
        self.under_way(now) || self.settling.is_some_and(|until| now < until)
    }
}

/// What asking a window into full screen came to (`enter`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entry {
    /// The window covers the whole display now (or already did).
    Entered,
    /// This mode does not apply (the option is off, or the display has no
    /// housing): the caller uses macOS's full screen.
    NotWanted,
    /// It applies, but the window is still in macOS's full screen, or on its
    /// way into or out of it: ask again shortly.
    Busy,
}

/// Whether a display with a camera housing is connected right now.
#[cfg(target_os = "macos")]
pub fn available() -> bool {
    imp::available()
}

/// Turns the option on or off. Windows already in full screen stay as they
/// are; the caller moves them over (`App::set_whole_screen`).
#[cfg(target_os = "macos")]
pub fn set_enabled(on: bool) {
    imp::set_enabled(on);
}

/// Called on the main thread with a window (`window_key`) whenever it entered
/// or left this mode, from wherever that was asked (the green button and the
/// menu item call AppKit, not the app), when it finished a change into or out
/// of macOS's full screen, and when the displays changed under a window in
/// this mode. It should only post an event; the app then calls `sync`.
#[cfg(target_os = "macos")]
pub fn set_change_handler(handler: Box<dyn Fn(usize)>) {
    imp::set_change_handler(handler);
}

/// How the change handler names a window.
#[cfg(target_os = "macos")]
pub fn window_key(window: &tao::window::Window) -> usize {
    imp::window_key(window)
}

/// Makes `window` take part: adds the overrides to its class (once) and
/// remembers its web view. Call it for every window, after its web view is
/// built. Main thread only.
#[cfg(target_os = "macos")]
pub fn install(window: &tao::window::Window, webview: &wry::WebView) {
    imp::install(window, webview);
}

/// The window is going away.
#[cfg(target_os = "macos")]
pub fn forget(window: &tao::window::Window) {
    imp::forget(window);
}

/// Whether `window` covers the whole display through this mode.
#[cfg(target_os = "macos")]
pub fn is_active(window: &tao::window::Window) -> bool {
    imp::is_active(window)
}

/// Whether full screen for `window` would be this mode right now: the option
/// is on and the display it is on has a camera housing.
#[cfg(target_os = "macos")]
pub fn applies_to(window: &tao::window::Window) -> bool {
    imp::applies_to(window)
}

/// Whether `window` is animating into or out of macOS's own full screen. Its
/// frame is neither the windowed one nor a full-screen one then.
#[cfg(target_os = "macos")]
pub fn in_transition(window: &tao::window::Window) -> bool {
    imp::in_transition(window)
}

/// Puts `window` into this mode if it applies to it.
#[cfg(target_os = "macos")]
pub fn enter(window: &tao::window::Window) -> Entry {
    imp::enter_window(window)
}

/// Takes `window` out of this mode, back to its windowed frame. Does nothing
/// for a window that is not in it.
#[cfg(target_os = "macos")]
pub fn leave(window: &tao::window::Window) {
    imp::leave_window(window);
}

/// The page in `window` said it keeps clear of a housing (true), or a new
/// document replaced it (false).
#[cfg(target_os = "macos")]
pub fn set_page_ready(window: &tao::window::Window, ready: bool) {
    imp::set_page_ready(window, ready);
}

/// Brings `window` in line with where it is now: its frame with the display it
/// is on (it moved, or the display changed), the web view's distance from the
/// top, and what the page knows. Returns the script to run in the page when
/// the page has to be told something new. Cheap when nothing changed.
#[cfg(target_os = "macos")]
pub fn sync(window: &tao::window::Window) -> Option<String> {
    imp::sync(window)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::ffi::CStr;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::ptr::{self, NonNull};
    use std::rc::Rc;
    use std::time::Instant;

    use block2::RcBlock;
    use objc2::ffi::class_addMethod;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Imp, NSObjectProtocol, ProtocolObject, Sel};
    use objc2::{msg_send, sel, ClassType, Message};
    use objc2_app_kit::{
        NSApplication, NSApplicationDidChangeScreenParametersNotification, NSApplicationPresentationOptions,
        NSResponder, NSScreen, NSView, NSWindow, NSWindowDidEnterFullScreenNotification,
        NSWindowDidExitFullScreenNotification, NSWindowStyleMask, NSWindowWillEnterFullScreenNotification,
        NSWindowWillExitFullScreenNotification,
    };
    use objc2_foundation::{
        MainThreadMarker, NSNotification, NSNotificationCenter, NSNotificationName, NSOperationQueue, NSPoint, NSRect,
        NSSize,
    };
    use tao::platform::macos::WindowExtMacOS;
    use wry::WebViewExtMacOS;

    use super::{Entry, Housing, Layout, NativeTransition, Toggle};

    const _: () = {
        assert!(NSApplicationPresentationOptions::AutoHideDock.bits() == super::AUTO_HIDE_DOCK);
        assert!(NSApplicationPresentationOptions::HideDock.bits() == super::HIDE_DOCK);
        assert!(NSApplicationPresentationOptions::AutoHideMenuBar.bits() == super::AUTO_HIDE_MENU_BAR);
        assert!(NSApplicationPresentationOptions::HideMenuBar.bits() == super::HIDE_MENU_BAR);
        assert!(NSApplicationPresentationOptions::FullScreen.bits() == super::PRESENTATION_FULL_SCREEN);
    };

    /// What a window was before it took the whole display.
    #[derive(Clone)]
    struct Saved {
        /// Its content area on screen; the frame is rebuilt around it, since
        /// the title bar is gone in between.
        content: NSRect,
        style: NSWindowStyleMask,
        movable: bool,
        background: Option<Retained<AnyObject>>,
    }

    /// A registration with the notification center, kept to take it back.
    type Observer = Retained<ProtocolObject<dyn NSObjectProtocol>>;

    struct Tracked {
        /// The NSWindow's address: what the overrides and the app both have.
        window: usize,
        /// The web view, kept below the housing for a page that is not ready.
        web_view: Retained<NSView>,
        page_ready: bool,
        /// Some while the window is in this mode.
        saved: Option<Saved>,
        /// The display frame the window was last given. It is given a frame
        /// again only when its display's frame is another one (it moved to
        /// another display, the resolution changed), never because its own
        /// frame differs: if macOS ever adjusts the frame it was given, the two
        /// must not take turns at it.
        fitted: Option<NSRect>,
        /// What the web view and the page were given last.
        applied: Layout,
        /// The page of this document was told `applied.cutout`.
        told: bool,
        /// Where the window is in a change of macOS's own full screen.
        native: NativeTransition,
        /// The window's full-screen notifications, until `forget`.
        observers: Vec<Observer>,
    }

    thread_local! {
        static ENABLED: Cell<bool> = const { Cell::new(false) };
        static WINDOWS: RefCell<Vec<Tracked>> = const { RefCell::new(Vec::new()) };
        /// The presentation options this module added and has not taken off.
        static ADDED: Cell<usize> = const { Cell::new(0) };
        static ON_CHANGE: RefCell<Option<ChangeHandler>> = const { RefCell::new(None) };
        /// The class that already has the overrides.
        static OVERRIDDEN: Cell<usize> = const { Cell::new(0) };
        /// The displays are being watched.
        static WATCHING_SCREENS: Cell<bool> = const { Cell::new(false) };
    }

    /// Told the window (`key`) that entered or left this mode.
    type ChangeHandler = Rc<dyn Fn(usize)>;
    type ActionFn = extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

    fn ns_window(window: &tao::window::Window) -> Option<&NSWindow> {
        MainThreadMarker::new()?;
        // SAFETY: tao hands out a pointer to its live NSWindow (objc2-app-kit
        // 0.3.2, the crate used here), null-checked by `as_ref`; the reference
        // lives no longer than the borrow of `window`.
        unsafe { window.ns_window().cast::<NSWindow>().as_ref() }
    }

    fn key(window: &NSWindow) -> usize {
        ptr::from_ref(window) as usize
    }

    pub(super) fn window_key(window: &tao::window::Window) -> usize {
        window.ns_window() as usize
    }

    /// Runs `f` on the record of `window`. None when there is none, or the
    /// list is in use (which no caller's nesting allows; fail closed anyway).
    /// `f` must not call into AppKit.
    fn with_tracked<R>(window: usize, f: impl FnOnce(&mut Tracked) -> R) -> Option<R> {
        WINDOWS
            .try_with(|list| {
                let mut list = list.try_borrow_mut().ok()?;
                list.iter_mut().find(|t| t.window == window).map(f)
            })
            .ok()
            .flatten()
    }

    fn active(window: usize) -> bool {
        with_tracked(window, |t| t.saved.is_some()).unwrap_or(false)
    }

    /// The windows in this mode, without `but`.
    fn active_windows(but: Option<usize>) -> Vec<usize> {
        WINDOWS
            .try_with(|list| {
                list.try_borrow().map_or_else(
                    |_| Vec::new(),
                    |list| {
                        list.iter()
                            .filter(|t| t.saved.is_some() && Some(t.window) != but)
                            .map(|t| t.window)
                            .collect()
                    },
                )
            })
            .unwrap_or_default()
    }

    fn enabled() -> bool {
        ENABLED.try_with(Cell::get).unwrap_or(false)
    }

    pub(super) fn set_enabled(on: bool) {
        let _ = ENABLED.try_with(|enabled| enabled.set(on));
    }

    pub(super) fn set_change_handler(handler: Box<dyn Fn(usize)>) {
        let handler: ChangeHandler = Rc::from(handler);
        let _ = ON_CHANGE.try_with(|slot| {
            if let Ok(mut slot) = slot.try_borrow_mut() {
                *slot = Some(handler);
            }
        });
    }

    fn changed(window: usize) {
        let handler = ON_CHANGE
            .try_with(|slot| slot.try_borrow().ok().and_then(|slot| slot.clone()))
            .ok()
            .flatten();
        if let Some(handler) = handler {
            handler(window);
        }
    }

    /// The housing of `screen`. None on a macOS without the safe-area API
    /// (before 12, where no Mac has a housing either) and for a display
    /// without one.
    fn screen_housing(screen: &NSScreen) -> Option<Housing> {
        // SAFETY: asking a live object whether it has a method.
        let has_api: bool = unsafe { msg_send![screen, respondsToSelector: sel!(safeAreaInsets)] };
        if !has_api {
            return None;
        }
        super::housing(
            screen.frame().size.width,
            screen.safeAreaInsets().top,
            screen.auxiliaryTopLeftArea().size.width,
            screen.auxiliaryTopRightArea().size.width,
        )
    }

    pub(super) fn available() -> bool {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        NSScreen::screens(mtm)
            .to_vec()
            .iter()
            .any(|screen| screen_housing(screen).is_some())
    }

    /// Calls `on` whenever `name` is posted (about `object`, when given).
    fn observe(name: &NSNotificationName, object: Option<&AnyObject>, on: impl Fn() + 'static) -> Observer {
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = catch_unwind(AssertUnwindSafe(&on));
        });
        // SAFETY: `object` is nil or the window these names are posted about.
        // With no queue the block runs on the posting thread, which for these
        // AppKit notifications is the main thread, where the block was made.
        unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(name),
                object,
                None,
                &block,
            )
        }
    }

    /// AppKit's word on when `window` begins and ends a change into or out of
    /// its own full screen.
    fn observe_window(window: &NSWindow) -> Vec<Observer> {
        let id = key(window);
        let object = AsRef::<AnyObject>::as_ref(window);
        // SAFETY: constant names exported by AppKit.
        let (will_enter, will_exit, did_enter, did_exit) = unsafe {
            (
                NSWindowWillEnterFullScreenNotification,
                NSWindowWillExitFullScreenNotification,
                NSWindowDidEnterFullScreenNotification,
                NSWindowDidExitFullScreenNotification,
            )
        };
        vec![
            observe(will_enter, Some(object), move || native_began(id)),
            observe(will_exit, Some(object), move || native_began(id)),
            observe(did_enter, Some(object), move || native_ended(id)),
            observe(did_exit, Some(object), move || native_ended(id)),
        ]
    }

    fn native_began(window: usize) {
        with_tracked(window, |t| t.native.began(Instant::now()));
    }

    fn native_ended(window: usize) {
        with_tracked(window, |t| t.native.ended(Instant::now()));
        // A native Space opening or closing changes who owns the Dock and the
        // menu bar: what could not be set or taken off meanwhile is done now,
        // outside the notification.
        on_next_turn(move || {
            reconcile_presentation(!active_windows(None).is_empty());
            changed(window);
        });
    }

    /// A display was added, removed or changed its resolution: a window in
    /// this mode gets its display's new frame. tao reports a move or a resize
    /// for most of that, but not for a change that leaves the window where it
    /// was.
    fn watch_screens() {
        if WATCHING_SCREENS
            .try_with(|watching| watching.replace(true))
            .unwrap_or(true)
        {
            return;
        }
        // SAFETY: a constant name exported by AppKit.
        let name = unsafe { NSApplicationDidChangeScreenParametersNotification };
        // The notification center keeps the registration for the life of the app.
        let _ = observe(name, None, || {
            for window in active_windows(None) {
                changed(window);
            }
        });
    }

    pub(super) fn install(window: &tao::window::Window, webview: &wry::WebView) {
        let Some(ns_window) = ns_window(window) else {
            return;
        };
        add_overrides(ns_window);
        watch_screens();
        let wk = WebViewExtMacOS::webview(webview);
        let view: &NSView = &wk;
        let view = view.retain();
        let id = key(ns_window);
        if with_tracked(id, |t| t.web_view = view.clone()).is_some() {
            return;
        }
        let tracked = Tracked {
            window: id,
            web_view: view,
            page_ready: false,
            saved: None,
            fitted: None,
            applied: Layout {
                inset: 0.0,
                cutout: None,
            },
            told: false,
            native: NativeTransition::default(),
            observers: observe_window(ns_window),
        };
        let _ = WINDOWS.try_with(|list| {
            if let Ok(mut list) = list.try_borrow_mut() {
                list.push(tracked);
            }
        });
    }

    pub(super) fn forget(window: &tao::window::Window) {
        let Some(ns_window) = ns_window(window) else {
            return;
        };
        let id = key(ns_window);
        // The Dock and the menu bar come back with the last window in this mode.
        if active(id) {
            leave(ns_window);
        }
        let removed = WINDOWS
            .try_with(|list| {
                let mut list = list.try_borrow_mut().ok()?;
                let at = list.iter().position(|t| t.window == id)?;
                Some(list.remove(at))
            })
            .ok()
            .flatten();
        if let Some(tracked) = removed {
            let center = NSNotificationCenter::defaultCenter();
            for observer in &tracked.observers {
                // SAFETY: taking back a registration this module made.
                unsafe { center.removeObserver(AsRef::<AnyObject>::as_ref(&**observer)) };
            }
        }
    }

    pub(super) fn is_active(window: &tao::window::Window) -> bool {
        active(window_key(window))
    }

    pub(super) fn in_transition(window: &tao::window::Window) -> bool {
        let now = Instant::now();
        with_tracked(window_key(window), |t| t.native.under_way(now)).unwrap_or(false)
    }

    /// In macOS's full screen, or on the way into or out of it.
    fn native_busy(window: &NSWindow) -> bool {
        let now = Instant::now();
        window.styleMask().contains(NSWindowStyleMask::FullScreen)
            || with_tracked(key(window), |t| t.native.busy(now)).unwrap_or(false)
    }

    fn applies(window: &NSWindow) -> bool {
        enabled()
            && with_tracked(key(window), |_| ()).is_some()
            && window.screen().and_then(|s| screen_housing(&s)).is_some()
    }

    pub(super) fn applies_to(window: &tao::window::Window) -> bool {
        ns_window(window).is_some_and(applies)
    }

    pub(super) fn enter_window(window: &tao::window::Window) -> Entry {
        let Some(ns_window) = ns_window(window) else {
            return Entry::NotWanted;
        };
        if active(key(ns_window)) {
            return Entry::Entered;
        }
        if !applies(ns_window) {
            return Entry::NotWanted;
        }
        if native_busy(ns_window) {
            return Entry::Busy;
        }
        enter(ns_window);
        if active(key(ns_window)) {
            Entry::Entered
        } else {
            Entry::NotWanted
        }
    }

    pub(super) fn leave_window(window: &tao::window::Window) {
        if let Some(ns_window) = ns_window(window) {
            leave(ns_window);
        }
    }

    pub(super) fn set_page_ready(window: &tao::window::Window, ready: bool) {
        with_tracked(window_key(window), |t| {
            t.page_ready = ready;
            // A new document knows nothing; one that just said it is ready is
            // told even when the housing is where the last document had it.
            t.told = false;
        });
    }

    pub(super) fn sync(window: &tao::window::Window) -> Option<String> {
        let ns_window = ns_window(window)?;
        let window = key(ns_window);
        let (is_active, page_ready, web_view, applied, told, fitted) = with_tracked(window, |t| {
            (
                t.saved.is_some(),
                t.page_ready,
                t.web_view.clone(),
                t.applied,
                t.told,
                t.fitted,
            )
        })?;
        // Whatever could not be set or taken off earlier (a native Space was in front).
        reconcile_presentation(!active_windows(None).is_empty());
        let screen = ns_window.screen();
        if is_active {
            if let Some(frame) = screen
                .as_deref()
                .map(NSScreen::frame)
                .filter(|frame| fitted != Some(*frame))
            {
                with_tracked(window, |t| t.fitted = Some(frame));
                ns_window.setFrame_display(frame, true);
            }
        }
        let housing = screen.as_deref().and_then(screen_housing);
        let layout = super::layout(is_active, housing, page_ready);
        // Always measured against the view the web view sits in, so a window
        // that changed size keeps the web view filling it.
        inset_web_view(&web_view, layout.inset);
        let tell = page_ready && (!told || layout.cutout != applied.cutout);
        with_tracked(window, |t| {
            t.applied = layout;
            t.told = t.told || tell;
        });
        tell.then(|| super::page_script(layout.cutout))
    }

    /// The web view inside its parent, `inset` points below the top (AppKit
    /// counts from the bottom, so the top strip is what the height leaves).
    fn inset_web_view(web_view: &NSView, inset: f64) {
        // SAFETY: reading the parent of a live view on the main thread.
        let Some(parent) = (unsafe { web_view.superview() }) else {
            return;
        };
        let bounds = parent.bounds();
        let wanted = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(bounds.size.width, (bounds.size.height - inset).max(0.0)),
        );
        // A docked Web Inspector resizes the web view itself: leave it alone
        // unless this mode has something to say (an inset, or one to undo).
        let current = web_view.frame();
        let at_top = (current.origin.y + current.size.height - bounds.size.height).abs() < 0.5;
        if (inset > 0.0 || !at_top) && current != wanted {
            web_view.setFrame(wanted);
        }
    }

    fn decide(window: &NSWindow) -> Toggle {
        let now = Instant::now();
        let tracked = with_tracked(key(window), |t| (t.saved.is_some(), t.native.under_way(now)));
        let whole = tracked.is_some_and(|(whole, _)| whole);
        // A change that is under way is AppKit's to finish, or to refuse.
        let native = window.styleMask().contains(NSWindowStyleMask::FullScreen)
            || tracked.is_some_and(|(_, under_way)| under_way);
        let housing = window.screen().and_then(|s| screen_housing(&s)).is_some();
        // A window this module does not know is never taken out of AppKit's hands.
        super::toggle(whole, native, enabled() && tracked.is_some(), housing)
    }

    /// Makes the Dock and the menu bar auto-hide while `wanted` (a window is
    /// in this mode) and puts them back afterwards. Called again whenever that
    /// may have become possible: inside a native full-screen Space AppKit owns
    /// the options, and nothing is changed or forgotten until it is left.
    fn reconcile_presentation(wanted: bool) {
        let added = ADDED.try_with(Cell::get).unwrap_or(0);
        if !wanted && added == 0 {
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let Some((set, added)) = super::presentation_step(app.presentationOptions().bits(), added, wanted) else {
            return;
        };
        if let Some(options) = set {
            app.setPresentationOptions(NSApplicationPresentationOptions::from_bits_retain(options));
        }
        let _ = ADDED.try_with(|slot| slot.set(added));
    }

    fn enter(window: &NSWindow) {
        if MainThreadMarker::new().is_none() {
            return;
        }
        let Some(screen) = window.screen() else {
            return;
        };
        let id = key(window);
        let style = window.styleMask();
        // SAFETY: reading a property of a live window; nil is a valid answer.
        let background: Option<Retained<AnyObject>> = unsafe { msg_send![window, backgroundColor] };
        let saved = Saved {
            content: window.contentRectForFrameRect(window.frame()),
            style,
            movable: window.isMovable(),
            background,
        };
        // Marked first: the app must see a full-screen window from the first
        // resize it hears of, or it would save this frame as the windowed one.
        let frame = screen.frame();
        let marked = with_tracked(id, |t| {
            t.saved = Some(saved);
            t.fitted = Some(frame);
        });
        if marked.is_none() {
            return;
        }
        let responder = window.firstResponder();
        let was_key = window.isKeyWindow();

        reconcile_presentation(true);
        // Without a title bar the content is the whole frame; without the
        // resize border the edges of the display do not resize it.
        window.setStyleMask(style.difference(NSWindowStyleMask::Titled | NSWindowStyleMask::Resizable));
        window.setMovable(false);
        // What shows above a web view that is kept below the housing.
        if let Some(black) = black_color() {
            // SAFETY: setting a property of a live window to an NSColor.
            unsafe {
                let _: () = msg_send![window, setBackgroundColor: &*black];
            }
        }
        window.setFrame_display(frame, true);
        // Taking the title bar off drops the first responder, and with it the keys.
        restore_responder(window, responder);
        if was_key {
            window.makeKeyAndOrderFront(None);
        }
        // Once more after this turn of the run loop: the menu bar is only
        // really out of the way then, and a frame set before that can end up
        // below it.
        let again = window.retain();
        on_next_turn(move || {
            if active(key(&again)) {
                if again.frame() != frame {
                    again.setFrame_display(frame, true);
                }
                changed(key(&again));
            }
        });
        changed(id);
    }

    fn leave(window: &NSWindow) {
        let id = key(window);
        let Some(saved) = with_tracked(id, |t| t.saved.clone()).flatten() else {
            return;
        };
        let responder = window.firstResponder();
        reconcile_presentation(!active_windows(Some(id)).is_empty());
        // The web view fills the window again before the window shrinks, so the
        // strip that was kept free never shows in the windowed frame.
        if let Some(web_view) = with_tracked(id, |t| t.web_view.clone()) {
            inset_web_view(&web_view, 0.0);
        }
        // Still marked while the window changes back, for the same reason it is
        // marked first on the way in.
        window.setStyleMask(saved.style);
        window.setFrame_display(window.frameRectForContentRect(saved.content), true);
        window.setMovable(saved.movable);
        if let Some(background) = &saved.background {
            // SAFETY: putting back the NSColor the window had.
            unsafe {
                let _: () = msg_send![window, setBackgroundColor: &**background];
            }
        }
        restore_responder(window, responder);
        with_tracked(id, |t| {
            t.saved = None;
            t.fitted = None;
            t.applied.inset = 0.0;
        });
        changed(id);
    }

    fn restore_responder(window: &NSWindow, responder: Option<Retained<NSResponder>>) {
        if let Some(responder) = responder {
            // A window is its own first responder when nothing else is.
            if !ptr::eq(Retained::as_ptr(&responder).cast::<NSWindow>(), ptr::from_ref(window)) {
                window.makeFirstResponder(Some(&responder));
            }
        }
    }

    fn black_color() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSColor")?;
        // SAFETY: a class method that returns an autoreleased NSColor.
        unsafe { msg_send![class, blackColor] }
    }

    /// Runs `work` as its own operation on the main queue.
    fn on_next_turn(work: impl FnOnce() + 'static) {
        let once = Cell::new(Some(work));
        let block = RcBlock::new(move || {
            if let Some(work) = once.take() {
                let _ = catch_unwind(AssertUnwindSafe(work));
            }
        });
        // SAFETY: the main queue runs the block on the main thread, the only
        // thread this module is used on.
        unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&block) };
    }

    /// tao's window class (or, should it ever be renamed, the class of this
    /// window), never NSWindow itself: the overrides call NSWindow's methods.
    fn window_class(window: &NSWindow) -> Option<&'static AnyClass> {
        let own = AsRef::<AnyObject>::as_ref(window).class();
        let mut class = Some(own);
        while let Some(candidate) = class {
            if candidate.name() == c"TaoWindow" {
                return Some(candidate);
            }
            class = candidate.superclass();
        }
        (!ptr::eq(own, NSWindow::class())).then_some(own)
    }

    fn add_overrides(window: &NSWindow) {
        let Some(class) = window_class(window) else {
            eprintln!("codeman-desktop: unexpected window class; full screen stays macOS's own");
            return;
        };
        let address = ptr::from_ref(class) as usize;
        if OVERRIDDEN.try_with(|done| done.replace(address)).unwrap_or(address) == address {
            return;
        }
        // SAFETY (the transmutes): fn pointers of the same ABI; each signature
        // matches its selector and type encoding.
        add_override(
            class,
            sel!(toggleFullScreen:),
            unsafe { std::mem::transmute::<ActionFn, Imp>(toggle_full_screen) },
            c"v@:@",
        );
        add_override(
            class,
            sel!(performClose:),
            unsafe { std::mem::transmute::<ActionFn, Imp>(perform_close) },
            c"v@:@",
        );
    }

    /// Adds `sel` to `class` as an override of the method it inherits. The
    /// runtime refuses when the class itself already has the method (a later
    /// tao that implements it), and full screen is then macOS's own.
    fn add_override(class: &AnyClass, sel: Sel, imp: Imp, types: &CStr) {
        // SAFETY: `imp` takes exactly the arguments `types` describes.
        let added = unsafe { class_addMethod(ptr::from_ref(class).cast_mut(), sel, imp, types.as_ptr()) };
        if !added.as_bool() {
            eprintln!(
                "codeman-desktop: could not override {} on {}",
                sel.name().to_string_lossy(),
                class.name().to_string_lossy()
            );
        }
    }

    extern "C-unwind" fn toggle_full_screen(this: *mut AnyObject, _cmd: Sel, sender: *mut AnyObject) {
        // SAFETY: AppKit calls this on a live window of the class it was added to.
        let Some(window) = (unsafe { this.cast::<NSWindow>().as_ref() }) else {
            return;
        };
        match catch_unwind(AssertUnwindSafe(|| decide(window))).unwrap_or(Toggle::Native) {
            // SAFETY: NSWindow's own implementation, with the arguments it was sent.
            Toggle::Native => unsafe {
                let _: () = msg_send![super(window, NSWindow::class()), toggleFullScreen: sender];
            },
            // Not from inside the action that asked for it: the green button
            // is part of the title bar this takes off. Decided again when it
            // runs, since anything may have happened to the window by then.
            Toggle::EnterWhole | Toggle::LeaveWhole => {
                let window = window.retain();
                on_next_turn(move || match decide(&window) {
                    Toggle::EnterWhole => enter(&window),
                    Toggle::LeaveWhole => leave(&window),
                    Toggle::Native => {}
                });
            }
        }
    }

    /// Without a title bar there is no close button, and AppKit's performClose:
    /// then only beeps. Ask the delegate, as the button would: tao's answers no
    /// and reports the request, and the app decides what closing means.
    extern "C-unwind" fn perform_close(this: *mut AnyObject, _cmd: Sel, sender: *mut AnyObject) {
        // SAFETY: as in `toggle_full_screen`.
        let Some(window) = (unsafe { this.cast::<NSWindow>().as_ref() }) else {
            return;
        };
        if !active(key(window)) {
            // SAFETY: NSWindow's own implementation, with the arguments it was sent.
            unsafe {
                let _: () = msg_send![super(window, NSWindow::class()), performClose: sender];
            }
            return;
        }
        // SAFETY: reading the delegate of a live window and asking it the
        // question NSWindowDelegate defines, only when it implements it.
        unsafe {
            let delegate: Option<Retained<AnyObject>> = msg_send![window, delegate];
            let Some(delegate) = delegate else {
                return;
            };
            let asks: bool = msg_send![&*delegate, respondsToSelector: sel!(windowShouldClose:)];
            if asks {
                let _: bool = msg_send![&*delegate, windowShouldClose: window];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 14-inch MacBook Pro at its default scaling.
    const MBP14: (f64, f64, f64, f64) = (1512.0, 32.0, 663.5, 663.5);

    fn mbp14() -> Housing {
        housing(MBP14.0, MBP14.1, MBP14.2, MBP14.3).expect("a housing")
    }

    #[test]
    fn a_display_without_a_housing_has_none() {
        assert_eq!(housing(2560.0, 0.0, 0.0, 0.0), None);
        // Less than a point, a negative inset and junk are no housing either.
        assert_eq!(housing(1512.0, 0.4, 663.0, 663.0), None);
        assert_eq!(housing(1512.0, -32.0, 663.0, 663.0), None);
        assert_eq!(housing(1512.0, f64::NAN, 663.0, 663.0), None);
        assert_eq!(housing(1512.0, f64::INFINITY, 663.0, 663.0), None);
        assert_eq!(housing(1512.0, 900.0, 663.0, 663.0), None);
    }

    #[test]
    fn the_housing_lies_between_the_two_areas_beside_it() {
        let h = mbp14();
        assert_eq!(h.height, 32.0);
        assert_eq!(
            h.cutout,
            Some(Cutout {
                left: 663.5,
                width: 185.0,
                height: 32.0
            })
        );
    }

    #[test]
    fn a_housing_whose_place_is_not_known_keeps_its_height_only() {
        // No areas reported, areas that overlap, too little room on a side, junk.
        for (left, right) in [
            (0.0, 0.0),
            (800.0, 800.0),
            (60.0, 1300.0),
            (1300.0, 60.0),
            (f64::NAN, 663.0),
        ] {
            let h = housing(1512.0, 32.0, left, right).expect("a housing");
            assert_eq!(h.height, 32.0);
            assert_eq!(h.cutout, None, "{left} / {right}");
        }
        assert_eq!(housing(f64::INFINITY, 32.0, 663.0, 663.0).and_then(|h| h.cutout), None);
    }

    #[test]
    fn a_toggle_leaves_this_mode_first() {
        for native in [false, true] {
            for enabled in [false, true] {
                for housing in [false, true] {
                    assert_eq!(toggle(true, native, enabled, housing), Toggle::LeaveWhole);
                }
            }
        }
    }

    #[test]
    fn a_toggle_enters_this_mode_only_with_the_option_on_a_display_with_a_housing() {
        assert_eq!(toggle(false, false, true, true), Toggle::EnterWhole);
        assert_eq!(toggle(false, false, false, true), Toggle::Native);
        assert_eq!(toggle(false, false, true, false), Toggle::Native);
        assert_eq!(toggle(false, false, false, false), Toggle::Native);
    }

    #[test]
    fn a_window_in_macos_full_screen_leaves_it_through_macos() {
        assert_eq!(toggle(false, true, true, true), Toggle::Native);
        assert_eq!(toggle(false, true, false, false), Toggle::Native);
    }

    #[test]
    fn the_web_view_goes_under_the_housing_only_for_a_page_that_is_ready() {
        let h = mbp14();
        assert_eq!(
            layout(true, Some(h), true),
            Layout {
                inset: 0.0,
                cutout: h.cutout
            }
        );
        // A page that has not said so (an older server, the connect page).
        assert_eq!(
            layout(true, Some(h), false),
            Layout {
                inset: 32.0,
                cutout: None
            }
        );
    }

    #[test]
    fn a_housing_without_a_known_place_keeps_the_web_view_below_it() {
        let h = Housing {
            height: 38.0,
            cutout: None,
        };
        assert_eq!(
            layout(true, Some(h), true),
            Layout {
                inset: 38.0,
                cutout: None
            }
        );
    }

    #[test]
    fn nothing_is_kept_free_outside_this_mode_or_without_a_housing() {
        let none = Layout {
            inset: 0.0,
            cutout: None,
        };
        assert_eq!(layout(false, Some(mbp14()), true), none);
        assert_eq!(layout(false, Some(mbp14()), false), none);
        assert_eq!(layout(true, None, true), none);
        assert_eq!(layout(true, None, false), none);
    }

    #[test]
    fn the_page_is_told_the_housing_in_points() {
        assert_eq!(
            page_script(mbp14().cutout),
            "window.CodemanHostCutout&&typeof window.CodemanHostCutout.apply==='function'\
             &&window.CodemanHostCutout.apply({left:663.5,width:185.0,height:32.0});"
        );
        assert_eq!(
            page_script(None),
            "window.CodemanHostCutout&&typeof window.CodemanHostCutout.apply==='function'\
             &&window.CodemanHostCutout.apply(null);"
        );
    }

    #[test]
    fn entering_hides_the_dock_and_the_menu_bar_and_remembers_what_it_added() {
        assert_eq!(
            presentation_for_entry(0),
            Some((AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR, AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR))
        );
        // A Dock that is hidden already keeps its own bit; only the menu bar is added.
        assert_eq!(
            presentation_for_entry(HIDE_DOCK),
            Some((HIDE_DOCK | AUTO_HIDE_MENU_BAR, AUTO_HIDE_MENU_BAR))
        );
        assert_eq!(
            presentation_for_entry(AUTO_HIDE_DOCK),
            Some((AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR, AUTO_HIDE_MENU_BAR))
        );
        // Both out of the way already: nothing to add, nothing to undo.
        let both = AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR;
        assert_eq!(presentation_for_entry(both), Some((both, 0)));
        let hidden = HIDE_DOCK | HIDE_MENU_BAR;
        assert_eq!(presentation_for_entry(hidden), Some((hidden, 0)));
    }

    #[test]
    fn entering_never_combines_what_appkit_refuses() {
        // Every valid starting point without the full-screen bit.
        for before in [
            0,
            AUTO_HIDE_DOCK,
            HIDE_DOCK,
            AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR,
            HIDE_DOCK | AUTO_HIDE_MENU_BAR,
            HIDE_DOCK | HIDE_MENU_BAR,
        ] {
            let (after, added) = presentation_for_entry(before).expect("not in a Space");
            // Never both of a pair, and a hidden menu bar always has a hidden Dock.
            assert_ne!(after & (AUTO_HIDE_DOCK | HIDE_DOCK), AUTO_HIDE_DOCK | HIDE_DOCK);
            assert_ne!(
                after & (AUTO_HIDE_MENU_BAR | HIDE_MENU_BAR),
                AUTO_HIDE_MENU_BAR | HIDE_MENU_BAR
            );
            assert_ne!(after & (AUTO_HIDE_DOCK | HIDE_DOCK), 0);
            assert_eq!(after & !added, before);
        }
    }

    #[test]
    fn the_options_are_left_alone_inside_a_native_full_screen_space() {
        let space = PRESENTATION_FULL_SCREEN | AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR;
        assert_eq!(presentation_for_entry(space), None);
        assert_eq!(presentation_for_exit(space, AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR), None);
    }

    #[test]
    fn leaving_takes_off_only_what_entering_added() {
        let both = AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR;
        assert_eq!(presentation_for_exit(both, both), Some(0));
        assert_eq!(
            presentation_for_exit(HIDE_DOCK | AUTO_HIDE_MENU_BAR, AUTO_HIDE_MENU_BAR),
            Some(HIDE_DOCK)
        );
        // Nothing was added: nothing is set.
        assert_eq!(presentation_for_exit(both, 0), None);
        // Something else took the bits off meanwhile: nothing to do.
        assert_eq!(presentation_for_exit(0, both), None);
    }

    #[test]
    fn the_options_follow_whether_a_window_is_in_this_mode() {
        let both = AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR;
        // A first window enters: both are set and remembered.
        assert_eq!(presentation_step(0, 0, true), Some((Some(both), both)));
        // A second one enters, or the same question is asked again: nothing to set, nothing forgotten.
        assert_eq!(presentation_step(both, both, true), Some((None, both)));
        // The last one leaves: both come off and nothing is owed any more.
        assert_eq!(presentation_step(both, both, false), Some((Some(0), 0)));
        // Nothing was ever added: nothing to do.
        assert_eq!(presentation_step(0, 0, false), Some((None, 0)));
        // Something else already took them off: nothing to set, and nothing owed.
        assert_eq!(presentation_step(0, both, false), Some((None, 0)));
    }

    #[test]
    fn inside_a_native_space_the_options_wait_and_nothing_is_forgotten() {
        let both = AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR;
        let space = PRESENTATION_FULL_SCREEN | both;
        // The last window left this mode while a pop-out's Space was in front:
        // the answer is "not now", so the bits stay on the books...
        assert_eq!(presentation_step(space, both, false), None);
        assert_eq!(presentation_step(space, 0, true), None);
        // ...and come off once the Space has closed and AppKit put the app's own options back.
        assert_eq!(presentation_step(both, both, false), Some((Some(0), 0)));
    }

    #[test]
    fn a_change_of_macos_full_screen_is_under_way_until_appkit_says_it_ended() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut native = NativeTransition::default();
        assert!(!native.under_way(t0));
        assert!(!native.busy(t0));
        native.began(t0);
        assert!(native.under_way(t0));
        assert!(native.under_way(t0 + Duration::from_millis(900)));
        assert!(native.busy(t0 + Duration::from_millis(900)));
        native.ended(t0 + Duration::from_millis(900));
        assert!(!native.under_way(t0 + Duration::from_millis(900)));
    }

    #[test]
    fn a_window_that_just_finished_such_a_change_is_left_alone_a_moment_longer() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut native = NativeTransition::default();
        native.began(t0);
        native.ended(t0 + Duration::from_millis(700));
        // tao puts the window's style back in a block queued at that moment.
        assert!(native.busy(t0 + Duration::from_millis(700)));
        assert!(native.busy(t0 + Duration::from_millis(700) + TRANSITION_SETTLE - Duration::from_millis(1)));
        assert!(!native.busy(t0 + Duration::from_millis(700) + TRANSITION_SETTLE));
        // Its frame is the windowed one again from the moment the change ended.
        assert!(!native.under_way(t0 + Duration::from_millis(701)));
    }

    #[test]
    fn a_change_appkit_never_reports_as_ended_stops_counting_by_itself() {
        use std::time::Instant;
        // An entry that failed sends no notification.
        let t0 = Instant::now();
        let mut native = NativeTransition::default();
        native.began(t0);
        assert!(native.busy(t0 + TRANSITION_CEILING - std::time::Duration::from_millis(1)));
        assert!(!native.busy(t0 + TRANSITION_CEILING));
        // A new change starts the count again.
        native.began(t0 + TRANSITION_CEILING);
        assert!(native.under_way(t0 + TRANSITION_CEILING));
    }

    #[test]
    fn leaving_never_keeps_a_hidden_menu_bar_over_a_visible_dock() {
        // Only the Dock bit was ours, and the menu bar's was there before:
        // AppKit refuses a hidden menu bar without a hidden Dock, so it goes too.
        assert_eq!(
            presentation_for_exit(AUTO_HIDE_DOCK | AUTO_HIDE_MENU_BAR, AUTO_HIDE_DOCK),
            Some(0)
        );
    }
}
