//! Two things a browser does that wry 0.57.1 leaves out on macOS: JavaScript
//! `alert`/`confirm`/`prompt` dialogs, and answering HTTP Basic challenges.
//!
//! wry's `WKUIDelegate` implements only the file panel, media permissions and
//! `window.open`. Without the three JavaScript panel methods WebKit treats every
//! `confirm()` as Cancel and every `prompt()` as null, and drops `alert()`.
//! Codeman guards Update, Delete case, Kill all, restoring a config backup and
//! closing an edited file preview with `confirm()`, so all of those silently did
//! nothing. wry's `WKNavigationDelegate` has no challenge method either. Codeman
//! keeps its login cookies in memory, so after a server restart every request
//! the loaded page makes gets 401, where a browser would have replayed the Basic
//! login it remembers.
//!
//! A challenge is answered only when it is Codeman's own: the protection space
//! is the server's scheme, host and port, and the URL that got the 401 (the
//! challenge's `failureResponse`) lies below the server's base path and is not
//! a proxied dashboard (`webview/`) or a rendered HTML file (`html-view/`).
//! Those relay a 401 from content Codeman did not write, which must neither
//! receive the password nor count as the server refusing it. The login is
//! handed over with `NSURLCredentialPersistenceNone`, so WebKit keeps no copy
//! of it: every challenge comes back here and gets the login of that moment,
//! never one an earlier connect left behind.
//!
//! Two smaller helpers live here too: `clear_cookies`, which empties the web
//! views' cookie jar before a login so an earlier user's session cookie cannot
//! win over the new login, and `content_size`, the window's content area.
//!
//! `install` adds the missing methods to the classes of the delegates wry made,
//! once per class and never over a method the class already has, and then sets
//! the same delegates on the web view again. WebKit asks a delegate which
//! optional methods it implements when the delegate is set and keeps the answer,
//! so a method added after that is never called.
//!
//! All of it is fail-safe. A missing delegate is logged and skipped. Every path
//! that cannot do its job answers with what WebKit does when the method is
//! missing: an alert counts as dismissed, a confirm as Cancel, a prompt as null,
//! and a challenge gets WebKit's default handling. The one deliberate exception
//! is a challenge from our server after it refused the saved login: that is
//! cancelled, because sending the same login again would cost one failed login
//! (and rate-limit budget) for every request the page retries.
//!
//! Each completion handler is called exactly once, after the work, outside the
//! code that could fail. The release build aborts on panic, so this code avoids
//! panicking at all: no unwrap, `try_with`/`try_borrow` on the thread-locals,
//! every object WebKit hands over is read as an `Option`, and page text is never
//! converted to a Rust string (an unpaired UTF-16 surrogate has no UTF-8 form).

use url::Url;

/// The login the challenge handler answers with: the server the user connected
/// to (its URL, base path included) and the credentials given for it. The
/// scheme, host and effective port (443 for a plain `https://` URL) a challenge
/// must come from are read from `server`.
#[derive(Clone)]
pub struct BasicCredentials {
    pub server: Url,
    pub username: String,
    pub password: String,
}

/// What one authentication challenge gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChallengeAnswer {
    /// Not ours (another method, a proxy, another server, no saved login):
    /// WebKit's own handling, the same as before this module existed.
    Default,
    /// Our server asks for the first time: send the saved login.
    UseCredential,
    /// Our server refused the saved login: stop, and tell the app.
    CancelAndReport,
    /// Refused and already reported: do not send the same login again, or each
    /// request the page retries would count as another failed login.
    Cancel,
}

/// The parts of a challenge `decide` looks at.
struct Challenge<'a> {
    basic: bool,
    proxy: bool,
    scheme: &'a str,
    host: &'a str,
    port: i64,
    previous_failures: i64,
    /// The URL whose response asked for the login (the challenge's
    /// `failureResponse`); `None` when WebKit gave none or it did not parse.
    failed: Option<&'a Url>,
}

/// A challenge is ours only when its protection space is the saved server and
/// the URL that got the 401 is in `policy::challenge_in_scope`. Anything else,
/// even after the server refused the login, gets WebKit's default handling, so
/// a web tab's dashboard asking for its own login can neither receive the
/// password nor send the app back to the connect screen.
fn decide(challenge: &Challenge<'_>, saved: Option<&BasicCredentials>, rejected: bool) -> ChallengeAnswer {
    if !challenge.basic || challenge.proxy {
        return ChallengeAnswer::Default;
    }
    let ours = saved.is_some_and(|saved| {
        credentials_match(saved, challenge.scheme, challenge.host, challenge.port)
            && challenge
                .failed
                .is_some_and(|failed| crate::policy::challenge_in_scope(failed, &saved.server))
    });
    if !ours {
        return ChallengeAnswer::Default;
    }
    match (challenge.previous_failures > 0, rejected) {
        (_, true) => ChallengeAnswer::Cancel,
        (true, false) => ChallengeAnswer::CancelAndReport,
        (false, false) => ChallengeAnswer::UseCredential,
    }
}

/// Whether a challenge's protection space is the server the login was given
/// for: same scheme, host (case-insensitive, IPv6 brackets ignored) and port
/// (the server URL's effective one).
fn credentials_match(saved: &BasicCredentials, scheme: &str, host: &str, port: i64) -> bool {
    let (Some(saved_host), Some(saved_port)) = (saved.server.host_str(), saved.server.port_or_known_default()) else {
        return false;
    };
    let Some(port) = effective_port(scheme, port) else {
        return false;
    };
    !saved_host.is_empty()
        && saved.server.scheme().eq_ignore_ascii_case(scheme)
        && bare_host(saved_host).eq_ignore_ascii_case(bare_host(host))
        && i64::from(saved_port) == port
}

/// A protection space states the port it was reached on; 0 is read as the
/// scheme's default in case a challenge ever leaves it out.
fn effective_port(scheme: &str, port: i64) -> Option<i64> {
    if port > 0 {
        Some(port)
    } else if scheme.eq_ignore_ascii_case("http") {
        Some(80)
    } else if scheme.eq_ignore_ascii_case("https") {
        Some(443)
    } else {
        None
    }
}

fn bare_host(host: &str) -> &str {
    host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host)
}

/// How a dialog names the page that opened it ("localhost:3000"), from a
/// security origin's host and port (0 = the scheme's default, left out).
fn origin_label(host: &str, port: i64) -> Option<String> {
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    Some(if port > 0 { format!("{host}:{port}") } else { host })
}

/// The bold first line of a dialog, like Safari's, so a frame cannot pass its
/// text off as the app's own: the page's text always goes below it. `frame` is
/// the host that names the frame and whether it is embedded, which a sandboxed
/// frame is (an HTML file preview, an untrusted web tab): its origin is opaque,
/// so the host is only the server it was loaded from, and it must not read as
/// Codeman speaking. `None` is a frame nothing names: an opaque origin whose
/// document has no host either (`about:srcdoc`, a `data:` or `blob:` URL).
fn dialog_title(frame: Option<(&str, bool)>) -> String {
    match frame {
        Some((origin, false)) => format!("The page at {origin} says:"),
        Some((origin, true)) => format!("An embedded page on {origin} says:"),
        None => "An embedded page says:".to_string(),
    }
}

/// Makes this web view show JavaScript dialogs and answer HTTP Basic
/// challenges. Call it after every `build()`; repeating it is harmless.
#[cfg(target_os = "macos")]
pub fn install(webview: &wry::WebView) {
    imp::install(webview);
}

/// The login HTTP Basic challenges from that server are answered with
/// (`None`: answer none), from the next challenge on: WebKit keeps no copy of
/// an earlier one. Also re-arms the refusal report. Main thread only.
#[cfg(target_os = "macos")]
pub fn set_credentials(creds: Option<BasicCredentials>) {
    imp::set_credentials(creds);
}

/// Called on the main thread, once per `set_credentials`, when the server
/// refused the saved login. It runs inside a WebKit callback, so it should
/// only post an event, never touch windows directly.
#[cfg(target_os = "macos")]
pub fn set_auth_rejected_handler(handler: Box<dyn Fn()>) {
    imp::set_auth_rejected_handler(handler);
}

/// Removes every cookie from the app's default website data store, which all
/// of its web views use, then calls `done`. Only cookies: local storage, where
/// Codeman keeps per-device settings, stays. Main thread only.
///
/// `done` runs exactly once, on the main thread, as its own operation on the
/// main queue: never before this returns and never inside a WebKit callback.
/// It also runs when the cookies could not be removed (fail-open), so the
/// caller always gets to load. Called off the main thread, this removes
/// nothing and calls `done` right away on the calling thread. If WebKit never
/// answers at all, `done` never runs: the caller's own deadline covers that.
#[cfg(target_os = "macos")]
pub fn clear_cookies(done: Box<dyn FnOnce()>) {
    imp::clear_cookies(done);
}

/// The window's content area in points (`contentRectForFrameRect` of its
/// frame). Unlike the web view's bounds, it does not shrink while a docked Web
/// Inspector takes part of the window. `None` off the main thread or for a
/// size that is not a positive finite number.
#[cfg(target_os = "macos")]
pub fn content_size(window: &tao::window::Window) -> Option<(f64, f64)> {
    imp::content_size(window)
}

/// An app-modal message with an OK button, for something the user asked the app
/// itself to do that failed. Main thread only; does nothing elsewhere.
#[cfg(target_os = "macos")]
pub fn show_message(title: &str, detail: &str) {
    imp::show_message(title, detail);
}

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::ffi::{c_char, CStr};
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::ptr;
    use std::rc::Rc;

    use block2::{Block, RcBlock};
    use objc2::ffi::class_addMethod;
    use objc2::rc::{autoreleasepool, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use objc2::{msg_send, sel, ClassType, Message};
    use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSTextField, NSView, NSWindow};
    use objc2_foundation::{
        MainThreadMarker, NSDate, NSInteger, NSOperationQueue, NSPoint, NSRect, NSSet, NSSize, NSString,
        NSURLAuthenticationChallenge, NSURLAuthenticationMethodHTTPBasic, NSURLCredential, NSURLCredentialPersistence,
        NSURLProtectionSpace, NSURLRequest, NSURLResponse, NSURLSessionAuthChallengeDisposition, NSURL,
    };
    use objc2_web_kit::{WKFrameInfo, WKSecurityOrigin, WKWebsiteDataStore, WKWebsiteDataTypeCookies};
    use tao::platform::macos::WindowExtMacOS;
    use url::Url;
    use wry::WebViewExtMacOS;

    use super::{decide, dialog_title, origin_label, BasicCredentials, Challenge, ChallengeAnswer};

    /// Page text in a dialog is cut at this many UTF-16 units, so a huge
    /// message cannot push the alert's buttons off the screen.
    const MAX_DIALOG_UTF16: usize = 2000;

    thread_local! {
        /// The login challenges are answered with; `None` answers none.
        static SAVED: RefCell<Option<BasicCredentials>> = const { RefCell::new(None) };
        /// The server refused `SAVED` and the app was told; `set_credentials` clears it.
        static REJECTED: Cell<bool> = const { Cell::new(false) };
        /// Told once when the server refuses `SAVED`.
        static ON_REJECTED: RefCell<Option<Rc<dyn Fn()>>> = const { RefCell::new(None) };
    }

    // The added methods, with every object argument as a raw pointer: WebKit
    // passes nonnull objects, but a null one must not become an invalid `&`.
    type AlertFn = extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut NSString,
        *mut WKFrameInfo,
        *mut Block<dyn Fn()>,
    );
    type ConfirmFn = extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut NSString,
        *mut WKFrameInfo,
        *mut Block<dyn Fn(Bool)>,
    );
    type PromptFn = extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut NSString,
        *mut NSString,
        *mut WKFrameInfo,
        *mut Block<dyn Fn(*mut NSString)>,
    );
    type ChallengeHandler = Block<dyn Fn(NSURLSessionAuthChallengeDisposition, *mut NSURLCredential)>;
    type ChallengeFn = extern "C-unwind" fn(
        *mut AnyObject,
        Sel,
        *mut AnyObject,
        *mut NSURLAuthenticationChallenge,
        *mut ChallengeHandler,
    );

    pub(super) fn install(webview: &wry::WebView) {
        if MainThreadMarker::new().is_none() {
            eprintln!("codeman-desktop: macos::install called off the main thread; skipped");
            return;
        }
        let wk = WebViewExtMacOS::webview(webview);

        // SAFETY: reading and setting the delegates of a live web view on the
        // main thread. `delegate` keeps the object alive across the swap (the
        // web view holds its delegates weakly; wry holds them strongly too).
        match unsafe { wk.UIDelegate() } {
            Some(delegate) => {
                let class = AsRef::<AnyObject>::as_ref(&*delegate).class();
                // SAFETY (all three transmutes): fn pointers of the same ABI;
                // each signature matches its selector and type encoding.
                add_method(
                    class,
                    sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:),
                    unsafe { std::mem::transmute::<AlertFn, Imp>(run_alert) },
                    c"v@:@@@@?",
                );
                add_method(
                    class,
                    sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:),
                    unsafe { std::mem::transmute::<ConfirmFn, Imp>(run_confirm) },
                    c"v@:@@@@?",
                );
                add_method(
                    class,
                    sel!(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:),
                    unsafe { std::mem::transmute::<PromptFn, Imp>(run_prompt) },
                    c"v@:@@@@@?",
                );
                unsafe {
                    wk.setUIDelegate(None);
                    wk.setUIDelegate(Some(&*delegate));
                }
            }
            None => eprintln!("codeman-desktop: web view has no UI delegate; JavaScript dialogs stay off"),
        }

        // SAFETY: as above.
        match unsafe { wk.navigationDelegate() } {
            Some(delegate) => {
                let class = AsRef::<AnyObject>::as_ref(&*delegate).class();
                add_method(
                    class,
                    sel!(webView:didReceiveAuthenticationChallenge:completionHandler:),
                    // SAFETY: as above.
                    unsafe { std::mem::transmute::<ChallengeFn, Imp>(did_receive_challenge) },
                    c"v@:@@@?",
                );
                unsafe {
                    wk.setNavigationDelegate(None);
                    wk.setNavigationDelegate(Some(&*delegate));
                }
            }
            None => eprintln!("codeman-desktop: web view has no navigation delegate; Basic logins are not answered"),
        }
    }

    pub(super) fn set_credentials(creds: Option<BasicCredentials>) {
        if MainThreadMarker::new().is_none() {
            eprintln!("codeman-desktop: macos::set_credentials called off the main thread; ignored");
            return;
        }
        let stored = SAVED.try_with(|saved| saved.try_borrow_mut().map(|mut saved| *saved = creds).is_ok());
        if stored != Ok(true) {
            eprintln!("codeman-desktop: could not store the login for Basic challenges");
        }
        let _ = REJECTED.try_with(|rejected| rejected.set(false));
    }

    pub(super) fn set_auth_rejected_handler(handler: Box<dyn Fn()>) {
        if MainThreadMarker::new().is_none() {
            eprintln!("codeman-desktop: macos::set_auth_rejected_handler called off the main thread; ignored");
            return;
        }
        let handler: Rc<dyn Fn()> = Rc::from(handler);
        let stored = ON_REJECTED.try_with(|slot| slot.try_borrow_mut().map(|mut slot| *slot = Some(handler)).is_ok());
        if stored != Ok(true) {
            eprintln!("codeman-desktop: could not store the login-refused handler");
        }
    }

    pub(super) fn clear_cookies(done: Box<dyn FnOnce()>) {
        if MainThreadMarker::new().is_none() {
            eprintln!("codeman-desktop: macos::clear_cookies called off the main thread; cookies kept");
            // `done` was made on this thread, so it runs here instead of being
            // sent to another one.
            run_done(done);
            return;
        }
        // Every way out of here, a panic included, either hands `pending` to
        // WebKit's completion handler or drops it, and both pass `done` on.
        let pending = Pending(Cell::new(Some(done)));
        let _ = catch_unwind(AssertUnwindSafe(|| autoreleasepool(|_| remove_cookies(pending))));
    }

    fn remove_cookies(pending: Pending) {
        // SAFETY: class methods called on the main thread (checked by the
        // caller), with nil handled by the `Option` return types.
        let store: Option<Retained<WKWebsiteDataStore>> =
            unsafe { msg_send![WKWebsiteDataStore::class(), defaultDataStore] };
        let since: Option<Retained<NSDate>> = unsafe { msg_send![NSDate::class(), distantPast] };
        let (Some(store), Some(since)) = (store, since) else {
            eprintln!("codeman-desktop: no website data store; cookies kept");
            return;
        };
        // SAFETY: an immutable string constant exported by WebKit.
        let types = NSSet::from_slice(&[unsafe { WKWebsiteDataTypeCookies }]);
        let completion = RcBlock::new(move || pending.finish());
        // SAFETY: main thread; WebKit copies the block, keeps it until the
        // cookies are gone and then calls it. Dropping our reference after the
        // call is fine.
        unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &since, &completion) };
    }

    /// `done` until it is passed on: by the completion handler, or, when
    /// WebKit releases the handler without calling it or a step before it
    /// fails, by the drop. `Cell::take` makes that exactly once.
    struct Pending(Cell<Option<Box<dyn FnOnce()>>>);

    impl Pending {
        fn finish(&self) {
            if let Some(done) = self.0.take() {
                run_on_main_queue(done);
            }
        }
    }

    impl Drop for Pending {
        fn drop(&mut self) {
            self.finish();
        }
    }

    /// Runs `done` as its own operation on the main queue, so on the main
    /// thread whatever thread WebKit calls back on, and never inside
    /// `clear_cookies` or a WebKit callback.
    fn run_on_main_queue(done: Box<dyn FnOnce()>) {
        let once = Cell::new(Some(done));
        let block = RcBlock::new(move || {
            if let Some(done) = once.take() {
                run_done(done);
            }
        });
        // SAFETY: the main queue runs the block on the main thread, the thread
        // `done` was made on (`clear_cookies` checked), so `done` is never
        // called anywhere else.
        unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&block) };
    }

    fn run_done(done: Box<dyn FnOnce()>) {
        if catch_unwind(AssertUnwindSafe(done)).is_err() {
            eprintln!("codeman-desktop: the cookies-cleared callback panicked");
        }
    }

    pub(super) fn show_message(title: &str, detail: &str) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(title));
        alert.setInformativeText(&NSString::from_str(detail));
        let _ = alert.addButtonWithTitle(&NSString::from_str("OK"));
        alert.runModal();
    }

    pub(super) fn content_size(window: &tao::window::Window) -> Option<(f64, f64)> {
        // NSWindow is main-thread only.
        MainThreadMarker::new()?;
        // SAFETY: tao hands out a pointer to its live NSWindow (objc2-app-kit
        // 0.3.2, the crate used here), null-checked by `as_ref`; the reference
        // ends with this call, while `window` is still borrowed.
        let ns_window = unsafe { window.ns_window().cast::<NSWindow>().as_ref() }?;
        let size = ns_window.contentRectForFrameRect(ns_window.frame()).size;
        let usable = |v: f64| v.is_finite() && v > 0.0;
        (usable(size.width) && usable(size.height)).then_some((size.width, size.height))
    }

    /// Adds `sel` to `class` unless an instance already responds to it (ours
    /// from an earlier `install`, or a later wry that implements it itself).
    fn add_method(class: &AnyClass, sel: Sel, imp: Imp, types: &CStr) {
        if class.responds_to(sel) {
            return;
        }
        // SAFETY: `imp` takes exactly the arguments `types` describes, and the
        // class does not have the method yet, so nothing is replaced.
        let added = unsafe { class_addMethod(ptr::from_ref(class).cast_mut(), sel, imp, types.as_ptr()) };
        if !added.as_bool() {
            eprintln!(
                "codeman-desktop: could not add {} to {}",
                sel.name().to_string_lossy(),
                class.name().to_string_lossy()
            );
        }
    }

    extern "C-unwind" fn run_alert(
        _this: *mut AnyObject,
        _cmd: Sel,
        _web_view: *mut AnyObject,
        message: *mut NSString,
        frame: *mut WKFrameInfo,
        handler: *mut Block<dyn Fn()>,
    ) {
        // SAFETY: WebKit's block and objects live for the duration of this call.
        let Some(handler) = (unsafe { handler.as_ref() }) else {
            return;
        };
        let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
            show_panel(Panel::Alert, message.as_ref(), None, frame.as_ref())
        }));
        handler.call(());
    }

    extern "C-unwind" fn run_confirm(
        _this: *mut AnyObject,
        _cmd: Sel,
        _web_view: *mut AnyObject,
        message: *mut NSString,
        frame: *mut WKFrameInfo,
        handler: *mut Block<dyn Fn(Bool)>,
    ) {
        // SAFETY: as in `run_alert`.
        let Some(handler) = (unsafe { handler.as_ref() }) else {
            return;
        };
        let closed = catch_unwind(AssertUnwindSafe(|| unsafe {
            show_panel(Panel::Confirm, message.as_ref(), None, frame.as_ref())
        }));
        let ok = matches!(closed, Ok(Some(Closed { ok: true, .. })));
        handler.call((Bool::new(ok),));
    }

    extern "C-unwind" fn run_prompt(
        _this: *mut AnyObject,
        _cmd: Sel,
        _web_view: *mut AnyObject,
        prompt: *mut NSString,
        default_text: *mut NSString,
        frame: *mut WKFrameInfo,
        handler: *mut Block<dyn Fn(*mut NSString)>,
    ) {
        // SAFETY: as in `run_alert`.
        let Some(handler) = (unsafe { handler.as_ref() }) else {
            return;
        };
        let closed = catch_unwind(AssertUnwindSafe(|| unsafe {
            show_panel(Panel::Prompt, prompt.as_ref(), default_text.as_ref(), frame.as_ref())
        }));
        let text = match closed {
            Ok(Some(Closed { ok: true, text })) => text,
            _ => None,
        };
        // `text` outlives the call, so the pointer stays valid while WebKit copies it.
        handler.call((text
            .as_ref()
            .map_or(ptr::null_mut(), |t| Retained::as_ptr(t).cast_mut()),));
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Panel {
        Alert,
        Confirm,
        Prompt,
    }

    /// How the user closed a dialog; `text` is the prompt field's content.
    struct Closed {
        ok: bool,
        text: Option<Retained<NSString>>,
    }

    /// Shows one JavaScript dialog as an app-modal NSAlert. `None` when it
    /// could not be shown. Synchronous on purpose: the completion handler is
    /// called right after, so it cannot be lost with a closing window.
    fn show_panel(
        panel: Panel,
        message: Option<&NSString>,
        default_text: Option<&NSString>,
        frame: Option<&WKFrameInfo>,
    ) -> Option<Closed> {
        let mtm = MainThreadMarker::new()?;
        let alert = NSAlert::new(mtm);
        let body = match message {
            Some(message) => clipped(message),
            None => NSString::from_str(""),
        };
        // The bold line is always the app's own; the page's text goes below.
        let named = frame.and_then(frame_origin);
        let title = dialog_title(named.as_ref().map(|(origin, embedded)| (origin.as_str(), *embedded)));
        alert.setMessageText(&NSString::from_str(&title));
        alert.setInformativeText(&body);
        let _ = alert.addButtonWithTitle(&NSString::from_str("OK"));
        if panel != Panel::Alert {
            let _ = alert.addButtonWithTitle(&NSString::from_str("Cancel"));
        }
        let field = (panel == Panel::Prompt).then(|| {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(300.0, 24.0));
            let field = NSTextField::initWithFrame(mtm.alloc::<NSTextField>(), frame);
            if let Some(text) = default_text {
                field.setStringValue(text);
            }
            field
        });
        if let Some(field) = &field {
            let view: &NSView = field;
            alert.setAccessoryView(Some(view));
            // Lay out now so the field can take the focus instead of the OK button.
            alert.layout();
            // SAFETY: a plain property read; nil is handled.
            let window: Option<Retained<NSWindow>> = unsafe { msg_send![&*alert, window] };
            if let Some(window) = window {
                window.setInitialFirstResponder(Some(view));
            }
        }
        let ok = alert.runModal() == NSAlertFirstButtonReturn;
        Some(Closed {
            ok,
            text: field.map(|field| field.stringValue()),
        })
    }

    /// The page's text, cut at a whole character after `MAX_DIALOG_UTF16`
    /// units. Stays an NSString, so it is shown exactly as the page sent it.
    fn clipped(text: &NSString) -> Retained<NSString> {
        if text.length() <= MAX_DIALOG_UTF16 {
            return text.retain();
        }
        let cut = text.rangeOfComposedCharacterSequenceAtIndex(MAX_DIALOG_UTF16).location;
        text.substringToIndex(cut)
            .stringByAppendingString(&NSString::from_str("…"))
    }

    /// The host (and port) of the frame that opened a dialog: its security
    /// origin, else its request URL's host. The flag says "embedded". It is
    /// set for every sub-frame, whatever its origin (a trusted web tab is
    /// proxied under Codeman's own origin and would read as Codeman
    /// otherwise), and whenever the origin names no host, which is an opaque
    /// origin (a sandboxed frame) or no origin at all: a frame the app is
    /// unsure about never speaks as the page.
    fn frame_origin(frame: &WKFrameInfo) -> Option<(String, bool)> {
        autoreleasepool(|_| {
            // SAFETY (every read here): property reads on objects WebKit handed
            // us, with nil handled by the `Option` return types.
            let sub_frame = !unsafe { frame.isMainFrame() };
            let origin: Option<Retained<WKSecurityOrigin>> = unsafe { msg_send![frame, securityOrigin] };
            if let Some(origin) = origin {
                let host: Option<Retained<NSString>> = unsafe { msg_send![&*origin, host] };
                let port: NSInteger = unsafe { msg_send![&*origin, port] };
                if let Some(label) = host
                    .as_deref()
                    .and_then(rust_string)
                    .and_then(|h| origin_label(&h, port as i64))
                {
                    return Some((label, sub_frame));
                }
            }
            let request: Option<Retained<NSURLRequest>> = unsafe { msg_send![frame, request] };
            let request = request?;
            let url: Option<Retained<NSURL>> = unsafe { msg_send![&*request, URL] };
            let url = url?;
            let host: Option<Retained<NSString>> = unsafe { msg_send![&*url, host] };
            let host = host?;
            Some((origin_label(&rust_string(&host)?, 0)?, true))
        })
    }

    /// Copies an NSString into Rust, or `None` when it has no UTF-8 form:
    /// `UTF8String` returns NULL for an unpaired surrogate, and objc2's own
    /// conversion would then build a slice from a null pointer. Call it inside
    /// an autorelease pool (the bytes may be autoreleased).
    fn rust_string(text: &NSString) -> Option<String> {
        // SAFETY: `UTF8String` returns NULL or a NUL-terminated buffer that
        // lives until the pool drains; it is copied before that.
        let bytes: *const c_char = unsafe { msg_send![text, UTF8String] };
        if bytes.is_null() {
            return None;
        }
        unsafe { CStr::from_ptr(bytes) }.to_str().ok().map(str::to_owned)
    }

    extern "C-unwind" fn did_receive_challenge(
        _this: *mut AnyObject,
        _cmd: Sel,
        _web_view: *mut AnyObject,
        challenge: *mut NSURLAuthenticationChallenge,
        handler: *mut ChallengeHandler,
    ) {
        // SAFETY: as in `run_alert`.
        let Some(handler) = (unsafe { handler.as_ref() }) else {
            return;
        };
        let reply = catch_unwind(AssertUnwindSafe(|| reply_to(unsafe { challenge.as_ref() }))).unwrap_or_default();
        let credential = reply
            .credential
            .as_ref()
            .map_or(ptr::null_mut(), |c| Retained::as_ptr(c).cast_mut());
        handler.call((reply.disposition, credential));
        // Told after WebKit has its answer, so the app's handler cannot delay it.
        if reply.report {
            notify_rejected();
        }
    }

    struct Reply {
        disposition: NSURLSessionAuthChallengeDisposition,
        credential: Option<Retained<NSURLCredential>>,
        report: bool,
    }

    impl Default for Reply {
        fn default() -> Self {
            Reply {
                disposition: NSURLSessionAuthChallengeDisposition::PerformDefaultHandling,
                credential: None,
                report: false,
            }
        }
    }

    fn reply_to(challenge: Option<&NSURLAuthenticationChallenge>) -> Reply {
        let Some(challenge) = challenge else {
            return Reply::default();
        };
        autoreleasepool(|_| {
            // SAFETY (every read here): property reads on the challenge WebKit
            // handed us, with nil handled by the `Option` return types.
            let space: Option<Retained<NSURLProtectionSpace>> = unsafe { msg_send![challenge, protectionSpace] };
            let Some(space) = space else {
                return Reply::default();
            };
            let method: Option<Retained<NSString>> = unsafe { msg_send![&*space, authenticationMethod] };
            // SAFETY: an immutable string constant exported by Foundation.
            let basic =
                method.is_some_and(|method| method.isEqualToString(unsafe { NSURLAuthenticationMethodHTTPBasic }));
            if !basic {
                // Server trust above all: the certificate decision stays WebKit's.
                return Reply::default();
            }
            let proxy: bool = unsafe { msg_send![&*space, isProxy] };
            let host: Option<Retained<NSString>> = unsafe { msg_send![&*space, host] };
            let scheme: Option<Retained<NSString>> = unsafe { msg_send![&*space, protocol] };
            let port: NSInteger = unsafe { msg_send![&*space, port] };
            let previous_failures: NSInteger = unsafe { msg_send![challenge, previousFailureCount] };
            let (Some(host), Some(scheme)) = (
                host.as_deref().and_then(rust_string),
                scheme.as_deref().and_then(rust_string),
            ) else {
                return Reply::default();
            };

            let failed = failure_url(challenge);

            let saved = SAVED
                .try_with(|saved| saved.try_borrow().ok().and_then(|saved| saved.clone()))
                .ok()
                .flatten();
            let rejected = REJECTED.try_with(Cell::get).unwrap_or(false);
            let asked = Challenge {
                basic,
                proxy,
                scheme: &scheme,
                host: &host,
                port: port as i64,
                previous_failures: previous_failures as i64,
                failed: failed.as_ref(),
            };
            match (decide(&asked, saved.as_ref(), rejected), saved) {
                (ChallengeAnswer::UseCredential, Some(saved)) => {
                    let user = NSString::from_str(&saved.username);
                    let password = NSString::from_str(&saved.password);
                    // None: WebKit uses it for this request only and stores
                    // nothing, so the next challenge comes back here and gets
                    // the login current then. With ForSession WebKit kept it,
                    // sent it on its own to later requests below that URL, and
                    // went on doing so after Switch Server or another login.
                    // SAFETY: a class factory method with nil handled.
                    let credential: Option<Retained<NSURLCredential>> = unsafe {
                        msg_send![
                            NSURLCredential::class(),
                            credentialWithUser: &*user,
                            password: &*password,
                            persistence: NSURLCredentialPersistence::None
                        ]
                    };
                    match credential {
                        Some(credential) => Reply {
                            disposition: NSURLSessionAuthChallengeDisposition::UseCredential,
                            credential: Some(credential),
                            report: false,
                        },
                        None => Reply::default(),
                    }
                }
                (ChallengeAnswer::CancelAndReport, _) => {
                    let _ = REJECTED.try_with(|rejected| rejected.set(true));
                    eprintln!("codeman-desktop: {host}:{port} refused the saved login; not sending it again");
                    Reply {
                        disposition: NSURLSessionAuthChallengeDisposition::CancelAuthenticationChallenge,
                        credential: None,
                        report: true,
                    }
                }
                (ChallengeAnswer::Cancel, _) => Reply {
                    disposition: NSURLSessionAuthChallengeDisposition::CancelAuthenticationChallenge,
                    credential: None,
                    report: false,
                },
                (ChallengeAnswer::Default | ChallengeAnswer::UseCredential, _) => Reply::default(),
            }
        })
    }

    /// The URL whose 401 raised the challenge, from its `failureResponse`.
    /// `None` when WebKit gave no response or URL, or it does not parse. Call
    /// it inside an autorelease pool (`rust_string`).
    fn failure_url(challenge: &NSURLAuthenticationChallenge) -> Option<Url> {
        // SAFETY (every read here): property reads on objects WebKit handed
        // us, with nil handled by the `Option` return types.
        let response: Option<Retained<NSURLResponse>> = unsafe { msg_send![challenge, failureResponse] };
        let url: Option<Retained<NSURL>> = unsafe { msg_send![&*response?, URL] };
        let text: Option<Retained<NSString>> = unsafe { msg_send![&*url?, absoluteString] };
        Url::parse(&rust_string(&*text?)?).ok()
    }

    fn notify_rejected() {
        // Cloned out first: the handler may call `set_credentials` or
        // `set_auth_rejected_handler`, which would find the cell borrowed.
        let handler = ON_REJECTED
            .try_with(|slot| slot.try_borrow().ok().and_then(|slot| slot.clone()))
            .ok()
            .flatten();
        if let Some(handler) = handler {
            if catch_unwind(AssertUnwindSafe(|| handler())).is_err() {
                eprintln!("codeman-desktop: the login-refused handler panicked");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).expect("test URL")
    }

    fn saved(server: &str) -> BasicCredentials {
        BasicCredentials {
            server: url(server),
            username: "admin".into(),
            password: "pw".into(),
        }
    }

    fn challenge<'a>(
        scheme: &'a str,
        host: &'a str,
        port: i64,
        previous_failures: i64,
        failed: Option<&'a Url>,
    ) -> Challenge<'a> {
        Challenge {
            basic: true,
            proxy: false,
            scheme,
            host,
            port,
            previous_failures,
            failed,
        }
    }

    /// What a run of challenges gets, with the refusal latched the way
    /// `reply_to` latches it (on CancelAndReport only).
    fn answers(login: &BasicCredentials, asked: &[Challenge<'_>]) -> Vec<ChallengeAnswer> {
        let mut rejected = false;
        asked
            .iter()
            .map(|c| {
                let answer = decide(c, Some(login), rejected);
                rejected |= answer == ChallengeAnswer::CancelAndReport;
                answer
            })
            .collect()
    }

    #[test]
    fn first_basic_challenge_from_our_server_uses_the_login() {
        let login = saved("https://codeman.example/");
        let failed = url("https://codeman.example/api/sessions");
        let c = challenge("https", "Codeman.Example", 443, 0, Some(&failed));
        assert_eq!(decide(&c, Some(&login), false), ChallengeAnswer::UseCredential);
    }

    #[test]
    fn a_refused_login_is_reported_once_then_never_resent() {
        let login = saved("http://localhost:3000/");
        let failed = url("http://localhost:3000/api/status");
        let asked = [
            challenge("http", "localhost", 3000, 0, Some(&failed)),
            challenge("http", "localhost", 3000, 1, Some(&failed)),
            challenge("http", "localhost", 3000, 1, Some(&failed)),
            challenge("http", "localhost", 3000, 0, Some(&failed)),
        ];
        assert_eq!(
            answers(&login, &asked),
            [
                ChallengeAnswer::UseCredential,
                ChallengeAnswer::CancelAndReport,
                ChallengeAnswer::Cancel,
                ChallengeAnswer::Cancel,
            ]
        );
    }

    #[test]
    fn a_web_tab_or_rendered_html_asking_for_a_login_is_never_ours() {
        let login = saved("http://localhost:3000/");
        let ours = url("http://localhost:3000/api/status");
        for target in [
            "http://localhost:3000/webview/cap/",
            "http://localhost:3000/webview/cap/api/v1/query",
            "http://localhost:3000/html-view/cap/report.html",
            "http://localhost:3000/%77ebview/cap/",
        ] {
            let failed = url(target);
            // The dashboard answers 401 twice, as it would after a real
            // UseCredential: both get WebKit's own handling and nothing is
            // latched, so the next challenge from Codeman still gets the login.
            let asked = [
                challenge("http", "localhost", 3000, 0, Some(&failed)),
                challenge("http", "localhost", 3000, 1, Some(&failed)),
                challenge("http", "localhost", 3000, 0, Some(&ours)),
            ];
            assert_eq!(
                answers(&login, &asked),
                [
                    ChallengeAnswer::Default,
                    ChallengeAnswer::Default,
                    ChallengeAnswer::UseCredential,
                ],
                "{target}"
            );
            // Not even cancelled once the server has refused the login.
            assert_eq!(
                decide(&asked[1], Some(&login), true),
                ChallengeAnswer::Default,
                "{target}"
            );
        }
    }

    #[test]
    fn only_urls_below_the_base_path_are_ours() {
        let login = saved("http://h:3000/codeman/");
        let inside = url("http://h:3000/codeman/api/status");
        let sibling = url("http://h:3000/grafana/");
        let prefix = url("http://h:3000/codemanx/");
        let root = url("http://h:3000/");
        assert_eq!(
            decide(&challenge("http", "h", 3000, 0, Some(&inside)), Some(&login), false),
            ChallengeAnswer::UseCredential
        );
        for failed in [&sibling, &prefix, &root] {
            assert_eq!(
                decide(&challenge("http", "h", 3000, 1, Some(failed)), Some(&login), false),
                ChallengeAnswer::Default,
                "{failed}"
            );
        }
    }

    #[test]
    fn a_challenge_without_a_failure_url_is_not_ours() {
        let login = saved("http://localhost:3000/");
        assert_eq!(
            decide(&challenge("http", "localhost", 3000, 0, None), Some(&login), false),
            ChallengeAnswer::Default
        );
        assert_eq!(
            decide(&challenge("http", "localhost", 3000, 1, None), Some(&login), true),
            ChallengeAnswer::Default
        );
    }

    #[test]
    fn anything_else_gets_default_handling() {
        let login = saved("http://localhost:3000/");
        let failed = url("http://localhost:3000/api/status");
        let ok = Some(&failed);
        assert_eq!(
            decide(&challenge("http", "localhost", 3000, 0, ok), None, false),
            ChallengeAnswer::Default
        );
        assert_eq!(
            decide(&challenge("https", "localhost", 3000, 0, ok), Some(&login), false),
            ChallengeAnswer::Default
        );
        assert_eq!(
            decide(&challenge("http", "localhost", 3001, 0, ok), Some(&login), false),
            ChallengeAnswer::Default
        );
        assert_eq!(
            decide(&challenge("http", "127.0.0.1", 3000, 0, ok), Some(&login), false),
            ChallengeAnswer::Default
        );
        // A failure URL on another server, under a matching protection space.
        let elsewhere = url("http://localhost:3001/api/status");
        assert_eq!(
            decide(
                &challenge("http", "localhost", 3000, 0, Some(&elsewhere)),
                Some(&login),
                false
            ),
            ChallengeAnswer::Default
        );
        let not_basic = Challenge {
            basic: false,
            ..challenge("http", "localhost", 3000, 0, ok)
        };
        assert_eq!(decide(&not_basic, Some(&login), false), ChallengeAnswer::Default);
        let proxy = Challenge {
            proxy: true,
            ..challenge("http", "localhost", 3000, 0, ok)
        };
        assert_eq!(decide(&proxy, Some(&login), false), ChallengeAnswer::Default);
        // Another server is never cancelled, even after ours refused the login.
        let other = url("http://other:3000/api/status");
        assert_eq!(
            decide(&challenge("http", "other", 3000, 1, Some(&other)), Some(&login), true),
            ChallengeAnswer::Default
        );
    }

    #[test]
    fn ports_and_hosts_compare_like_urls() {
        assert!(credentials_match(&saved("https://h/"), "https", "h", 0));
        assert!(credentials_match(&saved("https://h/"), "https", "h", 443));
        assert!(credentials_match(&saved("http://h/"), "HTTP", "H", 80));
        assert!(credentials_match(&saved("http://[::1]:3000/"), "http", "::1", 3000));
        assert!(credentials_match(&saved("http://[::1]:3000/"), "http", "[::1]", 3000));
        assert!(!credentials_match(&saved("http://h/"), "ftp", "h", 0));
        assert!(!credentials_match(&saved("http://h:8080/"), "http", "h", 80));
        assert!(!credentials_match(&saved("mailto:admin@h"), "http", "h", 80));
    }

    #[test]
    fn dialogs_name_the_page() {
        assert_eq!(origin_label("localhost", 3000).as_deref(), Some("localhost:3000"));
        assert_eq!(origin_label("example.com", 0).as_deref(), Some("example.com"));
        assert_eq!(origin_label("::1", 3000).as_deref(), Some("[::1]:3000"));
        assert_eq!(origin_label(" ", 3000), None);
        assert_eq!(
            dialog_title(Some(("localhost:3000", false))),
            "The page at localhost:3000 says:"
        );
        assert_eq!(
            dialog_title(Some(("localhost:3000", true))),
            "An embedded page on localhost:3000 says:"
        );
        // A frame nothing names (about:srcdoc under an opaque origin) still
        // gets a first line of the app's own, never its own text in bold.
        assert_eq!(dialog_title(None), "An embedded page says:");
    }
}
