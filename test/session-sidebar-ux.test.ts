/** Structural and schema coverage for vertical session navigation density and actions. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const app = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
const html = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
const settingsUi = readFileSync(resolve(publicDir, 'settings-ui.js'), 'utf8');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const i18n = readFileSync(resolve(publicDir, 'i18n.js'), 'utf8');
const railController = readFileSync(resolve(publicDir, 'tab-rail-resize.js'), 'utf8');

describe('vertical session navigation UX contract', () => {
  it('accepts only integer session-name sizes from 11 through 18 pixels', () => {
    for (const value of [11, 14, 18]) {
      expect(SettingsUpdateSchema.safeParse({ sessionSidebarFontSize: value }).success).toBe(true);
    }
    for (const value of [10, 19, 14.5, '14']) {
      expect(SettingsUpdateSchema.safeParse({ sessionSidebarFontSize: value }).success).toBe(false);
    }
  });

  it('renders one existing action cluster through a shared placement resolver', () => {
    expect(app).toContain('shouldInlineSessionActions()');
    expect(app).toContain('const inlineSessionActions = this.shouldInlineSessionActions();');
    expect(app).toContain('const tabActionsHtml =');
    expect(app).toContain("${inlineSessionActions ? tabActionsHtml : ''}");
    expect(app).toContain("${inlineSessionActions ? '' : tabActionsHtml}");
    expect(app.match(/class="tab-actions"/g)).toHaveLength(1);
    expect(app).toContain("tab.querySelector(':scope > .tab-actions')");
  });

  it('limits inline actions to expanded sidebar and expanded non-compact rail', () => {
    expect(app).toMatch(/isSessionSidebarActive\(\)[\s\S]{0,100}!this\.isSessionSidebarCollapsed\(\)/);
    expect(app).toMatch(/_tabOrientation\(\) === 'vertical'[\s\S]{0,120}tab-rail-compact/);
    expect(styles).toContain("html[data-session-list='sidebar'][data-sidebar='expanded']");
    expect(styles).toContain("html[data-tab-orientation='vertical']:not(.tab-rail-compact)");
  });

  it('opens only the existing session actions from the overflow trigger', () => {
    expect(railController).toContain('openTabRailActionMenu(event, sessionId)');
    expect(railController).toContain("label: 'Session options'");
    expect(railController).toContain("label: 'Open in a new window'");
    expect(railController).toContain("label: 'Close session'");
    expect(railController).not.toContain('Move to group');
  });

  it('wires the name-only size through first paint, settings, defaults, and both vertical surfaces', () => {
    expect(html).toMatch(/id="appSettingsSessionSidebarFontSize"[^>]*min="11"[^>]*max="18"[^>]*step="1"/);
    expect(html).toContain('aria-labelledby="appSettingsSessionSidebarFontSizeLabel"');
    expect(html).toContain('--session-sidebar-name-font-size');
    expect(settingsUi).toContain('sessionSidebarFontSize: this.resolveSessionSidebarFontSize(');
    // 12 = the sidebar's historical 0.75rem name size: the default must
    // never restyle an install whose user never touched the slider.
    expect(settingsUi).toContain('sessionSidebarFontSize: 12,');
    expect(settingsUi).toContain("'sessionSidebarFontSize'");
    expect(app).toContain('resolveSessionSidebarFontSize(value)');
    expect(app).toContain('applySessionSidebarFontSize(settings = null)');
    expect(styles).toMatch(
      /\.session-sidebar \.tab-name[^}]*font-size: var\(--session-sidebar-name-font-size, 12px\)/s
    );
    expect(styles).toMatch(
      /\.tab-rail \.session-tab \.tab-name[^}]*font-size: var\(--session-sidebar-name-font-size, 12px\)/s
    );
  });

  it('labels and translates the name-only scope', () => {
    expect(html).toContain('Session Name Font Size');
    expect(html).toContain('Adjust only session names in the vertical sidebar.');
    expect(i18n).toContain("'Session Name Font Size':");
    expect(i18n).toContain("'Adjust only session names in the vertical sidebar.':");
  });
});

describe('watching badge on a rich session row', () => {
  it('reads the label off the session payload', () => {
    expect(app).toContain("watching: typeof session.watching === 'string' ? session.watching : ''");
  });

  it('renders it beside the state pill rather than in place of it', () => {
    // A session can be watching a monitor AND holding a question for the user, so the
    // pill that says which one still decides the row; this badge only adds a fact.
    const meta = app.slice(app.indexOf('_sidebarRichMetaHTML(row) {'));
    const body = meta.slice(0, meta.indexOf('_sidebarRichStampText(timestamp, format) {'));
    expect(body).toContain('tab-pill tab-pill--${escapeHtml(pillMod)}');
    expect(body).toContain('tab-pill tab-pill--watching');
    expect(body).toContain('Still running in the background:');
  });

  it('re-renders the row when the background work changes', () => {
    // The meta line is rebuilt only when this signature moves, so a badge left out of
    // it would appear and disappear a render late, or not at all.
    expect(app).toContain(
      "const sig = `${row.state}${row.exited ? '+exited' : ''}:${row.since ? row.since.at : 0}:${row.createdAt}:${row.watching}`"
    );
  });

  it('escapes the label everywhere it reaches markup', () => {
    // `watching` is pane-derived and a config-supplied pattern decides what its capture
    // group holds, so every interpolation of it into HTML has to go through escapeHtml().
    // The row is installed with innerHTML, which makes an unescaped quote in that
    // attribute an injection rather than a cosmetic bug.
    expect(app).toContain('${richRow.createdAt}:${escapeHtml(richRow.watching)}"');
    expect(app).not.toContain('${richRow.createdAt}:${richRow.watching}"');
  });

  it('words the tooltip exactly as the phone overview does', () => {
    // Both files build this sentence themselves, deliberately, so that a stale cached
    // module still renders a complete row. Substring-matching the prefix would let the
    // two drift; the whole sentence is what has to agree.
    const overview = readFileSync(resolve(publicDir, 'mobile-overview.js'), 'utf8');
    expect(overview).toContain("'Still running in the background: ' + label");
    expect(app).toContain('`Still running in the background: ${row.watching}`');
  });

  it('colours it with the accent, never with the two colours that mean a human is needed', () => {
    const rule = styles.slice(styles.indexOf('.tab-pill--watching'));
    const block = rule.slice(0, rule.indexOf('}'));
    expect(block).toContain('var(--accent)');
    expect(block).not.toContain('var(--red)');
    expect(block).not.toContain('var(--yellow)');
  });
});
