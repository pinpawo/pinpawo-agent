import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { StudioHttpRoute, StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import {
  createProjectFilesPlugin,
  createStudioPlugin,
  type ProjectFilesPluginContext,
} from './projectFilesPlugin';

function pluginContext(routes: StudioHttpRoute[]): ProjectFilesPluginContext {
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
    hooks: {
      expose: () => () => undefined,
      contribute: (_plugin, _name, install) => {
        const cleanup = install(hook as never);
        return typeof cleanup === 'function' ? cleanup : () => undefined;
      },
    },
  };
}

test('Project Files contributes list/read routes and a scoped Toolkit without dispatching', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-plugin-'));
  await writeFile(path.join(root, 'PROJECT.md'), '# Project\n');
  const routes: StudioHttpRoute[] = [];
  const plugin = createProjectFilesPlugin({ rootDir: root });
  await plugin.start(pluginContext(routes));

  assert.deepEqual(plugin.toolkits.map(({ name }) => name), ['project_files']);
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

test('installed Project Files reads an explicitly configured Wiki outside the Studio workdir', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-data-'));
  const workdir = path.join(parent, 'project');
  const wikiDirectory = path.join(parent, 'studio-data', 'wiki');
  await mkdir(workdir, { recursive: true });
  await mkdir(path.join(wikiDirectory, 'guides'), { recursive: true });
  await Promise.all([
    writeFile(path.join(wikiDirectory, 'PROJECT.md'), '# Studio Wiki\n'),
    writeFile(path.join(wikiDirectory, 'guides', 'START.md'), '# Start\n'),
    writeFile(path.join(parent, 'private.md'), '# Private\n'),
  ]);
  await symlink(path.join(wikiDirectory, 'PROJECT.md'), path.join(wikiDirectory, 'internal.md'));
  await symlink(path.join(parent, 'private.md'), path.join(wikiDirectory, 'escape.md'));
  await symlink(parent, path.join(wikiDirectory, 'escape-dir'));

  const plugin = createStudioPlugin({ wikiDirectory }, { workdir });
  assert.equal(plugin.service.rootDir, wikiDirectory);
  assert.deepEqual((await plugin.service.listDocuments()).map(({ path: documentPath }) => documentPath), [
    'guides/START.md',
    'PROJECT.md',
  ]);
  assert.equal((await plugin.service.readDocument('PROJECT.md'))?.content, '# Studio Wiki\n');
  assert.equal((await plugin.service.readDocument('internal.md'))?.content, '# Studio Wiki\n');
  await assert.rejects(plugin.service.readDocument('../private.md'), /normalized relative Markdown path/);
  await assert.rejects(plugin.service.readDocument('escape.md'), /outside the configured root/);
  await assert.rejects(plugin.service.readDocument('escape-dir/private.md'), /outside the configured root/);

  const routes: StudioHttpRoute[] = [];
  await plugin.start(pluginContext(routes));
  const read = routes.find(({ path: routePath }) => routePath === '/knowledge/document');
  assert.ok(read);
  const response = await read.handle({
    url: new URL('http://studio.local/knowledge/document?path=../private.md'),
  } as never);
  assert.equal(response.status, 400);
  await plugin.stop?.();
});

test('installed Project Files requires an unambiguous absolute Wiki directory', () => {
  const workdir = path.join(tmpdir(), 'pinpawo-project-files-workdir');
  for (const wikiDirectory of ['', '  ', 'wiki', '../wiki', null, 123, '/bad\0path']) {
    assert.throws(
      () => createStudioPlugin({ wikiDirectory }, { workdir }),
      /wikiDirectory must be an absolute path/,
    );
  }
  assert.throws(
    () => createStudioPlugin({ directory: 'wiki', wikiDirectory: path.join(tmpdir(), 'wiki') }, { workdir }),
    /cannot both be configured/,
  );
});

test('configured Wiki root cannot be redirected after initialization for HTTP or service reads', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'pinpawo-project-files-root-swap-'));
  const workdir = path.join(parent, 'project');
  const first = path.join(parent, 'first');
  const second = path.join(parent, 'second');
  const alias = path.join(parent, 'configured');
  await mkdir(workdir);
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, 'PROJECT.md'), '# First\n');
  await writeFile(path.join(second, 'PROJECT.md'), '# Private other root\n');
  await symlink(first, alias);
  const plugin = createStudioPlugin({ wikiDirectory: alias }, { workdir });
  const routes: StudioHttpRoute[] = [];
  await plugin.start(pluginContext(routes));
  await unlink(alias);
  await symlink(second, alias);
  await assert.rejects(plugin.service.listDocuments(), /root changed after authorization/);
  await assert.rejects(plugin.service.readDocument('PROJECT.md'), /root changed after authorization/);
  const list = routes.find(({ path: routePath }) => routePath === '/knowledge');
  const read = routes.find(({ path: routePath }) => routePath === '/knowledge/document');
  assert.ok(list && read);
  await assert.rejects(async () => await list.handle({} as never), /root changed after authorization/);
  const response = await read.handle({
    url: new URL('http://studio.local/knowledge/document?path=PROJECT.md'),
  } as never);
  assert.equal(response.status, 400);
  assert.doesNotMatch(JSON.stringify(response.body), /Private other root/);
  await plugin.stop?.();
});
