import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tool } from '@langchain/core/tools';
import type { StructuredTool } from '@langchain/core/tools';
import {
  defineToolset,
  extractCapabilityKeywords,
  readRecord,
  readString,
  readStringArray,
  resultStatusSummary,
  searchCapabilities,
  splitCapabilitySearchTerms,
  type AgentToolset,
  type NamedStructuredTool,
  type ToolkitOperationMetadata,
} from '@pinpawo/pet-agent';
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
  ToolkitOperationMetadata
>;

function renderManifest(params: {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
}) {
  return `${json({
    id: params.id,
    name: params.name,
    description: params.description,
    icon: params.icon,
    color: params.color,
    defaultEnabled: true,
    builtIn: false,
  })}\n`;
}

function renderIndexJs(params: {
  id: string;
  description: string;
  task: string;
}) {
  return `export function createCapability() {
  return {
    name: ${JSON.stringify(params.id)},
    description: ${JSON.stringify(params.description)},
    availability: {
      cache: 'startup',
      check: async () => ({
        available: true,
        reason: 'template capability has no external runtime dependency',
      }),
    },
    createRuntime: async () => ({
      uses: ['bash'],
      instructions: [
        ${JSON.stringify(`你负责：${params.task}`)},
        ${JSON.stringify('先把用户目标拆成明确步骤，再决定要读取、写入或更新哪些文件。')},
        ${JSON.stringify('修改文件前先确认目录和现有内容；优先使用 read_file、view_file_chunk、apply_file_patch、update_file，只有需要整体重写时才用 write_file。')},
        ${JSON.stringify('如果需要新增或调整 capability 插件文件，保持 manifest.json 的 id 与这里导出的 name 完全一致。')},
        ${JSON.stringify('完成后总结产出的文件、验证结果，以及用户接下来需要手动确认或补充的内容。')},
      ],
    }),
  };
}

export default createCapability;
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
- \`manifest.json\`: UI metadata and capability id
- \`index.js\`: runtime entry loaded by local-agent
- \`index.test.mjs\`: dependency-free smoke test

## Install location
\`${params.rootDir}\`

## Validate
\`\`\`bash
node ${JSON.stringify(resolve(params.rootDir, 'index.test.mjs'))}
\`\`\`

## Notes
- This template is intentionally dependency-free so it can be loaded from \`~/.pinpawo/capabilities\` without a local \`node_modules\`.
- If you later need custom tools or typed source files, either add local dependencies inside this plugin directory, or place the plugin inside a repo path and append that path to \`capability_dirs\`.
- Keep \`manifest.json.id\` and \`createCapability().name\` identical.
- \`availability.check\` runs when local-agent starts, and again only on explicit refresh. Return \`available: false\` if required files, binaries, credentials, or services are missing.

## Capability goal
${params.description}
`;
}

function renderSmokeTest(params: { id: string; rootDir: string }) {
  const manifestPath = resolve(params.rootDir, 'manifest.json');
  return `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCapability } from './index.js';

const capability = createCapability();
assert.equal(capability.name, ${JSON.stringify(params.id)});
assert.equal(typeof capability.description, 'string');
assert.equal(typeof capability.createRuntime, 'function');
if (capability.availability) {
  assert.equal(typeof capability.availability.check, 'function');
  const availability = await capability.availability.check();
  assert.equal(typeof availability.available, 'boolean');
}

const runtime = await capability.createRuntime({});
assert.ok(Array.isArray(runtime.instructions), 'runtime.instructions should be an array');

const manifest = JSON.parse(await readFile(${JSON.stringify(manifestPath)}, 'utf-8'));
assert.equal(manifest.id, capability.name);
assert.equal(manifest.builtIn, false);

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

type PluginCapabilityShape = {
  name?: string;
  description?: string;
  availability?: {
    check?: (...args: unknown[]) => unknown;
    cache?: unknown;
  };
  createRuntime?: (...args: unknown[]) => unknown;
};

async function readPluginCapability(indexPath: string): Promise<PluginCapabilityShape | null> {
  const mod = await import(`${pathToFileURL(indexPath).href}?t=${Date.now()}`) as {
    createCapability?: () => PluginCapabilityShape;
    default?: () => PluginCapabilityShape;
  };
  const factory = mod.createCapability ?? mod.default;
  return typeof factory === 'function' ? factory() : null;
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
    createRuntime: () => ({}),
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
          { path: resolve(rootDir, 'manifest.json'), content: renderManifest({
            id: capabilityId,
            name: input.name.trim(),
            description: input.description.trim(),
            icon: input.icon?.trim() || 'wand.and.stars',
            color: input.color?.trim() || 'purple',
          }) },
          { path: resolve(rootDir, 'index.js'), content: renderIndexJs({
            id: capabilityId,
            description: input.description.trim(),
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
      description: '在本地生成一个可加载的 PinPawo capability 插件模板。默认写到 ~/.pinpawo/capabilities/<id>/，并生成 manifest.json、index.js、README.md、index.test.mjs、package.json。',
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
        const manifestPath = resolve(dir, 'manifest.json');
        const indexPath = resolve(dir, 'index.js');
        const warnings: string[] = [];

        if (!existsSync(manifestPath) || !existsSync(indexPath)) {
          return toolResult({
            status: 'failed',
            capabilityId: null,
            rootDir: dir,
            files: [manifestPath, indexPath].filter((path) => existsSync(path)),
            note: 'manifest.json 或 index.js 缺失，无法验证。',
          });
        }

        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
        const capability = await readPluginCapability(indexPath);
        if (!capability) {
          return toolResult({
            status: 'failed',
            capabilityId: null,
            rootDir: dir,
            files: [manifestPath, indexPath],
            note: 'index.js 必须导出 createCapability() 或默认导出。',
          });
        }

        if (!capability?.name || typeof capability.createRuntime !== 'function') {
          return toolResult({
            status: 'failed',
            capabilityId: null,
            rootDir: dir,
            files: [manifestPath, indexPath],
            note: 'createCapability() 返回的对象必须包含 name 和 createRuntime。',
          });
        }
        if (typeof capability.description !== 'string' || !capability.description.trim()) {
          warnings.push('capability.description 不能为空；capability_search 依赖 name + description 做候选发现');
        }
        const keywordResult = checkCapabilityKeywordQueries({
          name: capability.name,
          description: capability.description ?? '',
        });
        if (keywordResult.keywords.length < 3) {
          warnings.push('capability.description 可检索关键词偏少；建议加入用户会说的核心短语，并用逗号/顿号分隔');
        }

        if (manifest.id !== capability.name) {
          warnings.push(`manifest.id (${String(manifest.id)}) 与 capability.name (${capability.name}) 不一致`);
        }
        if (manifest.builtIn !== false) {
          warnings.push('建议用户插件的 manifest.json 中显式写 builtIn: false');
        }
        if (capability.availability) {
          if (typeof capability.availability.check !== 'function') {
            warnings.push('capability.availability.check 必须是函数，否则 local-agent 无法做启动期可用性判断');
          }
          if (
            capability.availability.cache !== undefined
            && capability.availability.cache !== 'startup'
            && capability.availability.cache !== 'none'
          ) {
            warnings.push('capability.availability.cache 只支持 startup 或 none');
          }
        }

        return toolResult({
          status: 'validated',
          capabilityId: capability.name,
          rootDir: dir,
          files: [manifestPath, indexPath],
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
      description: '验证某个 capability 插件目录是否包含有效的 manifest.json 和 index.js，并检查 createCapability 导出和 id 对齐情况。',
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
        const indexPath = dir ? resolve(dir, 'index.js') : null;
        const manifestPath = dir ? resolve(dir, 'manifest.json') : null;
        let capabilityId = input.name?.trim() || null;
        let description = input.description?.trim() || '';
        const files: string[] = [];

        if (dir) {
          if (!indexPath || !existsSync(indexPath)) {
            return toolResult({
              status: 'failed',
              capabilityId: null,
              rootDir: dir,
              files,
              note: 'index.js 缺失，无法读取 capability.name/description。',
            });
          }
          files.push(indexPath);
          if (manifestPath && existsSync(manifestPath)) files.push(manifestPath);

          const capability = await readPluginCapability(indexPath);
          if (!capability?.name) {
            return toolResult({
              status: 'failed',
              capabilityId: null,
              rootDir: dir,
              files,
              note: 'index.js 必须导出 createCapability() 或默认导出，并返回 name。',
            });
          }
          capabilityId = capability.name;
          description = typeof capability.description === 'string' ? capability.description : '';
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

export function createCapabilityCreatorToolset(): AgentToolset {
  const tools = buildCapabilityCreatorTools() as [
    NamedStructuredTool<'scaffold_capability_plugin'>,
    NamedStructuredTool<'validate_capability_plugin'>,
    NamedStructuredTool<'check_capability_keywords'>,
  ];
  return defineToolset({
    name: 'capability_creator',
    description: '生成、验证和检查 capability 插件模板的 capability-private toolset。',
    tools,
    operations: capabilityCreatorOperationMetadata,
  });
}
