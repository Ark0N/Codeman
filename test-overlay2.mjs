import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

page.on('console', msg => console.log('CONSOLE:', msg.type(), msg.text()));
page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

await page.goto('http://localhost:3099', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

// Create a fresh session
const resp = await page.evaluate(async () => {
  const r = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ov-test', mode: 'claude' })
  });
  return r.json();
});
const sid = resp.session?.id;
console.log('Session:', sid?.slice(0, 8));
await page.waitForTimeout(3000);

// Click on it
await page.locator(`.session-tab[data-id="${sid}"]`).click();
await page.waitForTimeout(3000);

// Check for the local echo toggle
const toggle = page.locator('#localEchoToggle');
const toggleVisible = await toggle.isVisible().catch(() => false);
console.log('Toggle visible:', toggleVisible);

if (!toggleVisible) {
  // Maybe need to open settings or it's somewhere else
  console.log('Looking for local echo toggle...');
  const all = await page.locator('input[type="checkbox"]').all();
  for (const cb of all) {
    const id = await cb.getAttribute('id');
    const label = await cb.evaluate(el => el.parentElement?.textContent?.trim().slice(0, 30));
    console.log('  checkbox:', id, label);
  }
}

// Get cell dimensions first
const cellInfo = await page.evaluate(() => {
  if (window.app?.sessions) {
    for (const [id, s] of Object.entries(window.app.sessions)) {
      const dims = s.terminal?._core?._renderService?.dimensions;
      if (dims) return {
        id: id.slice(0, 8),
        cssCell: dims.css?.cell,
        deviceChar: dims.device?.char,
        actualFull: dims,
      };
    }
  }
  return { error: 'no terminal' };
});
console.log('Cell info:', JSON.stringify(cellInfo, null, 2));

// Focus terminal and type with echo OFF
const textarea = page.locator('.xterm-helper-textarea').first();
await textarea.focus();
await page.waitForTimeout(500);
await page.keyboard.type('hello test', { delay: 80 });
await page.waitForTimeout(1500);

await page.screenshot({ path: '/tmp/echo-off-full.png' });
console.log('Saved echo-off-full.png');

// Clear
for (let i = 0; i < 10; i++) await page.keyboard.press('Backspace');
await page.waitForTimeout(500);

// Enable local echo
if (toggleVisible) {
  await toggle.click();
  await page.waitForTimeout(500);
  console.log('Toggled local echo ON');
}

// Type again
await textarea.focus();
await page.waitForTimeout(300);
await page.keyboard.type('hello test', { delay: 80 });
await page.waitForTimeout(1500);

await page.screenshot({ path: '/tmp/echo-on-full.png' });
console.log('Saved echo-on-full.png');

// Get overlay info
const oi = await page.evaluate(() => {
  const o = document.querySelector('.zl-overlay');
  if (!o) return { found: false, html: 'none' };
  return {
    found: true,
    display: o.style.display,
    top: o.style.top,
    childCount: o.children.length,
    innerHTML: o.innerHTML.slice(0, 500),
  };
});
console.log('Overlay:', JSON.stringify(oi, null, 2));

// Cleanup
if (sid) {
  await page.evaluate(async (id) => {
    await fetch('/api/sessions/' + id, { method: 'DELETE' });
  }, sid);
}

await browser.close();
console.log('Done');
