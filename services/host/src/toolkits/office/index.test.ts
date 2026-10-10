import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createOfficeToolkit, officeEnabled, resolveOfficeExecutable } from './index';
import { PosixShellRS } from '../shellRS/posixShellRS';
import type { ShellRS, ShellExecRequest } from '../shellRS/shellRS';

const scope = { context: { executionScope: { threadId: 'office-test', taskId: 'task', runId: 'run', delegationId: 'delegation' } } };

test('Office requires explicit opt in', () => {
  assert.equal(officeEnabled({}), false);
  assert.equal(officeEnabled({ capabilities: { office: false } }), false);
  assert.equal(officeEnabled({ capabilities: { office: true } }), true);
  assert.equal(officeEnabled({ capabilities: { office: true } }, false), false);
});

test('missing dependency has an explicit unavailable reason', async () => {
  const shell = new PosixShellRS();
  try {
    const toolkit = createOfficeToolkit({ shell, executable: '/missing/officecli' });
    const status = await toolkit.availability!();
    assert.equal(status.available, false);
    if (!status.available) assert.match(status.reason, /OfficeCLI is missing/);
    await assert.rejects(toolkit.tools[0]!.tool.invoke({ command: 'create', args: ['demo.docx'] }, scope), /requires iOfficeAI/);
    assert.equal(resolveOfficeExecutable('relative/binary'), null);
  } finally { await shell.dispose(); }
});

test('argv preserves spaces and shell metacharacters; failures remain structured', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'office toolkit '));
  const executable = join(directory, 'office cli');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o700);
  let request: ShellExecRequest | undefined;
  const shell: ShellRS = {
    contract: 'pinpawo.shell-rs', version: 1, status: () => ({ available: true }), ensureSession: () => {},
    exec: async (_id, input) => { request = input; return { status: 'exited', code: 7, stdout: 'partial', stderr: 'failure' }; },
    wait: async () => { throw new Error(); }, read: async () => { throw new Error(); },
    terminate: async () => { throw new Error(); }, list: async () => [],
  };
  try {
    const toolkit = createOfficeToolkit({ shell, executable });
    assert.equal((await toolkit.availability!()).available, true);
    assert.ok(toolkit.tools[0]!.review);
    const args = ['file with spaces.docx', '/', '--prop', 'text=$(touch nope); hello'];
    const result = JSON.parse(String(await toolkit.tools[0]!.tool.invoke({ command: 'add', args, cwd: directory }, scope)));
    assert.deepEqual(request!.command, { argv: [realpathSync(executable), 'add', ...args] });
    assert.equal(request!.cwd, directory);
    assert.deepEqual(request!.env, { OFFICECLI_NO_AUTO_INSTALL: '1', OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_RESIDENT: '1' });
    assert.equal(request!.onTimeout, 'terminate');
    assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7);
    await assert.rejects(toolkit.tools[0]!.tool.invoke({ command: 'install' }, scope));
    shell.exec = async () => ({ status: 'aborted', stdout: '', stderr: '' });
    await assert.rejects(toolkit.tools[0]!.tool.invoke({ command: 'help' }, scope), (error: Error) => error.name === 'AbortError');
    shell.exec = async () => ({ status: 'timeout', termination: 'confirmed', stdout: '', stderr: '' });
    assert.equal(JSON.parse(String(await toolkit.tools[0]!.tool.invoke({ command: 'help' }, scope))).termination, 'confirmed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real ShellRS subprocess preserves argv with a spaced executable and output file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'office process '));
  const executable = join(directory, 'office fixture');
  const output = join(directory, 'output text.txt');
  // A local transport fixture, not OfficeCLI and not a format roundtrip.
  writeFileSync(executable, '#!/bin/sh\nprintf "%s" "$3" > "$2"\ncat "$2"\n');
  chmodSync(executable, 0o700);
  const shell = new PosixShellRS();
  try {
    const toolkit = createOfficeToolkit({ shell, executable });
    const result = JSON.parse(String(await toolkit.tools[0]!.tool.invoke({
      command: 'create', args: [output, 'Hello 中文 $(no execution)'], cwd: directory,
    }, scope)));
    assert.equal(result.status, 'ok');
    assert.equal(result.stdout, 'Hello 中文 $(no execution)');
  } finally { await shell.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test('official npm shim never triggers a lazy download; requires installed vendor binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'office npm '));
  const shim = join(root, 'officecli.js');
  writeFileSync(shim, '#!/usr/bin/env node\nthrow new Error("must never execute installer");');
  chmodSync(shim, 0o700);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@officecli/officecli' }));
  try {
    assert.equal(resolveOfficeExecutable(shim), null);
    mkdirSync(join(root, 'vendor'));
    const native = join(root, 'vendor', 'officecli');
    writeFileSync(native, '#!/bin/sh\nexit 0\n'); chmodSync(native, 0o700);
    assert.equal(resolveOfficeExecutable(shim), realpathSync(native));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Office execution requires human-review support and shows argv/cwd in review', async () => {
  const shell = new PosixShellRS();
  try {
    const definition = createOfficeToolkit({ shell }).tools[0]!;
    const context = {
      toolkitName: 'office', toolName: 'office_cli',
      input: { command: 'set', args: ['Report File.docx', '/body', '--prop', 'text=hello'], cwd: '/project' },
      operation: definition.operation,
    };
    const blocked = await definition.review!.request({ ...context, reviewCapabilities: { humanReview: false, sessionAuthorization: false } });
    assert.ok(blocked && 'type' in blocked && blocked.type === 'block');
    const review = await definition.review!.request({ ...context, reviewCapabilities: { humanReview: true, sessionAuthorization: true } });
    assert.ok(review && 'schemaVersion' in review);
    if (review && 'schemaVersion' in review && review.view.kind === 'plain') {
      assert.match(review.view.body, /Report File.docx/);
      assert.match(review.view.body, /\/project/);
    }
  } finally { await shell.dispose(); }
});

test('actual Office tool timeout and cancellation reap the started process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'office cleanup '));
  const executable = join(directory, 'office fixture');
  writeFileSync(executable, '#!/bin/sh\necho $$ > "$2"\nexec /bin/sleep 30\n');
  chmodSync(executable, 0o700);
  const shell = new PosixShellRS();
  try {
    const tool = createOfficeToolkit({ shell, executable }).tools[0]!.tool;
    const timedPid = join(directory, 'timed.pid');
    const result = JSON.parse(String(await tool.invoke({ command: 'create', args: [timedPid], timeoutSeconds: 1 }, scope)));
    assert.equal(result.status, 'timeout');
    assert.equal(result.termination, 'confirmed');
    assert.throws(() => process.kill(Number(readFileSync(timedPid, 'utf8')), 0));
    const abortedPid = join(directory, 'aborted.pid');
    const controller = new AbortController();
    const pending = tool.invoke({ command: 'create', args: [abortedPid] }, { ...scope, signal: controller.signal });
    // Attach rejection observation before aborting the call.
    const rejected = assert.rejects(pending, (error: Error) => error.name === 'AbortError');
    for (let attempt = 0; attempt < 200 && !existsSync(abortedPid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(abortedPid));
    controller.abort();
    await rejected;
    const pid = Number(readFileSync(abortedPid, 'utf8'));
    // LangChain may reject on AbortSignal before ShellRS finishes cleanup.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(pid, 0));
  } finally { await shell.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
