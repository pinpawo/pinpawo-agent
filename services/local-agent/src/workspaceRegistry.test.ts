import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachWorkspaceConfig, buildLocalAgentRuntimeConfig } from './runtimeConfig';
import {
  listWorkspaceEntries,
  loadWorkspaceRegistry,
  selectWorkspaceEntry,
  upsertWorkspaceEntry,
} from './workspaceRegistry';

test('workspace registry lists the active runtime workspace even when registry is empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-workspaces-'));
  const registryPath = join(root, 'workspaces.json');
  const runtimeConfig = attachWorkspaceConfig(
    buildLocalAgentRuntimeConfig(join(root, 'active')),
    { workspaceId: 'active-workspace', workspaceName: 'Active Workspace' },
  );

  const workspaces = listWorkspaceEntries({ runtimeConfig, registryPath });

  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]?.id, 'active-workspace');
  assert.equal(workspaces[0]?.name, 'Active Workspace');
  assert.equal(workspaces[0]?.rootPath, join(root, 'active'));
  assert.equal(workspaces[0]?.active, true);
});

test('workspace registry upserts and selects registered workspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-workspaces-'));
  const registryPath = join(root, 'workspaces.json');

  const first = upsertWorkspaceEntry({
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: join(root, 'a'),
    registryPath,
    now: '2026-07-02T00:00:00.000Z',
  });
  upsertWorkspaceEntry({
    id: 'workspace-b',
    name: 'Workspace B',
    rootPath: join(root, 'b'),
    registryPath,
    now: '2026-07-02T00:01:00.000Z',
  });
  const selected = selectWorkspaceEntry({
    workspaceId: 'workspace-a',
    registryPath,
    now: '2026-07-02T00:02:00.000Z',
  });

  assert.equal(first.createdAt, '2026-07-02T00:00:00.000Z');
  assert.equal(selected.lastOpenedAt, '2026-07-02T00:02:00.000Z');
  assert.equal(loadWorkspaceRegistry(registryPath).workspaces.length, 2);
  assert.match(readFileSync(registryPath, 'utf8'), /workspace-a/);
});

test('workspace registry preserves active workspace registry metadata in lists', () => {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-workspaces-'));
  const registryPath = join(root, 'workspaces.json');
  upsertWorkspaceEntry({
    id: 'active-workspace',
    name: 'Old Name',
    rootPath: join(root, 'active'),
    registryPath,
    now: '2026-07-02T00:00:00.000Z',
  });
  const runtimeConfig = attachWorkspaceConfig(
    buildLocalAgentRuntimeConfig(join(root, 'active')),
    { workspaceId: 'active-workspace', workspaceName: 'Active Workspace' },
  );

  const workspaces = listWorkspaceEntries({ runtimeConfig, registryPath });

  assert.equal(workspaces[0]?.id, 'active-workspace');
  assert.equal(workspaces[0]?.name, 'Active Workspace');
  assert.equal(workspaces[0]?.createdAt, '2026-07-02T00:00:00.000Z');
  assert.equal(workspaces[0]?.lastOpenedAt, '2026-07-02T00:00:00.000Z');
});
