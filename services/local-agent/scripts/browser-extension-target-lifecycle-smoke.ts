import assert from 'node:assert/strict';
import { ChromeExtensionBrowserSession } from '../src/toolkits/browser/drivers/chromeExtension/session';
import { browserRuntime } from '../src/toolkits/browser/runtime';
import { startBrowserScenarioFixture } from './browser-scenario-fixture';
import { BrowserScenarioReporter } from './browser-scenario-report';

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

async function waitForExtension(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (browserRuntime.getSnapshot().extension.commandReady) return;
    await delay(100);
  }
  throw new Error(
    'PinPawo Chrome extension did not connect. Reload the unpacked extension and retry.',
  );
}

const browser = new ChromeExtensionBrowserSession();
const fixture = await startBrowserScenarioFixture();
const reporter = new BrowserScenarioReporter('extension', 'browser-smoke-fixture');
let extensionConnected = false;
let failure: unknown;

try {
  await reporter.run('extension_connection', 'first_pass', async () => {
    await browserRuntime.start();
    await waitForExtension();
    extensionConnected = true;
    console.log('[browser-extension-smoke] extension connected');
  });

  const parentUrl = fixture.url('/parent');
  await reporter.run('navigate_and_dynamic_wait', 'first_pass', async () => {
    const opened = JSON.parse(await browser.open(parentUrl)) as Snapshot;
    assert.equal(new URL(opened.url).pathname, '/parent');
    assert.equal(opened.title, 'Browser fixture parent');
    console.log('[browser-extension-smoke] parent opened');
    await browser.wait('#delayed', 2_000, 'visible');
    console.log('[browser-extension-smoke] visible wait passed');
  });

  await reporter.run('long_content_extract', 'first_pass', async () => {
    const longContent = JSON.parse(await browser.extract({
      selector: '#long-content',
      limit: 10_000,
    })) as Extract;
    assert.ok(longContent.textLength > 50_000);
    assert.equal(longContent.returnedTextLength, 10_000);
    assert.equal(longContent.hasMore, true);
    assert.equal(longContent.nextOffset, 10_000);
    const continuation = JSON.parse(await browser.extract({
      selector: '#long-content',
      offset: longContent.nextOffset!,
      limit: 10_000,
    })) as Extract;
    assert.equal(continuation.text.length, 10_000);
    console.log('[browser-extension-smoke] long-content extract passed');
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
    console.log('[browser-extension-smoke] opaque-ref form and scroll passed');
  });

  await reporter.run('same_origin_popup_recovery', 'recovery', async () => {
    const child = JSON.parse(await browser.click('#open-popup')) as Snapshot;
    if (new URL(child.url).pathname !== '/child') {
      console.log(`[browser-extension-smoke] parent result: ${JSON.stringify(child).slice(0, 2_000)}`);
    }
    assert.equal(new URL(child.url).pathname, '/child');
    console.log('[browser-extension-smoke] popup followed');

    const returned = JSON.parse(await browser.click('#close-popup')) as Snapshot;
    assert.equal(new URL(returned.url).pathname, '/parent');
    console.log('[browser-extension-smoke] parent restored');
    await browser.wait('#close-popup', 2_000, 'hidden');
    console.log('[browser-extension-smoke] popup follow, parent fallback and waits passed');
  });

  await reporter.run('cross_origin_manual_takeover', 'guard', async () => {
    await assert.rejects(
      browser.click('#open-cross-origin-popup'),
      (error: BrowserCommandError) => {
        assert.equal(error.code, 'origin_changed');
        assert.equal(error.details?.manualActionRequired, true);
        assert.equal(error.details?.interactionDispatched, true);
        assert.equal(error.details?.recovery, 'complete_popup_manually');
        assert.equal(error.details?.approvedOrigin, new URL(parentUrl).origin);
        assert.equal(error.details?.actualOrigin, new URL(fixture.foreignUrl('/child')).origin);
        assert.doesNotMatch(JSON.stringify(error.details), /\/child/);
        return true;
      },
    );
  });
  await reporter.run('cross_origin_popup_close_recovery', 'recovery', async () => {
    await delay(1_000);
    const recovered = JSON.parse(await browser.snapshot()) as Snapshot;
    assert.equal(new URL(recovered.url).pathname, '/parent');
    console.log('[browser-extension-smoke] cross-origin manual takeover and recovery passed');
  });

  await reporter.run('bridge_restart_recovery', 'recovery', async () => {
    await browserRuntime.stop();
    extensionConnected = false;
    await browserRuntime.start();
    await waitForExtension();
    extensionConnected = true;
    const afterBridgeRestart = JSON.parse(await browser.snapshot()) as Snapshot;
    assert.equal(new URL(afterBridgeRestart.url).pathname, '/parent');
    console.log('[browser-extension-smoke] bridge restart recovery passed');
  });
} catch (error) {
  failure = error;
  throw error;
} finally {
  console.log(`[browser-evaluation] ${JSON.stringify(reporter.finish(failure))}`);
  if (extensionConnected) await browser.close().catch(() => {});
  await browserRuntime.stop();
  await fixture.close();
}
