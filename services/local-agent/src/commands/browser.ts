import {
  getBrowserExtensionHostStatus,
  PINPAWO_CHROME_WEB_STORE_EXTENSION_ID,
  registerBrowserExtensionHost,
  unregisterBrowserExtensionHost,
} from '../toolkits/browser/drivers/chromeExtension/nativeHost/install';
import { existsSync } from 'node:fs';
import {
  DEFAULT_BROWSER_BRIDGE_SOCKET_PATH,
  DEFAULT_BROWSER_BRIDGE_TOKEN_PATH,
} from '../toolkits/browser/drivers/chromeExtension/bridge';

export type BrowserCommandOptions = {
  extensionId?: string;
};

export async function runBrowserCommand(
  target: string,
  action: string,
  options: BrowserCommandOptions = {},
) {
  if (target !== 'extension') {
    throw new Error(`Unknown browser integration: ${target}`);
  }
  if (action === 'register') {
    const extensionId = options.extensionId ?? PINPAWO_CHROME_WEB_STORE_EXTENSION_ID;
    const paths = await registerBrowserExtensionHost({ extensionId });
    const status = await getBrowserExtensionHostStatus();
    process.stdout.write(JSON.stringify({
      registered: true,
      extensionId,
      extensionIds: status.extensionIds,
      nativeHostEntryPath: paths.nativeHostEntryPath,
      extensionPath: status.extensionPath,
      manifests: paths.manifestPaths,
    }, null, 2) + '\n');
    return;
  }
  if (action === 'unregister') {
    const paths = await unregisterBrowserExtensionHost();
    process.stdout.write(JSON.stringify({
      registered: false,
      removedManifests: paths.manifestPaths,
    }, null, 2) + '\n');
    return;
  }
  if (action === 'status') {
    process.stdout.write(JSON.stringify({
      host: await getBrowserExtensionHostStatus(),
      runtimeFiles: {
        socketPresent: existsSync(DEFAULT_BROWSER_BRIDGE_SOCKET_PATH),
        tokenPresent: existsSync(DEFAULT_BROWSER_BRIDGE_TOKEN_PATH),
        note: 'Use the running local-agent /health endpoint for live host, extension, debugger and target state.',
      },
    }, null, 2) + '\n');
    return;
  }
  throw new Error(`Unknown browser extension action: ${action}`);
}
