import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compileAgentRegistry } from '@pinpawo/pet-agent';
import { resolveStudioHostConfig, type StudioPlugin } from '@pinpawo/studio-core';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { loadCapabilityDirectory } from 'pinpawo/host-runtime';
import { createFilesToolkit } from '../../../services/host/src/toolkits/files/index';
import { createStudioPlugin as filesFactory } from '../../../plugins/project-files/src/projectFilesPlugin';
import { createStudioWithPets } from '../../../tests/support/livePets';

test('an existing Studio can migrate its Wiki and preserve customized Pet instructions', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-wiki-migration-'));
  const workdir = path.join(root, 'project');
  const wikiDirectory = path.join(root, 'independent-studio-data', 'wiki');
  const oldWiki = path.join(workdir, 'wiki');
  const petDir = path.join(workdir, '.pinpawo', 'pets', 'wiki');
  const capabilityDir = path.join(petDir, 'capabilities', 'wiki-maintenance');
  const configPath = path.join(workdir, '.pinpawo', 'studio.json');
  const custom = `User-specific Wiki instruction ${randomUUID()}`;
  const before = `# Existing knowledge\n\nPreserve ${randomUUID()}\n`;
  const token = 'isolated-wiki-migration-test-token';
  await Promise.all([
    mkdir(oldWiki, { recursive: true }),
    mkdir(wikiDirectory, { recursive: true }),
    mkdir(capabilityDir, { recursive: true }),
  ]);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await Promise.all([
    writeFile(path.join(oldWiki, 'PROJECT.md'), before),
    writeFile(path.join(workdir, '.pinpawo', 'pets', 'wiki.json'), JSON.stringify({ definitionId: 'wiki', name: 'Wiki', defaultCapabilityName: 'wiki_maintenance' })),
    writeFile(path.join(petDir, 'PET.md'), `# Wiki\n\n${custom}\n`),
    writeFile(path.join(capabilityDir, 'CAPABILITY.md'), '---\nname: wiki_maintenance\ndescription: Maintain the project Wiki.\nuses:\n  - files\nversion: 1\n---\n\nKeep existing knowledge.\n'),
    writeFile(configPath, JSON.stringify({
      studioId: 'existing', definitions: ['wiki'],
      plugins: [{ id: '@pinpawo-plugin/studio-http' }, { id: '@pinpawo-plugin/project-files', options: { directory: 'wiki' } }],
    })),
  ]);
  const originalPet = await readFile(path.join(petDir, 'PET.md'), 'utf8');

  // The old Studio retains its original workdir-relative knowledge until explicitly changed.
  const legacy = filesFactory({ directory: 'wiki' }, { workdir });
  assert.equal((await legacy.service.readDocument('PROJECT.md'))?.content, before);

  // Model the documented manual migration without replacing user-authored Pet content.
  await copyFile(path.join(oldWiki, 'PROJECT.md'), path.join(wikiDirectory, 'PROJECT.md'));
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { plugins: Array<{ id: string; options?: Record<string, unknown> }> };
  const filesConfig = config.plugins.find(({ id }) => id === '@pinpawo-plugin/project-files');
  assert.ok(filesConfig);
  filesConfig.options = { wikiDirectory };
  await writeFile(configPath, JSON.stringify(config));
  const oldCapability = await readFile(path.join(capabilityDir, 'CAPABILITY.md'), 'utf8');
  await writeFile(path.join(capabilityDir, 'CAPABILITY.md'), oldCapability.replace('  - files\n', '  - files\n  - project_files\n'));
  assert.equal(await readFile(path.join(petDir, 'PET.md'), 'utf8'), originalPet);

  const http = createStudioHttpPlugin({ port: 0, authToken: token });
  const configuration = await resolveStudioHostConfig({
    workdir,
    resolvePlugin: (id, options): StudioPlugin => {
      if (id === '@pinpawo-plugin/studio-http') return http;
      assert.equal(id, '@pinpawo-plugin/project-files');
      return filesFactory(options, { workdir });
    },
  });
  const toolkits = [createFilesToolkit(), ...configuration.plugins.flatMap((plugin) => plugin.toolkits)];
  const loaded = await loadCapabilityDirectory(path.dirname(capabilityDir));
  const registry = compileAgentRegistry({ toolkits, capabilities: loaded.map(({ capability }) => capability) });
  assert.deepEqual(registry.unavailableCapabilities, []);
  const capability = registry.capabilities.find(({ capability }) => capability.name === 'wiki_maintenance');
  assert.ok(capability);
  for (const name of ['project_files_list', 'project_files_read', 'project_files_write']) assert.ok(capability.toolNames.includes(name));
  const knowledge = toolkits.find(({ name }) => name === 'project_files');
  assert.ok(knowledge);
  const read = knowledge.tools.find(({ tool }) => tool.name === 'project_files_read');
  const write = knowledge.tools.find(({ tool }) => tool.name === 'project_files_write');
  assert.ok(read && write);
  assert.ok(write.review?.authorization?.buildMatcher, 'migration preserves the write review policy');

  const studio = await createStudioWithPets({
    studioId: configuration.resolved.studio.studioId,
    plugins: configuration.plugins,
    pets: [{
      registration: { petId: 'wiki', name: 'Wiki' },
      dispatch: {
        getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
        onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {}, dispatch: async () => {},
      },
    }],
  });
  t.after(async () => { await studio.shutdown(); });
  const url = `http://127.0.0.1:${http.address()!.port}/knowledge/document?path=PROJECT.md`;
  const headers = { Authorization: `Bearer ${token}` };
  const first = await fetch(url, { headers });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { document: { content: string } }).document.content, before);
  const readResult = JSON.parse(await read.tool.invoke({ path: 'PROJECT.md' }) as string) as { document: { content: string; digest: string } };
  assert.equal(readResult.document.content, before);
  const updated = `${before}\nUpdated by an authorized Wiki task.\n`;
  // Direct invocation verifies the data path; runtime approval is asserted via review metadata above.
  await write.tool.invoke({ path: 'PROJECT.md', content: updated, expectedDigest: readResult.document.digest });
  const after = await fetch(url, { headers });
  assert.equal(after.status, 200);
  assert.equal((await after.json() as { document: { content: string } }).document.content, updated);
  assert.equal(await readFile(path.join(wikiDirectory, 'PROJECT.md'), 'utf8'), updated);
  assert.equal(await readFile(path.join(oldWiki, 'PROJECT.md'), 'utf8'), before, 'legacy project Wiki remains untouched');
});
