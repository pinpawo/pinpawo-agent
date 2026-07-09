import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentActor } from '../../types/agent';
import type { CapabilityArtifactRef } from '../../types/artifact';
import type {
  CapabilityCandidate,
  SubagentAnnounce,
  SubagentCompletionReason,
  RunDelegationSummary,
  RunPendingTask,
  RunTaskPlanDraft,
} from './types';
import { clipForPrompt, formatDelegationStatus, readMessageText } from './utils';

const MAX_DECISION_RUN_DELEGATIONS = 6;
const MAX_RECENT_MAIN_MESSAGES = 6;
const MAX_RECENT_ANNOUNCE_CONTEXT = 5;
const MAX_CONTEXT_SUMMARIES = 2;
const MAX_RECENT_CAPABILITY_ARTIFACTS = 6;

export function buildCapabilityArtifactContext(artifacts: CapabilityArtifactRef[] | undefined): string {
  if (!artifacts || artifacts.length === 0) return '';
  const lines = ['当前会话 capability artifacts（仅短引用；需要细节时交给对应 capability/host 按 ref 读取）：'];
  for (const artifact of artifacts.slice(-MAX_RECENT_CAPABILITY_ARTIFACTS)) {
    lines.push(`- [${artifact.kind}] ${clipForPrompt(artifact.title ?? artifact.id, 120)}`);
    lines.push(`  capability: ${artifact.capabilityId}; uri: ${artifact.uri}`);
    if (artifact.preview) {
      lines.push(`  preview: ${clipForPrompt(artifact.preview, 240)}`);
    }
  }
  return lines.join('\n');
}

export function buildRunDelegationSummaryContext(runDelegationSummaries: RunDelegationSummary[]): string {
  if (runDelegationSummaries.length === 0) {
    return '当前 run 任务跟踪：\n- 暂无 delegated task。';
  }

  const visibleDelegations = runDelegationSummaries.slice(-MAX_DECISION_RUN_DELEGATIONS);
  const lines = [
    '当前 run 任务跟踪（仅保留本 run 近期任务）',
    visibleDelegations.some((delegation) => delegation.status !== 'completed')
      ? '- 存在尚未 completed 的 delegated task。'
      : '- 所有 delegated task 均为 completed。',
  ];

  for (const delegation of visibleDelegations) {
    lines.push('');
    lines.push(`任务 ${delegation.id}`);
    lines.push(`- 执行器：${delegation.lane}`);
    lines.push(`- 任务目标：${clipForPrompt(delegation.task, 160)}`);
    lines.push(`- 状态：${formatDelegationStatus(delegation.status)}`);
    if (delegation.resultPreview) {
      lines.push(`- 结果摘要：${clipForPrompt(delegation.resultPreview, 220)}`);
    }
  }

  return lines.join('\n');
}

export function buildRouteTargetsContext(params: {
  generalTools: StructuredTool[];
  capabilityCandidates: CapabilityCandidate[];
  capabilitySearchAttempted: boolean;
  capabilitySearchQuery: string | null;
  capabilityRegistryAvailable?: boolean;
}): string {
  const {
    generalTools,
    capabilityCandidates,
    capabilitySearchAttempted,
    capabilitySearchQuery,
    capabilityRegistryAvailable,
  } = params;
  const lines = [
    'Route targets：',
    '只根据下面的 target 描述为当前 task 选择 lane。',
  ];
  if (generalTools.length > 0) {
    lines.push('', 'general lane（可使用下列通用工具）：');
    for (const toolItem of generalTools) {
      lines.push(`- ${toolItem.name}: ${clipForPrompt(toolItem.description, 140)}`);
    }
  } else {
    lines.push('', 'general lane：不可用');
  }

  if (capabilityCandidates.length > 0) {
    lines.push('', 'capability lane 候选（如果匹配，优先使用对应 capability.<name> lane）：');
    for (const candidate of capabilityCandidates) {
      const matchedTerms = candidate.matchedTerms.length > 0
        ? `；匹配：${candidate.matchedTerms.join('|')}`
        : '';
      lines.push(`- capability.${candidate.name}：${clipForPrompt(candidate.description, 180)}${matchedTerms}`);
    }
  } else if (capabilitySearchAttempted) {
    lines.push('', 'capability lane：已搜索，未找到匹配候选。');
    if (capabilitySearchQuery) {
      lines.push(`- 搜索 query：${clipForPrompt(capabilitySearchQuery, 120)}`);
    }
  } else if (capabilityRegistryAvailable) {
    lines.push('', 'capability lane：当前没有候选。');
  } else {
    lines.push('', 'capability lane：不可用');
  }

  return lines.join('\n');
}

function xmlTextBlock(tag: string, text: string, attrs = ''): string {
  const safeText = text.replaceAll(']]>', ']]]]><![CDATA[>');
  return [
    `<${tag}${attrs}>`,
    '<![CDATA[',
    safeText,
    ']]>',
    `</${tag}>`,
  ].join('\n');
}

function indentXmlBlock(block: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  let inCdata = false;
  return block.split('\n').map((line) => {
    if (line.trim() === '<![CDATA[') {
      inCdata = true;
      return `${prefix}${line}`;
    }
    if (line.trim() === ']]>') {
      inCdata = false;
      return `${prefix}${line}`;
    }
    return inCdata ? line : `${prefix}${line}`;
  }).join('\n');
}

export function buildDelegationOutcomeCurrentTaskContext(task: {
  id: string;
  lane: string;
  task: string;
  contextSummary: string | null;
} | null): string | null {
  if (!task) return null;
  const lines = [
    '<current_delegation>',
    `  <delegation_id>${task.id}</delegation_id>`,
    `  <lane>${task.lane}</lane>`,
    indentXmlBlock(xmlTextBlock('task', clipForPrompt(task.task, 240)), 2),
  ].filter((line): line is string => Boolean(line));
  if (task.contextSummary) {
    lines.push(indentXmlBlock(xmlTextBlock('context_summary', clipForPrompt(task.contextSummary, 320)), 2));
  }
  lines.push('</current_delegation>');
  return lines.join('\n');
}

export function buildTaskPlanDraftContext(planDraft: RunTaskPlanDraft): string | null {
  const visibleSteps = (planDraft ?? [])
    .map((step) => clipForPrompt(step, 160))
    .filter(Boolean)
    .slice(0, 5);
  if (visibleSteps.length === 0) return null;

  const lines = [
    '<task_plan_draft role="self_guidance" source="previous_task_decision">',
    '  <note>这是上一轮 taskDecision 预计还没开始的步骤草案，只作为本轮选择下一步 task 与维护后续草案的参考；它不是控制流依据。</note>',
  ];
  visibleSteps.forEach((step, index) => {
    lines.push(indentXmlBlock(xmlTextBlock('step', step, ` index="${(index + 1).toString()}"`), 2));
  });
  lines.push('</task_plan_draft>');
  return lines.join('\n');
}

export function buildDelegationOutcomeOtherTasksContext(
  runDelegationSummaries: RunDelegationSummary[],
  activeDelegationId: string | null,
): string {
  const otherDelegations = activeDelegationId
    ? runDelegationSummaries.filter((delegation) => delegation.id !== activeDelegationId)
    : runDelegationSummaries;
  if (otherDelegations.length === 0) {
    return [
      '<other_delegations>',
      '  <none>true</none>',
      '</other_delegations>',
    ].join('\n');
  }

  const visibleDelegations = otherDelegations.slice(-MAX_DECISION_RUN_DELEGATIONS);
  const lines = ['<other_delegations>'];
  for (const delegation of visibleDelegations) {
    lines.push('  <delegation>');
    lines.push(`    <delegation_id>${delegation.id}</delegation_id>`);
    lines.push(`    <lane>${delegation.lane}</lane>`);
    lines.push(`    <status>${formatDelegationStatus(delegation.status)}</status>`);
    lines.push(indentXmlBlock(xmlTextBlock('task', clipForPrompt(delegation.task, 160)), 4));
    if (delegation.resultPreview) {
      lines.push(indentXmlBlock(xmlTextBlock('result_preview', clipForPrompt(delegation.resultPreview, 220)), 4));
    }
    lines.push('  </delegation>');
  }
  lines.push('</other_delegations>');
  return lines.join('\n');
}

export function buildRecentSubagentAnnounceContext(announces: SubagentAnnounce[]): string {
  if (announces.length === 0) {
    return '';
  }

  const lines = ['最近 subagent announce（用于理解“之前/刚刚/继续/完成了吗”等指代）：'];
  for (const item of announces.slice(-MAX_RECENT_ANNOUNCE_CONTEXT)) {
    lines.push(`- ${item.delegationId ? `[${item.delegationId}] ` : ''}${item.lane}`);
    if (item.task) {
      lines.push(`  delegated task：${clipForPrompt(item.task, 140)}`);
    }
    if (item.text) {
      lines.push(`  返回摘要：${clipForPrompt(item.text, 220)}`);
    }
  }

  return lines.join('\n');
}

function buildRecentSubagentAnnounceXmlContext(announces: SubagentAnnounce[]): string | null {
  if (announces.length === 0) {
    return null;
  }

  const lines = ['<recent_subagent_announces purpose="coreference">'];
  for (const item of announces.slice(-MAX_RECENT_ANNOUNCE_CONTEXT)) {
    lines.push('  <announce>');
    if (item.delegationId) {
      lines.push(`    <delegation_id>${item.delegationId}</delegation_id>`);
    }
    lines.push(`    <lane>${item.lane}</lane>`);
    if (item.task) {
      lines.push(indentXmlBlock(xmlTextBlock('task', clipForPrompt(item.task, 140)), 4));
    }
    if (item.text) {
      lines.push(indentXmlBlock(xmlTextBlock('summary', item.text), 4));
    }
    lines.push('  </announce>');
  }
  lines.push('</recent_subagent_announces>');
  return lines.join('\n');
}

function buildDecisionConfigLines(actor: AgentActor, workdir?: string, runtimeEnvironment?: string): string[] {
  const configLines = [
    '[配置]',
    `角色：「${actor.name}」`,
    workdir ? `工作目录：${workdir}` : null,
    workdir ? '相对路径默认相对于工作目录；只有在工具显式指定其他目录时，才偏离这个目录。' : null,
    runtimeEnvironment ? runtimeEnvironment : null,
  ].filter((line) => line !== null);
  return configLines as string[];
}

// Core decision prompt prefix shared by taskDecision, routeDecision, and
// outcomeDecision. Keep this synchronized with
// docs/PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md.
function buildOrchestratorDecisionPromptPrefixLines(): string[] {
  return [
    'pet-agent orchestrator 是围绕用户目标运行 task loop 的控制层。',
    '它理解用户当前输入与对话上下文，把需要推进的工作组织成当前单步 task，交给 capability subagent 执行；subagent 以 announce 返回执行结果。',
    'task loop 由三个 decision 节点驱动：taskDecision 生成当前单步 task，routeDecision 为 task 选择执行 capability，outcomeDecision 验收 announce 并决定继续当前 task、进入下一个 task，或结束交给 answer。',
    'decision 节点只输出结构化判断字段：不回答用户、不执行工具、不编造执行事实；用户可见的回复始终由 answer 节点基于主对话生成。',
    '用户目标是 outcomeDecision 判断 task loop 继续或结束的唯一基准。',
    '',
    'task loop 流程：',
    '1. taskDecision（决策）',
    '   - 读取：用户请求、对话上下文、已完成 task 的结论摘要、上一轮 plan_draft（如有）。',
    '   - 用户目标已能直接回应 → action=answer，交给 answer。',
    '   - 还需要执行 → action=next_task，产出当前单步 task 与 search_keywords；已有 plan_draft 时同步维护它。',
    '2. capabilitySearch（系统步骤，关键词匹配）',
    '   - 用 search_keywords（缺省时用 task 文本）搜索 custom capability，产出 capability 候选。',
    '3. routeDecision（决策）',
    '   - 读取：当前 task、capability 候选。',
    '   - 从候选中选择执行 capability；没有匹配候选时兜底 general（内建通用 capability）。',
    '4. capability subagent 执行（执行步骤）',
    '   - 选中的 capability subagent 执行当前 task，以 announce 返回结果；announce 是执行结果回到 task loop 的唯一通道。',
    '5. outcomeDecision（决策）',
    '   - 读取：用户目标、当前 task、subagent announce、同一 run 的其他 task 摘要。',
    '   - continue：当前 task 未达标 → 同一 capability 继续执行，gap_note 说明缺口。',
    '   - task_done：当前 task 已达标但用户目标未完 → 系统 handoff 本任务结论；有后续 plan_draft 时回到 taskDecision，否则进入 answer。',
    '   - goal_done：用户目标已达成 → 系统 handoff 后进入 answer。',
    '6. answer（回复）',
    '   - 基于主对话（含 handoff 进来的任务结论）生成用户可见回复。',
    '',
    '术语：',
    '- 用户请求（user request）：用户本轮的原始输入。',
    '- 用户目标（user goal）：orchestrator 从用户请求和对话上下文理解出的本轮目标；它是验收的唯一基准，不等于任何任务清单或草案。',
    '- plan_draft：上一轮 taskDecision 预留的、尚未开始的后续步骤备忘；只作为 taskDecision 规划参考，不是任务清单，不是验收依据。',
    '- gap_note：outcomeDecision 在 continue / task_done 时对缺口的一句说明，作为后续执行或规划的提示。',
    '- handoff：系统动作——task 达标或 goal 达成时，把 announce 结论并入主对话并清理执行现场；此后所有节点只依赖主对话里的结论，不依赖执行过程记录。',
  ];
}

function buildSingleStepTaskInstructions(): string[] {
  return [
    '单步任务粒度：同一执行器、同一工具域内能连续完成的相邻动作算一步。',
    '复合请求只产出当前最应该先执行的一步；不要把多个阶段、多个工具域或完整编号计划塞进一个 task。',
    'task 文本必须是执行器可直接开始的明确目标，不要写成步骤清单。',
    '如果需要后续步骤，等当前 delegated task 返回后再由 outcome decision 继续判断。',
  ];
}

export function buildTaskDecisionSystemPrompt(params: {
  actor: AgentActor;
  runDelegationContext: string;
  hasTaskPlanDraft?: boolean;
  workdir?: string;
  runtimeEnvironment?: string;
}): string {
  const taskDecisionFocus = params.hasTaskPlanDraft
    ? '判断重点：根据上下文决定当前要交给执行器的单步 task；参考上一轮 plan_draft，维护当前 task 之后仍未开始的后续 task 草案。'
    : '判断重点：根据上下文决定当前要交给执行器的单步 task；当前没有上一轮 plan_draft，本轮不新建后续 task 草案。';
  const taskPlanDraftDecisionBasis = params.hasTaskPlanDraft
    ? '- 上一轮 plan_draft 只是参考：只维护本次 task 之后仍未开始的后续草案，已被最新结论覆盖的项不要保留。'
    : '- 当前没有上一轮 plan_draft：不要新建后续草案，plan_draft 必须为 null；本次 task_done 后如果没有预留草案就会进入 answer。';
  const taskPlanDraftInstructions = params.hasTaskPlanDraft
    ? [
        '- 先决定 task 字段；再参考上一轮 plan_draft，判断本次 task 之后是否还有后续 task。',
        '- 仍合理的后续 task 可以沿用；已被本次 task、已完成步骤或最新结论覆盖的项不要保留。',
        '- plan_draft 只填写本次 task 之后尚未开始的后续 task，1~5 个短句；没有后续 task 时为 null；不输出 patch、删除标记或游标。',
      ]
    : [
        '- 先决定 task 字段；plan_draft 返回 null，不要新建后续 task 草案。',
        '- 如果这是 task_done 后的回环且没有上一轮 plan_draft，表示没有预留后续 task，选择 answer 结束。',
      ];
  const planDraftFieldSemantic = params.hasTaskPlanDraft
    ? '- plan_draft 可在 action=next_task 时填写本次 task 之后尚未开始的后续 task 草案；answer 时为 null 或省略。'
    : '- plan_draft 在当前没有上一轮 plan_draft 时必须为 null；answer 时为 null 或省略。';
  const taskDecisionExample = params.hasTaskPlanDraft
    ? {
        action: 'next_task',
        task: '读取 issue #269 内容并提炼需求点。',
        context_summary: '用户要求先理解 issue，再继续检查本地实现。',
        search_keywords: 'github issue|网页抓取|需求分析',
        plan_draft: [
          '检索本地实现与 git log',
          '汇总结论并回复用户',
        ],
      }
    : {
        action: 'next_task',
        task: '读取 issue #269 内容并提炼需求点。',
        context_summary: '用户要求先理解 issue，再回复当前可得结论。',
        search_keywords: 'github issue|网页抓取|需求分析',
        plan_draft: null,
      };

  return [
    ...buildDecisionConfigLines(params.actor, params.workdir, params.runtimeEnvironment),
    '',
    ...buildOrchestratorDecisionPromptPrefixLines(),
    '',
    '当前阶段：taskDecision（用户请求后的 task 生成）。',
    '当前节点：task decision 节点。',
    '节点边界：只决定当前是否需要进入执行管道，以及当前 delegated task 是什么；不要选择 general/capability lane，不要回答用户，不要执行工具。',
    '',
    '决策原则：',
    taskDecisionFocus,
    '- action=answer：当前不需要进入执行管道，交给 answer 节点基于完整对话历史回复用户。',
    '- action=next_task：生成当前单步 delegated task，并提供必要 context_summary 与 capability search 关键词。',
    params.hasTaskPlanDraft
      ? '- 如果 action=next_task，同时维护本次 task 之后仍未开始的后续 plan_draft。'
      : '- 当前没有上一轮 plan_draft；无论 action 是什么，plan_draft 都不要新建。',
    '- 用户当前请求、近期对话上下文，以及 runDelegationSummaries 中已经完成的任务结论。',
    '- runDelegationSummaries 是只读事实账本，用来避免重复执行和理解已有结论；不要把它当作控制流命令。',
    taskPlanDraftDecisionBasis,
    params.runDelegationContext,
    '- 如果当前输入足以直接回应用户（无需 delegate 给执行器），选择 answer；最终回复由后续 answer 节点基于完整对话历史生成。',
    '- 如果用户询问已有上下文、最近任务状态或之前结果，选择 answer 交给回复节点回答；不要在决策层凭印象复述或编造之前的结果。',
    '- 如果用户目标本身无法判断，或需要向用户补充、澄清、确认，选择 answer 交给回复节点处理；不要在决策层直接提问。',
    '- 如果需要执行器读取、搜索、修改、运行命令、访问外部系统或调用专门能力，选择 next_task。',
    ...buildSingleStepTaskInstructions().map((line) => `- ${line}`),
    '- search_keywords 用于下一步 capability search：提取能匹配执行器能力的关键词、同义词或短语；多个词用 | 分隔。没有额外关键词时可为 null。',
    '- 对 code review / PR review / GitHub PR URL / 仓库变更评审类请求，search_keywords 应包含 explore、code review、PR review、repository investigation 等调查/审查词；不要只因为出现 URL 就只输出 browser/url。',
    ...taskPlanDraftInstructions,
    '',
    '输出一个结构化 task decision。',
    '必须返回一个 JSON object，字段名必须严格使用：action、task、context_summary、search_keywords、plan_draft。',
    'action 取值：',
    '- answer：无需继续 delegate，交给后续 answer 节点回复用户；不要在这里撰写最终回复内容。',
    '- next_task：生成一个单步 delegated task，交给后续 search/route 管道选择执行器。',
    '字段语义：',
    '- action 必填，且必须是上面的枚举值之一。',
    '- task 只在 action=next_task 时填写；answer 时为 null 或省略。',
    '- context_summary 只在 action=next_task 时填写必要上下文；answer 时为 null 或省略。',
    '- search_keywords 只在 action=next_task 时填写用于 capability search 的关键词；answer 时为 null 或省略。',
    planDraftFieldSemantic,
    `正确示例：${JSON.stringify(taskDecisionExample)}`,
  ].filter((line) => line !== null).join('\n');
}

export function buildRouteDecisionSystemPrompt(params: {
  actor: AgentActor;
  targetsContext: string;
  workdir?: string;
  runtimeEnvironment?: string;
}): string {
  return [
    ...buildDecisionConfigLines(params.actor, params.workdir, params.runtimeEnvironment),
    '',
    ...buildOrchestratorDecisionPromptPrefixLines(),
    '',
    '当前阶段：routeDecision（task 已生成，capability search 已完成）。',
    '当前节点：route decision 节点。',
    '节点边界：只为当前单步 task 选择执行 capability；不要改写 task，不要回答用户，不要执行工具。',
    '',
    params.targetsContext,
    '',
    '决策原则：',
    '- 如果当前 task 匹配某个 custom capability candidate，选择对应 capability.<name>；custom capability 优先于 general。',
    '- 如果所有候选都不匹配，且需要通用工具能力才能继续，选择 general。',
    '- 不要因为缺少主题、平台、时长等执行参数就避开匹配的 capability；澄清由执行器内部处理，除非 task 本身无法判断。',
    '- 每次只选择一个执行 capability。',
    '',
    '输出一个结构化 route decision。',
    '必须返回一个 JSON object，字段名必须严格使用：lane。',
    'lane 取值由 schema 限定：general 或当前候选中的 capability.<name>。',
  ].filter((line) => line !== null).join('\n');
}

export function buildDelegationOutcomeDecisionSystemPrompt(params: {
  actor: AgentActor;
  outputInstruction: string;
  workdir?: string;
  runtimeEnvironment?: string;
}): string {
  return [
    ...buildDecisionConfigLines(params.actor, params.workdir, params.runtimeEnvironment),
    '',
    ...buildOrchestratorDecisionPromptPrefixLines(),
    '',
    '当前阶段：delegationOutcomeDecision（subagent 返回后的结果验收）。',
    '当前节点：子任务结果验收节点。你的唯一职责是判断当前 delegated task 和当前 run 目标的完成度。',
    '节点边界：不要回答用户、不要总结 subagent 结果、不要生成下一步 task、不要选择 general/capability lane、不要执行工具；最终回复由后续 answer 节点生成。',
    '',
    '决策原则：',
    '- outcome=continue：当前 delegated task 未达标，但同一 task 仍可继续执行。',
    '- outcome=task_done：当前 delegated task 已达标，但用户当前 run 目标仍有明确未完成部分。',
    '- outcome=goal_done：用户当前 run 目标已经满足，或需要交给 answer 节点向用户澄清/确认。',
    '- 用户原始请求：判断当前 run 目标是什么、是否已经满足。',
    '- 当前 delegated task：判断这一次执行原本要完成什么。',
    '- subagent announce 原文：判断当前 task 是否达标的执行结果来源。',
    '- run 任务跟踪只用于理解 delegation 链路；完成与否以当前 subagent announce 是否覆盖用户目标为准。',
    '- 本节点不接收 plan 草案、不接收工具列表，也不依赖 capability 枚举。',
    '- 如果当前 delegated task 未达标，但用户目标仍明确且不需要用户补充信息，选择 continue；gap_note 简述缺口。',
    '- 如果当前 delegated task 已达标，但用户原始请求仍有明确未完成目标，选择 task_done；不要在这里写下一步 task，只在 gap_note 写未完成方向。',
    '- 如果 subagent announce 已经满足用户当前 run 目标，选择 goal_done；不要在这里撰写最终回复内容。',
    '- 如果信息不足、用户意图不明确，或下一步需要用户先补充、澄清、确认，选择 goal_done 交给 answer 节点处理；不要在决策层直接提问。',
    '- outcome 只表达验收 verdict；不要输出 task 文本、context summary、search keywords、lane 或 capability。',
    '',
    params.outputInstruction,
  ].filter((line) => line !== null).join('\n');
}

export function buildAnswerSystemPrompt(params: {
  actor: AgentActor;
  workdir?: string;
  runtimeEnvironment?: string;
}): string {
  return [
    ...buildDecisionConfigLines(params.actor, params.workdir, params.runtimeEnvironment),
    '',
    '你是 orchestrator 的最终回复节点。orchestrator 已经判断当前 run 无需再 delegate 给执行器，现在由你直接回复用户。',
    '你能看到完整的对话历史（包括之前 subagent/执行器返回的完整内容）。',
    '',
    '回复原则：',
    '- 基于完整对话历史，对用户当前请求给出忠实、连贯、直接可用的回复。',
    '- 如果最近历史里已有执行器/subagent 返回的长文结果，把它当作来源材料：提炼成面向用户的最终总结、结论、关键依据和必要后续建议。',
    '- 不要把紧邻的执行器/subagent 结果原文整体复制一遍；除非用户明确要求查看原文、完整内容或重发，否则避免重复已经展示过的 handoff 内容。',
    '- 严禁编造历史中没有出现的数据、数字、来源或结论；如需引用之前的结果，以对话历史中的原文为准，不要凭记忆改写。',
    '- 如果用户是在要求复述、重发或继续之前的结果，就从历史中找到对应内容如实呈现，不要重新生成一份与之前不一致的版本。',
    '- 如果历史中确实缺少回答或继续推进所需的信息，直接向用户提出需要补充或确认的问题，不要用先验知识填补。',
    '- 直接输出给用户看的回复正文，不要输出 JSON、动作字段或决策说明。',
  ].filter((line) => line !== null).join('\n');
}

export function buildUserRequestContext(userRequest: string | null): string | null {
  return userRequest ? `用户原始请求：${clipForPrompt(userRequest, 320)}` : null;
}

function formatSubagentAnnounceText(item: SubagentAnnounce): string | null {
  if (!item.text) return null;
  return xmlTextBlock('result', item.text.trim(), ' format="markdown" role="data"');
}

function formatSubagentAnnounceArtifactRefs(item: SubagentAnnounce): string | null {
  if (!item.artifactRefs || item.artifactRefs.length === 0) return null;
  const lines = ['  <artifacts>'];
  for (const ref of item.artifactRefs) {
    lines.push('    <artifact>');
    lines.push(`      <uri>${clipForPrompt(ref.uri, 260)}</uri>`);
    lines.push(`      <capability>${clipForPrompt(ref.capabilityId, 120)}</capability>`);
    lines.push(`      <kind>${ref.kind}</kind>`);
    if (ref.title) {
      lines.push(`      <title>${clipForPrompt(ref.title, 140)}</title>`);
    }
    if (ref.preview) {
      lines.push(indentXmlBlock(xmlTextBlock('preview', clipForPrompt(ref.preview, 180)), 6));
    }
    lines.push('    </artifact>');
  }
  lines.push('  </artifacts>');
  return lines.join('\n');
}

export function buildSubagentAnnounceContext(
  item: SubagentAnnounce | null,
  completionReason?: SubagentCompletionReason | null,
): string | null {
  if (!item) return null;
  // No completed/progress verdict here: the orchestrator judges completion from
  // the announce text + stop reason. Feeding a pre-baked "状态" would bias it into
  // rubber-stamping. See docs/PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md.
  const resultBlock = formatSubagentAnnounceText(item);
  const lines = [
    '<subagent_announce>',
    item.delegationId ? `  <delegation_id>${item.delegationId}</delegation_id>` : null,
    `  <lane>${item.lane}</lane>`,
    completionReason ? `  <stop_reason>${completionReason}</stop_reason>` : null,
    resultBlock ? indentXmlBlock(resultBlock, 2) : null,
    formatSubagentAnnounceArtifactRefs(item),
    '</subagent_announce>',
  ].filter(Boolean);
  return lines.join('\n');
}

function messageRoleLabel(message: BaseMessage): string {
  const type = message._getType();
  if (type === 'human') return '用户';
  if (type === 'ai') return '助手';
  if (type === 'system') return '系统';
  return type;
}

function buildCompactionSummaryXmlContext(contextSummaries: string[] | undefined): string | null {
  const visibleSummaries = (contextSummaries ?? [])
    .slice(-MAX_CONTEXT_SUMMARIES)
    .map((summary) => clipForPrompt(summary, 1200))
    .filter(Boolean);
  if (visibleSummaries.length === 0) {
    return null;
  }

  const lines = ['<context_summaries source="compaction" role="context">'];
  visibleSummaries.forEach((summary, index) => {
    lines.push(indentXmlBlock(xmlTextBlock('summary', summary, ` index="${(index + 1).toString()}"`), 2));
  });
  lines.push('</context_summaries>');
  return lines.join('\n');
}

function buildRecentMessagesXmlContext(messages: BaseMessage[]): string | null {
  const entries = messages
    .slice(-MAX_RECENT_MAIN_MESSAGES)
    .map((message) => {
      const text = readMessageText(message);
      if (!text) return null;
      return {
        role: messageRoleLabel(message),
        text: clipForPrompt(text, 220),
      };
    })
    .filter((entry): entry is { role: string; text: string } => Boolean(entry));

  if (entries.length === 0) {
    return null;
  }

  const lines = ['<recent_messages purpose="coreference">'];
  for (const entry of entries) {
    lines.push('  <message>');
    lines.push(`    <role>${entry.role}</role>`);
    lines.push(indentXmlBlock(xmlTextBlock('text', entry.text), 4));
    lines.push('  </message>');
  }
  lines.push('</recent_messages>');
  return lines.join('\n');
}

export function buildTaskDecisionInput(params: {
  latestUserRequest: string | null;
  recentMessages: BaseMessage[];
  requestContext?: string | null;
  taskPlanDraftContext?: string | null;
}): string {
  const context = params.requestContext ?? buildPreparedRequestContext({
    latestUserRequest: params.latestUserRequest,
    recentMessages: params.recentMessages,
    recentAnnounces: [],
  });
  const instruction = params.taskPlanDraftContext
    ? '请根据以上动态上下文判断是否需要执行器；需要时先生成当前单步 task，并维护当前 task 之后仍未开始的后续 plan_draft。'
    : '请根据以上动态上下文判断是否需要执行器；需要时只生成当前单步 task，plan_draft 返回 null，不要新建后续草案。';
  return [
    '<task_decision_input>',
    indentXmlBlock(context, 2),
    params.taskPlanDraftContext ? indentXmlBlock(params.taskPlanDraftContext, 2) : null,
    `  <instruction>${instruction}</instruction>`,
    '</task_decision_input>',
  ].filter((line) => line !== null).join('\n');
}

export function buildRouteDecisionInput(params: {
  pendingTask: RunPendingTask | null;
}): string {
  const task = params.pendingTask;
  return [
    '<route_decision_input>',
    task
      ? indentXmlBlock(xmlTextBlock('task', clipForPrompt(task.task, 420)), 2)
      : '  <task missing="true" />',
    task?.contextSummary
      ? indentXmlBlock(xmlTextBlock('context_summary', clipForPrompt(task.contextSummary, 420)), 2)
      : null,
    task?.searchKeywords
      ? indentXmlBlock(xmlTextBlock('search_keywords', clipForPrompt(task.searchKeywords, 240)), 2)
      : null,
    '  <instruction>请只为当前 task 选择执行 lane。</instruction>',
    '</route_decision_input>',
  ].filter((line) => line !== null).join('\n');
}

export function buildPreparedRequestContext(params: {
  latestUserRequest: string | null;
  recentMessages: BaseMessage[];
  recentAnnounces: SubagentAnnounce[];
  contextSummaries?: string[];
  capabilityArtifacts?: CapabilityArtifactRef[];
}): string {
  const compactionSummaryContext = buildCompactionSummaryXmlContext(params.contextSummaries);
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);
  const recentAnnouncesContext = buildRecentSubagentAnnounceXmlContext(params.recentAnnounces);
  const recentMessagesContext = buildRecentMessagesXmlContext(params.recentMessages);

  return [
    '<user_intent_context>',
    params.latestUserRequest
      ? indentXmlBlock(xmlTextBlock('user_request', clipForPrompt(params.latestUserRequest, 420)), 2)
      : '  <user_request missing="true" />',
    compactionSummaryContext ? indentXmlBlock(compactionSummaryContext, 2) : null,
    artifactContext ? indentXmlBlock(xmlTextBlock('capability_artifacts', artifactContext), 2) : null,
    recentAnnouncesContext ? indentXmlBlock(recentAnnouncesContext, 2) : null,
    recentMessagesContext ? indentXmlBlock(recentMessagesContext, 2) : null,
    '</user_intent_context>',
  ].filter((line) => line !== null).join('\n');
}

export function buildDelegationOutcomeDecisionInput(params: {
  latestUserRequest: string | null;
  currentTaskContext: string | null;
  subagentAnnounceContext: string | null;
  otherTasksContext?: string | null;
  capabilityArtifacts?: CapabilityArtifactRef[];
}): string {
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);
  return [
    '<delegation_outcome_input>',
    params.latestUserRequest
      ? indentXmlBlock(xmlTextBlock('user_request', clipForPrompt(params.latestUserRequest, 420)), 2)
      : '  <user_request missing="true" />',
    params.currentTaskContext
      ? indentXmlBlock(params.currentTaskContext, 2)
      : '  <current_delegation missing="true" />',
    params.subagentAnnounceContext
      ? indentXmlBlock(params.subagentAnnounceContext, 2)
      : '  <subagent_announce missing="true" />',
    params.otherTasksContext
      ? indentXmlBlock(params.otherTasksContext, 2)
      : null,
    artifactContext
      ? indentXmlBlock(xmlTextBlock('capability_artifacts', artifactContext), 2)
      : null,
    '  <instruction>请根据当前 delegated task、subagent announce 和用户原始请求，判断当前 run 下一步。</instruction>',
    '</delegation_outcome_input>',
  ].filter((line) => line !== null).join('\n');
}
