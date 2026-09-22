import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--test', 'src/cdp.integration.test.ts'], {
  cwd: new URL('..', import.meta.url),
  env: { ...process.env, PINPAWO_TEST_CDP: '1' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
