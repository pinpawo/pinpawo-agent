import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileAgentRegistry, defineInstructionDocument, type AgentToolkit } from '@pinpawo/pet-agent';
import { createGithubToolkit } from '../github';
import { createShellToolkit } from '../shell';
import { PosixShellRS } from '../shellRS';
import type { ShellRS } from '../shellRS/shellRS';
import { createGitToolkit } from './index';
import { createGitTools } from './gitTools';

const sessionContext = {
  executionScope: {
    threadId: 'thread-git', taskId: 'task-1', runId: 'run-1', delegationId: 'delegation-1',
  },
};

/** Tools run through ShellRS on behalf of an Agent session. */
function sessionTool(name: string) {
  const found = createGitTools(new PosixShellRS()).find((item) => item.name === name);
  assert.ok(found, `missing ${name}`);
  return {
    invoke: (input: Record<string, unknown>, config: Record<string, unknown> = {}) => found.invoke(
      input as never,
      { ...config, context: sessionContext },
    ),
  };
}

function definition(toolkit: AgentToolkit, toolName: string) {
  return toolkit.tools.find((item) => item.tool.name === toolName);
}

const gitAddTool = sessionTool('git_add');
const gitCommitTool = sessionTool('git_commit');
const gitPushTool = sessionTool('git_push');

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-git-tools-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'PinPawo Test'], { cwd: dir });
  return dir;
}

test('git tools stage and commit without shell command strings or an editor', async () => {
  const repo = createRepo();
  writeFileSync(join(repo, 'README.md'), 'hello\n', 'utf-8');

  assert.match(
    String(await gitAddTool.invoke({ cwd: repo, pathspecs: ['README.md'] })),
    /\(no output\)/,
  );
  assert.match(
    execFileSync('git', ['diff', '--cached', '--stat'], { cwd: repo, encoding: 'utf-8' }),
    /README\.md/,
  );
  assert.match(
    String(await gitCommitTool.invoke({ cwd: repo, message: 'test: add readme' })),
    /test: add readme/,
  );
});

test('git_add requires explicit pathspecs', async () => {
  await assert.rejects(
    () => gitAddTool.invoke({ pathspecs: [] }),
    /Too small|at least/,
  );
});

test('git_push performs a normal push without exposing force or delete options', async (t) => {
  const repo = createRepo();
  const remote = mkdtempSync(join(tmpdir(), 'pinpawo-git-remote-'));
  const extMarker = join(repo, 'ext-helper-ran');
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  writeFileSync(join(repo, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'test: initial commit'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['init', '--bare'], { cwd: remote, stdio: 'ignore' });
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf-8' }).trim();

  assert.match(
    String(await gitPushTool.invoke({ cwd: repo, remote })),
    /new branch/,
  );
  assert.equal(
    execFileSync('git', ['rev-parse', `refs/heads/${branch}`], { cwd: remote, encoding: 'utf-8' }).trim().length,
    40,
  );
  await assert.rejects(
    () => gitPushTool.invoke({ cwd: repo, remote, refspec: '+HEAD:main' }),
    /force and delete refspecs are not supported/,
  );

  assert.match(
    String(await gitPushTool.invoke({
      cwd: repo,
      remote: `ext::touch ${extMarker}`,
    })),
    /transport 'ext' not allowed/,
  );
  assert.equal(existsSync(extMarker), false);

  execFileSync('git', ['remote', 'add', 'unsafe-ext', `ext::touch ${extMarker}`], { cwd: repo });
  assert.match(
    String(await gitPushTool.invoke({ cwd: repo, remote: 'unsafe-ext' })),
    /transport 'ext' not allowed/,
  );
  assert.equal(existsSync(extMarker), false);
});

test('createGitToolkit exposes only schema-bounded writes, all unreviewed', () => {
  const toolkit = createGitToolkit({ shell: new PosixShellRS() });
  assert.equal(toolkit.name, 'git');
  assert.deepEqual(toolkit.tools.map((item) => item.tool.name), ['git_add', 'git_commit', 'git_push']);
  assert.equal(definition(toolkit, 'git_commit')?.operation?.title, '创建 git commit');
  assert.equal(definition(toolkit, 'git_push')?.operation?.title, '推送 git 分支');
  for (const name of ['git_add', 'git_commit', 'git_push']) {
    assert.equal(definition(toolkit, name)?.review, undefined, `${name} runs without review`);
  }
});

test('git ended by a signal reports an error, not an empty success', async () => {
  // ShellRS reports a signal-terminated process as exited with no code.
  const shell: ShellRS = {
    contract: 'pinpawo.shell-rs',
    version: 1,
    status: () => ({ available: true }),
    ensureSession: () => undefined,
    exec: async () => ({ status: 'exited', code: null, stdout: '', stderr: '' }),
    wait: async () => { throw new Error('unused'); },
    read: async () => { throw new Error('unused'); },
    terminate: async () => { throw new Error('unused'); },
    list: async () => [],
  };
  const gitCommit = createGitTools(shell).find((item) => item.name === 'git_commit')!;
  assert.equal(
    await gitCommit.invoke({ message: 'x' } as never, { context: sessionContext }),
    'Error: git commit was terminated by a signal',
  );
});

test('git and github alone grant only their write tools; reads need an explicit shell', () => {
  const shell = new PosixShellRS();
  const capability = (name: string, uses: string[]) => ({
    name,
    description: name,
    uses,
    instructions: defineInstructionDocument({ content: `# ${name}` }),
  });
  const registry = compileAgentRegistry({
    toolkits: [createShellToolkit({ shell }), createGitToolkit({ shell }), createGithubToolkit({ shell })],
    capabilities: [
      capability('git_only', ['git']),
      capability('github_only', ['github']),
      capability('git_with_shell', ['git', 'shell']),
    ],
  });
  const toolNames = (name: string) => registry.capabilities.find((item) => item.capability.name === name)?.toolNames;

  assert.deepEqual(registry.unavailableCapabilities, []);
  // Old Capabilities still compile, but are never silently widened to shell.
  assert.deepEqual(toolNames('git_only'), ['git_add', 'git_commit', 'git_push']);
  assert.deepEqual(toolNames('github_only'), ['gh_pr_create', 'gh_issue_create']);
  assert.ok(toolNames('git_with_shell')?.includes('inspect_shell'));
});
