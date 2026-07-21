import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  getBrowserExtensionHostStatus,
  registerBrowserExtensionHost,
  unregisterBrowserExtensionHost,
} from './install';

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

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
