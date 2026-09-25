/**
 * Browser smoke through the RS service (#862): the same scenario as the
 * driver smoke, driven the way a Host drives it — `BrowserRSClient` to the
 * RS service, which holds the extension bridge. Starts the service when none
 * runs and leaves it running afterwards.
 *
 * The last phase restarts the "Host": the client is disposed and a new one
 * continues the same Agent session on the page opened before.
 */
import { BROWSER_RS_CONTRACT } from '@pinpawo-toolkit/browser';
import { connectRSService } from '../src/rsService/launcher';
import { resolveRSServicePaths } from '../src/rsService/paths';
import type { RSServiceStatus } from '../src/rsService/server';
import { BrowserRSClient } from '../src/toolkits/browserRSClient';
import { startBrowserScenarioFixture } from './browser-scenario-fixture';
import { BrowserScenarioReporter } from './browser-scenario-report';
import { runBrowserSmokeScenario, type SmokeBrowser } from './browser-smoke-scenario';

const paths = resolveRSServicePaths();
const context = {
  agentSessionId: `browser-rs-service-smoke-${Date.now().toString()}`,
  workdir: process.cwd(),
};

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** The Browser Tools' view of a BrowserRS, bound to this smoke's session. */
function smokeBrowser(client: BrowserRSClient): SmokeBrowser {
  return {
    open: (url) => client.open(context, url),
    snapshot: () => client.snapshot(context),
    click: (target) => client.click(context, target),
    type: (target, text, submit) => client.type(context, target, text, submit),
    scroll: (options) => client.scroll(context, options),
    wait: (target, timeoutMs, state, signal) => client.wait(
      { ...context, ...(signal ? { signal } : {}) },
      target,
      timeoutMs,
      state,
    ),
    extract: (options) => client.extract(context, options),
    close: () => client.close(context),
  };
}

// Longer than the Native Host's 30s maximum reconnect backoff.
async function waitForExtension(timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Asking for status is also what lets the service retry a bridge that
    // could not start.
    await client.status();
    const admin = await connectRSService({ paths });
    if (admin) {
      try {
        const status = await admin.admin('status') as RSServiceStatus;
        const browser = status.rs.find(({ contract }) => contract === BROWSER_RS_CONTRACT);
        if (browser?.details.commandReady === true) return;
      } finally {
        await admin.close();
      }
    }
    await delay(200);
  }
  throw new Error(
    'PinPawo Chrome extension did not connect to the RS service. Reload the unpacked extension and retry.',
  );
}

let client = new BrowserRSClient({ paths });
let browser = smokeBrowser(client);
const fixture = await startBrowserScenarioFixture();
const reporter = new BrowserScenarioReporter('extension', 'browser-smoke-fixture');
let failure: unknown;

try {
  await runBrowserSmokeScenario({
    label: 'browser-rs-service-smoke',
    browser: () => browser,
    reporter,
    fixture,
    connect: async () => {
      // Not `start()`: the RS may be unavailable until the bridge gets its
      // socket, which waitForExtension keeps retrying.
      await client.status();
      await waitForExtension();
    },
    recovery: {
      name: 'host_restart_continuity',
      run: async () => {
        // The Host goes away; its session and page stay in the service.
        await client.dispose();
        client = new BrowserRSClient({ paths });
        browser = smokeBrowser(client);
      },
    },
  });
} catch (error) {
  failure = error;
  throw error;
} finally {
  console.log(`[browser-evaluation] ${JSON.stringify(reporter.finish(failure))}`);
  await browser.close().catch(() => {});
  await client.dispose();
  await fixture.close();
}
