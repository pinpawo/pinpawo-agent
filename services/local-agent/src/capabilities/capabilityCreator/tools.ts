import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import {
  defineToolkit,
  GENERAL_CAPABILITY_NAME,
  readRecord,
  readString,
  resultStatusSummary,
  type AgentToolkit,
  type NamedStructuredTool,
  type ToolOperationMetadata,
} from '@pinpawo/pet-agent';
import { validateCapabilityPlugin } from '../../capabilityLoader';
import {
  capabilityCreatorResultSchema,
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
          uses: record?.uses,
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
} satisfies Record<
  'scaffold_capability_plugin' | 'validate_capability_plugin',
  ToolOperationMetadata
>;

function renderCapabilityDocument(params: {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  task: string;
  uses: string[];
  workflow?: string[];
  boundaries?: string[];
  outputRequirements?: string[];
}) {
  const workflow = params.workflow?.length
    ? params.workflow
    : [
        '确认当前请求是否属于本 Capability 的职责边界，信息不足时先说明缺口。',
        '按最小必要步骤执行任务，只使用 frontmatter `uses` 声明的 Toolkit。',
        '对关键结果做必要验证；工具结果未确认成功时，不要声称已完成。',
      ];
  const boundaries = params.boundaries?.length
    ? params.boundaries
    : [
        '严格限定在本 Capability 的职责内；超出范围时明确说明并建议更合适的处理方式。',
        '不假设未声明的工具、权限、数据源或外部状态已经可用。',
      ];
  const outputRequirements = params.outputRequirements?.length
    ? params.outputRequirements
    : [
        '给出简洁、可执行的结果，并区分已确认事实、局限和待确认项。',
      ];
  const normalizeListItem = (item: string) => item.replace(/\s*\n\s*/g, ' ');
  const orderedList = (items: string[]) => items
    .map((item, index) => `${String(index + 1)}. ${normalizeListItem(item)}`)
    .join('\n');
  const bulletList = (items: string[]) => items
    .map((item) => `- ${normalizeListItem(item)}`)
    .join('\n');
  const renderedUses = params.uses.length > 0
    ? `uses:\n${params.uses.map((name) => `  - ${JSON.stringify(name)}`).join('\n')}`
    : 'uses: []';

  return `---
name: ${params.id}
description: ${JSON.stringify(params.description)}
${renderedUses}
version: 1
icon: ${JSON.stringify(params.icon)}
color: ${JSON.stringify(params.color)}
defaultEnabled: true
---

# ${params.name}

## 职责

${params.task}

## 执行流程

${orderedList(workflow)}

## 约束与边界

${bulletList(boundaries)}

## 输出要求

${bulletList(outputRequirements)}
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
npm test
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

function renderSmokeTest(params: { id: string }) {
  return `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const document = await readFile(new URL('./CAPABILITY.md', import.meta.url), 'utf-8');
assert.match(document, /^---\\n/);
assert.match(document, /name:\\s*${params.id}/);
assert.match(document, /uses:(?: \\[\\]|\\n(?:\\s+-\\s+.+\\n)+)/);
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
        if (capabilityId === GENERAL_CAPABILITY_NAME) {
          return toolResult({
            status: 'failed',
            capabilityId,
            rootDir: null,
            files: [],
            note: `capability id "${GENERAL_CAPABILITY_NAME}" 由 local-agent host 保留，请使用其他 id。`,
          });
        }

        const rootDir = resolveCapabilityRoot(input.rootDir, capabilityId);
        const uses = input.uses ?? ['bash'];
        const files = [
          { path: resolve(rootDir, 'CAPABILITY.md'), content: renderCapabilityDocument({
            id: capabilityId,
            name: input.name.trim(),
            description: input.description.trim(),
            icon: input.icon?.trim() || 'wand.and.stars',
            color: input.color?.trim() || 'purple',
            task: input.task.trim(),
            uses,
            workflow: input.workflow,
            boundaries: input.boundaries,
            outputRequirements: input.outputRequirements,
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

        const validation = await validateCapabilityPlugin(rootDir);
        if (!validation.ok || !validation.capability) {
          return toolResult({
            status: 'failed',
            capabilityId,
            rootDir,
            files: files.map((file) => file.path),
            note: `文件已写入，但加载契约验证失败：${validation.errors.join('; ')}`,
          });
        }

        const warnings = [...validation.warnings];
        if (capabilityId !== input.id) {
          warnings.push(`capability id 已从 "${input.id}" 归一化为 "${capabilityId}"`);
        }
        return toolResult({
          status: 'created',
          capabilityId,
          rootDir,
          files: files.map((file) => file.path),
          note: `capability 模板已生成并通过加载契约验证：${rootDir}`,
          warnings,
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
      description: '在本地生成并立即验证 PinPawo CAPABILITY.md。可显式声明 Toolkit、执行流程、边界和输出契约；默认写到 ~/.pinpawo/capabilities/<id>/。',
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
        return toolResult({
          status: 'validated',
          capabilityId: capability.name,
          rootDir: dir,
          files: [
            validation.capabilityPath,
            ...(validation.entryPath ? [validation.entryPath] : []),
          ],
          note: `验证完成：${basename(dir)}`,
          warnings: validation.warnings,
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

export function buildCapabilityCreatorTools(): StructuredTool[] {
  return [
    createScaffoldCapabilityPluginTool(),
    createValidateCapabilityPluginTool(),
  ];
}

export function createCapabilityCreatorToolkit(): AgentToolkit {
  const tools = buildCapabilityCreatorTools() as [
    NamedStructuredTool<'scaffold_capability_plugin'>,
    NamedStructuredTool<'validate_capability_plugin'>,
  ];
  return defineToolkit({
    name: 'capability_creator',
    description: '设计、生成并验证可加载的 capability 插件。',
    tools: tools.map((toolItem) => ({
      tool: toolItem,
      operation: capabilityCreatorOperationMetadata[toolItem.name],
    })),
  });
}
