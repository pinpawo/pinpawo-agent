import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  getBrowserExtensionHostStatus,
  PINPAWO_CHROME_WEB_STORE_EXTENSION_ID,
  registerBrowserExtensionHost,
  unregisterBrowserExtensionHost,
} from './install';
import { BROWSER_NATIVE_HOST_NAME } from '../protocol';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const SECOND_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

test('native host registration writes exact-origin manifests and an executable wrapper', async () => {
  const homeDir = await mkdtemp(resolve(tmpdir(), 'pinpawo-extension-install-'));
  const nativeHostEntryPath = resolve(homeDir, 'package', 'dist', 'native-host.js');
  await mkdir(resolve(homeDir, 'package', 'dist'), { recursive: true });
  await writeFile(nativeHostEntryPath, '# native host\n');
  const options = {
    extensionId: EXTENSION_ID,
    homeDir,
    platform: 'darwin' as const,
    nodePath: '/path with spaces/node',
    nativeHostEntryPath,
  };
  const paths = await registerBrowserExtensionHost(options);
  const wrapper = await readFile(paths.wrapperPath, 'utf8');
  assert.match(wrapper, new RegExp(`exec '/path with spaces/node' '${nativeHostEntryPath}'`));

  const manifest = JSON.parse(await readFile(paths.manifestPaths[0]!, 'utf8')) as {
    allowed_origins: string[];
    path: string;
  };
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(manifest.path, paths.wrapperPath);

  const status = await getBrowserExtensionHostStatus(options);
  assert.equal(status.registered, true);
  assert.equal(status.healthy, true);
  assert.equal(status.repairRecommended, false);
  assert.deepEqual(status.extensionIds, [EXTENSION_ID]);

  await unregisterBrowserExtensionHost(options);
  assert.equal((await getBrowserExtensionHostStatus(options)).registered, false);
});

test('native host status identifies registration drift that repair can restore', async () => {
  const homeDir = await mkdtemp(resolve(tmpdir(), 'pinpawo-extension-install-'));
  const nativeHostEntryPath = resolve(homeDir, 'package', 'dist', 'native-host.js');
  await mkdir(resolve(homeDir, 'package', 'dist'), { recursive: true });
  await writeFile(nativeHostEntryPath, '# native host\n');
  const options = {
    extensionId: EXTENSION_ID,
    homeDir,
    platform: 'darwin' as const,
    nodePath: '/node',
    nativeHostEntryPath,
  };
  const paths = await registerBrowserExtensionHost(options);
  await chmod(paths.wrapperPath, 0o600);
  await writeFile(paths.manifestPaths[0]!, JSON.stringify({
    name: BROWSER_NATIVE_HOST_NAME,
    path: '/stale/wrapper',
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  }));

  const status = await getBrowserExtensionHostStatus(options);
  assert.equal(status.registered, true);
  assert.equal(status.healthy, false);
  assert.equal(status.repairRecommended, true);
  assert.deepEqual(status.diagnostics, ['native_host_wrapper_not_executable']);
  assert.equal(status.manifests[0]!.wrapperPathMatches, false);

  await registerBrowserExtensionHost(options);
  assert.equal((await getBrowserExtensionHostStatus(options)).healthy, true);
});

test('native host registration rejects non-Chrome extension IDs', async () => {
  await assert.rejects(
    registerBrowserExtensionHost({ extensionId: 'not-an-extension-id' }),
    /32 lowercase letters/,
  );
});

test('native host registration defaults to the Web Store ID and preserves dev IDs', async () => {
  const homeDir = await mkdtemp(resolve(tmpdir(), 'pinpawo-extension-install-'));
  const baseOptions = {
    homeDir,
    platform: 'darwin' as const,
    nodePath: '/node',
    nativeHostEntryPath: '/package/dist/native-host.js',
  };
  await registerBrowserExtensionHost({
    ...baseOptions,
    extensionId: SECOND_EXTENSION_ID,
  });
  const paths = await registerBrowserExtensionHost(baseOptions);
  const manifest = JSON.parse(await readFile(paths.manifestPaths[0]!, 'utf8')) as {
    allowed_origins: string[];
  };
  assert.deepEqual(manifest.allowed_origins, [
    `chrome-extension://${PINPAWO_CHROME_WEB_STORE_EXTENSION_ID}/`,
    `chrome-extension://${SECOND_EXTENSION_ID}/`,
  ].sort());

  const status = await getBrowserExtensionHostStatus(baseOptions);
  assert.deepEqual(status.extensionIds.sort(), [
    PINPAWO_CHROME_WEB_STORE_EXTENSION_ID,
    SECOND_EXTENSION_ID,
  ].sort());
});
