import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserToolkit } from './toolkit';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeExtensionBrowserRS } from './chromeExtensionBrowserRS';
import { BROWSER_RS_REQUIREMENT } from './browserRS';
import { BrowserExtensionBridge } from './drivers/chromeExtension/bridge';

/** Keep tests off the user's real bridge socket. */
function isolatedBridge() {
  const dir = mkdtempSync(join(tmpdir(), 'ppb-'));
  return new BrowserExtensionBridge({
    socketPath: join(dir, 'bridge.sock'),
    tokenPath: join(dir, 'bridge.token'),
  });
}

test('only browser_screenshot requires image input', () => {
  const toolkit = createBrowserToolkit({ browser: new ChromeExtensionBrowserRS() });
  const requiringImage = toolkit.tools
    .filter((definition) => definition.requiresInputModalities?.includes('image'))
    .map((definition) => definition.tool.name);

  assert.deepEqual(requiringImage, ['browser_screenshot']);
});

test('the Browser Toolkit declares its BrowserRS dependency for Host assembly', () => {
  const toolkit = createBrowserToolkit({ browser: new ChromeExtensionBrowserRS() });
  assert.deepEqual(toolkit.requires, { browser: BROWSER_RS_REQUIREMENT });
  assert.equal('runtime' in toolkit, false);
});

test('Browser Toolkit availability follows its injected BrowserRS status', async () => {
  const browser = new ChromeExtensionBrowserRS({ bridge: isolatedBridge() });
  const toolkit = createBrowserToolkit({ browser });
  assert.deepEqual(await toolkit.availability?.(), { available: true });

  await browser.dispose();
  const availability = await toolkit.availability?.();
  assert.equal(availability?.available, false);
});

test('a bridge that fails to start makes only the BrowserRS unavailable', async () => {
  const bridge = isolatedBridge();
  bridge.start = async () => { throw new Error('socket busy'); };
  const browser = new ChromeExtensionBrowserRS({ bridge });

  await assert.rejects(browser.start(), /socket busy/);
  assert.deepEqual(browser.status(), {
    available: false,
    reason: 'Browser extension bridge failed to start: socket busy',
  });
  const toolkit = createBrowserToolkit({ browser });
  assert.equal((await toolkit.availability?.())?.available, false);
});

test('dispose during an in-flight start releases the bridge once the start settles', async () => {
  const lifecycle: string[] = [];
  let finishStart!: () => void;
  const bridge = isolatedBridge();
  bridge.start = async () => {
    lifecycle.push('start');
    await new Promise<void>((resolve) => { finishStart = resolve; });
  };
  bridge.stop = async () => { lifecycle.push('stop'); };
  const browser = new ChromeExtensionBrowserRS({ bridge });

  const starting = browser.start();
  await new Promise((resolve) => setImmediate(resolve));
  const disposing = browser.dispose();
  finishStart();
  await starting;
  await disposing;

  assert.deepEqual(lifecycle, ['start', 'stop']);
  assert.equal(browser.status().available, false);
});
