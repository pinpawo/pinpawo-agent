import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defineCapability,
  defineCapabilityDocumentSource,
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';

export const STUDIO_PLANNING_CAPABILITY_NAME = 'studio_planning';

function resolveDocumentUrl(): URL {
  const sourceUrl = new URL('./STUDIO_PLANNING_CAPABILITY.md', import.meta.url);
  if (existsSync(sourceUrl)) return sourceUrl;

  throw new Error('Built-in studio_planning Capability document is missing');
}

function readStudioPlanningCapability(): AgentCapability {
  const documentUrl = resolveDocumentUrl();
  const documentPath = fileURLToPath(documentUrl);
  const source = readFileSync(documentUrl, 'utf8');
  const closingFrontmatter = source.indexOf('\n---', 4);
  const body = closingFrontmatter >= 0
    ? source.slice(source.indexOf('\n', closingFrontmatter + 4) + 1)
    : source;
  return defineCapability({
    name: STUDIO_PLANNING_CAPABILITY_NAME,
    description: '在共享看板上拆解与推进任务；把目标拆成可指派的任务、认领并完成分配给自己的任务。',
    uses: ['kanban'],
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
 * 它声明 `uses: ['kanban']`,并与 kanban module 一起由应用 composition root
 * 注入 Studio。缺少 toolkit 时 Capability 会落进 `unavailableCapabilities` ——
 * 那是预期行为,不是错误:注册表只把它标为不可用,不会抛错。
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
