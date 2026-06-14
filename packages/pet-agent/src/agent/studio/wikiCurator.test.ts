import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

import {
  createLLMWikiCurator,
  createSkeletonWikiCurator,
  DEFAULT_CURATOR_PROMPT,
  defaultPromptProvider,
  ensureWikiSkeleton,
  fileReadPromptProvider,
} from './wikiCurator';
import type { StudioDispatchState } from './types';

async function makeWikiTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function sampleDispatch(overrides: Partial<StudioDispatchState> = {}): StudioDispatchState {
  return {
    id: 'd1',
    taskIndex: 0,
    petId: 'script',
    status: 'finished',
    brief: '写视频脚本结构',
    resultText: '已完成脚本结构,3 段式,每段 30 秒。',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('skeleton curator writes source file and appends index', async () => {
  const wikiRoot = await makeWikiTempDir('curator-skeleton-');
  const curator = createSkeletonWikiCurator();
  const result = await curator.curate({
    wikiRoot,
    dispatch: sampleDispatch(),
  });

  assert.ok(result.changedPaths.some((p) => p.includes('sources/')));
  assert.ok(result.changedPaths.includes('index.md'));

  const source = await fs.readFile(
    path.join(wikiRoot, 'sources', 'd1-script.md'),
    'utf8',
  );
  assert.match(source, /已完成脚本结构/);
  const index = await fs.readFile(path.join(wikiRoot, 'index.md'), 'utf8');
  assert.match(index, /d1/);
});

test('LLM curator passes wiki snapshot to model and applies structured output', async () => {
  const wikiRoot = await makeWikiTempDir('curator-llm-');
  await ensureWikiSkeleton(wikiRoot);

  let capturedSystemPrompt = '';
  let capturedUserMessage = '';

  // 构造一个 fake chat model:withStructuredOutput 返回一个 invoke 函数
  const fakeModel = {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content: string; _getType?: () => string }>) => {
        const system = messages.find((m) => m._getType?.() === 'system');
        const human = messages.find((m) => m._getType?.() === 'human');
        capturedSystemPrompt = typeof system?.content === 'string' ? system.content : '';
        capturedUserMessage = typeof human?.content === 'string' ? human.content : '';

        return {
          topicUpdates: [
            {
              fileName: 'script-structure.md',
              content: '# 脚本结构\n\n3 段式,每段 30 秒。',
            },
          ],
          indexContent: '# Studio Wiki\n\n## 主题\n\n- topics/script-structure.md\n',
        };
      },
    }),
  } as unknown as BaseChatModel;

  const curator = createLLMWikiCurator({
    models: { act: fakeModel },
  });

  const result = await curator.curate({
    wikiRoot,
    dispatch: sampleDispatch(),
  });

  // System prompt 是默认 curator prompt
  assert.equal(capturedSystemPrompt.trim(), DEFAULT_CURATOR_PROMPT.trim());
  // User message 含 brief 与 pet reply
  assert.match(capturedUserMessage, /写视频脚本结构/);
  assert.match(capturedUserMessage, /已完成脚本结构/);

  // topic 文件被写入
  const topicContent = await fs.readFile(
    path.join(wikiRoot, 'topics', 'script-structure.md'),
    'utf8',
  );
  assert.match(topicContent, /3 段式/);

  // index 被覆写
  const indexContent = await fs.readFile(path.join(wikiRoot, 'index.md'), 'utf8');
  assert.match(indexContent, /script-structure\.md/);

  // 原始素材也被存档
  const sourceContent = await fs.readFile(
    path.join(wikiRoot, 'sources', 'd1-script.md'),
    'utf8',
  );
  assert.match(sourceContent, /已完成脚本结构/);

  // changedPaths 包含 source / topic / index
  assert.ok(result.changedPaths.some((p) => p.includes('sources/')));
  assert.ok(result.changedPaths.some((p) => p.includes('topics/script-structure.md')));
  assert.ok(result.changedPaths.includes('index.md'));
});

test('LLM curator uses caller-provided promptProvider override', async () => {
  const wikiRoot = await makeWikiTempDir('curator-llm-prompt-');
  await ensureWikiSkeleton(wikiRoot);

  let capturedSystemPrompt = '';
  const fakeModel = {
    withStructuredOutput: () => ({
      invoke: async (messages: Array<{ content: string; _getType?: () => string }>) => {
        const system = messages.find((m) => m._getType?.() === 'system');
        capturedSystemPrompt = typeof system?.content === 'string' ? system.content : '';
        return {
          topicUpdates: [],
          indexContent: '# (empty)',
        };
      },
    }),
  } as unknown as BaseChatModel;

  const customPrompt = '自定义 curator prompt:只关心 用户偏好。';
  const curator = createLLMWikiCurator({
    models: { act: fakeModel },
    promptProvider: () => customPrompt,
  });

  await curator.curate({ wikiRoot, dispatch: sampleDispatch() });
  assert.equal(capturedSystemPrompt.trim(), customPrompt.trim());
});

test('LLM curator forwards structured output options to model', async () => {
  const wikiRoot = await makeWikiTempDir('curator-llm-structured-output-');
  await ensureWikiSkeleton(wikiRoot);

  let capturedOptions: unknown;
  const fakeModel = {
    withStructuredOutput: (_schema: unknown, options: unknown) => {
      capturedOptions = options;
      return {
        invoke: async () => ({ topicUpdates: [], indexContent: '# x' }),
      };
    },
  } as unknown as BaseChatModel;

  const curator = createLLMWikiCurator({
    models: { act: fakeModel },
    structuredOutput: { method: 'functionCalling', strict: false },
  });

  await curator.curate({ wikiRoot, dispatch: sampleDispatch() });

  assert.deepEqual(capturedOptions, {
    name: 'curate_wiki',
    method: 'functionCalling',
    strict: false,
  });
});

test('LLM curator calls promptProvider on each curate invocation', async () => {
  const wikiRoot = await makeWikiTempDir('curator-llm-provider-calls-');
  await ensureWikiSkeleton(wikiRoot);

  let providerCalls = 0;
  const fakeModel = {
    withStructuredOutput: () => ({
      invoke: async () => ({ topicUpdates: [], indexContent: '# x' }),
    }),
  } as unknown as BaseChatModel;

  const curator = createLLMWikiCurator({
    models: { act: fakeModel },
    promptProvider: () => {
      providerCalls += 1;
      return `prompt #${providerCalls}`;
    },
  });

  await curator.curate({ wikiRoot, dispatch: sampleDispatch() });
  await curator.curate({ wikiRoot, dispatch: sampleDispatch({ id: 'd2' }) });
  assert.equal(providerCalls, 2, 'provider should be invoked each curate call');
});

test('fileReadPromptProvider reads file once and caches', async () => {
  const tmpDir = await makeWikiTempDir('curator-prompt-file-');
  const promptFile = path.join(tmpDir, 'curator.md');
  await fs.writeFile(promptFile, '  # prompt from file\n', 'utf8');

  const provider = fileReadPromptProvider(promptFile);
  const first = await provider();
  // 改写文件,验证 provider 仍然返回缓存
  await fs.writeFile(promptFile, '# changed content', 'utf8');
  const second = await provider();

  assert.equal(first, '# prompt from file');
  assert.equal(second, '# prompt from file', 'fileReadPromptProvider should cache after first read');
});

test('defaultPromptProvider returns DEFAULT_CURATOR_PROMPT', async () => {
  const provider = defaultPromptProvider();
  assert.equal(await provider(), DEFAULT_CURATOR_PROMPT);
});

test('LLM curator rejects unsafe topic file names', async () => {
  const wikiRoot = await makeWikiTempDir('curator-llm-safety-');
  await ensureWikiSkeleton(wikiRoot);

  const fakeModel = {
    withStructuredOutput: () => ({
      invoke: async () => ({
        topicUpdates: [
          { fileName: '../escape.md', content: 'should not be written' },
          { fileName: '.hidden.md', content: 'should not be written' },
          { fileName: 'not-markdown.txt', content: 'should not be written' },
          { fileName: 'legit.md', content: '# legit\n' },
        ],
        indexContent: '# wiki',
      }),
    }),
  } as unknown as BaseChatModel;

  const curator = createLLMWikiCurator({ models: { act: fakeModel } });
  await curator.curate({ wikiRoot, dispatch: sampleDispatch() });

  // 只有 legit.md 被写入
  const entries = await fs.readdir(path.join(wikiRoot, 'topics'));
  assert.deepEqual(entries.sort(), ['legit.md']);
});
