import {
  chmod,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROWSER_NATIVE_HOST_NAME } from '../protocol';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

export type BrowserExtensionInstallPaths = {
  wrapperPath: string;
  manifestPaths: string[];
  nativeHostEntryPath: string;
};

export type BrowserExtensionInstallOptions = {
  extensionId: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  nativeHostEntryPath?: string;
};

export type BrowserExtensionStatus = {
  registered: boolean;
  extensionIds: string[];
  manifests: Array<{ path: string; installed: boolean }>;
  nativeHostEntryPath: string;
  extensionPath: string;
  extensionBuilt: boolean;
};

function defaultNativeHostEntryPath(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, 'native-host.js'),
    resolve(process.cwd(), 'dist', 'native-host.js'),
    resolve(process.cwd(), 'services', 'local-agent', 'dist', 'native-host.js'),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function resolveBrowserExtensionInstallPaths(
  homeDir = homedir(),
  currentPlatform = platform(),
  nativeHostEntryPath = defaultNativeHostEntryPath(),
): BrowserExtensionInstallPaths {
  const manifestName = `${BROWSER_NATIVE_HOST_NAME}.json`;
  let manifestPaths: string[];
  if (currentPlatform === 'darwin') {
    manifestPaths = [
      resolve(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', manifestName),
      resolve(homeDir, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts', manifestName),
    ];
  } else if (currentPlatform === 'linux') {
    manifestPaths = [
      resolve(homeDir, '.config', 'google-chrome', 'NativeMessagingHosts', manifestName),
      resolve(homeDir, '.config', 'chromium', 'NativeMessagingHosts', manifestName),
    ];
  } else {
    throw new Error('Chrome extension driver registration currently supports macOS and Linux');
  }
  return {
    wrapperPath: resolve(homeDir, '.pinpawo', 'native-host', 'pinpawo-browser-native-host'),
    manifestPaths,
    nativeHostEntryPath,
  };
}

function validateExtensionId(extensionId: string) {
  if (!EXTENSION_ID_PATTERN.test(extensionId)) {
    throw new Error('Chrome extension ID must be 32 lowercase letters in the range a-p');
  }
}

async function unlinkIfPresent(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function registerBrowserExtensionHost(
  options: BrowserExtensionInstallOptions,
): Promise<BrowserExtensionInstallPaths> {
  validateExtensionId(options.extensionId);
  const paths = resolveBrowserExtensionInstallPaths(
    options.homeDir,
    options.platform,
    options.nativeHostEntryPath,
  );
  await mkdir(dirname(paths.wrapperPath), { recursive: true, mode: 0o700 });
  const wrapper = `#!/bin/sh\nexec ${shellQuote(options.nodePath ?? process.execPath)} ${shellQuote(paths.nativeHostEntryPath)}\n`;
  await writeFile(paths.wrapperPath, wrapper, { mode: 0o755 });
  await chmod(paths.wrapperPath, 0o755);

  const manifest = JSON.stringify({
    name: BROWSER_NATIVE_HOST_NAME,
    description: 'PinPawo Chrome extension native messaging bridge',
    path: paths.wrapperPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${options.extensionId}/`],
  }, null, 2) + '\n';
  for (const manifestPath of paths.manifestPaths) {
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, manifest, { mode: 0o600 });
  }
  return paths;
}

export async function unregisterBrowserExtensionHost(
  options: Omit<BrowserExtensionInstallOptions, 'extensionId'> = {},
): Promise<BrowserExtensionInstallPaths> {
  const paths = resolveBrowserExtensionInstallPaths(
    options.homeDir,
    options.platform,
    options.nativeHostEntryPath,
  );
  await Promise.all(paths.manifestPaths.map(unlinkIfPresent));
  await unlinkIfPresent(paths.wrapperPath);
  return paths;
}

export async function getBrowserExtensionHostStatus(
  options: Omit<BrowserExtensionInstallOptions, 'extensionId'> = {},
): Promise<BrowserExtensionStatus> {
  const paths = resolveBrowserExtensionInstallPaths(
    options.homeDir,
    options.platform,
    options.nativeHostEntryPath,
  );
  const extensionIds = new Set<string>();
  const manifests = await Promise.all(paths.manifestPaths.map(async (manifestPath) => {
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        allowed_origins?: unknown;
      };
      if (Array.isArray(parsed.allowed_origins)) {
        for (const origin of parsed.allowed_origins) {
          const match = typeof origin === 'string'
            ? /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin)
            : null;
          if (match?.[1]) extensionIds.add(match[1]);
        }
      }
      return { path: manifestPath, installed: true };
    } catch {
      return { path: manifestPath, installed: false };
    }
  }));
  return {
    registered: manifests.some((manifest) => manifest.installed),
    extensionIds: [...extensionIds],
    manifests,
    nativeHostEntryPath: paths.nativeHostEntryPath,
    extensionPath: resolve(dirname(paths.nativeHostEntryPath), 'chrome-extension'),
    extensionBuilt: existsSync(resolve(dirname(paths.nativeHostEntryPath), 'chrome-extension', 'manifest.json')),
  };
}
