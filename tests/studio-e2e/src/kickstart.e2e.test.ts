import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initStudioWorkdir, type StudioPlugin } from '@pinpawo/studio-core';

test('Studio init enables Channel and keeps only an explicit external-request Trigger', async (t) => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-init-e2e-'));
  const studioDataRoot = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-data-'));
  t.after(async () => { await rm(workdir, { recursive: true, force: true }); await rm(studioDataRoot, { recursive: true, force: true }); });
  await initStudioWorkdir({ workdir, studioDataRoot });
  const config = await readFile(path.join(workdir, '.pinpawo', 'studio.json'), 'utf8');
  const parsed = JSON.parse(config) as {
    plugins: Array<{
      id: string;
      options?: {
        triggers?: Array<{
          triggerId: string;
          source?: { secretEnv?: string };
        }>;
      };
    }>;
  };
  assert.ok(parsed.plugins.some(({ id }) => id === '@pinpawo-plugin/channel'));
  const trigger = parsed.plugins.find(({ id }) => id === '@pinpawo-plugin/trigger');
  assert.equal(trigger?.options?.triggers?.length, 1);
  assert.ok(trigger?.options?.triggers?.some((definition) => (
    definition.triggerId === 'external-request'
    && definition.source?.secretEnv === 'PINPAWO_STUDIO_TRIGGER_SECRET'
  )));
});

// Assemble the shipped Plugin selection and exercise the surviving public routes.
test('shipped Plugins support explicit Wiki work and Knowledge without opening historical task storage', async (t) => {
  const { mkdir, rm, writeFile } = await import('node:fs/promises');
  const { createStudio, resolveStudioHostConfig } = await import('@pinpawo/studio-core');
  const { createStudioHttpPlugin } = await import('@pinpawo-plugin/studio-http');
  const { createStudioPlugin: channelFactory } = await import('@pinpawo-plugin/channel');
  const { createStudioPlugin: noticeFactory } = await import('@pinpawo-plugin/notice');
  const { createStudioPlugin: schedulerFactory } = await import('@pinpawo-plugin/scheduler');
  const { createStudioPlugin: filesFactory } = await import('@pinpawo-plugin/project-files');
  const { createTriggerPlugin } = await import('@pinpawo-plugin/trigger');
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-retired-workdir-'));
  const studioDataRoot = await mkdtemp(path.join(tmpdir(), 'pinpawo-studio-data-'));
  const { wikiDirectory } = await initStudioWorkdir({ workdir, studioDataRoot });
  const historyDir = path.join(workdir, '.pinpawo', 'kanban');
  await mkdir(historyDir, { recursive: true });
  const history = path.join(historyDir, 'tasks.sqlite');
  const archived = Buffer.from('historical storage must not be opened or migrated');
  await writeFile(history, archived);
  const configPath = path.join(workdir, '.pinpawo', 'studio.json');
  const beforeConfig = await readFile(configPath);
  const beforeWiki = await readFile(path.join(wikiDirectory, 'PROJECT.md'));
  const token = 'explicit-wiki-test-token';
  const http = createStudioHttpPlugin({ port: 0, authToken: token });
  const factories = new Map<string, (
    options: Record<string, unknown> | undefined,
    environment: { workdir: string },
  ) => StudioPlugin>([
    ['@pinpawo-plugin/channel', channelFactory],
    ['@pinpawo-plugin/notice', noticeFactory],
    ['@pinpawo-plugin/scheduler', schedulerFactory],
    ['@pinpawo-plugin/project-files', filesFactory],
  ]);
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options) => {
      if (id === '@pinpawo-plugin/studio-http') return http;
      if (id === '@pinpawo-plugin/trigger') {
        // Supply test credentials without consulting or mutating user environment.
        const definitions = options!.triggers as Array<{ triggerId: string; petId: string; request: string }>;
        return createTriggerPlugin({ triggers: definitions.map(({ triggerId, petId, request }) => ({
          triggerId, petId, request, source: { kind: 'http' as const, secret: 'explicit-planning-test-secret' },
        })) });
      }
      const factory = factories.get(id);
      assert.ok(factory, `Unexpected configured Plugin: ${id}`);
      return factory(options, { workdir });
    },
  });
  const { compileAgentRegistry } = await import('@pinpawo/pet-agent');
  const { loadCapabilityDirectory } = await import('pinpawo/host-runtime');
  const { createFilesToolkit } = await import('../../../services/host/src/toolkits/files/index');
  const { createShellToolkit } = await import('../../../services/host/src/toolkits/shell/index');
  const { createWebToolkit } = await import('../../../services/host/src/toolkits/web/index');
  const { createGitToolkit } = await import('../../../services/host/src/toolkits/git/index');
  const { createGithubToolkit } = await import('../../../services/host/src/toolkits/github/index');
  const { PosixShellRS } = await import('../../../services/host/src/toolkits/shellRS/index');
  const shell = new PosixShellRS();
  t.after(() => shell.dispose());
  const toolkits = [
    createFilesToolkit(), createShellToolkit({ shell: shell }), createWebToolkit(), createGitToolkit({ shell: shell }), createGithubToolkit({ shell: shell }),
    ...configuration.plugins.flatMap((plugin) => plugin.toolkits),
  ];
  for (const pet of configuration.resolved.pets) {
    const loaded = await loadCapabilityDirectory(path.join(workdir, '.pinpawo', 'pets', pet.petId, 'capabilities'));
    const registry = compileAgentRegistry({ toolkits, capabilities: loaded.map(({ capability }) => capability) });
    assert.deepEqual(registry.unavailableCapabilities, [], `${pet.petId} has no missing Toolkit bindings`);
    const preferred = registry.capabilities.find(({ capability }) => capability.name === pet.defaultCapabilityName);
    assert.ok(preferred, `${pet.petId} retains an executable default Capability`);
    assert.ok(preferred.toolNames.includes('channel_read_context'));
    if (pet.petId === 'wiki') {
      for (const name of ['project_files_list', 'project_files_read', 'project_files_write']) {
        assert.ok(preferred.toolNames.includes(name), `Wiki Capability binds ${name}`);
      }
    }
  }
  const received: Array<{ petId: string; request: string }> = [];
  const studio = await createStudio({
    studioId: configuration.resolved.studio.studioId,
    entryPetId: configuration.resolved.studio.entryPetId,
    plugins: configuration.plugins,
    pets: configuration.resolved.pets.map(({ petId, name }) => ({
      registration: { petId, name },
      dispatch: {
        getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
        dispatch: async ({ request }) => { received.push({ petId, request }); },
      },
    })),
  });
  t.after(async () => {
    await studio.shutdown();
    await rm(workdir, { recursive: true, force: true });
    await rm(studioDataRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.deepEqual(studio.listPets().map(({ petId }) => petId), ['executor', 'reviewer', 'wiki']);
  for (const route of ['/kanban', '/kanban/events']) {
    assert.equal((await fetch(base + route, { headers })).status, 404);
  }
  assert.equal((await fetch(base + '/kanban/control', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/channels', { headers })).status, 200);
  const knowledge = await fetch(base + '/knowledge', { headers });
  assert.equal(knowledge.status, 200);
  const listing = await knowledge.json() as { documents: Array<{ path: string }> };
  assert.deepEqual(listing.documents.map(({ path }) => path), ['PROJECT.md']);
  const document = await fetch(base + '/knowledge/document?path=PROJECT.md', { headers });
  assert.equal(document.status, 200);
  assert.equal((await document.json() as { document: { content: string } }).document.content, beforeWiki.toString());
  // Verify the exact Toolkit definitions selected by the Wiki Capability resolve to
  // the same root exposed by HTTP. Direct invoke here checks storage integration;
  // review metadata is separately checked; it does not simulate an Agent approval.
  const projectFiles = toolkits.find(({ name }) => name === 'project_files');
  assert.ok(projectFiles);
  const findKnowledgeTool = (name: string) => {
    const definition = projectFiles.tools.find(({ tool }) => tool.name === name);
    assert.ok(definition, `${name} is registered`);
    return definition;
  };
  const listTool = findKnowledgeTool('project_files_list');
  const readTool = findKnowledgeTool('project_files_read');
  const writeTool = findKnowledgeTool('project_files_write');
  const initialList = JSON.parse(await listTool.tool.invoke({}) as string);
  assert.ok(initialList.documents.some(({ path: itemPath }: { path: string }) => itemPath === 'PROJECT.md'));
  const current = JSON.parse(await readTool.tool.invoke({ path: 'PROJECT.md' }) as string);
  assert.equal(current.document.content, beforeWiki.toString());
  assert.match(current.document.digest, /^[a-f0-9]{64}$/);
  assert.ok(writeTool.review?.authorization?.buildMatcher, 'writes require exact review');
  assert.equal(writeTool.review?.canAutoApprove, undefined, 'writes are not silently auto-approved');
  const input = { path: 'smoke.md', content: '# Knowledge from the Wiki Pet\n', expectedDigest: null };
  const review = await writeTool.review?.request({
    toolkitName: 'project_files', toolName: 'project_files_write', input,
    operation: writeTool.operation, reviewCapabilities: { humanReview: true, sessionAuthorization: true },
  });
  assert.ok(review && 'schemaVersion' in review && review.view.kind === 'operation');
  await writeTool.tool.invoke(input);
  const newDocument = await fetch(base + '/knowledge/document?path=smoke.md', { headers });
  assert.equal(newDocument.status, 200);
  assert.equal((await newDocument.json() as { document: { content: string } }).document.content, input.content);
  assert.equal(await readFile(path.join(wikiDirectory, 'smoke.md'), 'utf8'), input.content);
  await assert.rejects(readFile(path.join(workdir, 'wiki', 'smoke.md')), /ENOENT/);
  studio.notify({
    source: 'resident-pet', type: 'dispatch.completed',
    occurredAt: new Date().toISOString(),
    payload: { petId: 'executor', invocationId: 'completed-work', reply: 'Delivery evidence' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [], 'Invocation completion does not dispatch Wiki maintenance');
  const request = 'Reconcile Wiki from the supplied review evidence.';
  assert.equal((await fetch(base + '/dispatch', {
    method: 'POST', headers, body: JSON.stringify({ petId: 'wiki', request }),
  })).status, 202);
  assert.deepEqual(received, [{ petId: 'wiki', request }]);
  assert.deepEqual(await readFile(history), archived);
  assert.deepEqual(await readFile(configPath), beforeConfig);
  assert.deepEqual(await readFile(path.join(wikiDirectory, 'PROJECT.md')), beforeWiki);
});
