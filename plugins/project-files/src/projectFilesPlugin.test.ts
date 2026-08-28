import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { StudioHttpRoute, StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import type { StudioPluginContext } from '@pinpawo/studio';
import { createProjectFilesPlugin, createStudioPlugin } from './projectFilesPlugin';

function pluginContext(routes: StudioHttpRoute[]): StudioPluginContext {
  const hook: StudioHttpRoutesHook = {
    register: (route) => {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
  return {
    dispatch: async () => ({ petId: 'planner', invocationId: 'invocation-1' }),
    notify: () => undefined,
    subscribe: () => () => undefined,
    listPets: () => [],
    hooks: {
      expose: () => () => undefined,
      contribute: (_plugin, _name, install) => {
        const cleanup = install(hook as never);
        return typeof cleanup === 'function' ? cleanup : () => undefined;
      },
    },
  };
}

test('Project Files contributes list/read routes without dispatching or defining Toolkits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-plugin-'));
  await writeFile(path.join(root, 'PROJECT.md'), '# Project\n');
  const routes: StudioHttpRoute[] = [];
  const plugin = createProjectFilesPlugin({ rootDir: root });
  await plugin.start(pluginContext(routes));

  assert.deepEqual(plugin.toolkits, []);
  const list = routes.find(({ path: routePath }) => routePath === '/knowledge');
  const read = routes.find(({ path: routePath }) => routePath === '/knowledge/document');
  assert.ok(list && read);
  assert.deepEqual(await list.handle({} as never), {
    kind: 'json',
    body: {
      documents: [{
        path: 'PROJECT.md',
        title: 'PROJECT',
        size: 10,
        modifiedAt: (await plugin.service.listDocuments())[0]?.modifiedAt,
      }],
    },
  });
  const response = await read.handle({
    url: new URL('http://studio.local/knowledge/document?path=PROJECT.md'),
  } as never);
  assert.equal(response.kind, 'json');
  assert.equal((response.body as { document?: { content?: string } }).document?.content, '# Project\n');

  await plugin.stop?.();
  assert.deepEqual(routes, []);
});

test('installed Project Files Plugin keeps its root inside the Studio workdir', async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-installed-'));
  await mkdir(path.join(workdir, 'docs'), { recursive: true });
  const plugin = createStudioPlugin({ directory: 'docs' }, { workdir });
  assert.equal(plugin.service.rootDir, path.join(workdir, 'docs'));
  assert.throws(
    () => createStudioPlugin({ directory: '../private' }, { workdir }),
    /stay inside the Studio workdir/,
  );

  const outside = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-outside-'));
  await writeFile(path.join(outside, 'PRIVATE.md'), '# Private\n');
  await symlink(outside, path.join(workdir, 'linked-wiki'));
  const linked = createStudioPlugin({ directory: 'linked-wiki' }, { workdir });
  await assert.rejects(
    linked.service.listDocuments(),
    /outside the configured root/,
  );
});
