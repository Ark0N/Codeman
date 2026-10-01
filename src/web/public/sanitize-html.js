/**
 * @fileoverview Allowlist-based HTML sanitizer for markdown-rendered, agent/transcript-derived
 * content that is subsequently assigned via innerHTML (response viewer, attachment markdown
 * preview, message bodies).
 *
 * Security (COD-56): the previous sanitizer was a hand-rolled DENYLIST — it removed a fixed
 * set of tags (script/iframe/object/embed/form/base/meta/link/style), stripped on* attrs and a
 * few dangerous URL schemes, then re-serialized. Denylists are mXSS-prone: they did not strip
 * `svg`/`math` (which carry their own foreign-namespace parsing rules and can smuggle script via
 * namespace confusion), did not strip `style` attributes (CSS `expression()`/`url(javascript:)`
 * on legacy engines), and had no positive allowlist, so any tag/attribute not explicitly named
 * survived. `marked` runs with raw-HTML passthrough, so crafted HTML echoed by an agent flows
 * straight into this function.
 *
 * This module replaces that with DOMPurify (Cure53), an allowlist sanitizer that is the
 * industry standard for mXSS defense. It is configured to allow exactly the tag/attribute set
 * that markdown rendering legitimately produces (headings, lists, code, blockquotes, links,
 * tables, images with safe src) and to FORBID `style`/`svg`/`math` plus all event handlers and
 * dangerous URL schemes.
 *
 * Cross-environment: in the browser this file runs as a classic <script> after
 * vendor/dompurify.min.js and wires `window.sanitizeMarkdownHtml`. The factory is also exported
 * (window/globalThis + CommonJS) so a jsdom unit test can build a sanitizer bound to a
 * jsdom-window DOMPurify instance and exercise the exact same config.
 *
 * @globals {function} sanitizeMarkdownHtml - (html:string) => string, sanitized HTML
 * @globals {function} createMarkdownSanitizer - (DOMPurify) => sanitizeMarkdownHtml (for tests)
 * @dependency vendor/dompurify.min.js (provides the global DOMPurify)
 * @loadorder 5.6 of 15 — after input-cjk.js(5.5), before app.js(6) (app.js calls it)
 */

(function (root) {
  'use strict';

  /**
   * Tags markdown rendering (marked, gfm) legitimately emits. Anything outside this set is
   * dropped by DOMPurify. Deliberately excludes svg/math (mXSS foreign-namespace vectors) and
   * form/embed/object/iframe/script/style (no place in rendered markdown).
   */
  var ALLOWED_TAGS = [
    'a',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'del',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'ins',
    'kbd',
    'li',
    'mark',
    'ol',
    'p',
    'pre',
    'q',
    's',
    'samp',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
    'var',
  ];

  /**
   * Attributes allowed on the tags above. `style` is intentionally absent (CSS-based vectors).
   * `class`/`id` survive because the response viewer adds wrapper classes downstream and code
   * blocks may carry `language-*` classes from marked. `name` is absent on purpose: marked never
   * emits it, and `<img name="app">` would make `document.app` that image, which every inline
   * `onclick="app.…()"` handler resolves before the global (DOM clobbering), so one rendered
   * README could break every button until a reload.
   */
  var ALLOWED_ATTR = [
    'href',
    'src',
    'alt',
    'title',
    'class',
    'id',
    'colspan',
    'rowspan',
    'align',
    'width',
    'height',
    'lang',
    'dir',
    'start',
    'reversed',
    'type',
  ];

  /**
   * Build a sanitizer bound to a specific DOMPurify instance. The browser passes the global
   * DOMPurify; tests pass a jsdom-window-bound instance so the same config is exercised under
   * vitest without a real browser.
   */
  function createMarkdownSanitizer(DOMPurify) {
    if (!DOMPurify || typeof DOMPurify.sanitize !== 'function') {
      throw new Error('createMarkdownSanitizer: a DOMPurify instance is required');
    }

    var CONFIG = {
      ALLOWED_TAGS: ALLOWED_TAGS,
      ALLOWED_ATTR: ALLOWED_ATTR,
      // Defense in depth even though style/svg/math are not in ALLOWED_TAGS: also forbid the
      // foreign-namespace roots and style so config drift can't silently re-admit them.
      FORBID_TAGS: ['style', 'svg', 'math', 'script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['style'],
      // NOTE: do NOT set USE_PROFILES here. DOMPurify treats USE_PROFILES and
      // ALLOWED_TAGS/ALLOWED_ATTR as mutually exclusive — when a profile is set it
      // RESETS the allow-lists to the full profile and silently ignores the curated
      // lists above, widening the tag set far beyond what markdown emits. Relying on
      // the explicit ALLOWED_TAGS/ALLOWED_ATTR keeps the tight allowlist in force;
      // FORBID_TAGS/FORBID_ATTR remain as defense-in-depth. DOMPurify still applies
      // its default safe-URI handling (blocks javascript:/vbscript:, allows
      // http/https/mailto/tel + data: only on image tags).
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: [],
      RETURN_DOM: false,
      RETURN_DOM_FRAGMENT: false,
      // Keep text content of any removed element (so stripping a stray tag doesn't eat prose),
      // matching the previous serializer's behavior of dropping the element but not its text.
      KEEP_CONTENT: true,
    };

    return function sanitizeMarkdownHtml(html) {
      return DOMPurify.sanitize(html == null ? '' : String(html), CONFIG);
    };
  }

  // Expose the factory for tests (and any non-browser consumer).
  if (root) {
    root.createMarkdownSanitizer = createMarkdownSanitizer;
    // In the browser, vendor/dompurify.min.js has already defined the global DOMPurify.
    if (root.DOMPurify && typeof root.DOMPurify.sanitize === 'function') {
      root.sanitizeMarkdownHtml = createMarkdownSanitizer(root.DOMPurify);
    }
  }

  // CommonJS export for the vitest/jsdom unit test.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createMarkdownSanitizer: createMarkdownSanitizer,
      ALLOWED_TAGS: ALLOWED_TAGS,
      ALLOWED_ATTR: ALLOWED_ATTR,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
