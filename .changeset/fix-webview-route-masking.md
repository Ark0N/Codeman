---
"aicodeman": patch
---

fix(webview): let a proxied single-page app route on its own path, and recover a frame that reloads

A dashboard served through a web tab saw `/webview/<cap>/` as its `location.pathname`, and
no app has a route for that: a React Router, Vue Router or Vite dev-server page painted its
HTML and CSS and then replaced them with its own "page not found" the moment its script ran.
The proxy's runtime shim now rewrites the history entry to the path the page would see on its
own origin before any page script runs, while every URL the page emits still goes through
the existing rewrite layers (plus `Worker`, `sendBeacon` and `window.open`, which the masked
Referer can no longer rescue). A navigation the page starts itself afterwards — a dev
server's full-reload HMR, a root-absolute `location.href` — lands on Codeman's root with no
capability; it is recognised by shape (an iframe navigation asking for HTML for a path Codeman
does not serve), answered with a static page that tells the owning tab which path was lost,
and the tab remounts the frame inside the prefix at that path. That answer is served before
the credential checks, so it never counts as a failed login.
