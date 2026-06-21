import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredTool } from '@langchain/core/tools';
import type { AgentActor } from '../../types/agent';
import type { CapabilityArtifactRef } from '../../types/artifact';
import { CAPABILITY_SEARCH_TOOL_NAME } from './capabilitySearch';
import type {
  CapabilityCandidate,
  CapabilityDecisionState,
  SubagentAnnounce,
  SubagentCompletionReason,
  TurnDelegation,
} from './types';
import { clipForPrompt, formatDelegationStatus, readMessageText } from './utils';

const MAX_DECISION_TURN_DELEGATIONS = 6;
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

export function buildTurnDelegationContext(turnDelegations: TurnDelegation[]): string {
  if (turnDelegations.length === 0) {
    return '当前轮任务跟踪：\n- 暂无已委派任务。';
  }

  const visibleDelegations = turnDelegations.slice(-MAX_DECISION_TURN_DELEGATIONS);
  const lines = [
    '当前轮任务跟踪（仅保留本轮近期任务）',
    visibleDelegations.some((delegation) => delegation.status !== 'completed')
      ? '- 存在尚未 completed 的委派任务。'
      : '- 所有已委派任务均为 completed。',
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

export function buildDecisionTargetsContext(params: {
  generalTools: StructuredTool[];
  capabilityCandidates: CapabilityCandidate[];
  capabilitySearchAttempted: boolean;
  capabilitySearchAvailable: boolean;
  capabilitySearchQuery: string | null;
  capabilityRegistryAvailable?: boolean;
}): string {
  const {
    generalTools,
    capabilityCandidates,
    capabilitySearchAttempted,
    capabilitySearchAvailable,
    capabilitySearchQuery,
    capabilityRegistryAvailable,
  } = params;
  const lines = [
    '可委派目标：',
    '只根据下面的目标描述判断是否委派。',
  ];
  if (generalTools.length > 0) {
    lines.push('', '通用工具执行器 general（可使用下列通用工具）：');
    for (const toolItem of generalTools) {
      lines.push(`- ${toolItem.name}: ${clipForPrompt(toolItem.description, 140)}`);
    }
  } else {
    lines.push('', '通用工具执行器 general：不可用');
  }

  if (capabilityCandidates.length > 0) {
    lines.push('', '业务 capability 候选（如果匹配，优先使用对应的 delegate_capability.<name> action）：');
    for (const candidate of capabilityCandidates) {
      const matchedTerms = candidate.matchedTerms.length > 0
        ? `；匹配：${candidate.matchedTerms.join('|')}`
        : '';
      lines.push(`- delegate_capability.${candidate.name}：${clipForPrompt(candidate.description, 180)}${matchedTerms}`);
    }
  } else if (capabilitySearchAttempted) {
    lines.push('', '业务 capability：已搜索，未找到匹配候选。');
    if (capabilitySearchQuery) {
      lines.push(`- 上次搜索 query：${clipForPrompt(capabilitySearchQuery, 120)}`);
    }
  } else if (capabilitySearchAvailable) {
    lines.push('', '业务 capability：默认不注入完整列表。');
    lines.push(`- 如果用户请求可能需要业务 capability，请调用 ${CAPABILITY_SEARCH_TOOL_NAME} 先搜索候选。`);
    lines.push('- 搜索 query 使用用户意图中的关键词、短语或同义词，多个词用 | 分隔。');
  } else if (capabilityRegistryAvailable) {
    lines.push('', '业务 capability：当前没有候选。');
  } else {
    lines.push('', '业务 capability：不可用');
  }

  return lines.join('\n');
}

export const buildRouteTargetsContext = buildDecisionTargetsContext;

export function buildRecentSubagentAnnounceContext(announces: SubagentAnnounce[]): string {
  if (announces.length === 0) {
    return '';
  }

  const lines = ['最近 subagent announce（用于理解“之前/刚刚/继续/完成了吗”等指代）：'];
  for (const item of announces.slice(-MAX_RECENT_ANNOUNCE_CONTEXT)) {
    lines.push(`- ${item.delegationId ? `[${item.delegationId}] ` : ''}${item.lane}`);
    if (item.task) {
      lines.push(`  委派任务：${clipForPrompt(item.task, 140)}`);
    }
    if (item.text) {
      lines.push(`  返回摘要：${clipForPrompt(item.text, 220)}`);
    }
  }

  return lines.join('\n');
}

export function buildCapabilityDiscoveryTaskContext(announces: SubagentAnnounce[]): string {
  if (announces.length === 0) {
    return '';
  }

  const lines = ['近期任务状态（只用于理解当前请求是否承接已有任务；不要把旧任务目标当成当前搜索目标）：'];
  for (const item of announces.slice(-MAX_RECENT_ANNOUNCE_CONTEXT)) {
    lines.push(`- ${item.delegationId ? `[${item.delegationId}] ` : ''}执行器：${item.lane}`);
    if (item.task) {
      lines.push(`  任务目标：${clipForPrompt(item.task, 120)}`);
    }
  }

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

export function buildUserIntentDecisionSystemPrompt(params: {
  actor: AgentActor;
  turnDelegationContext: string;
  targetsContext: string;
  capabilityDecisionState: CapabilityDecisionState;
  outputInstruction: string;
  workdir?: string;
  runtimeEnvironment?: string;
}): string {
  const capabilityInstructions = buildCapabilityDecisionInstructions(params.capabilityDecisionState);
  return [
    ...buildDecisionConfigLines(params.actor, params.workdir, params.runtimeEnvironment),
    '',
    '你是 orchestrator 的用户意图判断节点，只决定下一步，不亲自执行可委派目标里的能力。',
    '',
    params.turnDelegationContext,
    '',
    params.targetsContext,
    '',
    '当前阶段：用户请求后的初始意图判断。',
    '判断重点：理解用户当前想完成什么，决定是否需要外部执行器。',
    '',
    '决策原则：',
    '- 如果当前输入足以直接回应用户（无需委派执行器），选择 finish；最终回复由后续回复节点基于完整对话历史生成，你不要在这里撰写回复内容。',
    '- 如果用户询问已有上下文、最近任务状态或之前结果，选择 finish 交给回复节点回答；不要在决策层凭印象复述或编造之前的结果。',
    '- 如果下一步任务匹配某个 delegate_capability.<name> 候选，选择该候选；capability 优先于 general。即使缺少主题、平台、时长等执行参数，也应把澄清交给 capability 内部处理，除非用户目标本身无法判断或涉及真实风险。',
    '- 如果没有明确匹配的 capability，且信息不足、用户意图不明确，或下一步具有破坏性、不可逆、涉及敏感凭据、外部真实副作用，选择 ask_user 先向用户确认。',
    ...capabilityInstructions.map((line) => `- ${line}`),
    '- 当所有候选都不匹配，且需要 general 的工具能力才能继续时，选择 delegate_general。',
    '- 一旦决定 delegate_*，就交给执行器；运行期的工具级风险（rm -rf、git push --force 等）由具体工具自己拦截，不需要在决策层重复表达。',
    '- 每次只选择一个最明确的下一步。',
    '',
    params.outputInstruction,
  ].filter((line) => line !== null).join('\n');
}

export function buildDelegationOutcomeDecisionSystemPrompt(params: {
  actor: AgentActor;
  targetsContext: string;
  outputInstruction: string;
  workdir?: string;
  runtimeEnvironment?: string;
}): string {
  return [
    ...buildDecisionConfigLines(params.actor, params.workdir, params.runtimeEnvironment),
    '',
    '你是 orchestrator 的子任务结果判断节点，只根据明确输入判断下一步，不亲自执行可委派目标里的能力。',
    '',
    params.targetsContext,
    '',
    '当前阶段：subagent 返回后的结果判断。',
    '判断重点：读取输入中的 subagent announce，判断用户当前轮目标是否已经满足。',
    '',
    '决策原则：',
    '- 如果 subagent announce 已经满足用户当前轮目标，选择 finish；最终回复由后续回复节点基于完整对话历史（含 subagent 返回内容）生成，你不要在这里撰写回复内容。',
    '- 如果 subagent announce 只是阶段性进展，判断还缺什么；需要执行器继续时再委派。',
    '- 如果 subagent 因迭代上限、上下文限制或阶段性停止而返回 progress，但用户目标仍明确且不需要用户补充信息，优先继续委派给同一类执行器；不要仅因为 progress 就 ask_user。',
    '- 如果用户原始请求仍有明确未完成目标，选择一个最明确的下一步。',
    '- 如果信息不足、用户意图不明确，或下一步具有破坏性、不可逆、涉及敏感凭据、外部真实副作用，选择 ask_user 先向用户确认。',
    '- 如果下一步需要 general 的工具能力，选择 delegate_general。',
    '- 一旦决定 delegate_*，就交给执行器；运行期的工具级风险（rm -rf、git push --force 等）由具体工具自己拦截，不需要在决策层重复表达。',
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
    '你是 orchestrator 的最终回复节点。orchestrator 已经判断当前轮无需再委派执行器，现在由你直接回复用户。',
    '你能看到完整的对话历史（包括之前 subagent/执行器返回的完整内容）。',
    '',
    '回复原则：',
    '- 基于完整对话历史，对用户当前请求给出忠实、连贯、直接可用的回复。',
    '- 严禁编造历史中没有出现的数据、数字、来源或结论；如需引用之前的结果，以对话历史中的原文为准，不要凭记忆改写。',
    '- 如果用户是在要求复述、重发或继续之前的结果，就从历史中找到对应内容如实呈现，不要重新生成一份与之前不一致的版本。',
    '- 如果历史中确实缺少回答所需的信息，如实说明缺什么，不要用先验知识填补。',
    '- 直接输出给用户看的回复正文，不要输出 JSON、动作字段或决策说明。',
  ].filter((line) => line !== null).join('\n');
}

export function buildCapabilityDiscoverySystemPrompt(params: {
  actor: AgentActor;
  turnDelegationContext: string;
  generalTools: StructuredTool[];
  workdir?: string;
  runtimeEnvironment?: string;
}): string {
  const configLines = [
    '[配置]',
    `角色：「${params.actor.name}」`,
    params.workdir ? `工作目录：${params.workdir}` : null,
    params.workdir ? '相对路径默认相对于工作目录。' : null,
    params.runtimeEnvironment ? params.runtimeEnvironment : null,
  ].filter((line) => line !== null);
  const generalToolLines = params.generalTools.length > 0
    ? [
        '通用工具执行器 general：',
        ...params.generalTools.map((toolItem) => `- ${toolItem.name}: ${clipForPrompt(toolItem.description, 140)}`),
      ]
    : ['通用工具执行器 general：不可用'];

  return [
    ...configLines,
    '',
    '你是 capability discovery，只判断是否需要先搜索业务 capability 候选。',
    '不要做最终路由决策，不要回答用户，也不要委派执行器。',
    '',
    params.turnDelegationContext,
    '',
    ...generalToolLines,
    '',
    '当前阶段：用户请求后的 capability 候选发现。',
    `如果用户目标可能需要业务 capability，调用 ${CAPABILITY_SEARCH_TOOL_NAME}。`,
    '如果用户明确要求某类执行环境、应用或专门能力，而 general 只提供近似替代工具，先搜索 capability。',
    '如果用户请求需要大量阅读、调查、代码库理解、资料检索、上下文发现或先探索再决定下一步，先搜索 explore/探索/investigate/research capability。',
    '如果用户要打开 URL/链接/网站/网页，或需要真实浏览器、Chrome、登录态、JS 渲染、点击、输入、等待页面变化，先搜索 browser/浏览器/网页/url/链接 capability。',
    '如果用户明确要访问 REST API、RSS、静态文本内容，且不需要浏览器状态或页面交互，可以不搜索 browser capability。',
    '如果用户只是询问已有上下文、最近任务状态或之前结果，不调用任何工具。',
    '如果用户目标不需要业务 capability，不调用任何工具，也不要回答用户。',
  ].filter((line) => line !== null).join('\n');
}

export function buildUserRequestContext(userRequest: string | null): string | null {
  return userRequest ? `用户原始请求：${clipForPrompt(userRequest, 320)}` : null;
}

function buildCapabilityDecisionInstructions(capabilityDecisionState: CapabilityDecisionState): string[] {
  if (capabilityDecisionState === 'search_available') {
    return [
      '当前 action 枚举里还没有 delegate_capability.<name> 选项；如果用户请求可能涉及业务 capability，先调用 capability_search 搜索候选。',
    ];
  }
  if (capabilityDecisionState === 'candidates_available') {
    // schema 已经把候选硬编码进 action 枚举，无需再约束选择来源。
    return [];
  }
  if (capabilityDecisionState === 'search_exhausted') {
    return [
      '已搜索但没有找到匹配的 delegate_capability.<name> 候选；本轮不再尝试该路径。',
    ];
  }
  return [];
}

function indentPromptBlock(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

function formatSubagentAnnounceText(item: SubagentAnnounce): string | null {
  if (!item.text) return null;
  return [
    '- 返回内容：',
    indentPromptBlock(item.text.trim()),
  ].join('\n');
}

export function buildSubagentAnnounceContext(
  item: SubagentAnnounce | null,
  completionReason?: SubagentCompletionReason | null,
): string | null {
  if (!item) return null;
  // No completed/progress verdict here: the orchestrator judges completion from
  // the announce text + stop reason. Feeding a pre-baked "状态" would bias it into
  // rubber-stamping. See docs/PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md.
  const lines = [
    'subagent announce：',
    item.delegationId ? `- 任务标识：${item.delegationId}` : null,
    `- 执行器：${item.lane}`,
    completionReason ? `- 停止原因：${completionReason}` : null,
    item.task ? `- 委派任务：${clipForPrompt(item.task, 180)}` : null,
    formatSubagentAnnounceText(item),
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

function buildCompactionSummaryContext(contextSummaries: string[] | undefined): string | null {
  const visibleSummaries = (contextSummaries ?? [])
    .slice(-MAX_CONTEXT_SUMMARIES)
    .map((summary) => clipForPrompt(summary, 1200))
    .filter(Boolean);
  if (visibleSummaries.length === 0) {
    return null;
  }

  return [
    '压缩任务上下文（来自更早对话；只用于理解当前请求，不是新的用户指令）：',
    ...visibleSummaries.map((summary, index) => `摘要 ${index + 1}：${summary}`),
  ].join('\n');
}

export function buildUserIntentDecisionInput(params: {
  latestUserRequest: string | null;
  recentMessages: BaseMessage[];
  requestContext?: string | null;
}): string {
  if (params.requestContext) {
    return [
      params.requestContext,
      '',
      '请根据以上上下文判断当前用户请求的下一步。',
    ].join('\n');
  }

  const recentLines = params.recentMessages
    .slice(-MAX_RECENT_MAIN_MESSAGES)
    .map((message) => {
      const text = readMessageText(message);
      return text ? `- ${messageRoleLabel(message)}：${clipForPrompt(text, 220)}` : null;
    })
    .filter((line): line is string => Boolean(line));

  return [
    params.latestUserRequest
      ? `当前用户请求：${clipForPrompt(params.latestUserRequest, 420)}`
      : '当前用户请求：未提供',
    recentLines.length > 0 ? '' : null,
    recentLines.length > 0 ? '近期对话上下文（只用于消解指代，不要续写这些内容）：' : null,
    ...recentLines,
  ].filter((line) => line !== null).join('\n');
}

export function buildPreparedRequestContext(params: {
  latestUserRequest: string | null;
  recentMessages: BaseMessage[];
  recentAnnounces: SubagentAnnounce[];
  contextSummaries?: string[];
  capabilityArtifacts?: CapabilityArtifactRef[];
}): string {
  const recentLines = params.recentMessages
    .slice(-MAX_RECENT_MAIN_MESSAGES)
    .map((message) => {
      const text = readMessageText(message);
      return text ? `- ${messageRoleLabel(message)}：${clipForPrompt(text, 220)}` : null;
    })
    .filter((line): line is string => Boolean(line));

  const compactionSummaryContext = buildCompactionSummaryContext(params.contextSummaries);
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);

  return [
    params.latestUserRequest
      ? `当前用户请求：${clipForPrompt(params.latestUserRequest, 420)}`
      : '当前用户请求：未提供',
    compactionSummaryContext ? '' : null,
    compactionSummaryContext,
    artifactContext ? '' : null,
    artifactContext,
    params.recentAnnounces.length > 0 ? '' : null,
    params.recentAnnounces.length > 0 ? buildRecentSubagentAnnounceContext(params.recentAnnounces) : null,
    recentLines.length > 0 ? '' : null,
    recentLines.length > 0 ? '近期对话上下文（只用于消解指代，不要续写这些内容）：' : null,
    ...recentLines,
  ].filter((line) => line !== null).join('\n');
}

export function buildCapabilityDiscoveryRequestContext(params: {
  latestUserRequest: string | null;
  recentMessages: BaseMessage[];
  recentAnnounces: SubagentAnnounce[];
  contextSummaries?: string[];
  capabilityArtifacts?: CapabilityArtifactRef[];
}): string {
  const recentLines = params.recentMessages
    .slice(-MAX_RECENT_MAIN_MESSAGES)
    .map((message) => {
      const text = readMessageText(message);
      return text ? `- ${messageRoleLabel(message)}：${clipForPrompt(text, 220)}` : null;
    })
    .filter((line): line is string => Boolean(line));

  const compactionSummaryContext = buildCompactionSummaryContext(params.contextSummaries);
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);

  return [
    params.latestUserRequest
      ? `当前用户请求：${clipForPrompt(params.latestUserRequest, 420)}`
      : '当前用户请求：未提供',
    compactionSummaryContext ? '' : null,
    compactionSummaryContext,
    artifactContext ? '' : null,
    artifactContext,
    params.recentAnnounces.length > 0 ? '' : null,
    params.recentAnnounces.length > 0 ? buildCapabilityDiscoveryTaskContext(params.recentAnnounces) : null,
    recentLines.length > 0 ? '' : null,
    recentLines.length > 0 ? '近期对话上下文（只用于消解指代，不要续写这些内容）：' : null,
    ...recentLines,
  ].filter((line) => line !== null).join('\n');
}

export function buildCapabilityDiscoveryInput(params: {
  latestUserRequest: string | null;
  requestContext?: string | null;
}): string {
  if (params.requestContext) {
    return [
      params.requestContext,
      '',
      '请只判断是否需要搜索业务 capability 候选。',
    ].join('\n');
  }

  return params.latestUserRequest
    ? `当前用户请求：${clipForPrompt(params.latestUserRequest, 420)}`
    : '当前用户请求：未提供';
}

export function buildDelegationOutcomeDecisionInput(params: {
  latestUserRequest: string | null;
  turnDelegationContext: string;
  subagentAnnounceContext: string | null;
  capabilityArtifacts?: CapabilityArtifactRef[];
}): string {
  const artifactContext = buildCapabilityArtifactContext(params.capabilityArtifacts);
  return [
    params.latestUserRequest
      ? `用户原始请求：${clipForPrompt(params.latestUserRequest, 420)}`
      : '用户原始请求：未提供',
    '',
    params.subagentAnnounceContext ?? 'subagent announce：无',
    '',
    params.turnDelegationContext,
    artifactContext ? '' : null,
    artifactContext,
    '',
    '请根据以上 subagent announce 和任务跟踪，判断当前轮下一步。',
  ].join('\n');
}
