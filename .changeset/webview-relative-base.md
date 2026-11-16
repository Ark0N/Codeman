---
"aicodeman": patch
---

Web tabs whose dashboard ships a relative `<base href>` render again. The proxy rewrites the document URL to strip its `/webview/<cap>/` prefix, and a relative base is resolved against that URL — so `./` (what Vite builds emit, DeepSeek Harness among them) pointed at Codeman's root: every module script 404'd and the page painted its background with nothing on it. The rewrite now resolves such a base against the document's own directory inside the proxy prefix before the mask runs (a page at `/webview/<cap>/app/page.html` gets `/webview/<cap>/app/`, not the proxy root); a cross-origin base is left exactly as the author wrote it.
