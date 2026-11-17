import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../../scripts/headDecisionEval.ts', import.meta.url));
test('Manual Head runner rejects missing opt-in, excessive trials and unknown cases before profile resolution', () => {
  for (const args of [[], ['--live', '--profile', 'synthetic', '--repeats', '3', '--output', '/tmp/not-written-head-eval.json'], ['--live', '--profile', 'synthetic', '--cases', 'not-a-case', '--output', '/tmp/not-written-head-eval.json']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('check arguments'), true);
    assert.equal(result.stderr.includes('synthetic'), false);
  }
});
