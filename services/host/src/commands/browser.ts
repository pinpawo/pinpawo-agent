import {
  BROWSER_RS_CONTRACT,
  DEFAULT_BROWSER_BRIDGE_SOCKET_PATH,
  DEFAULT_BROWSER_BRIDGE_TOKEN_PATH,
  getBrowserExtensionHostStatus,
  PINPAWO_CHROME_WEB_STORE_EXTENSION_ID,
  registerBrowserExtensionHost,
  unregisterBrowserExtensionHost,
} from '@pinpawo-toolkit/browser';
import { existsSync } from 'node:fs';
import { connectRSService } from '../rsService/launcher';
import { resolveRSServicePaths, type RSServicePaths } from '../rsService/paths';
import type { RSServiceStatus } from '../rsService/server';

export type BrowserCommandOptions = {
  extensionId?: string;
};

async function readBrowserServiceStatus(paths: RSServicePaths = resolveRSServicePaths()) {
  const admin = await connectRSService({ paths });
  if (!admin) return { running: false };
  try {
    const status = await admin.admin('status') as RSServiceStatus;
    const browser = status.rs.find(({ contract }) => contract === BROWSER_RS_CONTRACT);
    return { running: true, pid: status.pid, browser: browser?.details ?? null };
  } finally {
    await admin.close();
  }
}

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
      // The bridge lives in the RS service (#862); ask it rather than infer
      // from files. Management never starts the service.
      service: await readBrowserServiceStatus(),
      runtimeFiles: {
        socketPresent: existsSync(DEFAULT_BROWSER_BRIDGE_SOCKET_PATH),
        tokenPresent: existsSync(DEFAULT_BROWSER_BRIDGE_TOKEN_PATH),
      },
    }, null, 2) + '\n');
    return;
  }
  throw new Error(`Unknown browser extension action: ${action}`);
}
