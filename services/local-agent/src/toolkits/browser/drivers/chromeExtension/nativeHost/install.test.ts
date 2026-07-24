import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  getBrowserExtensionHostStatus,
  PINPAWO_CHROME_WEB_STORE_EXTENSION_ID,
  registerBrowserExtensionHost,
  unregisterBrowserExtensionHost,
} from './install';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const SECOND_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

test('native host registration writes exact-origin manifests and an executable wrapper', async () => {
  const homeDir = await mkdtemp(resolve(tmpdir(), 'pinpawo-extension-install-'));
  const options = {
    extensionId: EXTENSION_ID,
    homeDir,
    platform: 'darwin' as const,
    nodePath: '/path with spaces/node',
    nativeHostEntryPath: '/package/dist/native-host.js',
  };
  const paths = await registerBrowserExtensionHost(options);
  const wrapper = await readFile(paths.wrapperPath, 'utf8');
  assert.match(wrapper, /exec '\/path with spaces\/node' '\/package\/dist\/native-host\.js'/);

  const manifest = JSON.parse(await readFile(paths.manifestPaths[0]!, 'utf8')) as {
    allowed_origins: string[];
    path: string;
  };
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(manifest.path, paths.wrapperPath);

  const status = await getBrowserExtensionHostStatus(options);
  assert.equal(status.registered, true);
  assert.deepEqual(status.extensionIds, [EXTENSION_ID]);

  await unregisterBrowserExtensionHost(options);
  assert.equal((await getBrowserExtensionHostStatus(options)).registered, false);
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
