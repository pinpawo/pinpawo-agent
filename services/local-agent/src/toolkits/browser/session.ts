import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { getConfig } from '../../config';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLocalToolsWorkdir } from '../local/pathUtils';
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

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 50_000;
const MAX_INTERACTIVE_ELEMENTS = 20;
const DEFAULT_EXTRACT_TEXT_LIMIT = 50_000;
const MAX_EXTRACT_TEXT_LIMIT = 100_000;
const DEFAULT_CHROME_EXECUTABLE_PATH =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSIONS_DIR = resolve(homedir(), '.pinpawo', 'sessions');
const DEFAULT_SESSION = 'default';
const SAFE_SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

export interface BrowserExtractOptions {
  selector?: string;
  offset?: number;
  limit?: number;
}

type TextWindow = {
  offset: number;
  limit: number;
};

type TextChunk = TextWindow & {
  text: string;
  textLength: number;
  returnedTextLength: number;
  textEndOffset: number;
  truncated: boolean;
  hasMore: boolean;
  nextOffset: number | null;
};

function normalizeTextWindow(options: BrowserExtractOptions = {}): TextWindow {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_EXTRACT_TEXT_LIMIT;

  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('browser_extract offset must be a non-negative integer');
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_EXTRACT_TEXT_LIMIT) {
    throw new Error(`browser_extract limit must be an integer between 1 and ${MAX_EXTRACT_TEXT_LIMIT}`);
  }

  return { offset, limit };
}

export function buildBrowserTextChunk(
  text: string,
  options: BrowserExtractOptions = {},
): TextChunk {
  const { offset, limit } = normalizeTextWindow(options);
  const safeOffset = Math.min(offset, text.length);
  const textEndOffset = Math.min(safeOffset + limit, text.length);
  const chunk = text.slice(safeOffset, textEndOffset);
  const hasMore = textEndOffset < text.length;

  return {
    offset: safeOffset,
    limit,
    text: chunk,
    textLength: text.length,
    returnedTextLength: chunk.length,
    textEndOffset,
    truncated: safeOffset > 0 || hasMore,
    hasMore,
    nextOffset: hasMore ? textEndOffset : null,
  };
}

function buildSnapshotTextFields(text: string) {
  const chunk = buildBrowserTextChunk(text, { offset: 0, limit: MAX_TEXT_LENGTH });
  return {
    text: chunk.text,
    textLength: chunk.textLength,
    returnedTextLength: chunk.returnedTextLength,
    textOffset: chunk.offset,
    textEndOffset: chunk.textEndOffset,
    textLimit: MAX_TEXT_LENGTH,
    truncated: chunk.hasMore,
    hasMore: chunk.hasMore,
    nextTextOffset: chunk.nextOffset,
  };
}

export function buildBrowserSnapshotPayload<TInteractive>(
  input: {
    title: string;
    url: string;
    text: string;
    interactive: TInteractive[];
    interactiveCount?: number;
    textSource?: string;
    textUnavailableReason?: string;
  },
) {
  const interactiveCount = input.interactiveCount ?? input.interactive.length;
  return {
    title: input.title,
    url: input.url,
    interactive: input.interactive,
    interactiveCount,
    returnedInteractiveCount: input.interactive.length,
    interactiveTruncated: interactiveCount > input.interactive.length,
    ...buildSnapshotTextFields(input.text),
    textSource: input.textSource,
    textUnavailableReason: input.textUnavailableReason,
  };
}

export function buildBrowserExtractPayload(
  input: {
    title: string;
    url: string;
    text: string;
    selector?: string;
    offset?: number;
    limit?: number;
    textSource?: string;
  },
) {
  const chunk = buildBrowserTextChunk(input.text, input);
  return {
    title: input.title,
    url: input.url,
    selector: input.selector,
    textSource: input.textSource,
    ...chunk,
  };
}

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

type BrowserBackend = 'playwright';
export type BrowserStatus = {
  mode: 'playwright' | 'none';
  detail: string;
  configured: string;
};

async function detectBackend(): Promise<BrowserBackend> {
  // Env var takes precedence; falls back to stored config (written by Settings UI)
  const fromEnv = process.env.PINPAWO_BROWSER_BACKEND?.trim();
  const fromConfig = getConfig().browserBackend;
  const forced = fromEnv || fromConfig || 'auto';

  console.log(`[browser] detectBackend: env=${fromEnv ?? '(unset)'} config=${fromConfig} → forced=${forced}`);

  if (forced === 'agent-browser') {
    throw new Error(
      'Browser backend "agent-browser" is no longer supported.\n' +
        '  Set PINPAWO_BROWSER_BACKEND=auto or "playwright", and ensure playwright-core plus Google Chrome are installed.',
    );
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

  // auto-detect
  if (await canUsePlaywright()) { console.log('[browser] using playwright (auto)'); return 'playwright'; }
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

type PlaywrightInteractiveSnapshot = {
  index: number;
  tag: string;
  text: string;
  type: string | null;
  placeholder: string | null;
  hint: string;
};

type PlaywrightSnapshotSource = {
  title: string;
  url: string;
  text: string;
  interactiveCount: number;
  interactive: PlaywrightInteractiveSnapshot[];
};

class PlaywrightBrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private activeHeadless = false;
  private activeSessionDir = sessionDir(DEFAULT_SESSION);

  private readExecutablePath() {
    return process.env.PINPAWO_BROWSER_EXECUTABLE_PATH?.trim() || DEFAULT_CHROME_EXECUTABLE_PATH;
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
    this.page = existing[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);

    // When running inside the app bundle the parent process has no foreground
    // privileges, so Chrome won't come to front automatically. Bring it forward.
    if (!headless) {
      await this.page.bringToFront().catch(() => {});
    }

    return this.page;
  }

  private async requirePage(): Promise<Page> {
    if (!this.page) throw new Error('No active browser page. Use browser_open first.');
    return this.page;
  }

  private async buildSnapshot(page: Page): Promise<string> {
    const snapshot = await page.evaluate<PlaywrightSnapshotSource>(`
      (() => {
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
          .slice(0, ${MAX_INTERACTIVE_ELEMENTS})
          .map((el, i) => ({
            index: i + 1, tag: el.tagName.toLowerCase(),
            text: trim((el.textContent || '').trim(), 80),
            type: el.getAttribute('type'), placeholder: el.getAttribute('placeholder'),
            hint: hintFor(el),
          }));
        return {
          title: document.title,
          url: window.location.href,
          text: (document.body?.innerText || '').trim(),
          interactiveCount: interactiveElements.length,
          interactive,
        };
      })()
    `);
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

  async click(selector: string): Promise<string> {
    const page = await this.requirePage();
    await page.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
    return this.buildSnapshot(page);
  }

  async type(selector: string, text: string, submit = false): Promise<string> {
    const page = await this.requirePage();
    const loc = page.locator(selector).first();
    await loc.fill(text, { timeout: DEFAULT_TIMEOUT_MS });
    if (submit) {
      await loc.press('Enter', { timeout: DEFAULT_TIMEOUT_MS });
      await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => {});
    }
    return this.buildSnapshot(page);
  }

  async wait(selector?: string, timeoutMs = 3_000): Promise<string> {
    const page = await this.requirePage();
    if (selector) {
      await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs });
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

  async close(): Promise<string> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    this.page = null;
    this.context = null;
    return 'browser session closed';
  }

  listSessions(): string[] { return listSessionNames(); }
}

// ── Facade ────────────────────────────────────────────────────────────────────

type BrowserImpl = PlaywrightBrowserSession;

export class BrowserSession {
  private impl: BrowserImpl | null = null;
  private initPromise: Promise<BrowserImpl> | null = null;

  private ensureImpl(): Promise<BrowserImpl> {
    if (this.impl) return Promise.resolve(this.impl);
    if (!this.initPromise) {
      this.initPromise = detectBackend().then(() => {
        this.impl = new PlaywrightBrowserSession();
        return this.impl;
      }).catch((error) => {
        this.initPromise = null;
        throw error;
      });
    }
    return this.initPromise;
  }

  async open(url: string, opts?: BrowserOpenOptions) { return (await this.ensureImpl()).open(url, opts); }
  async openWithProfile(url: string, userDataDir: string, opts?: Omit<BrowserOpenOptions, 'session' | 'userDataDir'>) {
    return (await this.ensureImpl()).open(url, { ...opts, userDataDir });
  }
  async snapshot() { return (await this.ensureImpl()).snapshot(); }
  async click(selector: string) { return (await this.ensureImpl()).click(selector); }
  async type(selector: string, text: string, submit?: boolean) {
    return (await this.ensureImpl()).type(selector, text, submit);
  }
  async wait(selector?: string, timeoutMs?: number) {
    return (await this.ensureImpl()).wait(selector, timeoutMs);
  }
  async extract(options?: BrowserExtractOptions) { return (await this.ensureImpl()).extract(options); }
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
  if (configured === 'agent-browser') {
    return {
      mode: 'none',
      detail: 'configured agent-browser but that backend is no longer supported',
      configured,
    };
  }

  // auto-detect
  if (await canUsePlaywright()) {
    return { mode: 'playwright', detail: chromeExecPath, configured };
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
