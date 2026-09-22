import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { BrowserOperationError } from './errors';
import type { CdpRuntimeConfig } from './options';

export function defaultChromeExecutable(): string {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe')]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chrome is not installed; configure the CDP runtime executablePath or endpoint.');
  return found;
}

export function validateCdpConfig(config: CdpRuntimeConfig): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('CDP configuration must be an object.');
  for (const name of ['endpoint', 'executablePath', 'userDataDir'] as const) {
    const value = config[name];
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      throw new Error('CDP ' + name + ' must be a non-empty string.');
    }
  }
  if (config.headless !== undefined && typeof config.headless !== 'boolean') {
    throw new Error('CDP headless must be a boolean.');
  }
  if (config.env !== undefined && (!config.env || typeof config.env !== 'object' || Array.isArray(config.env)
    || Object.entries(config.env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0')))) {
    throw new Error('CDP env must contain string values and valid environment variable names.');
  }
  if (config.endpoint) {
    const endpoint = new URL(config.endpoint);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password) {
      throw new Error('CDP endpoint must be a local HTTP(S) or WebSocket URL without credentials.');
    }
    if (config.executablePath || config.userDataDir || config.headless !== undefined) {
      throw new Error('A borrowed CDP endpoint cannot configure executablePath, userDataDir or headless.');
    }
  }
  if (config.userDataDir && !isAbsolute(config.userDataDir)) throw new Error('CDP userDataDir must be absolute.');
  if (config.executablePath && !isAbsolute(config.executablePath)) throw new Error('CDP executablePath must be absolute.');
  if (config.timeoutMs !== undefined && (typeof config.timeoutMs !== 'number' || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
    throw new Error('CDP timeoutMs must be positive.');
  }
}

/** One CDP connection per instance, separate from each client's owned pages. */
export class CdpConnection {
  private browser: Browser | null = null;
  private pending: Promise<Browser> | null = null;
  private child: ChildProcess | null = null;
  private temporaryProfile: string | null = null;
  private disposed = false;
  private disconnected = false;
  readonly config: CdpRuntimeConfig;

  constructor(config: CdpRuntimeConfig = {}) {
    validateCdpConfig(config);
    this.config = Object.freeze({ ...config, env: Object.freeze({ ...(config.env ?? process.env) }) });
  }

  async getBrowser(): Promise<Browser> {
    if (this.disposed) throw new BrowserOperationError('runtime_disconnected', 'CDP runtime is closed.');
    if (this.disconnected) {
      throw new BrowserOperationError('runtime_disconnected', 'CDP connection was lost. Restart the runtime; existing page handles are invalid.');
    }
    if (this.browser) return this.browser;
    if (!this.pending) {
      this.pending = this.connect().catch(async (error) => {
        await this.stopOwnedProcess();
        this.pending = null;
        throw error;
      });
    }
    return this.pending;
  }

  private async connect(): Promise<Browser> {
    const endpoint = this.config.endpoint ?? await this.launchChrome();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: this.config.timeoutMs ?? 15_000 });
    if (this.disposed) {
      await browser.close();
      throw new BrowserOperationError('runtime_disconnected', 'CDP runtime closed while connecting.');
    }
    this.browser = browser;
    browser.on('disconnected', () => { this.disconnected = true; this.browser = null; });
    return browser;
  }

  private async launchChrome(): Promise<string> {
    const executable = this.config.executablePath ?? defaultChromeExecutable();
    if (!existsSync(executable)) throw new Error('Configured Chrome executable does not exist: ' + executable);
    let profile = this.config.userDataDir;
    if (!profile) {
      profile = await mkdtemp(join(tmpdir(), 'pinpawo-cdp-'));
      this.temporaryProfile = profile;
    }
    await mkdir(profile, { recursive: true, mode: 0o700 });
    if (this.disposed) throw new BrowserOperationError('runtime_disconnected', 'CDP runtime closed before Chrome started.');
    const args = [
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update',
      ...(this.config.headless ? ['--headless=new'] : []), 'about:blank',
    ];
    const child = spawn(executable, args, { env: this.config.env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.child = child;
    return new Promise<string>((resolve, reject) => {
      let stderr = '';
      const finish = (error?: Error, endpoint?: string) => {
        clearTimeout(timer);
        child.stderr?.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error); else resolve(endpoint!);
      };
      const onData = (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16_384);
        const endpoint = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
        if (endpoint) finish(undefined, endpoint);
      };
      const onError = (error: Error) => finish(error);
      const onExit = () => finish(new Error('Chrome exited before its CDP endpoint became ready. The configured profile may already be in use.'));
      const timer = setTimeout(() => finish(new Error('Timed out waiting for Chrome CDP endpoint.')), this.config.timeoutMs ?? 15_000);
      child.stderr?.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  private async stopOwnedProcess(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGTERM');
      });
    }
    if (this.temporaryProfile) {
      await rm(this.temporaryProfile, { recursive: true, force: true });
      this.temporaryProfile = null;
    }
  }

  diagnose() {
    return { connected: this.browser?.isConnected() ?? false, ownership: this.config.endpoint ? 'borrowed' : 'managed', closed: this.disposed, disconnected: this.disconnected };
  }

  async close(): Promise<void> {
    this.disposed = true;
    // connectOverCDP.close disconnects this transport; it does not send Browser.close.
    const browser = this.browser ?? await this.pending?.catch(() => null);
    await browser?.close();
    await this.stopOwnedProcess();
    this.browser = null;
  }
}
