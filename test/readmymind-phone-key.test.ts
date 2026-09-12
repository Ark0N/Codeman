// Port: none (pure static analysis — runs in CI, no browser/server).
//
// Read My Mind phase 3 part 1 guards: the modal's alternates row and the phone
// keyboard-accessory 🧠 key. The mobile Playwright suite is excluded from CI,
// so like test/mobile-header-buttons-policy.test.ts this parses the frontend
// assets directly to pin the wiring that only a phone would exercise:
//
//  1. the 🧠 key ships in BOTH accessory-bar templates (setMode() swaps the
//     bar's innerHTML between them, so a key present in only one layout would
//     silently vanish when the user toggles `extendedKeyboardBar`) and routes
//     to the shared modal;
//  2. the key is hidden unless the bar carries the `rmm-enabled` marker class
//     — gating must live on the BAR element because setMode() rebuilds the
//     buttons — synced at init and re-synced by settings-ui.js on every
//     settings apply (a live toggle needs no reload);
//  3. the header 🧠 button STAYS off phones (the key is the phone surface);
//  4. the modal renders on phones as a small dialog, not the full-screen
//     default that phone `.modal-content` rules would impose;
//  5. readmymind-ui.js keeps the no-innerHTML discipline (predictor output is
//     injectable content) and renders alternates into the i18n-skipped
//     container declared in index.html.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '../src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf-8');

describe('read my mind phone key + alternates (static guards)', () => {
  const accessory = read('keyboard-accessory.js');
  const styles = read('styles.css');
  const mobile = read('mobile.css');
  const html = read('index.html');
  const ui = read('readmymind-ui.js');
  const settingsUi = read('settings-ui.js');
  // Everything phone-specific lives in the max-width 599px block of mobile.css.
  const phoneBlock = mobile.slice(mobile.indexOf('@media (max-width: 599px)'));

  it('ships the 🧠 key in BOTH accessory bar templates and routes it to the modal', () => {
    const simple = accessory.match(/_simpleButtons\s*:\s*`([\s\S]*?)`/)?.[1] ?? '';
    const extended = accessory.match(/_extendedButtons\s*:\s*`([\s\S]*?)`/)?.[1] ?? '';
    expect(simple).toMatch(/accessory-btn-rmm[^>]*data-action="readmymind"/);
    expect(extended).toMatch(/accessory-btn-rmm[^>]*data-action="readmymind"/);
    expect(accessory).toMatch(/case 'readmymind':/);
    expect(accessory).toMatch(/openReadMyMind/);
  });

  it('hides the key until the bar carries rmm-enabled, synced at init and on settings apply', () => {
    expect(styles).toMatch(/\.keyboard-accessory-bar \.accessory-btn-rmm \{\s*display: none;/);
    expect(styles).toMatch(/\.keyboard-accessory-bar\.rmm-enabled \.accessory-btn-rmm \{\s*display: inline-flex;/);
    // init() applies the gate as soon as the bar exists…
    expect(accessory).toMatch(/this\.syncReadMyMind\(\);/);
    // …and settings-ui re-syncs it on every settings apply (live toggle).
    expect(settingsUi).toMatch(/KeyboardAccessoryBar\.syncReadMyMind/);
  });

  it('keeps the header 🧠 button off phones (the accessory key is the phone surface)', () => {
    expect(phoneBlock).toMatch(/\.btn-icon-header\.btn-readmymind\s*\{\s*display: none !important;/);
  });

  it('renders the modal as a small dialog on phones, not the full-screen default', () => {
    expect(phoneBlock).toMatch(/\.modal-content\.readmymind-modal\s*\{[^}]*height: auto;/);
  });

  it('declares the i18n-skipped alternates container and keeps the no-innerHTML discipline', () => {
    expect(html).toMatch(/id="readMyMindAlternates"[^>]*data-i18n-skip/);
    // Predictor output is injectable content: value/textContent only, ever.
    // (`.innerHTML`: property ACCESS — the fileoverview's "never innerHTML"
    // prose is allowed to say the word.)
    expect(ui).not.toMatch(/\.innerHTML/);
    expect(ui).toContain('readMyMindAlternates');
    expect(ui).toMatch(/\.textContent = suggestion\.prompt/);
  });

  // Phase 3 part 2: the Rethink steer note (docs/readmymind-plan.md phase 3).
  it('wires the rethink steer note end to end: field, payload, phase visibility, reset', () => {
    // The field lives in the modal, capped to the schema's 2000-char limit,
    // and Enter in it triggers a rethink (mirroring the prompt field's
    // Enter-to-send).
    expect(html).toMatch(/id="readMyMindSteer"[^>]*maxlength="2000"/);
    expect(html).toMatch(/id="readMyMindSteer"[^>]*onkeydown="[^"]*rethinkReadMyMind\(\)"/);
    // Predict sends the trimmed note as `steer`, bounded to the schema cap.
    expect(ui).toMatch(/body\.steer = steer\.slice\(0, 2000\)/);
    // The row hides ONLY during loading: Rethink is live in both the ready
    // and the empty-result phases, so the note must be reachable in both.
    expect(ui).toMatch(/steerRow\.style\.display = phase === 'loading' \? 'none' : ''/);
    // A fresh open resets the note along with the rethink memory.
    expect(ui).toMatch(/steer\.value = ''/);
  });

  it('styles the footer with btn-toolbar (bare "btn btn-*" matches no CSS in this codebase)', () => {
    const modal = html.slice(html.indexOf('id="readMyMindModal"'), html.indexOf('id="approvalsDrawer"'));
    // The unstyled classes the footer originally shipped with must not return.
    expect(modal).not.toMatch(/class="btn /);
    expect(modal.match(/class="btn-toolbar/g)?.length).toBe(4);
    expect(modal).toMatch(/class="btn-toolbar btn-primary"[^>]*sendReadMyMind\(true\)/);
    // btn-toolbar is display:flex (block-level): without the desktop footer
    // row rule the four buttons would stack vertically.
    expect(styles).toMatch(/\.readmymind-modal \.modal-footer \{[^}]*display: flex/);
    // The skin block's bare .btn-toolbar (0,2,1) greys out .btn-primary
    // (0,2,0), so Send's accent must be re-asserted at higher specificity.
    expect(styles).toMatch(/\.readmymind-modal \.modal-footer \.btn-toolbar\.btn-primary \{[^}]*var\(--accent\)/);
    // The phone block sizes the same class for finger targets.
    expect(phoneBlock).toMatch(/\.readmymind-modal \.modal-footer \.btn-toolbar/);
  });
});
