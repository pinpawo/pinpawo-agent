import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { BrowserSession } from '@pinpawo-toolkit/browser';
import { startBrowserScenarioFixture } from './browser-scenario-fixture';
import { BrowserScenarioReporter } from './browser-scenario-report';

type Snapshot = {
  title: string;
  url: string;
  text: string;
  interactive: Array<{ ref?: string; placeholder: string | null; hint: string }>;
};
type Extract = { text: string; textLength: number; returnedTextLength: number; hasMore: boolean; nextOffset: number | null };

const profileDir = await mkdtemp(resolve(tmpdir(), 'pinpawo-browser-popup-smoke-'));
const browser = new BrowserSession();
const fixture = await startBrowserScenarioFixture();
const reporter = new BrowserScenarioReporter('playwright', 'browser-smoke-fixture');
let failure: unknown;

type BrowserSessionInternals = {
  impl: {
    context: {
      newPage(): Promise<{ goto(url: string): Promise<unknown> }>;
    } | null;
  } | null;
};

try {
  const parentUrl = fixture.url('/parent');
  await reporter.run('navigate_and_dynamic_wait', 'first_pass', async () => {
    const opened = JSON.parse(await browser.openWithProfile(parentUrl, profileDir, {
      headless: true,
    })) as Snapshot;
    assert.equal(new URL(opened.url).pathname, '/parent');
    await browser.wait('#delayed', 2_000, 'visible');
  });

  await reporter.run('long_content_extract', 'first_pass', async () => {
    const longContent = JSON.parse(await browser.extract({
      selector: '#long-content',
      limit: 10_000,
    })) as Extract;
    assert.ok(longContent.textLength > 50_000);
    assert.equal(longContent.returnedTextLength, 10_000);
    assert.equal(longContent.hasMore, true);
    const continuation = JSON.parse(await browser.extract({
      selector: '#long-content',
      offset: longContent.nextOffset!,
      limit: 10_000,
    })) as Extract;
    assert.equal(continuation.text.length, 10_000);
  });

  await reporter.run('opaque_ref_form_and_scroll', 'first_pass', async () => {
    const formSnapshot = JSON.parse(await browser.snapshot()) as Snapshot;
    const taskName = formSnapshot.interactive.find((element) => element.placeholder === 'Task name');
    assert.ok(taskName?.ref, 'snapshot must expose an opaque ref for the form field');
    const typed = JSON.parse(await browser.type({ ref: taskName.ref }, 'Browser fixture')) as Snapshot;
    const save = typed.interactive.find((element) => element.hint.includes('#save'));
    assert.ok(save?.ref, 'snapshot must expose an opaque ref for the save button');
    const saved = JSON.parse(await browser.click({ ref: save.ref })) as Snapshot;
    assert.match(saved.text, /Saved: Browser fixture/);
    await browser.scroll({ deltaY: 800 });
    assert.match((JSON.parse(await browser.snapshot()) as Snapshot).text, /Scrolled/);
  });

  await reporter.run('frame_and_shadow_snapshot_observation', 'first_pass', async () => {
    const snapshot = JSON.parse(await browser.snapshot()) as Snapshot;
    reporter.observe('sameOriginIframeTextVisible', snapshot.text.includes('Same-origin iframe fixture content'));
    reporter.observe('crossOriginIframeTextVisible', snapshot.text.includes('Cross-origin iframe fixture content'));
    reporter.observe('openShadowTextVisible', snapshot.text.includes('Open shadow fixture content'));
    reporter.observe('closedShadowTextVisible', snapshot.text.includes('Closed shadow fixture content'));
  });
  await reporter.run('open_shadow_selector_observation', 'first_pass', async () => {
    try {
      const snapshot = JSON.parse(await browser.click('#open-shadow-button')) as Snapshot;
      reporter.observe('openShadowSelectorClickSucceeded', snapshot.text.includes('Open shadow clicked'));
      reporter.observe('openShadowSelectorErrorCode', 'none');
    } catch (error) {
      reporter.observe('openShadowSelectorClickSucceeded', false);
      reporter.observe(
        'openShadowSelectorErrorCode',
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'unexpected_error',
      );
    }
  });

  const context = (browser as unknown as BrowserSessionInternals).impl?.context;
  assert.ok(context, 'Playwright smoke requires an active browser context');
  const unrelated = await context.newPage();
  await unrelated.goto(fixture.url('/child'));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  const stillParent = JSON.parse(await browser.snapshot()) as Snapshot;
  assert.equal(new URL(stillParent.url).pathname, '/parent');

  await reporter.run('same_origin_popup_recovery', 'recovery', async () => {
    const child = JSON.parse(await browser.click('#open-popup')) as Snapshot;
    assert.equal(new URL(child.url).pathname, '/child');

    const returned = JSON.parse(await browser.click('#close-popup')) as Snapshot;
    assert.equal(new URL(returned.url).pathname, '/parent');
    await browser.wait('#close-popup', 2_000, 'hidden');
    console.log('[browser-smoke] popup follow and parent fallback passed');
  });
  reporter.skip('cross_origin_manual_takeover', 'guard', 'extension-only origin guard');
  reporter.skip('bridge_restart_recovery', 'recovery', 'extension-only bridge lifecycle');
} catch (error) {
  failure = error;
  throw error;
} finally {
  console.log(`[browser-evaluation] ${JSON.stringify(reporter.finish(failure))}`);
  await browser.close();
  await fixture.close();
  await rm(profileDir, { recursive: true, force: true });
}
