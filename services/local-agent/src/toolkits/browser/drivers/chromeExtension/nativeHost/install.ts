import {
  chmod,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BROWSER_NATIVE_HOST_NAME } from '../protocol';

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const EXTENSION_ORIGIN_PATTERN = /^chrome-extension:\/\/([a-p]{32})\/$/;

export const PINPAWO_CHROME_WEB_STORE_EXTENSION_ID = 'dkbghohaagjejhckdigepccecifkbklo';

export type BrowserExtensionInstallPaths = {
  wrapperPath: string;
  manifestPaths: string[];
  nativeHostEntryPath: string;
};

export type BrowserExtensionInstallOptions = {
  extensionId?: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
  nodePath?: string;
  nativeHostEntryPath?: string;
};

export type BrowserExtensionStatus = {
  registered: boolean;
  healthy: boolean;
  repairRecommended: boolean;
  diagnostics: string[];
  extensionIds: string[];
  manifests: Array<{
    path: string;
    installed: boolean;
    valid: boolean;
    wrapperPath: string | null;
    wrapperPathMatches: boolean;
    extensionIds: string[];
  }>;
  wrapper: {
    path: string;
    exists: boolean;
    executable: boolean;
  };
  nativeHostEntry: {
    path: string;
    exists: boolean;
  };
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

async function readAllowedOrigins(path: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      allowed_origins?: unknown;
    };
    if (!Array.isArray(parsed.allowed_origins)) return [];
    return parsed.allowed_origins.filter(
      (origin): origin is string => typeof origin === 'string'
        && EXTENSION_ORIGIN_PATTERN.test(origin),
    );
  } catch {
    return [];
  }
}

async function unlinkIfPresent(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function fileStatus(path: string): Promise<{ exists: boolean; executable: boolean }> {
  try {
    const details = await stat(path);
    return {
      exists: details.isFile(),
      executable: details.isFile() && (details.mode & 0o111) !== 0,
    };
  } catch {
    return { exists: false, executable: false };
  }
}

export async function registerBrowserExtensionHost(
  options: BrowserExtensionInstallOptions = {},
): Promise<BrowserExtensionInstallPaths> {
  const extensionId = options.extensionId ?? PINPAWO_CHROME_WEB_STORE_EXTENSION_ID;
  validateExtensionId(extensionId);
  const paths = resolveBrowserExtensionInstallPaths(
    options.homeDir,
    options.platform,
    options.nativeHostEntryPath,
  );
  await mkdir(dirname(paths.wrapperPath), { recursive: true, mode: 0o700 });
  const wrapper = `#!/bin/sh\nexec ${shellQuote(options.nodePath ?? process.execPath)} ${shellQuote(paths.nativeHostEntryPath)}\n`;
  await writeFile(paths.wrapperPath, wrapper, { mode: 0o755 });
  await chmod(paths.wrapperPath, 0o755);

  const allowedOrigins = new Set<string>([
    `chrome-extension://${extensionId}/`,
  ]);
  for (const manifestPath of paths.manifestPaths) {
    for (const origin of await readAllowedOrigins(manifestPath)) {
      allowedOrigins.add(origin);
    }
  }
  const manifest = JSON.stringify({
    name: BROWSER_NATIVE_HOST_NAME,
    description: 'PinPawo Chrome extension native messaging bridge',
    path: paths.wrapperPath,
    type: 'stdio',
    allowed_origins: [...allowedOrigins].sort(),
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
        name?: unknown;
        path?: unknown;
        type?: unknown;
        allowed_origins?: unknown;
      };
      const manifestExtensionIds: string[] = [];
      if (Array.isArray(parsed.allowed_origins)) {
        for (const origin of parsed.allowed_origins) {
          const match = typeof origin === 'string'
            ? EXTENSION_ORIGIN_PATTERN.exec(origin)
            : null;
          if (match?.[1]) {
            extensionIds.add(match[1]);
            manifestExtensionIds.push(match[1]);
          }
        }
      }
      const wrapperPath = typeof parsed.path === 'string' ? parsed.path : null;
      return {
        path: manifestPath,
        installed: true,
        valid: parsed.name === BROWSER_NATIVE_HOST_NAME && parsed.type === 'stdio',
        wrapperPath,
        wrapperPathMatches: wrapperPath === paths.wrapperPath,
        extensionIds: manifestExtensionIds.sort(),
      };
    } catch {
      return {
        path: manifestPath,
        installed: false,
        valid: false,
        wrapperPath: null,
        wrapperPathMatches: false,
        extensionIds: [],
      };
    }
  }));
  const [wrapper, nativeHostEntry] = await Promise.all([
    fileStatus(paths.wrapperPath),
    fileStatus(paths.nativeHostEntryPath),
  ]);
  const usableManifest = manifests.some((manifest) => manifest.installed
    && manifest.valid
    && manifest.wrapperPathMatches
    && manifest.extensionIds.length > 0);
  const diagnostics: string[] = [];
  if (!wrapper.exists) diagnostics.push('native_host_wrapper_missing');
  else if (!wrapper.executable) diagnostics.push('native_host_wrapper_not_executable');
  if (!nativeHostEntry.exists) diagnostics.push('native_host_entry_missing');
  if (!usableManifest) diagnostics.push('no_usable_native_host_manifest');
  return {
    registered: manifests.some((manifest) => manifest.installed),
    healthy: wrapper.exists && wrapper.executable && nativeHostEntry.exists && usableManifest,
    repairRecommended: !(wrapper.exists && wrapper.executable && nativeHostEntry.exists && usableManifest),
    diagnostics,
    extensionIds: [...extensionIds],
    manifests,
    wrapper: {
      path: paths.wrapperPath,
      ...wrapper,
    },
    nativeHostEntry: {
      path: paths.nativeHostEntryPath,
      exists: nativeHostEntry.exists,
    },
    nativeHostEntryPath: paths.nativeHostEntryPath,
    extensionPath: resolve(dirname(paths.nativeHostEntryPath), 'chrome-extension'),
    extensionBuilt: existsSync(resolve(dirname(paths.nativeHostEntryPath), 'chrome-extension', 'manifest.json')),
  };
}
