/**
 * E2E smoke tests for the Madar web UI — runs against the live container.
 *
 * Auth: We forge a JWT locally (same secret as the server) and inject it into
 * localStorage via addInitScript, so the app treats the browser as logged in.
 * The server's /api/auth/status endpoint will call getUser() which returns
 * the real user — we don't care about the username, only that the session is
 * accepted.
 */
import { test, expect, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const BASE = 'http://localhost:3000';

/** Minimal .env parser (no dotenv dependency). */
function parseDotEnv(filePath: string): Record<string, string> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const env = parseDotEnv(path.join(repoRoot, '.env'));
const JWT_SECRET = env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET not found in .env — cannot forge auth token');
}

/** Forge a session token that the server will accept. */
function forgeToken(): string {
  return jwt.sign(
    { id: 'e2e-user', username: 'e2e', tv: 0 },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/** Inject auth token into localStorage before any page script runs. */
async function injectAuth(page: Page): Promise<void> {
  const token = forgeToken();
  await page.addInitScript(({ t }) => {
    localStorage.setItem('wsd.token', t);
  }, { t: token });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

test.describe('Madar UI — recent changes verification', () => {

  /* -- a. /#/ide page ------------------------------------------------ */
  test('a) /#/ide — no "Open in new tab", has <select> picker, iframe visible', async ({ page }) => {
    await injectAuth(page);
    // Navigate to root first to load the SPA and set the hash
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/ide'; });

    // Wait for the iframe to appear (means the page loaded and IDE is up)
    const iframe = page.locator('iframe.opencode-frame');
    await expect(iframe).toBeVisible({ timeout: 20_000 });

    // The toolbar contains a <select> project picker
    const select = page.locator('.opencode-toolbar select');
    await expect(select).toBeVisible();

    // "Open in new tab" must NOT appear anywhere
    await expect(page.getByText('Open in new tab')).toHaveCount(0);
  });

  /* -- b. /#/opencode page ------------------------------------------- */
  test('b) /#/opencode — no select, status line, iframe visible', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/opencode'; });

    const iframe = page.locator('iframe.opencode-frame');
    await expect(iframe).toBeVisible({ timeout: 20_000 });

    // Zero <select> elements in the toolbar
    const selects = page.locator('.opencode-toolbar select');
    await expect(selects).toHaveCount(0);

    // Status line is present (contains "opencode:" text)
    const statusLine = page.locator('.opencode-toolbar .term-title');
    await expect(statusLine).toBeVisible();
    const statusText = await statusLine.textContent();
    expect(statusText).toMatch(/opencode:\s*(running|offline|…)/);

    // "Open in new tab" must NOT appear
    await expect(page.getByText('Open in new tab')).toHaveCount(0);
  });

  /* -- c. Dashboard quick-action navigation -------------------------- */
  test('c) Dashboard quick-actions navigate in-tab (no popups)', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);

    // Wait for the dashboard to finish loading (quick-action cards appear)
    await expect(page.locator('.dash-action-card').first()).toBeVisible({ timeout: 20_000 });

    // -- Track popup events (none should fire) --
    const popups: Page[] = [];
    page.on('popup', (p) => popups.push(p));

    // Click "OpenCode" card
    await page.locator('.dash-action-card', { hasText: 'OpenCode' }).click();
    await expect(page.locator('iframe.opencode-frame')).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain('/opencode');

    // Go back to dashboard via hash
    await page.evaluate(() => { window.location.hash = '/'; });
    await expect(page.locator('.dash-action-card').first()).toBeVisible({ timeout: 15_000 });

    // Click "VS Code" card
    await page.locator('.dash-action-card', { hasText: 'VS Code' }).click();
    await expect(page.locator('iframe.opencode-frame')).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain('/ide');

    // No popups opened during the entire flow
    expect(popups).toHaveLength(0);
  });

  /* -- d. Global: "Open in new tab" gone from all three pages -------- */
  test('d) "Open in new tab" text is absent on Dashboard, /opencode, and /ide', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);

    // Dashboard
    await expect(page.locator('.dash-action-card').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Open in new tab')).toHaveCount(0);

    // Navigate to /opencode
    await page.evaluate(() => { window.location.hash = '/opencode'; });
    await page.locator('.opencode-toolbar').waitFor({ timeout: 10_000 });
    await expect(page.getByText('Open in new tab')).toHaveCount(0);

    // Navigate to /ide
    await page.evaluate(() => { window.location.hash = '/ide'; });
    await page.locator('.opencode-toolbar').waitFor({ timeout: 10_000 });
    await expect(page.getByText('Open in new tab')).toHaveCount(0);
  });
});
