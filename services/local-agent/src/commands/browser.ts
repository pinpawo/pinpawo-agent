import {
  DEFAULT_BROWSER_BRIDGE_SOCKET_PATH,
  DEFAULT_BROWSER_BRIDGE_TOKEN_PATH,
  getBrowserExtensionHostStatus,
  PINPAWO_CHROME_WEB_STORE_EXTENSION_ID,
  registerBrowserExtensionHost,
  unregisterBrowserExtensionHost,
} from '@pinpawo-toolkit/browser';
import { existsSync } from 'node:fs';

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
  if (action === 'register' || action === 'repair') {
    const extensionId = options.extensionId ?? PINPAWO_CHROME_WEB_STORE_EXTENSION_ID;
    const paths = await registerBrowserExtensionHost({ extensionId });
    const status = await getBrowserExtensionHostStatus();
    process.stdout.write(JSON.stringify({
      registered: true,
      repaired: action === 'repair',
      healthy: status.healthy,
      diagnostics: status.diagnostics,
      extensionId,
      extensionIds: status.extensionIds,
      nativeHostEntryPath: paths.nativeHostEntryPath,
      bundledExtensionPath: status.bundledExtensionPath,
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
        note: 'These files only show whether a running local-agent has created its bridge runtime; they do not prove that an extension is connected.',
      },
    }, null, 2) + '\n');
    return;
  }
  throw new Error(`Unknown browser extension action: ${action}`);
}
