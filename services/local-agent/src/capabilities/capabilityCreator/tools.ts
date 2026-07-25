import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import {
  defineInstructionDocument,
  defineToolkit,
  extractCapabilityKeywords,
  readRecord,
  readString,
  readStringArray,
  resultStatusSummary,
  searchCapabilities,
  splitCapabilitySearchTerms,
  type AgentToolkit,
  type NamedStructuredTool,
  type ToolOperationMetadata,
} from '@pinpawo/pet-agent';
import { validateCapabilityPlugin } from '../../capabilityLoader';
import {
  capabilityCreatorResultSchema,
  checkCapabilityKeywordsInputSchema,
  scaffoldCapabilityPluginInputSchema,
  validateCapabilityPluginInputSchema,
} from './schemas';
import type { CapabilityCreatorResult } from './schemas';

function expandHome(p: string) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function normalizeCapabilityId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function resolveCapabilityRoot(rootDir: string | undefined, capabilityId: string) {
  const fallback = resolve(homedir(), '.pinpawo', 'capabilities', capabilityId);
  return resolve(expandHome(rootDir?.trim() || fallback));
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function toolResult(value: CapabilityCreatorResult): [string, CapabilityCreatorResult] {
  const parsed = capabilityCreatorResultSchema.parse(value);
  return [json(parsed), parsed];
}

function scaffoldInputSummary(input: unknown) {
  const record = readRecord(input);
  const id = readString(record, 'id');
  const rootDir = readString(record, 'rootDir');
  const name = readString(record, 'name');
  return id || rootDir || name
    ? {
        target: rootDir ?? id,
        summary: name ? `生成 ${name}` : '生成 capability 插件',
        details: {
          id,
          rootDir,
          overwrite: record?.overwrite,
          includePackageJson: record?.includePackageJson,
          includeReadme: record?.includeReadme,
          includeSmokeTest: record?.includeSmokeTest,
        },
      }
    : null;
}

function validateInputSummary(input: unknown) {
  const record = readRecord(input);
  const rootDir = readString(record, 'rootDir');
  return rootDir
    ? {
        target: rootDir,
        summary: '验证 capability 插件',
      }
    : null;
}

function keywordInputSummary(input: unknown) {
  const record = readRecord(input);
  const rootDir = readString(record, 'rootDir');
  const name = readString(record, 'name');
  const queries = readStringArray(record, 'queries');
  return rootDir || name
    ? {
        target: rootDir ?? name,
        summary: '检查 capability 关键词',
        details: {
          rootDir,
          name,
          queryCount: queries.length,
        },
      }
    : null;
}

const capabilityCreatorResultLabels: Record<string, string> = {
  created: 'capability 插件已生成',
  validated: 'capability 插件已验证',
  failed: 'capability 处理失败',
};

const capabilityCreatorOperationMetadata = {
  scaffold_capability_plugin: {
    title: '生成 capability 插件',
    summarizeInput: scaffoldInputSummary,
    summarizeOutput: (output) => resultStatusSummary(output, capabilityCreatorResultLabels),
    summarizeError: () => ({ summary: '生成 capability 插件失败' }),
  },
  validate_capability_plugin: {
    title: '验证 capability 插件',
    summarizeInput: validateInputSummary,
    summarizeOutput: (output) => resultStatusSummary(output, capabilityCreatorResultLabels),
    summarizeError: () => ({ summary: '验证 capability 插件失败' }),
  },
  check_capability_keywords: {
    title: '检查 capability 关键词',
    summarizeInput: keywordInputSummary,
    summarizeOutput: (output) => resultStatusSummary(output, capabilityCreatorResultLabels),
    summarizeError: () => ({ summary: '检查 capability 关键词失败' }),
  },
} satisfies Record<
  'scaffold_capability_plugin' | 'validate_capability_plugin' | 'check_capability_keywords',
  ToolOperationMetadata
>;

function renderCapabilityDocument(params: {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  task: string;
}) {
  return `---
name: ${params.id}
description: ${JSON.stringify(params.description)}
uses:
  - bash
version: 1
icon: ${JSON.stringify(params.icon)}
color: ${JSON.stringify(params.color)}
defaultEnabled: true
---

# ${params.name}

## 目标

${params.task}

## 工作流程

1. 先把用户目标拆成明确步骤，再决定要读取、写入或更新哪些文件。
2. 修改文件前先确认目录和现有内容。
3. 可读文本优先使用 \`view_file_chunk\`；PDF、Word、表格、图片等非文本文件才使用对应工具。
4. 编辑优先使用 \`apply_patch\`，只有需要整体重写时才使用 \`write_file\`。
5. 完成后总结产出的文件、验证结果，以及用户接下来需要手动确认或补充的内容。

## 约束与边界

所有工具都来自 frontmatter 的 \`uses\` 所声明的 Toolkit。不要在 Capability 中创建、替换或动态注入工具。
`;
}

function renderReadme(params: {
  id: string;
  name: string;
  description: string;
  rootDir: string;
}) {
  return `# ${params.name}

## Purpose
${params.description}

## Files
- \`CAPABILITY.md\`: routing metadata, Toolkit dependencies, and immutable instructions
- \`index.js\`: optional finalize-only lifecycle entry, only when declared by frontmatter
- \`index.test.mjs\`: dependency-free document smoke test

## Install location
\`${params.rootDir}\`

## Validate
\`\`\`bash
node ${JSON.stringify(resolve(params.rootDir, 'index.test.mjs'))}
\`\`\`

## Notes
- This template is intentionally dependency-free so it can be loaded from \`~/.pinpawo/capabilities\` without a local \`node_modules\`.
- If you later need custom tools or typed source files, either add local dependencies inside this plugin directory, or place the plugin inside a repo path and append that path to \`capability_dirs\`.
- Capability executability is derived by compiling the Toolkits required by \`uses\`.
- Model-invoked actions and external business effects must be implemented by Toolkit tools.

## Capability goal
${params.description}
`;
}

function renderSmokeTest(params: { id: string; rootDir: string }) {
  const capabilityPath = resolve(params.rootDir, 'CAPABILITY.md');
  return `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const document = await readFile(${JSON.stringify(capabilityPath)}, 'utf-8');
assert.match(document, /^---\\n/);
assert.match(document, /name:\\s*${params.id}/);
assert.match(document, /uses:\\n(?:\\s+-\\s+.+\\n)+/);
assert.match(document, /\\n---\\n\\n# /);

console.log('capability scaffold ok');
`;
}

function renderPackageJson(id: string) {
  return `${json({
    name: `pinpawo-capability-${id.replace(/_/g, '-')}`,
    private: true,
    type: 'module',
    scripts: {
      test: 'node index.test.mjs',
    },
  })}\n`;
}

function defaultKeywordQueries(params: { name: string; description: string; keywords: string[] }) {
  return [
    params.name,
    ...params.keywords.slice(0, 3),
    params.keywords.slice(0, 3).join('|'),
  ].filter((query) => query.trim().length > 0);
}

function checkCapabilityKeywordQueries(params: {
  name: string;
  description: string;
  queries?: string[];
}) {
  const capability = {
    name: params.name,
    description: params.description,
    uses: [],
    instructions: defineInstructionDocument({
      content: 'Keyword search fixture.',
    }),
  };
  const keywords = extractCapabilityKeywords(`${params.name} ${params.description}`);
  const queries = (params.queries?.length ? params.queries : defaultKeywordQueries({
    name: params.name,
    description: params.description,
    keywords,
  }))
    .map((query) => query.trim())
    .filter(Boolean);
  const keywordChecks = queries.map((query) => {
    const top = searchCapabilities(query, [capability])[0] ?? null;
    return {
      query,
      matched: top?.name === params.name,
      topCandidate: top?.name ?? null,
      score: top?.score ?? null,
      matchedTerms: top?.matchedTerms ?? [],
    };
  });
  const suggestedDescriptionTerms = keywordChecks
    .filter((item) => !item.matched)
    .flatMap((item) => splitCapabilitySearchTerms(item.query))
    .filter((term, index, terms) => terms.indexOf(term) === index)
    .slice(0, 8);

  return {
    keywords,
    keywordChecks,
    suggestedDescriptionTerms,
  };
}

export function createScaffoldCapabilityPluginTool(): StructuredTool {
  return tool(
    async (input) => {
      try {
        const capabilityId = normalizeCapabilityId(input.id);
        if (!capabilityId) {
          return toolResult({
            status: 'failed',
            capabilityId: null,
            rootDir: null,
            files: [],
            note: 'capability id 不能为空，且必须能归一化成合法的 snake_case 标识。',
          });
        }

        const rootDir = resolveCapabilityRoot(input.rootDir, capabilityId);
        const files = [
          { path: resolve(rootDir, 'CAPABILITY.md'), content: renderCapabilityDocument({
            id: capabilityId,
            name: input.name.trim(),
            description: input.description.trim(),
            icon: input.icon?.trim() || 'wand.and.stars',
            color: input.color?.trim() || 'purple',
            task: input.task.trim(),
          }) },
          ...((input.includeReadme ?? true)
            ? [{ path: resolve(rootDir, 'README.md'), content: renderReadme({
              id: capabilityId,
              name: input.name.trim(),
              description: input.description.trim(),
              rootDir,
            }) }]
            : []),
          ...((input.includeSmokeTest ?? true)
            ? [{ path: resolve(rootDir, 'index.test.mjs'), content: renderSmokeTest({
              id: capabilityId,
              rootDir,
            }) }]
            : []),
          ...((input.includePackageJson ?? true)
            ? [{ path: resolve(rootDir, 'package.json'), content: renderPackageJson(capabilityId) }]
            : []),
        ];

        const existing = files.filter((file) => existsSync(file.path)).map((file) => file.path);
        if (existing.length > 0 && !(input.overwrite ?? false)) {
          return toolResult({
            status: 'failed',
            capabilityId,
            rootDir,
            files: existing,
            note: `目标目录已有文件，且 overwrite=false：${existing.join(', ')}`,
          });
        }

        mkdirSync(rootDir, { recursive: true });
        for (const file of files) {
          mkdirSync(dirname(file.path), { recursive: true });
          writeFileSync(file.path, file.content, 'utf-8');
        }

        return toolResult({
          status: 'created',
          capabilityId,
          rootDir,
          files: files.map((file) => file.path),
          note: `capability 模板已生成到 ${rootDir}`,
        });
      } catch (error) {
        return toolResult({
          status: 'failed',
          capabilityId: null,
          rootDir: null,
          files: [],
          note: error instanceof Error ? error.message : String(error),
        });
      }
    },
    {
      name: 'scaffold_capability_plugin',
      description: '在本地生成一个可加载的 PinPawo CAPABILITY.md 模板。默认写到 ~/.pinpawo/capabilities/<id>/；只有确定需要 finalize 时才应另加代码 entry。',
      schema: scaffoldCapabilityPluginInputSchema,
      responseFormat: 'content_and_artifact',
    },
  );
}

export function createValidateCapabilityPluginTool(): StructuredTool {
  return tool(
    async ({ rootDir }) => {
      try {
        const dir = resolve(expandHome(rootDir));
        const validation = await validateCapabilityPlugin(dir);
        if (!validation.ok || !validation.capability) {
          return toolResult({
            status: 'failed',
            capabilityId: null,
            rootDir: dir,
            files: [
              validation.capabilityPath,
              ...(validation.entryPath ? [validation.entryPath] : []),
            ].filter((path) => existsSync(path)),
            note: validation.errors.join('; '),
          });
        }

        const capability = validation.capability;
        const warnings = [...validation.warnings];
        const keywordResult = checkCapabilityKeywordQueries({
          name: capability.name,
          description: capability.description,
        });
        if (keywordResult.keywords.length < 3) {
          warnings.push('capability.description 可检索关键词偏少；建议加入用户会说的核心短语，并用逗号/顿号分隔');
        }

        return toolResult({
          status: 'validated',
          capabilityId: capability.name,
          rootDir: dir,
          files: [
            validation.capabilityPath,
            ...(validation.entryPath ? [validation.entryPath] : []),
          ],
          note: `验证完成：${basename(dir)}`,
          warnings,
          keywords: keywordResult.keywords,
        });
      } catch (error) {
        return toolResult({
          status: 'failed',
          capabilityId: null,
          rootDir: resolve(expandHome(rootDir)),
          files: [],
          note: error instanceof Error ? error.message : String(error),
        });
      }
    },
    {
      name: 'validate_capability_plugin',
      description: '验证某个 capability 目录是否包含有效的 CAPABILITY.md；如声明 entry，同时检查它只导出 lifecycle.finalize。',
      schema: validateCapabilityPluginInputSchema,
      responseFormat: 'content_and_artifact',
    },
  );
}

export function createCheckCapabilityKeywordsTool(): StructuredTool {
  return tool(
    async (input) => {
      try {
        const dir = input.rootDir ? resolve(expandHome(input.rootDir)) : null;
        let capabilityId = input.name?.trim() || null;
        let description = input.description?.trim() || '';
        const files: string[] = [];

        if (dir) {
          const validation = await validateCapabilityPlugin(dir);
          if (!validation.ok || !validation.capability) {
            return toolResult({
              status: 'failed',
              capabilityId: null,
              rootDir: dir,
              files: existsSync(validation.capabilityPath)
                ? [validation.capabilityPath]
                : [],
              note: validation.errors.join('; '),
            });
          }
          files.push(validation.capabilityPath);
          if (validation.entryPath) files.push(validation.entryPath);
          capabilityId = validation.capability.name;
          description = validation.capability.description;
        }

        if (!capabilityId || !description) {
          return toolResult({
            status: 'failed',
            capabilityId,
            rootDir: dir,
            files,
            note: '请提供 rootDir，或同时提供 name 和 description。',
          });
        }

        const result = checkCapabilityKeywordQueries({
          name: capabilityId,
          description,
          queries: input.queries,
        });
        const missed = result.keywordChecks.filter((item) => !item.matched);
        return toolResult({
          status: 'validated',
          capabilityId,
          rootDir: dir,
          files,
          note: missed.length === 0
            ? '关键词检查通过：给定 query 都能命中该 capability。'
            : `关键词检查完成：${missed.length} 个 query 未命中，建议把 suggestedDescriptionTerms 补进 description。`,
          warnings: missed.map((item) => `query 未命中：${item.query}`),
          keywords: result.keywords,
          keywordChecks: result.keywordChecks,
          suggestedDescriptionTerms: result.suggestedDescriptionTerms,
        });
      } catch (error) {
        return toolResult({
          status: 'failed',
          capabilityId: null,
          rootDir: input.rootDir ? resolve(expandHome(input.rootDir)) : null,
          files: [],
          note: error instanceof Error ? error.message : String(error),
        });
      }
    },
    {
      name: 'check_capability_keywords',
      description: '检查 capability 的 name/description 是否能被 capability_search 按用户自然语言 query 正常发现，并给出建议补充的关键词。',
      schema: checkCapabilityKeywordsInputSchema,
      responseFormat: 'content_and_artifact',
    },
  );
}

export function buildCapabilityCreatorTools(): StructuredTool[] {
  return [
    createScaffoldCapabilityPluginTool(),
    createValidateCapabilityPluginTool(),
    createCheckCapabilityKeywordsTool(),
  ];
}

export function createCapabilityCreatorToolkit(): AgentToolkit {
  const tools = buildCapabilityCreatorTools() as [
    NamedStructuredTool<'scaffold_capability_plugin'>,
    NamedStructuredTool<'validate_capability_plugin'>,
    NamedStructuredTool<'check_capability_keywords'>,
  ];
  return defineToolkit({
    name: 'capability_creator',
    description: '生成、验证和检查 capability 插件模板。',
    tools: tools.map((toolItem) => ({
      tool: toolItem,
      operation: capabilityCreatorOperationMetadata[toolItem.name],
    })),
  });
}
