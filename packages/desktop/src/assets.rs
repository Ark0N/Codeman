//! Files bundled into the binary: the connect page, its icon, and the script
//! injected into every Codeman page (`window.CodemanHost`).

use std::borrow::Cow;
use wry::http::{header::CONTENT_TYPE, Request, Response, StatusCode};

const CONNECT_HTML: &[u8] = include_bytes!("../assets/connect.html");
const ICON_PNG: &[u8] = include_bytes!("../assets/icon.png");

/// The connect page loads nothing from outside the app.
const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src codemanapp:";

/// Serve `codemanapp://localhost/<path>`.
pub fn respond(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let (body, mime): (&'static [u8], &str) = match request.uri().path() {
        "/" | "/index.html" => (CONNECT_HTML, "text/html; charset=utf-8"),
        "/icon.png" => (ICON_PNG, "image/png"),
        _ => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Cow::Borrowed(&b"not found"[..]))
                .expect("static response");
        }
    };
    Response::builder()
        .header(CONTENT_TYPE, mime)
        .header("Content-Security-Policy", CSP)
        .header("Cache-Control", "no-store")
        .body(Cow::Borrowed(body))
        .expect("static response")
}

/// Injected at document start into the MAIN frame of every page (wry's
/// default), where it does nothing unless the page is http(s). It provides the
/// native-wrapper bridge Codeman's frontend already looks for
/// (`window.CodemanHost.openWindow/closeWindow/focusWindow`, see
/// `openInHostWindow` in src/web/public/app.js), so pop-outs become real app
/// windows. `openWindow` answers false, posting nothing, for a URL the native
/// side would drop (not http(s), or longer than its 4096-byte cap), so
/// Codeman shows its own error instead of marking a session detached with no
/// window behind it. Besides that it:
///
/// - turns a click on a same-origin download link (`download=true`, or a path
///   ending in `/download`) into a real download by giving the link a
///   `download` attribute. Codeman's file tree and attachment cards link to
///   `file-raw?download=true` without one, and the server sends a type WebKit
///   can show (png, pdf, txt), so WebKit would otherwise replace the Codeman
///   window with the file, with no way back. This runs in the capture phase,
///   before the file tree's own `stopPropagation`.
/// - does the same for `window.open` of such a `download=true` URL (the
///   attachment history), returning null instead of a window.
/// - sends clicks on links to other sites to the default browser, after
///   Codeman's own handlers have had their turn (bubble phase, skipped when
///   one of them called preventDefault). Middle clicks and modifier clicks
///   count too: a bare WKWebView has no new-tab gesture of its own, so they
///   would do nothing.
/// - reports the first same-origin 401 a `fetch` gets (`sessionExpired`),
///   once per page load: the session cookie is gone, usually because the
///   server restarted, and nothing in the page asks for the login again.
/// - defines `__codemanDesktopRefused(id)` (not enumerable) for
///   [`refused_script`].
pub const HOST_SHIM: &str = r#"(function () {
  'use strict';
  if (!/^https?:$/.test(location.protocol) || window.CodemanHost) return;
  var MAX_URL = 4096;
  var post = function (msg) {
    try { window.ipc.postMessage(JSON.stringify(msg)); return true; } catch (e) { return false; }
  };
  // An http(s) URL object, or null. fetch and window.open resolve against
  // the document base (Codeman sets <base href>), so those pass it.
  var httpUrl = function (raw, base) {
    try {
      var u = new URL(String(raw), base || location.href);
      return /^https?:$/.test(u.protocol) ? u : null;
    } catch (e) { return null; }
  };
  var sameOrigin = function (u) { return !!u && u.origin === location.origin; };
  var link = function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    return a && typeof a.href === 'string' && !a.hasAttribute('download') ? a : null;
  };

  Object.defineProperty(window, 'CodemanHost', {
    value: Object.freeze({
      desktop: true,
      openWindow: function (url) {
        var u = httpUrl(url);
        return u && u.href.length <= MAX_URL ? post({ cmd: 'openWindow', url: u.href }) : false;
      },
      closeWindow: function () { post({ cmd: 'closeWindow' }); },
      focusWindow: function () { post({ cmd: 'focusWindow' }); }
    })
  });

  // The native side could not open a window: say so. `id` is a string only
  // when CodemanHost.openWindow asked for that session's pop-out; that session
  // goes back to the dashboard (a fresh channel object, so this window's own
  // channel hears it too). Anything else, null included, only shows the toast.
  Object.defineProperty(window, '__codemanDesktopRefused', {
    value: function (id) {
      try {
        if (window.app && typeof window.app.showToast === 'function') {
          window.app.showToast('Could not open a new window', 'error');
        }
      } catch (e) {}
      try {
        if (typeof id === 'string' && id !== '' && typeof BroadcastChannel === 'function') {
          var ch = new BroadcastChannel('codeman-windows');
          ch.postMessage({ type: 'redocked', id: id });
          setTimeout(function () { try { ch.close(); } catch (e) {} }, 2000);
        }
      } catch (e) {}
    }
  });

  var markDownload = function (ev) {
    if (ev.button > 1) return;
    var a = link(ev);
    var u = a && httpUrl(a.href);
    if (sameOrigin(u) && (u.searchParams.get('download') === 'true' || /\/download$/.test(u.pathname))) {
      a.setAttribute('download', '');
    }
  };
  window.addEventListener('click', markDownload, true);
  window.addEventListener('auxclick', markDownload, true);

  var lastMiddle = null;
  var openOutside = function (ev) {
    if (ev.defaultPrevented || ev.button > 1) return;
    var a = link(ev);
    var u = a && httpUrl(a.href);
    if (!u || sameOrigin(u)) return;
    ev.preventDefault();
    // Older WebKit sends a middle click as 'click', newer as 'auxclick'; one
    // that sent both must still open the link once.
    if (ev.button === 1) {
      if (lastMiddle && lastMiddle.a === a && ev.timeStamp - lastMiddle.t < 500) return;
      lastMiddle = { a: a, t: ev.timeStamp };
    }
    post({ cmd: 'openExternal', url: u.href });
  };
  window.addEventListener('click', openOutside, false);
  window.addEventListener('auxclick', openOutside, false);

  var nativeOpen = window.open;
  if (typeof nativeOpen === 'function') {
    window.open = function open(url) {
      try {
        var u = arguments.length && url !== undefined ? httpUrl(url, document.baseURI) : null;
        if (sameOrigin(u) && u.searchParams.get('download') === 'true') {
          var a = document.createElement('a');
          a.href = u.href;
          a.setAttribute('download', '');
          a.click();
          return null;
        }
      } catch (e) {}
      return nativeOpen.apply(this, arguments);
    };
  }

  // Returns the promise fetch itself returned, so callers see exactly what
  // they saw before; the 401 check hangs off a side branch that swallows its
  // own errors and never reads the body.
  var expired = false;
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    var check = function (input, r) {
      if (expired || !r || r.status !== 401) return;
      var raw = r.url || (input && typeof input === 'object' && typeof input.url === 'string' ? input.url : input);
      if (!sameOrigin(httpUrl(raw, document.baseURI))) return;
      expired = true;
      post({ cmd: 'sessionExpired' });
    };
    window.fetch = function fetch(input) {
      var p = nativeFetch.apply(this, arguments);
      try {
        if (!expired && p && typeof p.then === 'function') {
          p.then(function (r) { try { check(input, r); } catch (e) {} }, function () {});
        }
      } catch (e) {}
      return p;
    };
  }
})();"#;

/// A toast inside Codeman (its own `showToast`; nothing happens on a page
/// without it). `kind` is one of Codeman's fixed toast kinds.
pub fn toast_script(text: &str, kind: &str) -> String {
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    format!("try {{ window.app && window.app.showToast && window.app.showToast({text}, \"{kind}\"); }} catch (e) {{}}")
}

/// A toast inside Codeman when a download finished.
pub fn download_toast_script(file_name: &str, ok: bool) -> String {
    let text = if ok {
        format!("Downloaded {file_name} to Downloads")
    } else {
        format!("Download of {file_name} failed")
    };
    toast_script(&text, if ok { "success" } else { "error" })
}

/// Runs in the window that asked for a window the native side did not open
/// (pop-out limit reached, policy refused it, window or web view failed to
/// build): the page shows an error toast. Does nothing on a page without the
/// shim.
///
/// `session_id` is the decoded id of a session pop-out
/// (`policy::session_id_of`), and only for a `CodemanHost.openWindow` request,
/// which comes from a trusted frame: that session then gets its tab back in
/// the dashboard. Pass `None` for every other refusal, above all the ones a
/// `window.open` or `target=_blank` from any frame caused, so a page cannot
/// make the dashboard drop the detached state of a session that is still
/// popped out.
pub fn refused_script(session_id: Option<&str>) -> String {
    let id = serde_json::to_string(&session_id).unwrap_or_else(|_| "null".into());
    format!(
        "try {{ if (typeof window.__codemanDesktopRefused === 'function') window.__codemanDesktopRefused({id}); }} catch (e) {{}}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(path: &str) -> Response<Cow<'static, [u8]>> {
        respond(
            Request::builder()
                .uri(format!("codemanapp://localhost{path}"))
                .body(Vec::new())
                .unwrap(),
        )
    }

    #[test]
    fn serves_page_and_icon_only() {
        let page = get("/index.html");
        assert_eq!(page.status(), StatusCode::OK);
        assert!(page.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        assert!(page.headers().contains_key("content-security-policy"));
        assert!(String::from_utf8_lossy(page.body()).contains("window.__codemanDesktop"));
        assert_eq!(get("/icon.png").status(), StatusCode::OK);
        assert_eq!(get("/../etc/passwd").status(), StatusCode::NOT_FOUND);
        assert_eq!(get("/other.js").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn refused_script_escapes_the_session_id() {
        let js = refused_script(Some("a'\"); alert(1); //\u{2028}\\"));
        assert!(js.starts_with("try { if (typeof window.__codemanDesktopRefused === 'function') "));
        assert!(js.contains(r#"window.__codemanDesktopRefused("a'\"); alert(1); //"#));
        assert!(js.contains("\u{2028}\\\\\"); } catch (e) {}"));
        assert!(js.ends_with(" } catch (e) {}"));
    }

    #[test]
    fn refused_script_without_a_session_passes_null() {
        assert_eq!(
            refused_script(None),
            "try { if (typeof window.__codemanDesktopRefused === 'function') window.__codemanDesktopRefused(null); } catch (e) {}"
        );
        assert!(refused_script(Some("")).contains("__codemanDesktopRefused(\"\")"));
    }

    #[test]
    fn shim_keeps_its_contract() {
        for needle in [
            "Object.freeze",
            "openWindow",
            "closeWindow",
            "focusWindow",
            "__codemanDesktopRefused",
            "sessionExpired",
            "'auxclick'",
            "MAX_URL = 4096",
            "typeof id === 'string' && id !== ''",
        ] {
            assert!(HOST_SHIM.contains(needle), "{needle}");
        }
        // The refused hook takes the session id the native side resolved; it
        // never parses or decodes a URL to find one.
        assert!(!HOST_SHIM.contains("decodeURIComponent"));
    }

    /// The connect page refuses what the app would drop without an answer, so
    /// its two limits have to be the app's own.
    #[test]
    fn connect_page_keeps_the_message_limits() {
        let page = String::from_utf8_lossy(CONNECT_HTML);
        for needle in [
            format!("var MAX_URL = {};", crate::policy::MAX_URL_LEN),
            format!("var MAX_FIELD = {};", crate::policy::MAX_FIELD_LEN),
        ] {
            assert!(page.contains(&needle), "{needle}");
        }
    }

    /// Copy puts setup::INSTALL_ONE_LINER on the clipboard, and the page shows
    /// the command as text of its own: the two have to be the same command.
    #[test]
    fn connect_page_shows_the_command_that_copy_copies() {
        let page = String::from_utf8_lossy(CONNECT_HTML);
        let shown = format!("<code id=\"oneliner\">{}</code>", crate::setup::INSTALL_ONE_LINER);
        assert!(page.contains(&shown), "{shown}");
    }

    #[test]
    fn toast_escapes_file_names() {
        let js = download_toast_script("a\"); alert(1); (\".txt", true);
        assert!(js.contains(r#"Downloaded a\"); alert(1); (\".txt to Downloads"#));
    }
}
