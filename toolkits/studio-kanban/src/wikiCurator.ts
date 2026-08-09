import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { AgentModels } from '@pinpawo/pet-agent';
import {
  invokeStructuredOutput,
  type StructuredOutputAutoRepairConfig,
  type StructuredOutputMethod,
} from '@pinpawo/pet-agent';
import type {
  StudioWikiTaskSource,
  WikiCurateInput,
  WikiCurateResult,
  WikiCurator,
} from '@pinpawo/studio';

/* ─────────────── filesystem helpers ─────────────── */

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function ensureFile(filePath: string, initial: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, initial, 'utf8');
  }
}

export async function ensureWikiSkeleton(wikiRoot: string): Promise<void> {
  await ensureDir(wikiRoot);
  await ensureDir(path.join(wikiRoot, 'sources'));
  await ensureDir(path.join(wikiRoot, 'topics'));
  await ensureDir(path.join(wikiRoot, 'notes'));
  await ensureFile(
    path.join(wikiRoot, 'index.md'),
    [
      '# Studio Wiki',
      '',
      '这个知识库由 wiki_curator 维护,记录本会话内多个 pet agent 协作产生的知识与素材。',
      '',
      '- `sources/`:每棒 pet 的原始返回文本存档。',
      '- `topics/`:主题化整理(curator 整理后产物)。',
      '- `notes/`:跨主题笔记。',
      '',
      '## 最近 task',
      '',
    ].join('\n') + '\n',
  );
}

async function writeSourceFile(wikiRoot: string, task: StudioWikiTaskSource): Promise<string> {
  const petRunId = task.petRunId ?? `task-${task.taskIndex}`;
  const sourceFile = path.join(wikiRoot, 'sources', `${petRunId}-${task.petId}.md`);
  const sourceBody = [
    '---',
    `petRunId: ${petRunId}`,
    `petId: ${task.petId}`,
    `taskIndex: ${task.taskIndex}`,
    `status: ${task.status}`,
    task.startedAt ? `startedAt: ${task.startedAt}` : null,
    task.finishedAt ? `finishedAt: ${task.finishedAt}` : null,
    '---',
    '',
    `# Task ${task.taskIndex} (pet: ${task.petId})`,
    '',
    '## Brief',
    '',
    task.brief,
    '',
    '## Pet Reply',
    '',
    task.resultText ?? task.errorMessage ?? '(no output)',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
  await fs.writeFile(sourceFile, sourceBody, 'utf8');
  return path.relative(wikiRoot, sourceFile);
}

/* ─────────────── Skeleton implementation ─────────────── */

/**
 * Skeleton curator:把 task 输出原文落档,简单追加到 index。
 * 不做 LLM 整理。适合测试或不需要 wiki 智能整理的场景。
 */
export function createSkeletonWikiCurator(): WikiCurator {
  return {
    async curate({ wikiRoot, task }) {
      await ensureWikiSkeleton(wikiRoot);
      const changed: string[] = [];

      const sourceRel = await writeSourceFile(wikiRoot, task);
      changed.push(sourceRel);

      const petRunId = task.petRunId ?? `task-${task.taskIndex}`;
      const indexFile = path.join(wikiRoot, 'index.md');
      const indexAppend = [
        '',
        `### ${petRunId} — ${task.petId}`,
        `- taskIndex: ${task.taskIndex}`,
        `- status: ${task.status}`,
        `- source: sources/${petRunId}-${task.petId}.md`,
        '',
      ].join('\n');
      await fs.appendFile(indexFile, indexAppend, 'utf8');
      changed.push('index.md');

      return { changedPaths: changed };
    },
  };
}

/* ─────────────── LLM-driven implementation ─────────────── */

export const DEFAULT_CURATOR_PROMPT = [
  '你是 Studio 多 pet agent 协作的知识库管理员(curator)。',
  '每次有 worker task 完成后,你都会被调用一次,把这一棒的产出整理进共享知识库 wiki/。',
  '',
  '你的职责:',
  '1. 阅读当前 wiki 的 index.md 与现有 topics 列表,理解知识库当前的组织方式。',
  '2. 阅读本次 task 的 brief 与 pet 返回文本。',
  '3. 决定如何把新信息整理进 wiki:',
  '   - 若内容能补充到已有主题 → 输出该主题的更新版本(完整覆盖)。',
  '   - 若是新主题 → 创建新的 topic 文件。',
  '   - 命名用清晰的短语(英文/中文都可),例如 script-structure.md / audio-strategy.md。',
  '4. 重写 index.md:它应该是知识库的"目录页",提供概要 + 主题清单 + 链接。',
  '',
  '写作风格参考 Karpathy 个人笔记的 wiki 风格:简洁、按主题组织、重点突出、',
  '便于后续读者(下一棒 pet)快速定位需要的内容。',
  '',
  '原始 task 素材会由系统单独写入 sources/{petRunId}-{petId}.md(你不需要管),',
  '你只负责输出 topics 与 index 的整理结果。',
].join('\n');

const curatorOutputSchema = z.object({
  topicUpdates: z
    .array(
      z.object({
        fileName: z
          .string()
          .min(1)
          .describe('topic 文件名(不含路径前缀,例如 "script-structure.md")'),
        content: z
          .string()
          .min(1)
          .describe('该 topic 文件的完整 markdown 内容(覆盖式写入)'),
      }),
    )
    .describe('需要新增或更新的 topic 文件列表;可为空数组表示本次不动 topic'),
  indexContent: z
    .string()
    .min(1)
    .describe('整理后的 index.md 完整内容(覆盖写入)'),
});

type CuratorOutput = z.infer<typeof curatorOutputSchema>;

/**
 * curator prompt 的提供方:每次 curate 调用一次,返回当前要用的 system prompt。
 * 预设有 defaultPromptProvider / fileReadPromptProvider;用户也可传任意 async fn。
 */
export type CuratorPromptProvider = () => string | Promise<string>;

/**
 * 默认 provider:返回内置 DEFAULT_CURATOR_PROMPT(Karpathy 风格)。
 */
export function defaultPromptProvider(): CuratorPromptProvider {
  return () => DEFAULT_CURATOR_PROMPT;
}

/**
 * 文件 provider:startup 时读一次文件,后续 curate 始终返回这份内容。
 * 想要"改 prompt 不重启"的场景,请用 custom provider 在每次调用时读文件。
 */
export function fileReadPromptProvider(absPath: string): CuratorPromptProvider {
  let cached: Promise<string> | null = null;
  return () => {
    if (!cached) cached = fs.readFile(absPath, 'utf8').then((s) => s.trim());
    return cached;
  };
}

export type LLMWikiCuratorStructuredOutputConfig = {
  method?: StructuredOutputMethod;
  strict?: boolean;
  autoRepair?: StructuredOutputAutoRepairConfig;
};

export type LLMWikiCuratorConfig = {
  models: AgentModels;
  /**
   * curator system prompt 的提供方。
   * - 不传:用 defaultPromptProvider()(DEFAULT_CURATOR_PROMPT)
   * - 传 fileReadPromptProvider(path):startup 读一次文件
   * - 传任意 async fn:custom 控制(可以每次重读、动态拼装等)
   */
  promptProvider?: CuratorPromptProvider;
  structuredOutput?: LLMWikiCuratorStructuredOutputConfig;
};

async function readWikiSnapshot(wikiRoot: string): Promise<{
  indexContent: string;
  topics: Array<{ fileName: string; content: string }>;
}> {
  const indexPath = path.join(wikiRoot, 'index.md');
  let indexContent = '';
  try {
    indexContent = await fs.readFile(indexPath, 'utf8');
  } catch {
    indexContent = '';
  }
  const topicsDir = path.join(wikiRoot, 'topics');
  const topics: Array<{ fileName: string; content: string }> = [];
  try {
    const entries = await fs.readdir(topicsDir);
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.md')) continue;
      const content = await fs.readFile(path.join(topicsDir, entry), 'utf8');
      topics.push({ fileName: entry, content });
    }
  } catch {
    // topics/ 不存在或不可读,留空
  }
  return { indexContent, topics };
}

function buildCuratorUserMessage(params: {
  task: StudioWikiTaskSource;
  indexContent: string;
  topics: Array<{ fileName: string; content: string }>;
}): string {
  const { task, indexContent, topics } = params;
  const topicsBlock = topics.length === 0
    ? '(无)'
    : topics
        .map((topic) => [`### ${topic.fileName}`, '```markdown', topic.content, '```'].join('\n'))
        .join('\n\n');

  return [
    '## 本次 task',
    '',
    `- petRunId: ${task.petRunId ?? `task-${task.taskIndex}`}`,
    `- petId: ${task.petId}`,
    `- taskIndex: ${task.taskIndex}`,
    `- status: ${task.status}`,
    '',
    '### Brief',
    '',
    task.brief,
    '',
    '### Pet Reply',
    '',
    task.resultText ?? task.errorMessage ?? '(no output)',
    '',
    '## 当前 wiki 快照',
    '',
    '### index.md',
    '',
    indexContent || '(空)',
    '',
    '### topics/',
    '',
    topicsBlock,
    '',
    '请根据以上内容整理 wiki,产出 topicUpdates 与 indexContent。',
  ].join('\n');
}

async function applyCuratorOutput(params: {
  wikiRoot: string;
  output: CuratorOutput;
}): Promise<string[]> {
  const { wikiRoot, output } = params;
  const changed: string[] = [];

  for (const topic of output.topicUpdates) {
    const rawName = topic.fileName;
    // 拒绝任何带路径分隔符、相对路径段、隐藏文件、非 markdown 的名字。
    if (
      !rawName
      || rawName.includes('/')
      || rawName.includes('\\')
      || rawName.includes('..')
      || rawName.startsWith('.')
      || !rawName.endsWith('.md')
    ) {
      continue;
    }
    const target = path.join(wikiRoot, 'topics', rawName);
    await fs.writeFile(target, topic.content, 'utf8');
    changed.push(path.relative(wikiRoot, target));
  }

  const indexPath = path.join(wikiRoot, 'index.md');
  await fs.writeFile(indexPath, output.indexContent, 'utf8');
  changed.push('index.md');

  return changed;
}

/**
 * LLM 驱动的 curator。
 *
 * 流程:
 * 1. 读 wiki 当前快照(index.md + topics/)
 * 2. 给 LLM 看当前快照 + 本次 task 输出
 * 3. LLM 通过 structured output 返回 { topicUpdates, indexContent }
 * 4. 把 topicUpdates 写到 topics/, 用 indexContent 覆写 index.md
 * 5. 原始素材(sources/) 由本函数顺手存档(与 skeleton 一致)
 */
export function createLLMWikiCurator(config: LLMWikiCuratorConfig): WikiCurator {
  const promptProvider = config.promptProvider ?? defaultPromptProvider();

  return {
    async curate({ wikiRoot, task }) {
      await ensureWikiSkeleton(wikiRoot);
      const changed: string[] = [];

      // 1. 落档原始素材
      const sourceRel = await writeSourceFile(wikiRoot, task);
      changed.push(sourceRel);

      // 2. 读当前 wiki 快照
      const snapshot = await readWikiSnapshot(wikiRoot);

      // 3. LLM 调用
      const userMessage = buildCuratorUserMessage({
        task,
        indexContent: snapshot.indexContent,
        topics: snapshot.topics,
      });

      const promptHead = (await promptProvider()).trim();
      const result = await invokeStructuredOutput({
        model: config.models.act,
        schema: curatorOutputSchema,
        options: {
          name: 'curate_wiki',
          ...(config.structuredOutput?.method ? { method: config.structuredOutput.method } : {}),
          ...(typeof config.structuredOutput?.strict === 'boolean' ? { strict: config.structuredOutput.strict } : {}),
          ...(typeof config.structuredOutput?.autoRepair !== 'undefined'
            ? { autoRepair: config.structuredOutput.autoRepair }
            : {}),
        },
        messages: [
          new SystemMessage(promptHead),
          new HumanMessage(userMessage),
        ],
      }) as CuratorOutput;

      // 4. 应用更新
      const applied = await applyCuratorOutput({ wikiRoot, output: result });
      for (const file of applied) {
        if (!changed.includes(file)) changed.push(file);
      }

      return { changedPaths: changed };
    },
  };
}
