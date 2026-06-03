import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { config } from '../config';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const nodeRequire = createRequire(import.meta.url);

// ── Playwright types ───────────────────────────────────────────────────────────
type PlaywrightCore = typeof import('playwright-core');
type BrowserContext = import('playwright-core').BrowserContext;
type Page = import('playwright-core').Page;

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 3_000;
const MAX_INTERACTIVE_ELEMENTS = 20;
const DEFAULT_CHROME_EXECUTABLE_PATH =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSIONS_DIR = resolve(homedir(), '.pinpawo', 'sessions');
const SCREENSHOTS_DIR = resolve(homedir(), '.pinpawo', 'screenshots');
const DEFAULT_SESSION = 'default';

/** 一次截屏的结构化结果。`dataUrl` 供多模态工具结果直接喂给视觉模型(见 #21 slice 2)。 */
export type BrowserScreenshot = {
  path: string;
  base64: string;
  dataUrl: string;
  byteLength: number;
  fullPage: boolean;
};
const SAFE_SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

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

type BrowserBackend = 'playwright' | 'agent-browser';
export type BrowserStatus = {
  mode: 'playwright' | 'agent-browser' | 'none';
  detail: string;
  configured: string;
};

async function detectBackend(): Promise<BrowserBackend> {
  // Env var takes precedence; falls back to stored config (written by Settings UI)
  const fromEnv = process.env.PINPAWO_BROWSER_BACKEND?.trim();
  const fromConfig = config.browserBackend;
  const forced = fromEnv || fromConfig || 'auto';

  console.log(`[browser] detectBackend: env=${fromEnv ?? '(unset)'} config=${fromConfig} → forced=${forced}`);

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

  if (forced === 'agent-browser') {
    if (!canUseAgentBrowser()) {
      throw new Error(
        'Browser backend forced to "agent-browser" but the binary was not found.\n' +
          '  Install an external agent-browser binary, then ensure it is in PATH or a standard install location.',
      );
    }
    console.log('[browser] using agent-browser (forced)');
    return 'agent-browser';
  }

  // auto-detect
  const persistedAgentBrowserSession = readPersistedSession();
  if (persistedAgentBrowserSession && await canReuseAgentBrowserSession(persistedAgentBrowserSession)) {
    console.log('[browser] using agent-browser (auto, existing session)');
    return 'agent-browser';
  }
  if (await canUsePlaywright()) { console.log('[browser] using playwright (auto)'); return 'playwright'; }
  if (canUseAgentBrowser()) { console.log('[browser] using agent-browser (auto)'); return 'agent-browser'; }
  throw new Error(
      'No browser backend available.\n' +
      '  Option 1 — Playwright + Chrome:\n' +
      '    npm install -g playwright-core\n' +
      '  Option 2 — agent-browser (standalone):\n' +
      '    install an external agent-browser binary and ensure it is in PATH',
  );
}

function resolvePlaywrightSearchRoots(): string[] {
  const home = homedir();
  const roots = [
    process.env.PINPAWO_PLAYWRIGHT_CORE_PATH?.trim() || '',
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    `${home}/.npm-global/lib/node_modules`,
    `${home}/.local/lib/node_modules`,
  ].filter(Boolean);

  // npm root -g via login shell
  const npmRoot = spawnSync('/bin/zsh', ['-lc', 'npm root -g'], {
    timeout: 3_000,
    encoding: 'utf8',
  }).stdout?.trim();
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

function resolvePlaywrightCorePath(): string | null {
  const override = process.env.PINPAWO_PLAYWRIGHT_CORE_PATH?.trim();
  if (override && existsSync(override)) {
    return override;
  }

  try {
    return nodeRequire.resolve('playwright-core');
  } catch {
    // Optional package dependency not installed; fall back to global search roots.
  }

  for (const root of resolvePlaywrightSearchRoots()) {
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

function loadPlaywrightCore(): PlaywrightCore | null {
  const resolved = resolvePlaywrightCorePath();
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
  return loadPlaywrightCore() !== null && existsSync(execPath);
}

let _agentBrowserBinary: string | null | undefined;

function resolveAgentBrowserCandidates(): string[] {
  const home = homedir();
  const candidates = [
    resolve(process.execPath, '..', 'agent-browser'),
    '/usr/local/bin/agent-browser',
    '/opt/homebrew/bin/agent-browser',
    `${home}/.npm-global/bin/agent-browser`,
    `${home}/.local/bin/agent-browser`,
  ];

  const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
  const nvmVersionsDir = resolve(nvmDir, 'versions', 'node');
  try {
    const nvmCandidates = readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => resolve(nvmVersionsDir, d.name, 'bin', 'agent-browser'));
    candidates.push(...nvmCandidates);
  } catch {
    // nvm not installed or no node versions — skip
  }

  try {
    candidates.push(nodeRequire.resolve('agent-browser/bin/agent-browser.js'));
  } catch {
    // optional package dependency not installed or not resolvable from this bundle
  }

  return [...new Set(candidates)];
}

function getAgentBrowserBinary(): string | null {
  if (_agentBrowserBinary !== undefined) return _agentBrowserBinary;

  for (const p of resolveAgentBrowserCandidates()) {
    if (existsSync(p)) { _agentBrowserBinary = p; return p; }
  }

  // Login shell PATH
  const result = spawnSync('/bin/zsh', ['-lc', 'which agent-browser'], {
    timeout: 3_000, encoding: 'utf8',
  });
  const found = result.stdout?.trim();
  _agentBrowserBinary = found && existsSync(found) ? found : null;
  return _agentBrowserBinary;
}

function canUseAgentBrowser(): boolean {
  return getAgentBrowserBinary() !== null;
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
  return isAbsolute(trimmed) ? trimmed : resolve(config.workdir, trimmed);
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
    await closeAgentBrowserSession(sessionPath);

    const playwrightCore = loadPlaywrightCore();
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
    const snapshot = await page.evaluate(`
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
        const interactive = Array.from(
          document.querySelectorAll('a,button,input,textarea,select,[role="button"]')
        )
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .slice(0, ${MAX_INTERACTIVE_ELEMENTS})
          .map((el, i) => ({
            index: i + 1, tag: el.tagName.toLowerCase(),
            text: trim((el.textContent || '').trim(), 80),
            type: el.getAttribute('type'), placeholder: el.getAttribute('placeholder'),
            hint: hintFor(el),
          }));
        return {
          title: document.title, url: window.location.href,
          text: trim((document.body?.innerText || '').trim(), ${MAX_TEXT_LENGTH}),
          interactive,
        };
      })()
    `);
    return JSON.stringify(snapshot, null, 2);
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

  /**
   * 对当前页面截屏(PNG),保存到 ~/.pinpawo/screenshots 并返回结构化结果。
   * 两种后端(playwright / agent-browser)都最终持有 Playwright Page,因此 page.screenshot() 通用。
   */
  async screenshot(opts: { fullPage?: boolean } = {}): Promise<BrowserScreenshot> {
    const page = await this.requirePage();
    const fullPage = opts.fullPage ?? false;
    const buffer = await page.screenshot({ fullPage, type: 'png' });
    if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const path = resolve(SCREENSHOTS_DIR, `screenshot-${Date.now()}.png`);
    writeFileSync(path, buffer);
    const base64 = buffer.toString('base64');
    return {
      path,
      base64,
      dataUrl: `data:image/png;base64,${base64}`,
      byteLength: buffer.length,
      fullPage,
    };
  }

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

  async extract(selector?: string): Promise<string> {
    const page = await this.requirePage();
    if (!selector) return this.buildSnapshot(page);
    return (await page.locator(selector).first().innerText({ timeout: DEFAULT_TIMEOUT_MS })).trim();
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

// ── agent-browser CLI implementation ──────────────────────────────────────────

/** Path where we persist the active browser session so the next process can detect it. */
const AGENT_BROWSER_STATE_FILE = resolve(homedir(), '.pinpawo', 'agent-browser-state.json');

function readPersistedAgentBrowserState(): { sessionDir: string; headless: boolean | null } | null {
  try {
    const s = JSON.parse(readFileSync(AGENT_BROWSER_STATE_FILE, 'utf-8'));
    const sessionDirValue = typeof s.sessionDir === 'string'
      ? s.sessionDir
      : typeof s.profileDir === 'string'
        ? s.profileDir
        : null;
    if (!sessionDirValue) return null;
    return {
      sessionDir: sessionDirValue,
      headless: typeof s.headless === 'boolean' ? s.headless : null,
    };
  } catch { return null; }
}

function readPersistedSession(): string | null {
  return readPersistedAgentBrowserState()?.sessionDir ?? null;
}

function writePersistedSession(sessionPath: string, headless: boolean) {
  try {
    writeFileSync(AGENT_BROWSER_STATE_FILE, JSON.stringify({ sessionDir: sessionPath, headless }), 'utf-8');
  } catch { /* best-effort */ }
}

function clearPersistedSession() {
  try { unlinkSync(AGENT_BROWSER_STATE_FILE); } catch { /* ok */ }
}

function isNodeEntrypoint(path: string): boolean {
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) {
    return true;
  }
  try {
    const prefix = readFileSync(path).subarray(0, 128).toString('utf8');
    return prefix.startsWith('#!') && /\bnode\b/.test(prefix);
  } catch {
    return false;
  }
}

function buildAgentBrowserCommand(binary: string, sessionPath: string, args: string[]) {
  const runWithNode = isNodeEntrypoint(binary);
  return {
    command: runWithNode ? process.execPath : binary,
    args: runWithNode
      ? [binary, '--profile', sessionPath, ...args]
      : ['--profile', sessionPath, ...args],
  };
}

async function execAgentBrowser(binary: string, sessionPath: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { command, args: commandArgs } = buildAgentBrowserCommand(binary, sessionPath, args);
  const { stdout } = await execFileAsync(command, commandArgs, { timeout: timeoutMs });
  return stdout.trim();
}

async function canReuseAgentBrowserSession(sessionPath: string): Promise<boolean> {
  const binary = getAgentBrowserBinary();
  if (!binary) return false;
  return execAgentBrowser(binary, sessionPath, ['snapshot'], 5_000)
    .then(() => true)
    .catch(() => false);
}

async function closeAgentBrowserSession(sessionPath: string): Promise<void> {
  const binary = getAgentBrowserBinary();
  if (!binary) return;
  await execAgentBrowser(binary, sessionPath, ['close'], 5_000).catch(() => {});
  if (readPersistedSession() === sessionPath) {
    clearPersistedSession();
  }
}

class AgentBrowserSession {
  private activeSessionDir: string = sessionDir(DEFAULT_SESSION);
  private activeHeadless = false;
  private readonly runWithNode: boolean;
  /** True once we've confirmed a daemon is live in this process run. */
  private daemonConfirmed = false;

  constructor(private readonly binary: string) {
    this.runWithNode = isNodeEntrypoint(binary);
  }

  private sessionFlags(): string[] {
    return ['--profile', this.activeSessionDir];
  }

  private async exec(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const command = this.runWithNode ? process.execPath : this.binary;
    const commandArgs = this.runWithNode
      ? [this.binary, ...this.sessionFlags(), ...args]
      : [...this.sessionFlags(), ...args];
    try {
      const { stdout } = await execFileAsync(
        command,
        commandArgs,
        { timeout: timeoutMs },
      );
      return stdout.trim();
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(e.stderr?.trim() || e.message || `agent-browser ${args[0]} failed`);
    }
  }

  private async buildSnapshot(): Promise<string> {
    const [tree, url, title] = await Promise.all([
      this.exec(['snapshot']),
      this.exec(['get', 'url']),
      this.exec(['get', 'title']),
    ]);
    return JSON.stringify({ title, url, tree }, null, 2);
  }

  async open(url: string, opts: BrowserOpenOptions = {}): Promise<string> {
    const newSessionDir = openSessionPath(opts);
    const newHeadless = opts.headless === true;

    if (!this.daemonConfirmed) {
      // Check if a daemon from a previous process run is still alive and using
      // the same browser session, so we can reuse it instead of restarting.
      const persistedState = readPersistedAgentBrowserState();
      if (persistedState?.sessionDir === newSessionDir) {
        this.activeSessionDir = newSessionDir;
        this.activeHeadless = persistedState.headless ?? newHeadless;
        if (persistedState.headless === null || persistedState.headless === newHeadless) {
          // Ping the daemon; if it responds we can reuse it.
          const alive = await this.exec(['snapshot'], 5_000).then(() => true).catch(() => false);
          if (alive) {
            this.daemonConfirmed = true;
          }
        }
      }
      // Not confirmed — close any stale daemon and start fresh.
      if (!this.daemonConfirmed) {
        await this.exec(['close']).catch(() => {});
        if (readPersistedSession() === this.activeSessionDir) {
          clearPersistedSession();
        }
        this.activeSessionDir = newSessionDir;
        this.activeHeadless = newHeadless;
      }
    } else if (newSessionDir !== this.activeSessionDir || newHeadless !== this.activeHeadless) {
      // Browser session or headless-mode switch within the same process run.
      await this.exec(['close']).catch(() => {});
      if (readPersistedSession() === this.activeSessionDir) {
        clearPersistedSession();
      }
      this.activeSessionDir = newSessionDir;
      this.activeHeadless = newHeadless;
    }

    mkdirSync(this.activeSessionDir, { recursive: true });
    const args = ['open', url];
    if (newHeadless) args.push('--headless');
    try {
      await this.exec(args, 30_000);
      this.daemonConfirmed = true;
      this.activeHeadless = newHeadless;
      writePersistedSession(this.activeSessionDir, this.activeHeadless);
      return await this.buildSnapshot();
    } catch (error) {
      this.daemonConfirmed = false;
      if (readPersistedSession() === this.activeSessionDir) {
        clearPersistedSession();
      }
      throw error;
    }
  }

  async snapshot(): Promise<string> { return this.buildSnapshot(); }

  async screenshot(_opts: { fullPage?: boolean } = {}): Promise<BrowserScreenshot> {
    throw new Error('当前为 agent-browser 后端，暂不支持截屏；截屏目前仅支持 playwright 后端。');
  }

  async click(selector: string): Promise<string> {
    await this.exec(['click', selector]);
    return this.buildSnapshot();
  }

  async type(selector: string, text: string, submit = false): Promise<string> {
    await this.exec(['fill', selector, text]);
    if (submit) await this.exec(['press', 'Enter']);
    return this.buildSnapshot();
  }

  async wait(selector?: string, timeoutMs = 3_000): Promise<string> {
    if (selector) {
      await this.exec(['wait', selector], timeoutMs + 5_000);
    } else {
      await this.exec(['wait', String(timeoutMs)], timeoutMs + 5_000);
    }
    return this.buildSnapshot();
  }

  async extract(selector?: string): Promise<string> {
    if (selector) return this.exec(['get', 'text', selector]);
    return this.buildSnapshot();
  }

  async close(): Promise<string> {
    await this.exec(['close']).catch(() => {});
    this.daemonConfirmed = false;
    clearPersistedSession();
    return 'browser session closed';
  }

  listSessions(): string[] { return listSessionNames(); }
}

// ── Facade ────────────────────────────────────────────────────────────────────

type BrowserImpl = PlaywrightBrowserSession | AgentBrowserSession;

export class BrowserSession {
  private impl: BrowserImpl | null = null;
  private initPromise: Promise<BrowserImpl> | null = null;

  private ensureImpl(): Promise<BrowserImpl> {
    if (this.impl) return Promise.resolve(this.impl);
    if (!this.initPromise) {
      this.initPromise = detectBackend().then((backend) => {
        this.impl =
          backend === 'playwright'
            ? new PlaywrightBrowserSession()
            : new AgentBrowserSession(getAgentBrowserBinary()!);
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
  async screenshot(opts?: { fullPage?: boolean }) { return (await this.ensureImpl()).screenshot(opts); }
  async click(selector: string) { return (await this.ensureImpl()).click(selector); }
  async type(selector: string, text: string, submit?: boolean) {
    return (await this.ensureImpl()).type(selector, text, submit);
  }
  async wait(selector?: string, timeoutMs?: number) {
    return (await this.ensureImpl()).wait(selector, timeoutMs);
  }
  async extract(selector?: string) { return (await this.ensureImpl()).extract(selector); }
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
  const fromConfig = config.browserBackend;
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
    const binary = getAgentBrowserBinary();
    if (binary) return { mode: 'agent-browser', detail: binary, configured };
    return {
      mode: 'none',
      detail: 'configured agent-browser but no external binary was found',
      configured,
    };
  }

  // auto-detect
  const persistedAgentBrowserSession = readPersistedSession();
  if (persistedAgentBrowserSession && await canReuseAgentBrowserSession(persistedAgentBrowserSession)) {
    const binary = getAgentBrowserBinary();
    return {
      mode: 'agent-browser',
      detail: binary ? `${binary} (existing session)` : 'existing agent-browser session',
      configured,
    };
  }
  if (await canUsePlaywright()) {
    return { mode: 'playwright', detail: chromeExecPath, configured };
  }
  const binary = getAgentBrowserBinary();
  if (binary) return { mode: 'agent-browser', detail: binary, configured };
  return { mode: 'none', detail: 'no external browser runtime available', configured };
}

// ── Full environment detection (for CLI `detect` command / Settings UI) ──────
export type BrowserEnvironment = {
  configured: string;
  chromePath: string;
  chromeAvailable: boolean;
  playwrightCorePath: string | null;
  agentBrowserPath: string | null;
};

export async function detectBrowserEnvironment(): Promise<BrowserEnvironment> {
  const chromePath =
    process.env.PINPAWO_BROWSER_EXECUTABLE_PATH?.trim() || DEFAULT_CHROME_EXECUTABLE_PATH;
  const fromEnv = process.env.PINPAWO_BROWSER_BACKEND?.trim();
  const fromConfig = config.browserBackend;

  return {
    configured: fromEnv || fromConfig || 'auto',
    chromePath,
    chromeAvailable: existsSync(chromePath),
    playwrightCorePath: resolvePlaywrightCorePath(),
    agentBrowserPath: getAgentBrowserBinary(),
  };
}
