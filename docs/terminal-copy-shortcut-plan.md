# Terminal smart copy (Ctrl+C) plan

Issue: [#211](https://github.com/Ark0N/Codeman/issues/211) "Terminal: Ctrl+C should copy when text is selected (interrupt otherwise)".
Origin: r/selfhosted feedback, "Biggest stumbling block is apparent lack of copy-paste in the terminal."

Status: **implemented and shipped** on 2026-08-05 (this document is kept as the rationale record). It was first served as an isolated beta over Tailscale for manual sign-off, then landed. Section 2 is the research that shaped the design, sections 4 to 6 describe what was built.

---

## 1. What the issue asks for

- Text selected in the terminal + `Ctrl+C` -> copy the selection, toast, clear the selection, do NOT send the byte to the PTY.
- No selection + `Ctrl+C` -> unchanged, the interrupt (`0x03`) reaches the PTY.
- `Ctrl+Shift+C` as an explicit copy chord.
- The selection check must run before the shortcut registry dispatch so a rebind cannot cost the user their interrupt key.
- Paste is out of scope (it already works via `Ctrl+V`, which terminal-ui.js routes to the image/text paste trap).

## 2. Verified current behavior

### 2.1 xterm cancels the Ctrl+C keydown, so no copy can happen

`src/web/public/vendor/xterm.min.js` (xterm 6.x), `_keyDown`:

```js
_keyDown(x){ if(this._keyDownHandled=!1, this._keyDownSeen=!0,
  this._customKeyEventHandler && this._customKeyEventHandler(x)===!1) return !1;
  ... evaluateKeyboardEvent(...) ... this.cancel(x) ... }
```

Two consequences that shape the design:

1. The custom handler runs **first**, before xterm evaluates the key. Returning `false` exits before `cancel(x)`, so returning `false` does **not** call `preventDefault()` for us.
2. When the handler returns `true`, xterm turns Ctrl+C into `0x03` and cancels the event, which is why the browser's own copy command never runs.

Probe (headless chromium against an isolated server on port 3174, selection active, real focus on `.xterm-helper-textarea`, synthetic Ctrl+C keydown):

```json
{ "hasSelection": true, "defaultPrevented": true, "dataSeen": ["\"\\u0003\""],
  "clipboardAfter": "SENTINEL-BEFORE", "stillHasSelection": false }
```

So today: interrupt byte sent, clipboard untouched, and xterm drops the selection anyway. The last point matters, "copy then clear the selection" is not a behavior change in how the selection feels, it is what already happens on any keypress.

### 2.2 Why right-click Copy works today

xterm registers a `copy` listener on its root element that substitutes the selection text:

```js
this._register(addDisposableListener(this.element,"copy",(k=>{ this.hasSelection() && copyHandler(k,this._selectionService) })))
```

Second probe (port 3175, real `page.keyboard.press('Control+c')`, custom handler patched to return `false` for Ctrl+C without `preventDefault`):

```json
{ "dataSeen": [], "copyEvents": ["xterm-element"],
  "clipboardAfter": "native-copy-probe-line\n...", "stillHasSelection": true }
```

So a "return false and let the browser copy" implementation would also work in Chromium. It is rejected below (section 3.3) because it gives no toast, does not clear the selection, and leans on per-browser behavior of the copy command when the focused element is xterm's empty helper textarea.

### 2.3 The document-level capture handler will not interfere

`setupEventListeners()` in `src/web/public/app.js:989` runs on document capture, before xterm's textarea listener. Its registry loop skips any entry whose action is not in the local `SHORTCUT_ACTIONS` map:

```js
if (shortcut.disabled || !shortcut.action) continue;
const action = SHORTCUT_ACTIONS[shortcut.action];
if (!action) continue;
```

This is exactly how `command-palette` already behaves: it is a full registry entry (rebindable and disableable in App Settings) whose dispatch happens in a dedicated, focus-aware gate rather than the generic loop. The new copy entry follows that pattern, so the capture handler falls through untouched and the terminal handler owns the decision.

### 2.4 Registry matching rules that constrain the bindings

`matchesShortcutEvent()` (`app.js:4890`):

- Ctrl and Cmd are interchangeable as the primary modifier, so a `['ctrl']` binding also matches Cmd+C on macOS. That is fine here: with a selection it copies (same result the native macOS path gives today), without one it falls through.
- Every other modifier must be declared exactly: `if (mods.includes('shift') !== !!e.shiftKey) return false`. So `Ctrl+Shift+C` needs its own binding, a plain `ctrl+c` binding will never swallow it.
- `binding.code` wins when present, otherwise `binding.key` is compared case-insensitively.

### 2.5 Where selection is actually possible

- The server strips mouse-tracking DECSETs for `claude`, `codex`, and `gemini` (`isAltScreenStripMode`, `src/session.ts:179`), which is why plain drag-select works in those tabs even though the TUI has mouse tracking on.
- `shell`, `opencode`, and `antigravity` keep mouse reporting, so xterm requires `Shift`+drag to force a selection there. Worth one line in the docs, it is not a code change.
  ⚠️ **Corrected 2026-09-16:** `opencode` no longer keeps mouse reporting in the browser. Its TUI enables tracking DECSETs, tmux `mouse off` passes them through to the tmux client, and xterm then reported DRAGS to the TUI instead of selecting — so `Shift`+drag was the only way to select, and a plain drag silently copied nothing (measured 62 `none` / 18 `any` over 16s; 5/5 dead drags while `any`). The server now strips those DECSETs (`isMuxMouseStripMode`), so a plain drag selects in opencode. `shell` and `antigravity` are unchanged.
- Touch devices deliberately disable selection entirely (`body.touch-device .terminal-container .xterm{user-select:none !important}`, `styles.css:3196`), and phones have no Ctrl key. This feature is desktop and hardware-keyboard only, with no mobile regression surface.

### 2.6 Helpers that already exist and should be reused

| Need | Existing code |
| --- | --- |
| Clipboard write with an HTTP-safe fallback | `_copyText(text)` in `app.js:1887` (Clipboard API, then hidden textarea + `execCommand`) |
| Toast | `showToast(message, type)` in `panels-ui.js:4385` |
| Translated string | `'Copied to clipboard'` already in `i18n.js:453` |
| Focus-aware chord gate to copy the shape of | `shouldOpenCommandPaletteFromShortcut(e)` in `panels-ui.js:285` |
| Buffer-wide copy (currently unreferenced) | `copyTerminal()` in `terminal-ui.js:2615` |

`_copyText` matters more than it looks: `install.sh`'s LAN option serves plain HTTP, where `navigator.clipboard` is undefined. The issue's suggested `navigator.clipboard.writeText` alone would silently do nothing for those users, the `execCommand` fallback covers them.

## 3. Design

### 3.1 Behavior

| Chord | Selection present | No selection |
| --- | --- | --- |
| `Ctrl+C` (and Cmd+C, per registry equivalence) | copy, toast, clear selection, swallow the key | fall through, xterm sends `0x03` (interrupt) |
| `Ctrl+Shift+C` | copy, toast, clear selection, swallow the key | swallow, no-op (see 3.2) |
| Shortcut disabled in App Settings | never copies, `Ctrl+C` is always the interrupt | unchanged |
| Rebound to another chord | that chord copies when a selection exists | plain `Ctrl+C` is always the interrupt |

### 3.2 Why `Ctrl+Shift+C` with no selection is swallowed rather than forwarded

Today `Ctrl+Shift+C` produces `0x03` as well (the shift is irrelevant to the control byte), so forwarding would be "no regression". But once the chord is advertised as *the explicit copy key*, letting it interrupt a running agent when the selection happens to be empty is a footgun with no upside. Swallowing costs nothing: a user who wants to interrupt has `Ctrl+C` right there.

The rule in code is "no selection and the matched chord had Shift -> swallow", not a hardcoded key check, so it stays correct under rebinds.

### 3.3 Why an explicit clipboard write rather than falling through to the native copy

Probe 2 showed the native path works in Chromium, but the explicit write is chosen because it:

- gives the "Copied to clipboard" toast, which is the discoverability half of the issue,
- clears the selection so a second `Ctrl+C` interrupts (the smart-copy contract),
- works on plain-HTTP LAN installs through `_copyText`'s `execCommand` fallback,
- does not depend on how each browser treats a copy command issued while an empty textarea has focus.

### 3.4 Why no new app setting

Per-shortcut enable/disable and rebinding already exist in App Settings -> Shortcuts and are driven by the registry. A user who wants "Ctrl+C is always interrupt" unchecks one box. Adding a `terminalSmartCopy` setting would duplicate that and would drag in the per-device vs synced decision (`displayKeys` + `.strict()` `SettingsUpdateSchema`) for no gain.

## 4. Code changes, file by file

### 4.1 `src/web/public/app.js`, registry entry

Add to `DEFAULT_SHORTCUTS` (after the `clear-terminal` entry, ~line 351) so the Terminal group stays together:

```js
{
  id: 'copy-selection',
  group: 'Terminal',
  label: 'Copy Selection',
  bindings: [
    { modifiers: ['ctrl'], key: 'c' },
    { modifiers: ['ctrl', 'shift'], key: 'C' },
  ],
  // Dispatched by shouldCopyTerminalSelectionFromShortcut() in terminal-ui.js,
  // deliberately NOT in SHORTCUT_ACTIONS: the generic capture loop always
  // preventDefaults, which would cost the user the interrupt key.
  action: 'copyTerminalSelection',
},
```

Match on `key`, not `code`. xterm decides what byte to emit from the produced character, so intercepting the physical `KeyC` on a layout where it does not produce "c" would diverge from what xterm would have sent.

The `action` string is required for App Settings to render the row as configurable (`configurable = !!shortcut.action && Array.isArray(shortcut.bindings)`, `settings-ui.js:2624`). Do **not** add `copyTerminalSelection` to `SHORTCUT_ACTIONS`.

### 4.2 `src/web/public/terminal-ui.js`, the gate

New prototype method, modeled on `shouldOpenCommandPaletteFromShortcut`:

```js
shouldCopyTerminalSelectionFromShortcut(ev) {
  if (!ev || ev.type !== 'keydown') return false;          // the handler also runs for keypress/keyup
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) return false;  // hot path: plain typing exits here
  const registryAvailable =
    typeof this.getShortcutRegistry === 'function' && typeof this.matchesShortcutEvent === 'function';
  const entry = registryAvailable
    ? this.getShortcutRegistry().find((s) => s.id === 'copy-selection')
    : null;
  if (entry) return !entry.disabled && this.matchesShortcutEvent(ev, entry);
  return (ev.key || '').toLowerCase() === 'c' && !ev.altKey; // fallback for isolated harnesses
}
```

### 4.3 `src/web/public/terminal-ui.js`, the branch

Inside `attachCustomKeyEventHandler` (`terminal-ui.js:133`), after the command-palette gate and before the `Ctrl+V` branch:

```js
// Smart copy (#211): with a selection, Ctrl+C copies instead of sending ^C.
// With no selection it MUST fall through (return true, no preventDefault) or
// the interrupt key is lost. Ctrl+Shift+C is the explicit chord and never
// falls through: an "explicit copy" that interrupts the agent is a footgun.
if (this.shouldCopyTerminalSelectionFromShortcut?.(ev)) {
  const selection = this.terminal.hasSelection?.() ? this.terminal.getSelection() : '';
  if (selection) {
    ev.preventDefault();
    void this.copyTerminalSelection(selection);
    return false;
  }
  if (ev.shiftKey) {
    ev.preventDefault();
    return false;
  }
  return true;
}
```

`preventDefault()` is explicit because returning `false` alone does not cancel the event (section 2.1), and without it the browser would run its own copy on top of ours.

### 4.4 `src/web/public/terminal-ui.js`, the copy action

```js
async copyTerminalSelection(text) {
  const selection = text ?? (this.terminal.hasSelection?.() ? this.terminal.getSelection() : '');
  if (!selection) return false;
  const ok = await this._copyText(selection);
  if (ok) {
    this.terminal.clearSelection?.();
    this.showToast('Copied to clipboard', 'success');
  } else {
    this.showToast('Failed to copy', 'error');
  }
  // _copyText's execCommand fallback focuses a temp textarea; restore the
  // terminal (this.terminal.focus is the CJK-aware router, not xterm's raw focus).
  this.terminal.focus();
  return ok;
}
```

The selection text is captured **before** the first `await`, and `navigator.clipboard.writeText` is reached in the same task as the keydown, so user activation still holds.

### 4.5 `src/web/public/i18n.js`

`'Copied to clipboard'` exists. Add `'Failed to copy': '复制失败'` (the error path is new to this surface).

### 4.6 Documentation

| File | Change |
| --- | --- |
| `README.md` shortcut table (~line 648) | `\| `Ctrl/Cmd+C` \| Copy selection (interrupts when nothing is selected) \|` and a `Ctrl+Shift+C` row |
| `src/web/public/index.html` help modal, Terminal section (~line 641) | `<div><kbd>Ctrl</kbd>+<kbd>C</kbd></div><div>Copy Selection / Interrupt</div>` plus the Ctrl+Shift+C row. Keep the existing negative assertion in `help-modal-shortcuts.test.ts` in mind (it forbids `Ctrl+K`, `C` is fine) |
| `CLAUDE.md` "Keyboard shortcuts" line | add `Ctrl+C` (copy selection, else interrupt) and `Ctrl+Shift+C` |
| `docs/architecture-invariants.md` -> "Command palette and shortcut registry" | append the invariant: the no-selection path must return `true` without `preventDefault`, the branch is keydown-only, and `copyTerminalSelection` must stay out of `SHORTCUT_ACTIONS` |

The shortcut overlay (`Ctrl+?`) and App Settings -> Shortcuts are registry-driven and pick the entry up with no edit.

## 5. Edge cases and risks

| Case | Handling |
| --- | --- |
| Handler also fires for `keypress`/`keyup` | gated on `ev.type === 'keydown'`. xterm's `_keyPress` bails on ctrl combos anyway, so no stray byte |
| CJK IME composing | the existing `isComposing || keyCode === 229` guard is the first line of the handler and stays first |
| Local echo overlay has unsent `pendingText` | the copy branch returns before `onData`, so `pendingText`, flushed offsets and the durable input queue are untouched. The no-selection path is byte-identical to today, including the "control char flushes buffered text then sends `0x03`" logic at `terminal-ui.js:895` |
| Plain HTTP (LAN install) | `_copyText` falls back to `execCommand`, then focus is restored |
| Clipboard write rejected (permissions policy, no gesture) | error toast, right-click Copy still available |
| Whitespace-only or empty selection | `getSelection()` empty string is treated as "no selection", so Ctrl+C still interrupts |
| macOS Cmd+C | registry treats ctrl/meta as interchangeable, so with a selection it takes our path (same visible result as today's native copy), without one it falls through |
| Chrome/Firefox `Ctrl+Shift+C` is the devtools inspect chord | browser-level and may still toggle devtools, our copy runs regardless. Document as a caveat, `Ctrl+C` is the primary path |
| Selection in a tab whose TUI owns the mouse (`shell`/`antigravity`; `opencode` left this list on 2026-09-16 — its DECSETs are stripped now) | unchanged, `Shift`+drag selects, then Ctrl+C copies |
| Web tab (iframe dashboard) focused | xterm handler never runs, browser-native copy inside the iframe |
| Teammate/subagent terminals (`panels-ui.js:2268`, `onData` wired) | same limitation exists there, out of scope for this PR (section 8) |

## 6. Test plan

New file `test/terminal-copy-selection.test.ts` (node env, `vm` harness in the style of `test/command-palette-ui.test.ts`), covering `shouldCopyTerminalSelectionFromShortcut` in isolation:

1. Ctrl+C keydown -> true, keyup/keypress of the same chord -> false.
2. Ctrl+Shift+C -> true, plain `c` -> false, Ctrl+K -> false.
3. Registry entry `disabled: true` -> false for every chord.
4. Rebound entry (for example Alt+Y) -> true for the rebind, false for Ctrl+C.
5. Missing registry (harness without `getShortcutRegistry`) -> falls back to the `c` check.

Static assertions appended to `test/keyboard-shortcuts.test.ts` (this suite already pins the xterm-handler chokepoint):

6. `DEFAULT_SHORTCUTS` contains `id: 'copy-selection'` and `SHORTCUT_ACTIONS` does **not** contain `copyTerminalSelection` (the interrupt-safety invariant).
7. `terminal-ui.js` contains the `shouldCopyTerminalSelectionFromShortcut` branch and a `return true` no-selection fall-through.
8. README + help modal rows exist (mirrors the existing palette/Alt-nav doc assertions).

`test/help-modal-shortcuts.test.ts`: add `expectShortcut(helpModal, ['Ctrl', 'C'], 'Copy Selection')`.

New browser test `test/terminal-copy-shortcut.test.ts` (Playwright, port **3174**, free per a scan of `test/`), following `test/webgl-fallback.test.ts`: boot `WebServer`, grant `clipboard-read`/`clipboard-write`, `terminal.write()` a known line, `selectLines()`, real `page.keyboard.press('Control+c')`, then assert clipboard content, empty `onData` capture, cleared selection and the toast. Second case: no selection, assert `onData` saw `\u0003` and the clipboard is unchanged.
Per repo convention, browser suites are excluded from CI, so add the filename to the exclude list in `config/vitest.ci.config.ts` and run it locally.

Regression runs: `npm test -- test/keyboard-shortcuts.test.ts`, `test/help-modal-shortcuts.test.ts`, `test/command-palette-ui.test.ts`, `test/input-send-order.test.ts`, then `npm run test:ci`.

## 7. Manual verification before COM (CLAUDE.md rule)

Against a throwaway session on the live instance (`curl -sk https://localhost:3000/...`, never w1/w2/w3):

1. Select output with the mouse, press Ctrl+C, confirm the toast, paste elsewhere, confirm the agent did not stop.
2. Press Ctrl+C again with nothing selected, confirm the agent interrupts.
3. Type a few characters with local echo on (phone or `localEchoEnabled` forced), press Ctrl+C with no selection, confirm buffered text plus interrupt behave as before.
4. Uncheck the shortcut in App Settings -> Shortcuts, confirm Ctrl+C always interrupts even with a selection.
5. Rebind it, confirm the new chord copies and Ctrl+C reverts to pure interrupt.
6. Repeat 1 and 2 in a `shell` or `antigravity` tab using Shift+drag to select (`opencode` selects with a plain drag since 2026-09-16).
7. Load over plain HTTP (`--host` LAN or `http://127.0.0.1:<port>`) and confirm the `execCommand` fallback copies and focus returns to the terminal.
8. Mobile smoke: confirm nothing changed (selection is CSS-disabled, no Ctrl key).

## 8. Out of scope, follow-ups worth filing separately

- **Teammate/subagent terminals** (`panels-ui.js:2268`) have the same blocked-copy problem. One `attachCustomKeyEventHandler` reusing `copyTerminalSelection` would fix them, but it touches a different surface and deserves its own change.
- **A mobile copy affordance.** Selection is disabled on touch, so phones still cannot copy terminal text. The unreferenced `copyTerminal()` (whole buffer) plus a keyboard-accessory "Copy" button would be the cheapest answer.
- **Right-click context menu** with Copy/Paste, better discoverability than any chord, but a bigger UI surface.
- **`copyTerminal()` cleanup**: it uses raw `navigator.clipboard` rather than `_copyText`, so it would fail on plain HTTP if ever wired up.

## 9. PR mechanics

- Branch off `master` (verify with `git branch --show-current`, the tree is shared), stage explicit paths only.
- Files touched: `src/web/public/app.js`, `src/web/public/terminal-ui.js`, `src/web/public/i18n.js`, `src/web/public/index.html`, `README.md`, `CLAUDE.md`, `docs/architecture-invariants.md`, `docs/terminal-copy-shortcut-plan.md`, three test files, `config/vitest.ci.config.ts`.
- `index.html`, `app.js` and `terminal-ui.js` are `.prettierignore`d hand-formatted assets, match the surrounding style by hand. `npm run check:public-assets` and `npm run check:frontend-syntax` are the guards.
- No changeset in this PR: a merged, unconsumed changeset turns the Release workflow red until the next COM, and the COM flow writes release notes covering everything since the last tag (current version is 1.10.0).
- Close #211 from the PR body.

Rough size: about 60 lines of product code, most of the work is the tests and the four documentation surfaces.
