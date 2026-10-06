import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileToolDefinitions } from './files';
import { createGitToolDefinitions } from './git';
import { createGithubToolDefinitions } from './github';
import { createProjectInspectionToolkit } from './projectInspection';
import { createShellToolDefinitions } from './shell';
import { PosixShellRS } from './shellRS';

test('project-inspection is the union of each Toolkit\'s declared read-only tools', () => {
  const shell = new PosixShellRS();
  const sources = [
    createFileToolDefinitions(),
    createShellToolDefinitions({ shell }),
    createGitToolDefinitions({ shell }),
    createGithubToolDefinitions({ shell }),
  ];
  const toolkit = createProjectInspectionToolkit({ shell });
  const names = toolkit.tools.map(({ tool }) => tool.name);

  assert.equal(toolkit.name, 'project-inspection');
  assert.deepEqual(names, sources.flatMap(({ inspection }) => inspection.map(({ tool }) => tool.name)));
  assert.ok(toolkit.tools.every(({ review }) => review === undefined));
  for (const expected of ['view_file_chunk', 'inspect_shell', 'get_current_time', 'git_diff', 'gh_issue_view']) {
    assert.ok(names.includes(expected), expected);
  }
  for (const forbidden of [
    'write_file', 'apply_patch', 'download_file', 'http_fetch', 'run_shell', 'start_process',
    'git_add', 'git_commit', 'git_push', 'git_shell', 'gh_pr_create', 'gh_issue_create', 'gh_shell',
  ]) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must remain outside read-only inspection`);
  }
});
