import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, [
  '--import', 'tsx/esm', '--test', '--test-reporter=tap',
  'src/runtimeService/endpoint.test.ts',
  'src/runtimeService/client.test.ts',
  'src/runtimeService/server.test.ts',
  'src/runtimeService/launcher.test.ts',
  'src/runtimeService/hostClient.test.ts',
  'src/commands/runtimeService.test.ts',
  'src/toolkits/local/shellEnvironment.test.ts',
  'src/toolkits/local/windowsProcessExecutor.test.ts',
], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PINPAWO_TEST_CDP: '1' },
  stdio: 'inherit',
  timeout: 180_000,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
