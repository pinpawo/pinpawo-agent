import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { runtimeServicePaths } from '../runtimeService/config';
import { startRuntimeService } from '../runtimeService/server';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../index.ts', import.meta.url));

for (const envLocation of ['home', 'workdir'] as const) {
  test(`runtime status uses PINPAWO_RUNTIME_DIR from the ${envLocation} .env without model configuration`, {
    timeout: 20_000,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pinpawo-runtime-cli-'));
    const testHome = join(root, 'home');
    const workdir = join(root, 'project');
    const directory = join(root, 'configured-runtime');
    const paths = runtimeServicePaths(directory);
    let service: Awaited<ReturnType<typeof startRuntimeService>> | undefined;
    try {
      await Promise.all([mkdir(join(testHome, '.pinpawo'), { recursive: true }), mkdir(workdir), mkdir(directory)]);
      const token = 'a'.repeat(64);
      await writeFile(paths.token, token, { mode: 0o600 });
      await writeFile(envLocation === 'home' ? join(testHome, '.pinpawo', '.env') : join(workdir, '.env'),
        `PINPAWO_RUNTIME_DIR=${directory}\n`);
      service = await startRuntimeService({
        endpoint: paths.endpoint, token, config: { instances: {}, toolkitBindings: {} }, factories: {},
      });
      const childEnvironment: NodeJS.ProcessEnv = { ...process.env, HOME: testHome, USERPROFILE: testHome };
      delete childEnvironment.PINPAWO_RUNTIME_DIR;
      const { stdout } = await run(process.execPath, [
        '--import', import.meta.resolve('tsx/esm'), cli, 'runtime', 'status',
      ], { cwd: workdir, env: childEnvironment, timeout: 15_000 });
      const status = JSON.parse(stdout) as { pid: number; instances: unknown[] };
      assert.equal(status.pid, process.pid, 'The CLI must connect to the service selected only by .env.');
      assert.deepEqual(status.instances, []);
    } finally {
      await service?.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}
