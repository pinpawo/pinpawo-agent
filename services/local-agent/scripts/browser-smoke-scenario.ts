import assert from 'node:assert/strict';
import type { BrowserScenarioFixture } from './browser-scenario-fixture';
import type { BrowserScenarioReporter } from './browser-scenario-report';

/**
 * The Browser smoke phases, shared by the driver smoke (straight to the
 * extension bridge) and the RS service smoke (through `BrowserRSClient`).
 * Each entry supplies how to reach the browser, how to wait for the
 * extension, and the recovery it proves last.
 */

export type SmokeBrowser = {
  open(url: string): Promise<string>;
  snapshot(): Promise<string>;
  click(target: string | { ref?: string; selector?: string }): Promise<string>;
  type(target: string | { ref?: string; selector?: string }, text: string, submit?: boolean): Promise<string>;
  scroll(options?: { deltaX?: number; deltaY?: number }): Promise<string>;
  wait(target?: string, timeoutMs?: number, state?: 'visible' | 'hidden', signal?: AbortSignal): Promise<string>;
  extract(options?: { selector?: string; offset?: number; limit?: number }): Promise<string>;
  close(): Promise<string>;
};

type Snapshot = {
  title: string;
  url: string;
  text: string;
  interactive: Array<{ ref?: string; placeholder: string | null; hint: string }>;
};
type Extract = { text: string; textLength: number; returnedTextLength: number; hasMore: boolean; nextOffset: number | null };
type BrowserCommandError = Error & {
  code?: string;
  details?: Record<string, unknown>;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function runBrowserSmokeScenario(options: Readonly<{
  label: string;
  /** The browser to use now; the recovery phase may replace it. */
  browser: () => SmokeBrowser;
  reporter: BrowserScenarioReporter;
  fixture: BrowserScenarioFixture;
  /** Runs as the `extension_connection` phase. */
  connect: () => Promise<void>;
  /** The last phase: after `run`, the page opened earlier must still be there. */
  recovery: Readonly<{ name: string; run: () => Promise<void> }>;
}>): Promise<void> {
  const log = (message: string) => console.log(`[${options.label}] ${message}`);
  await options.reporter.run('extension_connection', 'first_pass', async () => {
    await options.connect();
    log('extension connected');
  });

  const parentUrl = options.fixture.url('/parent');
  await options.reporter.run('navigate_and_dynamic_wait', 'first_pass', async () => {
    const opened = JSON.parse(await options.browser().open(parentUrl)) as Snapshot;
    assert.equal(new URL(opened.url).pathname, '/parent');
    assert.equal(opened.title, 'Browser fixture parent');
    log('parent opened');
    await options.browser().wait('#delayed', 2_000, 'visible');
    log('visible wait passed');
  });

  await options.reporter.run('long_content_extract', 'first_pass', async () => {
    const longContent = JSON.parse(await options.browser().extract({
      selector: '#long-content',
      limit: 10_000,
    })) as Extract;
    assert.ok(longContent.textLength > 50_000);
    assert.equal(longContent.returnedTextLength, 10_000);
    assert.equal(longContent.hasMore, true);
    assert.equal(longContent.nextOffset, 10_000);
    const continuation = JSON.parse(await options.browser().extract({
      selector: '#long-content',
      offset: longContent.nextOffset!,
      limit: 10_000,
    })) as Extract;
    assert.equal(continuation.text.length, 10_000);
    log('long-content extract passed');
  });

  await options.reporter.run('opaque_ref_form_and_scroll', 'first_pass', async () => {
    const formSnapshot = JSON.parse(await options.browser().snapshot()) as Snapshot;
    const taskName = formSnapshot.interactive.find((element) => element.placeholder === 'Task name');
    assert.ok(taskName?.ref, 'snapshot must expose an opaque ref for the form field');
    const typed = JSON.parse(await options.browser().type({ ref: taskName.ref }, 'Browser fixture')) as Snapshot;
    const save = typed.interactive.find((element) => element.hint.includes('#save'));
    assert.ok(save?.ref, 'snapshot must expose an opaque ref for the save button');
    const saved = JSON.parse(await options.browser().click({ ref: save.ref })) as Snapshot;
    assert.match(saved.text, /Saved: Browser fixture/);
    await options.browser().scroll({ deltaY: 800 });
    assert.match((JSON.parse(await options.browser().snapshot()) as Snapshot).text, /Scrolled/);
    log('opaque-ref form and scroll passed');
  });

  await options.reporter.run('frame_and_shadow_snapshot_observation', 'first_pass', async () => {
    const snapshot = JSON.parse(await options.browser().snapshot()) as Snapshot;
    options.reporter.observe('sameOriginIframeTextVisible', snapshot.text.includes('Same-origin iframe fixture content'));
    options.reporter.observe('crossOriginIframeTextVisible', snapshot.text.includes('Cross-origin iframe fixture content'));
    options.reporter.observe('openShadowTextVisible', snapshot.text.includes('Open shadow fixture content'));
    options.reporter.observe('closedShadowTextVisible', snapshot.text.includes('Closed shadow fixture content'));
  });
  await options.reporter.run('open_shadow_selector_observation', 'first_pass', async () => {
    try {
      const snapshot = JSON.parse(await options.browser().click('#open-shadow-button')) as Snapshot;
      options.reporter.observe('openShadowSelectorClickSucceeded', snapshot.text.includes('Open shadow clicked'));
      options.reporter.observe('openShadowSelectorErrorCode', 'none');
    } catch (error) {
      options.reporter.observe('openShadowSelectorClickSucceeded', false);
      options.reporter.observe(
        'openShadowSelectorErrorCode',
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'unexpected_error',
      );
    }
  });
  await options.reporter.run('extension_wait_cancellation', 'first_pass', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), 250);
    try {
      await assert.rejects(
        options.browser().wait('#never-visible', 30_000, 'visible', controller.signal),
        (error: BrowserCommandError) => error.code === 'browser_command_cancelled',
      );
    } finally {
      clearTimeout(timer);
    }
    const snapshot = JSON.parse(await options.browser().snapshot()) as Snapshot;
    assert.equal(new URL(snapshot.url).pathname, '/parent');
    assert.ok(
      Date.now() - startedAt < 2_000,
      'extension cancellation must release the serial queue without waiting for the original command deadline',
    );
  });

  await options.reporter.run('same_origin_popup_recovery', 'recovery', async () => {
    const child = JSON.parse(await options.browser().click('#open-popup')) as Snapshot;
    if (new URL(child.url).pathname !== '/child') {
      log(`parent result: ${JSON.stringify(child).slice(0, 2_000)}`);
    }
    assert.equal(new URL(child.url).pathname, '/child');
    log('popup followed');

    const returned = JSON.parse(await options.browser().click('#close-popup')) as Snapshot;
    assert.equal(new URL(returned.url).pathname, '/parent');
    log('parent restored');
    await options.browser().wait('#close-popup', 2_000, 'hidden');
    log('popup follow, parent fallback and waits passed');
  });

  await options.reporter.run('cross_origin_manual_takeover', 'guard', async () => {
    await assert.rejects(
      options.browser().click('#open-cross-origin-popup'),
      (error: BrowserCommandError) => {
        assert.equal(error.code, 'origin_changed');
        assert.equal(error.details?.manualActionRequired, true);
        assert.equal(error.details?.interactionDispatched, true);
        assert.equal(error.details?.recovery, 'complete_popup_manually');
        assert.equal(error.details?.approvedOrigin, new URL(parentUrl).origin);
        assert.equal(error.details?.actualOrigin, new URL(options.fixture.foreignUrl('/child')).origin);
        assert.doesNotMatch(JSON.stringify(error.details), /\/child/);
        return true;
      },
    );
  });
  await options.reporter.run('cross_origin_popup_close_recovery', 'recovery', async () => {
    await delay(1_000);
    const recovered = JSON.parse(await options.browser().snapshot()) as Snapshot;
    assert.equal(new URL(recovered.url).pathname, '/parent');
    log('cross-origin manual takeover and recovery passed');
  });

  await options.reporter.run(options.recovery.name, 'recovery', async () => {
    await options.recovery.run();
    const after = JSON.parse(await options.browser().snapshot()) as Snapshot;
    assert.equal(new URL(after.url).pathname, '/parent');
    log(`${options.recovery.name} passed`);
  });
}
