import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import type { BrowserContext, Page, ElementHandle } from 'playwright-core';
import { CdpConnection } from './connection';
import { BrowserOperationError } from './errors';
import { persistBrowserScreenshot, parseBrowserScreenshot } from './screenshot';
import {
  buildBrowserExtractPayload,
  buildBrowserExtractPayloadFromRaw,
  buildBrowserSnapshotPayload,
  normalizeBrowserExtractOptions,
  MAX_BROWSER_INTERACTIVE_ELEMENTS,
  type BrowserExtractOptions,
  type BrowserRawSnapshot,
} from './snapshotPayload';

export { buildBrowserExtractPayload, buildBrowserSnapshotPayload, buildBrowserTextChunk } from './snapshotPayload';
export type { BrowserExtractOptions } from './snapshotPayload';
export type BrowserOpenOptions = { headless?: boolean; session?: string; userDataDir?: string };
export type BrowserElementTarget = { selector?: string; ref?: string };
export type BrowserScrollOptions = { deltaX?: number; deltaY?: number; target?: BrowserElementTarget };
export type BrowserWaitState = 'visible' | 'hidden';
type PageElementHandle = ElementHandle<HTMLElement | SVGElement>;
const DEFAULT_TIMEOUT_MS = 15_000;

export function checkBrowserAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new BrowserOperationError('browser_command_cancelled', 'Browser operation was cancelled.', false);
}

function normalizeTarget(target: string | BrowserElementTarget): BrowserElementTarget {
  const value = typeof target === 'string' ? { selector: target.trim() } : target;
  if (!value || (value.selector ? 1 : 0) + (value.ref ? 1 : 0) !== 1) {
    throw new Error('browser target requires exactly one selector or ref');
  }
  return value;
}

/** A serialized page session belonging to one client + Toolkit + thread. */
export class CdpBrowserSession {
  private context: BrowserContext | null = null;
  private ownsContext = false;
  private page: Page | null = null;
  private readonly pages = new Set<Page>();
  private readonly parents = new WeakMap<Page, Page>();
  private readonly refElements = new Map<string, PageElementHandle>();
  private readonly refAttribute = 'data-pinpawo-ref-' + randomUUID();
  private readonly artifacts = new Set<string>();
  private navigationVersion = 0;
  private approvedOrigin: string | null = null;
  private disposed = false;
  private createdResources = false;
  private pendingPage: Promise<Page> | null = null;
  private closing: Promise<string> | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly connection: CdpConnection,
    readonly workdir: string,
    readonly name = 'default',
  ) {
    if (!isAbsolute(workdir)) throw new Error('Browser workdir must be absolute.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || name === '.' || name === '..') {
      throw new Error('Browser session must use 1-64 letters, numbers, dots, underscores or hyphens.');
    }
  }

  run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(async () => {
      checkBrowserAbort(signal);
      if (this.disposed) throw new BrowserOperationError('target_closed', 'Browser session has been closed. Use browser_open again.', true);
      let onAbort: (() => void) | undefined;
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => {
          void this.close().then(
            () => reject(new BrowserOperationError('browser_command_cancelled', 'Browser operation was cancelled and its owned pages were closed. An interaction may already have been dispatched.', false, { interactionDispatched: true })),
            (error) => reject(error),
          );
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([operation(), interrupted]);
      } catch (error) {
        if (signal?.aborted) {
          await this.close();
          throw new BrowserOperationError('browser_command_cancelled', 'Browser operation was cancelled and its owned pages were closed. An interaction may already have been dispatched.', false, { interactionDispatched: true });
        }
        throw error;
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private originError(interactionDispatched = false): BrowserOperationError {
    return new BrowserOperationError('origin_changed', 'The active page left the approved origin. Open its URL explicitly for review before reading or interacting with it.', false, {
      approvedOrigin: this.approvedOrigin,
      manualActionRequired: true,
      interactionDispatched,
    });
  }

  private assertOrigin(page: Page, interactionDispatched = false): void {
    if (page.isClosed()) throw new BrowserOperationError('target_closed', 'Browser page was closed.', true);
    if (!this.approvedOrigin) throw new BrowserOperationError('origin_approval_missing', 'Use browser_open with an explicitly reviewed URL.');
    let origin: string;
    try { origin = new URL(page.url()).origin; } catch { throw this.originError(interactionDispatched); }
    if (origin !== this.approvedOrigin) throw this.originError(interactionDispatched);
  }

  private activate(page: Page, parent?: Page): void {
    this.createdResources = true;
    if (parent) this.parents.set(page, parent);
    if (!this.pages.has(page)) {
      this.pages.add(page);
      page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
      page.on('popup', (popup) => {
        if (this.disposed) { void popup.close().catch(() => {}); return; }
        this.activate(popup, page);
      });
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          this.navigationVersion += 1;
          void this.clearRefElements();
        }
      });
      page.on('close', () => {
        this.pages.delete(page);
        if (this.page === page) {
          let parentPage = this.parents.get(page) ?? null;
          while (parentPage?.isClosed()) parentPage = this.parents.get(parentPage) ?? null;
          this.page = parentPage;
          void this.clearRefElements();
        }
      });
    }
    this.page = page;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.pendingPage) {
      this.pendingPage = (async () => {
        let context = this.context;
        if (!context) {
          const browser = await this.connection.getBrowser();
          context = this.name === 'default' ? browser.contexts()[0] : await browser.newContext();
          if (!context) throw new Error('CDP browser has no default context.');
          this.ownsContext = this.name !== 'default';
          this.context = context;
          this.createdResources ||= this.ownsContext;
          const createdContext = context;
          context.once('close', () => {
            if (this.context === createdContext) this.context = null;
          });
        }
        if (this.disposed) {
          if (this.ownsContext) await context.close();
          throw new BrowserOperationError('target_closed', 'Browser session closed while creating its context.');
        }
        const page = await context.newPage();
        if (this.disposed) {
          await page.close();
          if (this.ownsContext) await context.close();
          throw new BrowserOperationError('target_closed', 'Browser session closed while creating its page.');
        }
        this.activate(page);
        return page;
      })().finally(() => { this.pendingPage = null; });
    }
    return this.pendingPage;
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) throw new BrowserOperationError('browser_not_open', 'No active browser page. Use browser_open first.', true);
    this.assertOrigin(this.page);
    return this.page;
  }

  private async clearRefElements(): Promise<void> {
    const handles = [...this.refElements.values()];
    this.refElements.clear();
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => {})));
  }

  private async buildSnapshot(page: Page): Promise<string> {
    this.assertOrigin(page);
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
        const fullText = (document.body?.innerText || '').trim();
        return {
          title: document.title,
          url: window.location.href,
          text: fullText.slice(0, 50000),
          textLength: fullText.length,
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
    this.assertOrigin(page);
    if (new URL(snapshot.url).origin !== this.approvedOrigin) throw this.originError();
    return JSON.stringify(buildBrowserSnapshotPayload({
      title: snapshot.title,
      url: snapshot.url,
      text: snapshot.text,
      textLength: snapshot.textLength,
      textSource: 'document.body.innerText',
      interactive: snapshot.interactive,
      interactiveCount: snapshot.interactiveCount,
    }), null, 2);
  }


  async open(url: string, options: BrowserOpenOptions = {}): Promise<string> {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new BrowserOperationError('restricted_target', 'Only HTTP(S) browser targets are supported.');
    const config = this.connection.config;
    if (config.endpoint && (options.headless !== undefined || options.userDataDir !== undefined)) {
      throw new Error('A borrowed CDP browser cannot change headless or profile. Configure a managed runtime for startup options.');
    }
    if (!config.endpoint && options.headless !== undefined && options.headless !== (config.headless ?? false)) {
      throw new Error('headless must match the managed CDP runtime configuration.');
    }
    if (options.userDataDir && resolve(this.workdir, options.userDataDir) !== config.userDataDir) {
      throw new Error('userDataDir must match the managed CDP runtime configuration.');
    }
    await this.clearRefElements();
    this.approvedOrigin = parsed.origin;
    const page = await this.ensurePage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.connection.config.timeoutMs ?? 30_000 });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BrowserOperationError('navigation_timeout', 'Navigation timed out. Use browser_wait to inspect readiness without repeating navigation.', true);
      }
      throw error;
    }
    this.assertOrigin(page);
    return this.buildSnapshot(page);
  }

  async snapshot(): Promise<string> {
    const page = this.requirePage();
    try {
      return await this.buildSnapshot(page);
    } catch (error) {
      // A popup may close between the initial check and the CDP response.
      // Retrying this read on its already-owned parent never repeats an action.
      if (page.isClosed() && this.page && this.page !== page) {
        return this.buildSnapshot(this.requirePage());
      }
      throw error;
    }
  }

  private async target(target: string | BrowserElementTarget) {
    const page = this.requirePage();
    const normalized = normalizeTarget(target);
    if (normalized.selector) return page.locator(normalized.selector).first();
    const element = this.refElements.get(normalized.ref!);
    if (!element || !(await element.evaluate((node) => node.isConnected).catch(() => false))) {
      throw new BrowserOperationError('stale_element_reference', 'Element ref is stale. Take a new browser_snapshot.', true);
    }
    return element;
  }

  private async settle(previous: Page): Promise<string> {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 250));
    const page = this.page ?? previous;
    await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT_MS });
    this.assertOrigin(page, true);
    return this.buildSnapshot(page);
  }

  private async guardAction<T>(page: Page, operation: () => Promise<T>): Promise<T> {
    let originChanged = false;
    const onNavigation = () => {
      try { this.assertOrigin(page); } catch {
        originChanged = true;
        // A pending locator action must never follow a new, unapproved document.
        // Closing only this session-owned target cancels Playwright's auto-wait.
        void page.close().catch(() => {});
      }
    };
    page.on('framenavigated', onNavigation);
    try {
      this.assertOrigin(page);
      const result = await operation();
      if (originChanged) throw this.originError(true);
      return result;
    } catch (error) {
      if (originChanged) throw this.originError(true);
      throw error;
    } finally {
      page.off('framenavigated', onNavigation);
    }
  }

  async click(target: string | BrowserElementTarget): Promise<string> {
    const page = this.requirePage();
    const element = await this.target(target);
    this.assertOrigin(page);
    await this.guardAction(page, () => element.click({ timeout: DEFAULT_TIMEOUT_MS }));
    return this.settle(page);
  }

  async type(target: string | BrowserElementTarget, text: string, submit = false): Promise<string> {
    const page = this.requirePage();
    const element = await this.target(target);
    this.assertOrigin(page);
    await this.guardAction(page, async () => {
      await element.fill(text, { timeout: DEFAULT_TIMEOUT_MS });
      if (submit) await element.press('Enter', { timeout: DEFAULT_TIMEOUT_MS });
    });
    return this.settle(page);
  }

  async scroll(options: BrowserScrollOptions = {}): Promise<string> {
    const page = this.requirePage();
    const delta = { x: options.deltaX ?? 0, y: options.deltaY ?? 600 };
    if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) throw new Error('Scroll delta must be finite.');
    if (options.target) {
      const element = await this.target(options.target);
      if ('elementHandle' in element) {
        await element.evaluate((node, d) => node.scrollBy(d.x, d.y), delta);
      } else {
        await element.evaluate((node, d) => node.scrollBy(d.x, d.y), delta);
      }
    } else {
      await page.evaluate((d) => window.scrollBy(d.x, d.y), delta);
    }
    return this.buildSnapshot(page);
  }

  async wait(target?: string | BrowserElementTarget, timeoutMs = DEFAULT_TIMEOUT_MS, state: BrowserWaitState = 'visible'): Promise<string> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) throw new Error('Browser wait timeout must be between 1 and 120000ms.');
    const pendingPage = this.page;
    if (pendingPage && !pendingPage.isClosed() && pendingPage.url() === 'about:blank' && this.approvedOrigin) {
      await pendingPage.waitForURL((url) => url.protocol === 'http:' || url.protocol === 'https:', { timeout: timeoutMs });
    }
    const page = this.requirePage();
    if (target) {
      const element = await this.target(target);
      if ('waitFor' in element) await element.waitFor({ state, timeout: timeoutMs });
      else await element.waitForElementState(state, { timeout: timeoutMs });
    } else {
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
    }
    return this.buildSnapshot(page);
  }

  async extract(options: BrowserExtractOptions = {}): Promise<string> {
    const page = this.requirePage();
    const textWindow = normalizeBrowserExtractOptions(options);
    const raw = await page.locator(options.selector ?? 'body').first().evaluate((node, range) => {
      const fullText = (node as HTMLElement).innerText;
      const offset = Math.min(range.offset, fullText.length);
      return {
        text: fullText.slice(offset, offset + range.limit),
        textLength: fullText.length,
        offset,
        limit: range.limit,
        title: document.title,
        url: window.location.href,
      };
    }, textWindow);
    this.assertOrigin(page);
    if (new URL(raw.url).origin !== this.approvedOrigin) throw this.originError();
    return JSON.stringify(buildBrowserExtractPayloadFromRaw({ ...raw, selector: options.selector, textSource: options.selector ? 'selector.innerText' : 'document.body.innerText' }));
  }

  async screenshot(): Promise<string> {
    const page = this.requirePage();
    const navigationVersion = this.navigationVersion;
    const bytes = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false, timeout: DEFAULT_TIMEOUT_MS });
    this.assertOrigin(page);
    if (navigationVersion !== this.navigationVersion) throw new BrowserOperationError('navigation_failed', 'Page changed while capturing the screenshot. Capture again.', true);
    const serialized = await persistBrowserScreenshot({ mimeType: 'image/jpeg', data: bytes.toString('base64') }, this.workdir);
    const artifact = parseBrowserScreenshot(serialized).path;
    this.artifacts.add(artifact);
    if (this.disposed) { await rm(artifact, { force: true }); throw new BrowserOperationError('target_closed', 'Browser session closed while saving screenshot.'); }
    return serialized;
  }

  close(): Promise<string> {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose(): Promise<string> {
    this.disposed = true;
    await this.pendingPage?.catch(() => {});
    await this.clearRefElements();
    const cleanupUnconfirmed = this.createdResources && this.connection.diagnose().disconnected;
    const results = await Promise.allSettled([...this.pages].map((page) => page.close()));
    if (this.ownsContext && this.context) results.push(...await Promise.allSettled([this.context.close()]));
    this.page = null;
    this.context = null;
    await Promise.all([...this.artifacts].map((path) => rm(path, { force: true })));
    this.artifacts.clear();
    this.createdResources = false;
    const failure = results.find((result) => result.status === 'rejected');
    if (cleanupUnconfirmed || failure) {
      throw new BrowserOperationError('runtime_disconnected', 'Browser resource cleanup could not be confirmed after a CDP failure.', false, { cleanupUnconfirmed: true });
    }
    return 'browser session closed';
  }
}
