/**
 * Browser driver smoke: the extension bridge driven directly, without the RS
 * service. The RS service normally holds the bridge socket, so stop it first
 * (`pinpawo rs stop`); `test:browser-rs-service-smoke` runs the same scenario
 * through the service.
 */
import {
  ChromeExtensionBrowserRS,
  ChromeExtensionBrowserSession,
  BrowserExtensionBridge,
} from '@pinpawo-toolkit/browser';
import { startBrowserScenarioFixture } from './browser-scenario-fixture';
import { BrowserScenarioReporter } from './browser-scenario-report';
import { runBrowserSmokeScenario } from './browser-smoke-scenario';

const bridge = new BrowserExtensionBridge();
let browserRuntime = new ChromeExtensionBrowserRS({ bridge });

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// Longer than the Native Host's 30s maximum reconnect backoff: a host that has
// been retrying against an absent bridge may not retry again for that long.
async function waitForExtension(timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (browserRuntime.getSnapshot().extension.commandReady) return;
    await delay(100);
  }
  throw new Error(
    'PinPawo Chrome extension did not connect. Reload the unpacked extension and retry.',
  );
}

const browser = new ChromeExtensionBrowserSession(bridge);
const fixture = await startBrowserScenarioFixture();
const reporter = new BrowserScenarioReporter('extension', 'browser-smoke-fixture');
let extensionConnected = false;
let failure: unknown;

try {
  await runBrowserSmokeScenario({
    label: 'browser-extension-smoke',
    browser: () => browser,
    reporter,
    fixture,
    connect: async () => {
      await browserRuntime.start();
      await waitForExtension();
      extensionConnected = true;
    },
    recovery: {
      name: 'bridge_restart_recovery',
      run: async () => {
        await browserRuntime.dispose();
        extensionConnected = false;
        // A disposed instance stays disposed; a restart creates a new one.
        browserRuntime = new ChromeExtensionBrowserRS({ bridge });
        await browserRuntime.start();
        await waitForExtension();
        extensionConnected = true;
      },
    },
  });
} catch (error) {
  failure = error;
  throw error;
} finally {
  console.log(`[browser-evaluation] ${JSON.stringify(reporter.finish(failure))}`);
  if (extensionConnected) await browser.close().catch(() => {});
  await browserRuntime.dispose();
  await fixture.close();
}
