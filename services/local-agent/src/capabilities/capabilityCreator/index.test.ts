import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { validateCapabilityPlugin } from '../../capabilityLoader';
import {
  createCapabilityCreatorCapability,
  createCapabilityCreatorToolkit,
} from './index';

const execFileAsync = promisify(execFile);

test('capability_creator relies on the shared subagent context window policy', () => {
  const capability = createCapabilityCreatorCapability();

  assert.equal('contextManagement' in capability, false);
  assert.equal('contextPolicy' in capability, false);
});

test('capability_creator keeps artifact persistence out of model tool calls', () => {
  const capability = createCapabilityCreatorCapability();

  // Still needs bash, but no longer relies on the model calling capability_artifact_write (issue #137).
  assert.deepEqual(capability.uses, ['bash', 'capability_creator']);
  assert.ok(!capability.instructions.content.includes('capability_artifact_write'));
  assert.equal(capability.lifecycle?.finalize, undefined);
});

test('capability_creator scaffolds a loadable document with an explicit Toolkit boundary', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'pinpawo-capability-creator-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const rootDir = join(tempRoot, 'research-brief');
  const scaffold = createCapabilityCreatorToolkit().tools
    .find(({ tool }) => tool.name === 'scaffold_capability_plugin')?.tool;
  assert.ok(scaffold);

  await scaffold.invoke({
    id: 'Research Brief',
    name: '调研简报',
    description: '公开网页调研、多来源事实核对和引用整理',
    task: '阅读用户指定的公开来源并整理可追溯的调研简报。',
    uses: ['bash', 'git'],
    workflow: ['确认来源范围。', '收集并交叉核对证据。'],
    boundaries: ['不操作需要登录的页面。'],
    outputRequirements: ['每个关键事实附来源。'],
    rootDir,
  });

  const validation = await validateCapabilityPlugin(rootDir);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(validation.capability?.name, 'research_brief');
  assert.deepEqual(validation.capability?.uses, ['bash', 'git']);

  const smokeTest = await readFile(join(rootDir, 'index.test.mjs'), 'utf8');
  assert.ok(!smokeTest.includes(rootDir), 'generated smoke test must be portable');
  await execFileAsync(process.execPath, [join(rootDir, 'index.test.mjs')]);
});

test('capability_creator supports capabilities that need no Toolkit', async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'pinpawo-capability-creator-empty-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const rootDir = join(tempRoot, 'formatter');
  const scaffold = createCapabilityCreatorToolkit().tools
    .find(({ tool }) => tool.name === 'scaffold_capability_plugin')?.tool;
  assert.ok(scaffold);

  await scaffold.invoke({
    id: 'formatter',
    name: '格式化',
    description: '把用户提供的文本整理为指定格式',
    task: '只根据对话中已提供的文本进行格式转换。',
    uses: [],
    rootDir,
  });

  const validation = await validateCapabilityPlugin(rootDir);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.deepEqual(validation.capability?.uses, []);
  await execFileAsync(process.execPath, [join(rootDir, 'index.test.mjs')]);
});
