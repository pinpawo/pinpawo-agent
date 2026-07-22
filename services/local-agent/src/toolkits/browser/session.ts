import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { getConfig } from '../../config';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLocalToolsWorkdir } from '../local/pathUtils';
import {
  buildBrowserExtractPayload,
  buildBrowserSnapshotPayload,
  MAX_BROWSER_INTERACTIVE_ELEMENTS,
  type BrowserExtractOptions,
  type BrowserInteractiveElement,
  type BrowserRawSnapshot,
} from './snapshotPayload';
import { ChromeExtensionBrowserSession } from './drivers/chromeExtension/session';
import { browserRuntime } from './runtime';
import { persistBrowserScreenshot } from './screenshot';
import { BrowserOperationError } from './errors';

export {
  buildBrowserExtractPayload,
  buildBrowserSnapshotPayload,
  buildBrowserTextChunk,
} from './snapshotPayload';
export type { BrowserExtractOptions } from './snapshotPayload';
const execFileAsync = promisify(execFile);

const nodeRequire = createRequire(import.meta.url);

async function execLoginShellLine(command: string, timeoutMs = 3_000): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/bin/zsh', ['-lc', command], {
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// ── Playwright types ───────────────────────────────────────────────────────────
type PlaywrightCore = typeof import('playwright-core');
type BrowserContext = import('playwright-core').BrowserContext;
type Page = import('playwright-core').Page;
type PageElementHandle = import('playwright-core').ElementHandle<HTMLElement | SVGElement>;

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CHROME_EXECUTABLE_PATH =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSIONS_DIR = resolve(homedir(), '.pinpawo', 'sessions');
const DEFAULT_SESSION = 'default';
const SAFE_SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function sessionDir(name: string): string {
  const trimmed = name.trim();
  if (
    !SAFE_SESSION_NAME_PATTERN.test(trimmed)
    || trimmed === '.'
    || trimmed === '..'
  ) {
    throw new Error('browser session name must use 1-64 chars: letters, numbers, ".", "_" or "-", and must not contain path separators');
  }
  return resolve(SESSIONS_DIR, trimmed);
}

function listSessionNames(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  try {
    return readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// ── Backend detection ─────────────────────────────────────────────────────────

export type BrowserBackend = 'extension' | 'playwright';
export type BrowserStatus = {
  mode: BrowserBackend | 'none';
  detail: string;
  configured: string;
};

export function selectAutoBrowserBackend(input: {
  extensionConnected: boolean;
  extensionListening?: boolean;
  playwrightAvailable: boolean;
  requiresPlaywright?: boolean;
}): BrowserBackend | null {
  if (!input.requiresPlaywright && input.extensionConnected) return 'extension';
  if (input.playwrightAvailable) return 'playwright';
  if (!input.requiresPlaywright && input.extensionListening) return 'extension';
  return null;
}

async function detectBackend(requiresPlaywright = false): Promise<BrowserBackend> {
  // Env var takes precedence; falls back to stored config (written by Settings UI)
  const fromEnv = process.env.PINPAWO_BROWSER_BACKEND?.trim();
  const fromConfig = getConfig().browserBackend;
  const forced = fromEnv || fromConfig || 'auto';

  console.log(`[browser] detectBackend: env=${fromEnv ?? '(unset)'} config=${fromConfig} → forced=${forced}`);

  if (forced === 'agent-browser') {
    throw new Error(
      'Browser backend "agent-browser" is no longer supported.\n' +
        '  Set PINPAWO_BROWSER_BACKEND=auto, "playwright", or the explicitly installed "extension" backend.',
    );
  }

  if (forced === 'extension') {
    console.log('[browser] using Chrome extension (forced)');
    return 'extension';
  }

  if (forced === 'playwright') {
    if (!(await canUsePlaywright())) {
      throw new Error(
        'Browser backend forced to "playwright" but it is not available.\n' +
          '  Install external playwright-core (for example: npm install -g playwright-core)\n' +
          '  Also ensure Google Chrome is installed.',
      );
    }
    console.log('[browser] using playwright (forced)');
    return 'playwright';
  }

  if (forced !== 'auto') {
    throw new Error(
      `Unknown browser backend "${forced}". Use auto, playwright, or extension.`,
    );
  }

  // auto-detect
  const extensionStatus = browserRuntime.getExtensionStatus();
  const playwrightAvailable = await canUsePlaywright();
  const autoBackend = selectAutoBrowserBackend({
    extensionConnected: extensionStatus.extensionConnected,
    extensionListening: extensionStatus.listening,
    playwrightAvailable,
    requiresPlaywright,
  });
  if (autoBackend) {
    console.log(`[browser] using ${autoBackend === 'extension' ? 'Chrome extension' : 'playwright'} (auto)`);
    return autoBackend;
  }
  throw new Error(
      'No browser backend available.\n' +
      '  Install external playwright-core (for example: npm install -g playwright-core)\n' +
      '  Also ensure Google Chrome is installed.',
  );
}

async function resolvePlaywrightSearchRoots(): Promise<string[]> {
  const home = homedir();
  const roots = [
    process.env.PINPAWO_PLAYWRIGHT_CORE_PATH?.trim() || '',
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    `${home}/.npm-global/lib/node_modules`,
    `${home}/.local/lib/node_modules`,
  ].filter(Boolean);

  // npm root -g via login shell
  const npmRoot = await execLoginShellLine('npm root -g');
  if (npmRoot) {
    roots.push(npmRoot);
  }

  // nvm: scan all installed node versions for global node_modules
  const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
  const nvmVersionsDir = resolve(nvmDir, 'versions', 'node');
  try {
    const versions = readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => resolve(nvmVersionsDir, d.name, 'lib', 'node_modules'));
    roots.push(...versions);
  } catch {
    // nvm not installed or no versions — skip
  }

  // Also check the running node's own prefix (covers nvm's active version)
  const runningPrefix = resolve(process.execPath, '..', '..', 'lib', 'node_modules');
  roots.push(runningPrefix);

  return [...new Set(roots)];
}

async function resolvePlaywrightCorePath(): Promise<string | null> {
  const override = process.env.PINPAWO_PLAYWRIGHT_CORE_PATH?.trim();
  if (override && existsSync(override)) {
    return override;
  }

  try {
    return nodeRequire.resolve('playwright-core');
  } catch {
    // Optional package dependency not installed; fall back to global search roots.
  }

  for (const root of await resolvePlaywrightSearchRoots()) {
    try {
      const resolved = nodeRequire.resolve('playwright-core', { paths: [root] });
      if (resolved) {
        return resolved;
      }
    } catch {
      // try next root
    }
  }

  return null;
}

async function loadPlaywrightCore(): Promise<PlaywrightCore | null> {
  const resolved = await resolvePlaywrightCorePath();
  if (!resolved) {
    return null;
  }
  try {
    return nodeRequire(resolved) as PlaywrightCore;
  } catch {
    return null;
  }
}

async function canUsePlaywright(): Promise<boolean> {
  const execPath =
    process.env.PINPAWO_BROWSER_EXECUTABLE_PATH?.trim() || DEFAULT_CHROME_EXECUTABLE_PATH;
  return await loadPlaywrightCore() !== null && existsSync(execPath);
}

// ── Open options ──────────────────────────────────────────────────────────────

export interface BrowserOpenOptions {
  /** Run without a visible browser window. Keep false when login or captcha handling is needed. */
  headless?: boolean;
  /** Named browser session. Login state is persisted per session in ~/.pinpawo/sessions/<name>/ */
  session?: string;
  /** Explicit Chrome-style user-data-dir. Use only when the caller provides a local browser profile path. */
  userDataDir?: string;
}

export type BrowserElementTarget = {
  selector?: string;
  ref?: string;
};

export type BrowserScrollOptions = {
  deltaX?: number;
  deltaY?: number;
  target?: BrowserElementTarget;
};

function normalizeBrowserElementTarget(target: string | BrowserElementTarget): BrowserElementTarget {
  const normalized = typeof target === 'string' ? { selector: target.trim() } : {
    selector: target.selector?.trim(),
    ref: target.ref?.trim(),
  };
  if ((normalized.selector ? 1 : 0) + (normalized.ref ? 1 : 0) !== 1) {
    throw new Error('browser element target requires exactly one of selector or ref');
  }
  return normalized;
}

function resolveUserDataDir(userDataDir: string): string {
  const trimmed = userDataDir.trim();
  if (!trimmed) {
    throw new Error('userDataDir must not be empty');
  }
  if (trimmed === '~') {
    return homedir();
  }
  if (trimmed.startsWith('~/')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(getLocalToolsWorkdir(), trimmed);
}

function openSessionPath(opts: BrowserOpenOptions): string {
  return opts.userDataDir
    ? resolveUserDataDir(opts.userDataDir)
    : sessionDir(opts.session ?? DEFAULT_SESSION);
}

// ── Playwright implementation ─────────────────────────────────────────────────

class PlaywrightBrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly trackedPages = new WeakSet<Page>();
  private activeHeadless = false;
  private activeSessionDir = sessionDir(DEFAULT_SESSION);
  private readonly refAttribute = `data-pinpawo-ref-${randomUUID()}`;
  private readonly refElements = new Map<string, PageElementHandle>();

  private readExecutablePath() {
    return process.env.PINPAWO_BROWSER_EXECUTABLE_PATH?.trim() || DEFAULT_CHROME_EXECUTABLE_PATH;
  }

  private activatePage(page: Page): Page {
    if (page.isClosed()) return page;
    if (!this.trackedPages.has(page)) {
      this.trackedPages.add(page);
      page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
      page.on('close', () => {
        if (this.page !== page) return;
        const fallback = this.context?.pages()
          .filter((candidate) => !candidate.isClosed())
          .at(-1) ?? null;
        this.page = fallback;
        if (fallback) {
          this.activatePage(fallback);
          void fallback.bringToFront().catch(() => {});
        }
      });
    }
    this.page = page;
    return page;
  }

  private async settleActivePage(previousPage: Page, followWindowMs = 300): Promise<Page> {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, followWindowMs));
    const activePage = this.page && !this.page.isClosed()
      ? this.page
      : this.context?.pages().filter((candidate) => !candidate.isClosed()).at(-1);
    if (!activePage) {
      throw new BrowserOperationError(
        'target_closed',
        'Browser target closed before the operation completed.',
        true,
      );
    }
    this.activatePage(activePage);
    await activePage.waitForLoadState('domcontentloaded', {
      timeout: DEFAULT_TIMEOUT_MS,
    }).catch(() => {});
    if (activePage !== previousPage && !this.activeHeadless) {
      await activePage.bringToFront().catch(() => {});
    }
    return activePage;
  }

  private async ensurePage(headless: boolean, sessionPath: string): Promise<Page> {
    // Restart context if headless or browser session changed.
    if (this.context && (headless !== this.activeHeadless || sessionPath !== this.activeSessionDir)) {
      await this.close();
    }

    if (this.page) return this.page;

    const playwrightCore = await loadPlaywrightCore();
    if (!playwrightCore) {
      throw new Error(
        'playwright-core not found. Install external playwright-core or set PINPAWO_PLAYWRIGHT_CORE_PATH.',
      );
    }
    const { chromium } = playwrightCore;
    const executablePath = this.readExecutablePath();
    if (!existsSync(executablePath)) {
      throw new Error(
        `Chrome not found at "${executablePath}". Set PINPAWO_BROWSER_EXECUTABLE_PATH if installed elsewhere.`,
      );
    }
    mkdirSync(sessionPath, { recursive: true });

    this.activeHeadless = headless;
    this.activeSessionDir = sessionPath;

    this.context = await chromium.launchPersistentContext(sessionPath, {
      headless,
      executablePath,
    });
    const existing = this.context.pages();
    const initialPage = existing[0] ?? (await this.context.newPage());
    const activePage = this.activatePage(initialPage);
    this.context.on('page', (page) => {
      this.activatePage(page);
      if (!this.activeHeadless) void page.bringToFront().catch(() => {});
    });

    // When running inside the app bundle the parent process has no foreground
    // privileges, so Chrome won't come to front automatically. Bring it forward.
    if (!headless) {
      await activePage.bringToFront().catch(() => {});
    }

    return activePage;
  }

  private async requirePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    const fallback = this.context?.pages()
      .filter((candidate) => !candidate.isClosed())
      .at(-1);
    if (fallback) return this.activatePage(fallback);
    throw new BrowserOperationError(
      'browser_not_open',
      'No active browser page. Use browser_open first.',
      true,
    );
  }

  private async clearRefElements(): Promise<void> {
    const handles = [...this.refElements.values()];
    this.refElements.clear();
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));
  }

  private async buildSnapshot(page: Page): Promise<string> {
    await this.clearRefElements();
    const snapshot = await page.evaluate<BrowserRawSnapshot>(`
      (() => {
        const refAttribute = ${JSON.stringify(this.refAttribute)};
        document.querySelectorAll('[' + refAttribute + ']').forEach((element) => {
          element.removeAttribute(refAttribute);
        });
        const snapshotId = globalThis.crypto?.randomUUID?.()
          || Date.now().toString(36) + Math.random().toString(36).slice(2);
        const trim = (v, n) => v.length <= n ? v : v.slice(0, n) + '...';
        const hintFor = (el) => {
          const id = el.getAttribute('id'); if (id) return '#' + id;
          const aria = el.getAttribute('aria-label');
          if (aria) return '[aria-label="' + aria + '"]';
          const name = el.getAttribute('name');
          if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
          const text = (el.textContent || '').trim();
          if (text) return 'text=' + trim(text, 48);
          return el.tagName.toLowerCase();
        };
        const interactiveElements = Array.from(
          document.querySelectorAll('a,button,input,textarea,select,[role="button"]')
        )
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const interactive = interactiveElements
          .slice(0, ${MAX_BROWSER_INTERACTIVE_ELEMENTS})
          .map((el, i) => {
            const ref = snapshotId + ':' + (i + 1);
            el.setAttribute(refAttribute, ref);
            return {
              index: i + 1, ref, tag: el.tagName.toLowerCase(),
              text: trim((el.textContent || '').trim(), 80),
              type: el.getAttribute('type'), placeholder: el.getAttribute('placeholder'),
              hint: hintFor(el),
            };
          });
        return {
          title: document.title,
          url: window.location.href,
          text: (document.body?.innerText || '').trim(),
          interactiveCount: interactiveElements.length,
          interactive,
        };
      })()
    `);
    try {
      for (const element of snapshot.interactive) {
        if (!element.ref) continue;
        const locator = page.locator(`[${this.refAttribute}="${element.ref}"]`);
        if (await locator.count() !== 1) continue;
        const handle = await locator.elementHandle();
        if (handle) this.refElements.set(element.ref, handle);
      }
    } finally {
      await page.evaluate((refAttribute) => {
        document.querySelectorAll(`[${refAttribute}]`).forEach((element) => {
          element.removeAttribute(refAttribute);
        });
      }, this.refAttribute).catch(() => {});
    }
    return JSON.stringify(buildBrowserSnapshotPayload({
      title: snapshot.title,
      url: snapshot.url,
      text: snapshot.text,
      textSource: 'document.body.innerText',
      interactive: snapshot.interactive,
      interactiveCount: snapshot.interactiveCount,
    }), null, 2);
  }

  async open(url: string, opts: BrowserOpenOptions = {}): Promise<string> {
    const headless = opts.headless ?? this.activeHeadless;
    const sessionPath = openSessionPath(opts);
    const page = await this.ensurePage(headless, sessionPath);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return await this.buildSnapshot(page);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async snapshot(): Promise<string> { return this.buildSnapshot(await this.requirePage()); }

  private resolveTarget(target: string | BrowserElementTarget):
    | { selector: string }
    | { element: PageElementHandle } {
    const normalized = normalizeBrowserElementTarget(target);
    if (normalized.selector) return { selector: normalized.selector };
    const element = this.refElements.get(normalized.ref!);
    if (!element) {
      throw new BrowserOperationError(
        'stale_element_reference',
        'Stale browser element reference. Take a new browser_snapshot and retry.',
        true,
      );
    }
    return { element };
  }

  async click(target: string | BrowserElementTarget): Promise<string> {
    const page = await this.requirePage();
    const resolved = this.resolveTarget(target);
    if ('selector' in resolved) {
      await page.locator(resolved.selector).first().click({ timeout: DEFAULT_TIMEOUT_MS });
    } else {
      await resolved.element.click({ timeout: DEFAULT_TIMEOUT_MS });
    }
    const activePage = await this.settleActivePage(page);
    return this.buildSnapshot(activePage);
  }

  async type(target: string | BrowserElementTarget, text: string, submit = false): Promise<string> {
    const page = await this.requirePage();
    const resolved = this.resolveTarget(target);
    const loc = 'selector' in resolved ? page.locator(resolved.selector).first() : resolved.element;
    await loc.fill(text, { timeout: DEFAULT_TIMEOUT_MS });
    if (submit) {
      await loc.press('Enter', { timeout: DEFAULT_TIMEOUT_MS });
      const activePage = await this.settleActivePage(page);
      return this.buildSnapshot(activePage);
    }
    return this.buildSnapshot(page);
  }

  async scroll(options: BrowserScrollOptions = {}): Promise<string> {
    const page = await this.requirePage();
    if (options.target) {
      const resolved = this.resolveTarget(options.target);
      if ('selector' in resolved) {
        await page.locator(resolved.selector).first().hover({ timeout: DEFAULT_TIMEOUT_MS });
      } else {
        await resolved.element.hover({ timeout: DEFAULT_TIMEOUT_MS });
      }
    }
    await page.mouse.wheel(options.deltaX ?? 0, options.deltaY ?? 600);
    await page.waitForTimeout(150);
    return this.buildSnapshot(page);
  }

  async wait(target?: string | BrowserElementTarget, timeoutMs = 3_000): Promise<string> {
    const page = await this.requirePage();
    if (target) {
      const resolved = this.resolveTarget(target);
      if ('selector' in resolved) {
        await page.locator(resolved.selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
      } else {
        await resolved.element.waitForElementState('visible', { timeout: timeoutMs });
      }
    } else {
      await page.waitForTimeout(timeoutMs);
    }
    return this.buildSnapshot(page);
  }

  async extract(options: BrowserExtractOptions = {}): Promise<string> {
    const page = await this.requirePage();
    const text = options.selector
      ? await page.locator(options.selector).first().innerText({ timeout: DEFAULT_TIMEOUT_MS })
      : await page.evaluate<string>(`(document.body?.innerText || '').trim()`);
    return JSON.stringify(buildBrowserExtractPayload({
      title: await page.title(),
      url: page.url(),
      selector: options.selector,
      text: text.trim(),
      offset: options.offset,
      limit: options.limit,
      textSource: options.selector ? 'locator.innerText' : 'document.body.innerText',
    }), null, 2);
  }

  async screenshot(): Promise<string> {
    const page = await this.requirePage();
    const bytes = await page.screenshot({
      type: 'jpeg',
      quality: 75,
      fullPage: false,
    });
    return persistBrowserScreenshot({ mimeType: 'image/jpeg', data: bytes.toString('base64') });
  }

  async close(): Promise<string> {
    await this.clearRefElements();
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    this.page = null;
    this.context = null;
    return 'browser session closed';
  }

  listSessions(): string[] { return listSessionNames(); }
}

// ── Facade ────────────────────────────────────────────────────────────────────

type BrowserImpl = PlaywrightBrowserSession | ChromeExtensionBrowserSession;

export class BrowserSession {
  private impl: BrowserImpl | null = null;
  private initPromise: Promise<BrowserImpl> | null = null;

  private ensureImpl(requiresPlaywright = false): Promise<BrowserImpl> {
    if (this.impl) return Promise.resolve(this.impl);
    if (!this.initPromise) {
      this.initPromise = detectBackend(requiresPlaywright).then((backend) => {
        this.impl = backend === 'extension'
          ? new ChromeExtensionBrowserSession()
          : new PlaywrightBrowserSession();
        return this.impl;
      }).catch((error) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  async open(url: string, opts?: BrowserOpenOptions) {
    const requiresPlaywright = Boolean(
      opts?.headless
      || opts?.userDataDir
      || (opts?.session && opts.session !== DEFAULT_SESSION),
    );
    return (await this.ensureImpl(requiresPlaywright)).open(url, opts);
  }
  async openWithProfile(url: string, userDataDir: string, opts?: Omit<BrowserOpenOptions, 'session' | 'userDataDir'>) {
    return (await this.ensureImpl(true)).open(url, { ...opts, userDataDir });
  }
  async snapshot() { return (await this.ensureImpl()).snapshot(); }
  async click(target: string | BrowserElementTarget) { return (await this.ensureImpl()).click(target); }
  async type(target: string | BrowserElementTarget, text: string, submit?: boolean) {
    return (await this.ensureImpl()).type(target, text, submit);
  }
  async scroll(options?: BrowserScrollOptions) { return (await this.ensureImpl()).scroll(options); }
  async wait(target?: string | BrowserElementTarget, timeoutMs?: number) {
    return (await this.ensureImpl()).wait(target, timeoutMs);
  }
  async extract(options?: BrowserExtractOptions) { return (await this.ensureImpl()).extract(options); }
  async screenshot() { return (await this.ensureImpl()).screenshot(); }
  async close() {
    const impl = this.impl ?? (this.initPromise ? await this.initPromise : null);
    if (!impl) return 'browser session closed';
    try {
      return await impl.close();
    } finally {
      this.impl = null;
      this.initPromise = null;
    }
  }
  async listSessions() { return (await this.ensureImpl()).listSessions(); }
}

export const browserSession = new BrowserSession();

// ── Lightweight detection (no browser launch) ─────────────────────────────────
export async function detectBrowserStatus(): Promise<BrowserStatus> {
  const fromEnv = process.env.PINPAWO_BROWSER_BACKEND?.trim();
  const fromConfig = getConfig().browserBackend;
  const configured = fromEnv || fromConfig || 'auto';
  const chromeExecPath =
    process.env.PINPAWO_BROWSER_EXECUTABLE_PATH?.trim() || DEFAULT_CHROME_EXECUTABLE_PATH;

  // Respect the configured backend — same priority as detectBackend()
  if (configured === 'playwright') {
    if (await canUsePlaywright()) {
      return { mode: 'playwright', detail: chromeExecPath, configured };
    }
    return {
      mode: 'none',
      detail: `configured playwright but unavailable: missing playwright-core or Chrome at ${chromeExecPath}`,
      configured,
    };
  }
  if (configured === 'extension') {
    const status = browserRuntime.getExtensionStatus();
    return {
      mode: 'extension',
      detail: status.extensionConnected
        ? `connected extension ${status.extensionId ?? '(unknown)'}`
        : `configured; waiting for extension via ${status.socketPath}`,
      configured,
    };
  }
  if (configured === 'agent-browser') {
    return {
      mode: 'none',
      detail: 'configured agent-browser but that backend is no longer supported',
      configured,
    };
  }
  if (configured !== 'auto') {
    return {
      mode: 'none',
      detail: `unknown browser backend "${configured}"; use auto, playwright, or extension`,
      configured,
    };
  }

  // auto-detect
  const extension = browserRuntime.getExtensionStatus();
  if (extension.extensionConnected) {
    return {
      mode: 'extension',
      detail: `connected extension ${extension.extensionId ?? '(unknown)'}`,
      configured,
    };
  }
  if (await canUsePlaywright()) {
    return { mode: 'playwright', detail: chromeExecPath, configured };
  }
  if (extension.listening) {
    return {
      mode: 'extension',
      detail: `waiting for extension via ${extension.socketPath}`,
      configured,
    };
  }
  return { mode: 'none', detail: `missing playwright-core or Chrome at ${chromeExecPath}`, configured };
}

// ── Full environment detection (for CLI `detect` command / Settings UI) ──────
export type BrowserEnvironment = {
  configured: string;
  chromePath: string;
  chromeAvailable: boolean;
  playwrightCorePath: string | null;
};

export async function detectBrowserEnvironment(): Promise<BrowserEnvironment> {
  const chromePath =
    process.env.PINPAWO_BROWSER_EXECUTABLE_PATH?.trim() || DEFAULT_CHROME_EXECUTABLE_PATH;
  const fromEnv = process.env.PINPAWO_BROWSER_BACKEND?.trim();
  const fromConfig = getConfig().browserBackend;

  return {
    configured: fromEnv || fromConfig || 'auto',
    chromePath,
    chromeAvailable: existsSync(chromePath),
    playwrightCorePath: await resolvePlaywrightCorePath(),
  };
}
