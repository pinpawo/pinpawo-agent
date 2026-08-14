import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defineCapability,
  defineCapabilityDocumentSource,
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import { parseFrontmatterDocument } from '../../capabilityLoader';

export const STUDIO_PLANNING_CAPABILITY_NAME = 'studio_planning';

function resolveDocumentUrl(): URL {
  const sourceUrl = new URL('./CAPABILITY.md', import.meta.url);
  if (existsSync(sourceUrl)) return sourceUrl;

  const bundledUrl = new URL('./capabilities/studioPlanning/CAPABILITY.md', import.meta.url);
  if (existsSync(bundledUrl)) return bundledUrl;

  throw new Error('Built-in studio_planning Capability document is missing');
}

function readStudioPlanningCapability(): AgentCapability {
  const documentUrl = resolveDocumentUrl();
  const documentPath = fileURLToPath(documentUrl);
  const source = readFileSync(documentUrl, 'utf8');
  const { frontmatter, body } = parseFrontmatterDocument(source, documentPath);
  return defineCapability({
    name: frontmatter.name,
    description: frontmatter.description,
    uses: frontmatter.uses,
    instructions: defineInstructionDocument({ content: body }),
    document: defineCapabilityDocumentSource({
      filePath: documentPath,
      content: source,
    }),
  });
}

let cached: AgentCapability | null | undefined;

/**
 * 开箱即用的看板拆解能力。
 *
 * 它声明 `uses: ['kanban']`,而 kanban toolkit 只在 studio 装配时作为插件注入
 * (`buildStudio`)。因此在 chat 模式下这个 Capability 会落进
 * `unavailableCapabilities` —— 那是**预期行为**,不是错误:注册表缺 toolkit 时
 * 只把 Capability 标为不可用,不抛错(`compileExecutor`)。
 *
 * 走与用户 Capability 完全相同的 Markdown 契约,用户想改写它时可以直接复制
 * CAPABILITY.md 到 `~/.pinpawo/capabilities/` 覆盖。
 */
export function loadStudioPlanningCapability(): AgentCapability | null {
  if (cached !== undefined) return cached;
  try {
    cached = readStudioPlanningCapability();
  } catch (error) {
    cached = null;
    console.warn(
      '[capabilities] built-in "studio_planning" unavailable:',
      error instanceof Error ? error.message : String(error),
    );
  }
  return cached;
}
