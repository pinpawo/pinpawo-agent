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

test('separate Hosts create independent BrowserRS instances sharing one bridge', async () => {
  const bridge = isolatedBridge();
  const browserA = new ChromeExtensionBrowserRS({ bridge });
  const browserB = new ChromeExtensionBrowserRS({ bridge });
  await browserA.start();
  await browserB.start();
  assert.equal(bridge.getStatus().listening, true);

  await browserA.dispose();
  // B still holds its lease on the shared transport.
  assert.equal(bridge.getStatus().listening, true);
  assert.equal(browserB.status().available, true);
  await browserB.dispose();
  assert.equal(bridge.getStatus().listening, false);
});
