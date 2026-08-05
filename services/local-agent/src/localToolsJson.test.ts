import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import type { AgentToolkit } from '@pinpawo/pet-agent';
import { createBashToolkit } from './toolkits/local';
import { runJqProcess, runJqQuery } from './toolkits/local/jsonTools';

function definition(toolkit: AgentToolkit, toolName: string) {
  return toolkit.tools.find((item) => item.tool.name === toolName);
}

test('bash toolkit exposes jq_query as a read-only operation', () => {
  const definitionItem = definition(createBashToolkit(), 'jq_query');
  assert.ok(definitionItem?.operation);
  assert.equal(definitionItem?.review, undefined);
});

test('jq_query invokes jq without forwarding the agent environment', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-jq-query-'));
  const filePath = resolve(root, 'trace.json');
  writeFileSync(filePath, '{"runs":[1,2,3]}', 'utf-8');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invocations: Array<{
    file: string;
    args: string[];
    env: Record<string, string>;
  }> = [];

  const output = await runJqQuery({
    path: filePath,
    filter: '.runs | length',
  }, async (file, args, options) => {
    invocations.push({ file, args, env: options.env });
    return { stdout: '3\n', stderr: '' };
  });

  assert.equal(output, '3');
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.equal(invocation.file, 'jq');
  assert.deepEqual(invocation.args, [
    '--monochrome-output',
    '--compact-output',
    '--',
    '.runs | length',
    filePath,
  ]);
  assert.deepEqual(Object.keys(invocation.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
});

test('jq_query rejects directories before invoking jq', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-jq-query-dir-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let calls = 0;

  const output = await runJqQuery({ path: root, filter: '.' }, async () => {
    calls += 1;
    return { stdout: '', stderr: '' };
  });

  assert.match(output, /not a file/);
  assert.equal(calls, 0);
});

test('jq_query returns a truncation marker for streamed output beyond its preview', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'pinpawo-jq-query-large-'));
  const filePath = resolve(root, 'trace.json');
  writeFileSync(filePath, '{}', 'utf-8');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const output = await runJqQuery({ path: filePath, filter: '.' }, async () => ({
    stdout: 'x'.repeat(50_000),
    stderr: '',
    stdoutTotalChars: 5 * 1024 * 1024,
  }));

  assert.match(output, /^x{50000}\n\[truncated 5192880 chars\]$/);
});

test('jq process drains large output while retaining a bounded preview', async () => {
  const outputChars = 5 * 1024 * 1024;
  const result = await runJqProcess(process.execPath, [
    '-e',
    `process.stdout.write('x'.repeat(${outputChars.toString()}))`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    env: {},
    timeout: 30_000,
  });

  assert.equal(String(result.stdout).length, 50_000);
  assert.equal(result.stdoutTotalChars, outputChars);
  assert.equal(result.stderr, '');
});
