import { z } from 'zod';
import type {
  OrchestrationDecisionStructuredOutputConfig,
  OrchestrationDecisionStructuredOutputOptions,
} from './types';

/**
 * Static action kinds — values that don't depend on the current capability set.
 * `delegate_capability.<name>` values are appended at schema-build time.
 */
const STATIC_ACTION_KINDS = ['finish', 'delegate_general'] as const;
const CAPABILITY_ACTION_PREFIX = 'delegate_capability.' as const;

export type CapabilityActionName = `${typeof CAPABILITY_ACTION_PREFIX}${string}`;
export type ActionName = (typeof STATIC_ACTION_KINDS)[number] | CapabilityActionName;

export type OrchestrationDecision = {
  action: ActionName;
  task?: string | null;
  context_summary?: string | null;
};

export type OrchestrationDecisionSchemaParams = {
  capabilityCandidates: ReadonlyArray<{ name: string }>;
};

export function buildCapabilityActionName(capabilityName: string): CapabilityActionName {
  return `${CAPABILITY_ACTION_PREFIX}${capabilityName}` as CapabilityActionName;
}

export function parseAction(action: string): {
  kind: 'finish' | 'delegate_general' | 'delegate_capability';
  capabilityName: string | null;
} {
  if (action.startsWith(CAPABILITY_ACTION_PREFIX)) {
    return {
      kind: 'delegate_capability',
      capabilityName: action.slice(CAPABILITY_ACTION_PREFIX.length) || null,
    };
  }
  if (action === 'finish' || action === 'delegate_general') {
    return { kind: action, capabilityName: null };
  }
  // Unknown action; surfaced upstream by schema rejection. Default to finish for safety.
  return { kind: 'finish', capabilityName: null };
}

export function buildOrchestrationDecisionSchema(params: OrchestrationDecisionSchemaParams) {
  const seen = new Set<string>();
  for (const candidate of params.capabilityCandidates) {
    if (candidate.name.includes('.')) {
      throw new Error(
        `capability name must not contain '.': received "${candidate.name}". `
        + `Action enum encodes lane via "${CAPABILITY_ACTION_PREFIX}<name>".`,
      );
    }
    if (seen.has(candidate.name)) {
      throw new Error(`duplicate capability name in decision schema: "${candidate.name}"`);
    }
    seen.add(candidate.name);
  }

  const actionValues = [
    ...STATIC_ACTION_KINDS,
    ...params.capabilityCandidates.map((c) => buildCapabilityActionName(c.name)),
  ] as [string, ...string[]];

  return z.object({
    action: z.enum(actionValues).describe(
      '下一步动作。delegate_capability.<name> 表示委派给指定业务 capability 对应的 lane。',
    ),
    task: z.string().nullable().optional().describe(
      'action=delegate_general 或 delegate_capability.<name> 时交给执行器的明确任务；其他 action 为 null 或省略。',
    ),
    context_summary: z.string().nullable().optional().describe(
      'action=delegate_general 或 delegate_capability.<name> 时执行器所需的简短上下文；其他 action 为 null 或省略。',
    ),
  });
}

export function buildOrchestrationDecisionStructuredOutputOptions(
  config?: OrchestrationDecisionStructuredOutputConfig,
): OrchestrationDecisionStructuredOutputOptions {
  return {
    name: 'orchestration_decision',
    ...(config?.method ? { method: config.method } : {}),
    ...(typeof config?.strict === 'boolean' ? { strict: config.strict } : {}),
    ...(typeof config?.autoRepair !== 'undefined' ? { autoRepair: config.autoRepair } : {}),
  };
}

export function buildOrchestrationDecisionOutputInstruction(): string {
  return [
    '输出一个结构化 orchestration decision。',
    '必须返回一个 JSON object，字段名必须严格使用：action、task、context_summary。',
    '必须使用 action 字段表达下一步动作；不要输出 delegate_capability、delegate_general 或 finish 作为字段名。',
    'action 取值：',
    '- finish：无需继续委派，交给后续 answer 节点基于完整对话历史回复用户；你只需选择 finish，不要在这里撰写最终回复内容。',
    '- delegate_general：委派给通用工具执行器。',
    '- delegate_capability.<name>：委派给指定业务 capability。<name> 必须从当前候选里选。',
    '字段语义：',
    '- action 必填，且必须是上面的枚举值之一。',
    '- task 只在 delegate_general 或 delegate_capability.<name> 时填写明确任务；其他 action 为 null 或省略。',
    '- context_summary 只在 delegate_general 或 delegate_capability.<name> 时填写必要上下文；其他 action 为 null 或省略。',
    '正确示例：{"action":"delegate_capability.explore","task":"调查当前项目 typecheck 失败原因并修复。","context_summary":"用户要求定位并修复 typecheck 失败。"}',
    '一旦决定 delegate_* 就直接交给执行器；运行期的工具级风险由具体工具自己拦截，无需在决策层重复表达。',
  ].join('\n');
}

export function readDecisionText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}
