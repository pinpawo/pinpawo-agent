import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getConfig,
  setConfig,
} from './config';
import { LocalAgentHost } from './runtime';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';

test('requestStop ends runForever promptly', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-runtime-stop-'));
  const originalConfig = getConfig();
  const runtime = new LocalAgentHost(
    buildLocalAgentRuntimeConfig(workdir),
  );
  try {
    const running = runtime.runForever({ skipInit: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    runtime.requestStop();
    await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('runtime did not stop within 1 second'));
        }, 1_000).unref();
      }),
    ]);
  } finally {
    runtime.requestStop();
    setConfig(originalConfig);
    rmSync(workdir, { recursive: true, force: true });
  }
});
