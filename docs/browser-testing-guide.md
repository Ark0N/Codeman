# Browser Testing Guide for Codeman

This guide documents the browser testing infrastructure, framework comparison results, and best practices for testing the Codeman web UI.

## Quick Start

```bash
# Run standalone benchmark (recommended - avoids vitest hook issues)
npx tsx scripts/browser-comparison.mjs

# Run existing browser E2E tests
npm test -- test/browser-e2e.test.ts
```

## Framework Comparison Results

We tested three browser automation frameworks against the Codeman web UI:

| Framework | Avg Duration | Best For |
|-----------|--------------|----------|
| **Puppeteer** | 1223ms | Simple operations, Chrome-specific features |
| **Playwright** | 1373ms | Complex interactions, cross-browser, debugging |
| **Agent-Browser** | N/A (timeout) | AI agent navigation with semantic locators |

### Detailed Benchmarks

| Scenario | Playwright | Puppeteer |
|----------|------------|-----------|
| Page load | 1445ms | 433ms |
| Element selection | 442ms | 373ms |
| Modal interaction | 1487ms | 1605ms |
| Rapid operations (5 cycles) | 2119ms | 2482ms |

**Key findings:**
- Puppeteer is faster for simple page loads and element selection
- Playwright handles rapid/complex interactions better (auto-waiting)
- Agent-browser CLI has startup overhead issues in this environment

## Known Issues

### Vitest Hook Timeouts

**Problem:** Browser tests using vitest's `beforeAll`/`afterAll` hooks consistently timeout, even when the tests actually complete successfully.

**Symptoms:**
- Tests show as "skipped"
- Error: "Hook timed out in 60000ms"
- But cleanup messages appear (indicating tests ran)

**Root cause:** Unclear - possibly related to:
- vitest's module isolation with async browser launches
- Interaction between global setup.ts hooks and test-level hooks
- Multiple test file imports causing duplicate hook execution

**Workarounds:**
1. **Use standalone scripts** (recommended):
   ```bash
   npx tsx scripts/browser-comparison.mjs
   ```

2. **Run browser code directly in tests** (not in hooks):
   ```typescript
   it('should test something', async () => {
     const browser = await chromium.launch();
     // ... test code ...
     await browser.close();
   });
   ```

3. **Use the existing browser-e2e.test.ts pattern** which uses agent-browser CLI commands via `execSync` (avoids async hook issues)

## Test File Structure

### Port Allocation

| Port Range | Test File |
|------------|-----------|
| 3150-3153 | browser-e2e.test.ts (existing) |
| 3154 | file-link-click.test.ts |
| 3155 | browser-playwright.test.ts |
| 3156 | browser-puppeteer.test.ts |
| 3157 | browser-agent.test.ts |
| 3158-3160 | browser-comparison.test.ts |
| 3180-3182 | scripts/browser-comparison.mjs |

### File Purposes

| File | Framework | Status |
|------|-----------|--------|
| `test/browser-e2e.test.ts` | agent-browser | ✅ Working |
| `test/browser-playwright.test.ts` | Playwright | ⚠️ Vitest hook issues |
| `test/browser-puppeteer.test.ts` | Puppeteer | ⚠️ Vitest hook issues |
| `test/browser-agent.test.ts` | agent-browser | ⚠️ Vitest hook issues |
| `scripts/browser-comparison.mjs` | All three | ✅ Working (standalone) |

## Framework-Specific Patterns

### Playwright

```typescript
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.goto('http://localhost:3000');

// Auto-waiting selectors
await page.click('.btn-claude');
await page.waitForSelector('.session-tab', { state: 'visible' });

// Assertions with expect
await expect(page.locator('.header')).toBeVisible();
await expect(page).toHaveTitle('Codeman');

await browser.close();
```

**Pros:**
- Built-in auto-waiting
- Excellent trace viewer for debugging
- Cross-browser support (Chromium, Firefox, WebKit)
- Native `expect` assertions

**Cons:**
- Slightly slower page loads
- Larger dependency

### Puppeteer

```typescript
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage();
await page.goto('http://localhost:3000');

// Manual waiting often needed
await page.click('.btn-claude');
await page.waitForSelector('.session-tab', { visible: true });

// Element queries
const title = await page.title();
const text = await page.$eval('.logo', el => el.textContent);

// CDP access for advanced features
const client = await page.target().createCDPSession();
await client.send('Performance.enable');

await browser.close();
```

**Pros:**
- Faster for simple operations
- Direct Chrome DevTools Protocol access
- Smaller dependency
- Good for Chrome-specific testing

**Cons:**
- Chrome/Chromium only
- Manual waiting required
- Less robust for complex interactions

### Agent-Browser (CLI)

```typescript
import { execSync } from 'node:child_process';

function agentBrowser(cmd: string): string {
  return execSync(`npx agent-browser ${cmd}`, {
    timeout: 30000,
    encoding: 'utf-8',
  }).trim();
}

function agentBrowserJson<T>(cmd: string): T {
  const result = agentBrowser(`${cmd} --json`);
  return JSON.parse(result).data;
}

// Usage
agentBrowser('open http://localhost:3000');
agentBrowser('click ".btn-claude"');
const title = agentBrowserJson<{title: string}>('get title');

// Semantic locators (AI-friendly)
agentBrowser('find role button click --name "Submit"');
agentBrowser('find text "Settings" click');

// Accessibility snapshot
const snapshot = agentBrowser('snapshot');

agentBrowser('close');
```

**Pros:**
- AI-agent friendly (semantic locators)
- Accessibility tree snapshots
- Simple CLI interface
- Reference-based selection (@e1, @e2)

**Cons:**
- CLI overhead (spawn process per command)
- Slower for rapid operations
- Less programmatic control

## Best Practices

### 1. Use Standalone Scripts for Benchmarks

Vitest has issues with browser hooks. For reliable benchmarking:

```bash
# Create a standalone .mjs script
npx tsx scripts/browser-comparison.mjs
```

### 2. Browser Launch Arguments

Always include these args for headless environments:

```typescript
{
  headless: true,
  args: [
    '--no-sandbox',           // Required for Docker/CI
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Prevents /dev/shm issues
  ],
}
```

### 3. Install Playwright Browsers

```bash
npx playwright install chromium
```

### 4. Wait for Server Startup

```typescript
const server = new WebServer(PORT);
await server.start();
await new Promise(r => setTimeout(r, 1000)); // Allow server to stabilize
```

### 5. Clean Up Sessions

Track created sessions for cleanup:

```typescript
const createdSessions: string[] = [];

// In test
const response = await fetch(`${BASE_URL}/api/sessions`);
const data = await response.json();
createdSessions.push(data.sessions[0].id);

// In cleanup
for (const id of createdSessions) {
  await fetch(`${BASE_URL}/api/sessions/${id}`, { method: 'DELETE' });
}
```

### 6. Handle Modal Timing

Modals have animation delays:

```typescript
// Playwright (auto-waits)
await page.click('.help-btn');
await page.waitForSelector('#helpModal', { state: 'visible' });

// Puppeteer (manual wait)
await page.click('.help-btn');
await page.waitForSelector('#helpModal', { visible: true });

// Agent-browser (explicit delay)
agentBrowser('click ".help-btn"');
await new Promise(r => setTimeout(r, 500));
```

## Key DOM Selectors

For reference when writing browser tests:

```
.btn-claude              // Create Claude session button
.btn-settings            // Settings button
.help-btn                // Help button
.session-tab             // Session tabs
.session-tab.active      // Active session tab
.xterm                   // Terminal container
#helpModal               // Help modal
#appSettingsModal        // Settings modal
.modal-content           // Modal content
.modal-close             // Modal close button
.header-brand .logo      // Logo text
#versionDisplay          // Version display
#quickStartCase          // Quick start dropdown
```

## Recommendations by Use Case

| Use Case | Recommended Framework |
|----------|----------------------|
| CI/CD testing | Playwright |
| Chrome-specific features | Puppeteer |
| AI agent development | Agent-Browser |
| Visual regression | Playwright |
| Performance testing | Puppeteer |
| Accessibility testing | Agent-Browser |
| Cross-browser testing | Playwright |
| Quick prototyping | Agent-Browser CLI |

## Dependencies

```json
{
  "devDependencies": {
    "playwright": "^1.58.0",
    "puppeteer": "^24.36.0",
    "agent-browser": "^0.6.0"
  }
}
```

Install browsers after npm install:
```bash
npx playwright install chromium
```
