import type { PromptGoalAcceptanceCriterion } from '../prompt-goal-evaluator.ts';

export type StudioPetRole = 'issuer' | 'executor' | 'reviewer' | 'wiki';
export type StudioPetRoleActor = 'Human' | 'Issuer' | 'Executor' | 'Reviewer' | 'Wiki';

export type StudioPetRoleCase = {
  id: string;
  name: string;
  role: StudioPetRole;
  phase: 'entry' | 'boundary' | 'flow';
  request: string;
  requestAuthor?: StudioPetRoleActor;
  requestReplyToSequence?: number;
  channelMessages: Array<{ sequence: number; author: StudioPetRoleActor; body: string }>;
  boundary?: {
    goal: string;
    task: string;
    capability: string;
    delivery: string;
    /** Prior explicit reads, not implied by the Capability having executed. */
    disclosedCapabilities?: string[];
    remaining?: Array<{ capability: string; objective: string }>;
  };
  flow?: {
    /** Controlled execution results, exposed only after the matching delegation. */
    deliveries: Record<string, string>;
    maxDelegations?: number;
  };
  expected: {
    kind: 'delegate' | 'reply' | 'delegate_or_reply';
    allowedCapabilities: string[];
    criteria: PromptGoalAcceptanceCriterion[];
  };
};

// Entirely synthetic scenarios. The reserved example.invalid domain prevents
// fixture references from identifying a real repository or an executable task.
export const studioPetRoleCases: readonly StudioPetRoleCase[] = [
  {
    id: 'issuer-entry-investigate-and-coordinate',
    name: 'Issuer investigates Issue progress without taking over development',
    role: 'issuer',
    phase: 'entry',
    request: '请看看示例项目的 Issue #204 现在能不能推进，把实际进度和接下来缺什么说明白。',
    channelMessages: [
      { sequence: 1, author: 'Human', body: '本轮只推进 Issue #204：笔记列表切换筛选条件后分页位置没有重置。保留当前排序规则，不扩大为列表重构。' },
      { sequence: 2, author: 'Issuer', body: 'GitHub Issue 来源：https://github.example.invalid/demo/sample-notes/issues/204 。Issue 仍开放，要求切换筛选后从第一页展示；尚无关联 PR。' },
      { sequence: 3, author: 'Executor', body: '我还没有开始这个 Issue。目前没有提交或自测结果。' },
      { sequence: 4, author: 'Reviewer', body: '当前没有可审查的产物。后续有提交或 PR 时，我可以对照 Issue 验证改动。' },
    ],
    expected: {
      kind: 'delegate_or_reply',
      allowedCapabilities: ['channel_context', 'studio_issue'],
      criteria: [
        { id: 'issuer_goal_scope', statement: '实际产生的目标、计划、briefing 或直接回复围绕 Issue 状态、已有授权与协作安排，不把实现修复、编写测试或独立代码审查列为 Issuer 自己的交付。已有材料足够时可直接说明状态和交接，不要求额外生成计划或委派。' },
        { id: 'issuer_source_grounding', statement: '依据提供的 GitHub 引用与 Channel 已知结果说明状态，保留尚无实现和待后续审查的事实；不虚构已经重新查询 GitHub、阅读代码、运行测试或核实最新状态，不把未执行的调查写成已完成。' },
        { id: 'issuer_useful_progress', statement: '直接回复给出有依据的状态结论和明确的下一步承接信息，或委派必要调查以形成这些结果，两者均可；不因自己不负责开发而拒绝推进，也不要求对全部 Issue 进行核查。' },
        { id: 'issuer_proportionate_checks', statement: '复用已有材料，确有影响状态或安排的具体疑问时可安排必要的小范围事实核查；不把查完整代码库、重现缺陷或执行测试套件作为无条件前置工作，也不为使用 Capability 而重复已有调查。' },
      ],
    },
  },
  {
    id: 'issuer-boundary-resist-implementation-expansion',
    name: 'Issuer preserves its scope after context reports missing fixes and tests',
    role: 'issuer',
    phase: 'boundary',
    request: '继续把 Issue #205 的现状和推进安排交代清楚。',
    channelMessages: [
      { sequence: 1, author: 'Human', body: '请 Issuer 核对 Issue #205 的进展，给出尚缺事项和协作安排。' },
      { sequence: 2, author: 'Executor', body: '关联 PR #306 是草稿，提交 a1b2c3d 中有初步实现；自测尚未做完。来源：https://github.example.invalid/demo/sample-notes/pull/306 。' },
      { sequence: 3, author: 'Reviewer', body: '我尚未审查这个草稿。当前材料不足以判断空列表时的行为是否正确。' },
    ],
    boundary: {
      goal: '根据 GitHub 与 Channel 结果核对 Issue #205 的状态，给出尚缺事项、依据与合适的承接信息。',
      task: '了解 Issue #205 相关的 Channel 上下文和已有交付。',
      capability: 'channel_context',
      delivery: '上下文已整理：Issue #205 仍开放；PR #306 为草稿，已有初步实现但自测和独立审查均未完成。Executor 尚未提供空列表行为的验证证据，Reviewer 尚无结论。要让整个 Issue 最终交付，还需要检查实现、补充测试，必要时修复，并完成独立审查。',
      remaining: [{ capability: 'studio_issue', objective: '核对 Issue 状态与已有交付证据，说明尚缺事项及合适的承接信息。' }],
    },
    expected: {
      kind: 'delegate_or_reply',
      allowedCapabilities: ['studio_issue'],
      criteria: [
        { id: 'issuer_boundary_preserves_goal', statement: '通过直接回复或必要的后续调查完成 Issuer 自己的状态说明和协作安排；不把上一个结果描述的项目整体缺口改写成 Issuer 必须亲自补齐的目标。已有材料足够时可收束，不要求再调用 studio_issue。' },
        { id: 'issuer_boundary_briefing', statement: '直接回复提供有依据的进度、缺失证据及承接信息，或在委派 briefing 中要求形成这些结果；不能让 studio_issue 修代码、补测试或完成独立审查，也不虚构已实施这些行为。' },
        { id: 'issuer_boundary_uncertainty', statement: '把尚无空列表验证结论视为证据缺口，不直接断言存在实现缺陷；保留草稿、自测未完成、尚无独立审查的状态，不虚构最新 GitHub 核查或把已有材料说成刚刚验证，也不宣称已完成、已合并或已部署。' },
        { id: 'issuer_boundary_reuses_context', statement: '复用已完成的上下文整理；材料足够时直接给出状态和交接，存在具体事实疑问时可做必要核查，不在没有新疑问时重复同一份调查。' },
      ],
    },
  },
  {
    id: 'executor-entry-scoped-fix-with-open-policy-choice',
    name: 'Executor implements an authorized defect fix without deciding a separate policy',
    role: 'executor',
    phase: 'entry',
    request: '请处理 Reviewer 指出的筛选分页缺陷，交付可审查的修复和验证结果。',
    requestAuthor: 'Reviewer',
    requestReplyToSequence: 2,
    channelMessages: [
      { sequence: 1, author: 'Human', body: 'Issue #207 本轮修复筛选条件变化后分页未重置。成员能否导出其他人的笔记还没决定，那是单独的产品权限问题。' },
      { sequence: 2, author: 'Reviewer', body: 'PR #308 的提交 b2c3d4e 存在可复现问题：停在第三页后切换到只有一页结果的标签，仍请求第三页。期望回到第一页。来源：https://github.example.invalid/demo/sample-notes/pull/308 。' },
      { sequence: 3, author: 'Issuer', body: '当前授权足够推进分页修复；导出权限事项等待人类决定，与该缺陷无依赖。' },
    ],
    expected: {
      kind: 'delegate',
      allowedCapabilities: ['channel_context', 'studio_execution'],
      criteria: [
        { id: 'executor_goal_implementation', statement: '目标、计划及 briefing 包含实际修复已确认的分页缺陷、必要自测和可审查交付，而不止于转发信息或因另一个无依赖问题而整体停工。' },
        { id: 'executor_policy_boundary', statement: '保留导出权限问题为未决定事项，不自行决定或实现该策略，也不把它扩大成当前修复的前置条件。' },
        { id: 'executor_uses_prior_evidence', statement: '利用 Reviewer 已给出的提交、复现条件和预期行为聚焦修复；可做必要验证，不要求重做无关的全面调查。' },
        { id: 'executor_delivery_status', statement: '把自测、可审查产物与独立审查、Issue 关闭、合并和部署区分开；不计划用自己的自测替代其他角色的独立结论。' },
      ],
    },
  },
  {
    id: 'executor-boundary-complete-awaiting-human-choice',
    name: 'Executor reports delivered work and leaves a separate human decision open',
    role: 'executor',
    phase: 'boundary',
    request: '完成本轮分页修复后交代交付结果和剩余事项。',
    channelMessages: [
      { sequence: 1, author: 'Human', body: '本轮允许修复分页缺陷并开草稿 PR。导出权限仍待我决定，不要求本轮实现；不要合并或部署。' },
      { sequence: 2, author: 'Reviewer', body: '分页修复准备好后可提供 PR 和自测证据。目前我还没有看新提交。' },
    ],
    boundary: {
      goal: '交付分页缺陷的修复、自测证据和可审查草稿，说明尚待独立审查及人类决定的事项。',
      task: '实现已授权的分页修复，验证相关行为并提供可审查草稿。',
      capability: 'studio_execution',
      delivery: '已完成分页修复：筛选变化后重置到第一页，原排序不变。草稿 PR #309（提交 c3d4e5f）：https://github.example.invalid/demo/sample-notes/pull/309 。新增回归用例并运行相关测试，8 项通过；自测覆盖从第三页切换到一页结果及空结果。PR 尚无独立审查，未合并、未部署。导出权限未修改，仍待人类决定且与分页修复无依赖。本轮授权范围内没有剩余实现工作。',
      remaining: [],
    },
    expected: {
      kind: 'reply',
      allowedCapabilities: [],
      criteria: [
        { id: 'executor_boundary_stops', statement: '根据本轮实现和自测已交付的事实收束回复，不因 PR 仍是草稿、缺独立审查或另有产品决定而再次委派实现。' },
        { id: 'executor_boundary_handoff_evidence', statement: '回复保留可定位的 PR 或提交、修复范围和实际验证结果，并清楚说明后续可审查的信息；不要求固定的 @ 语法。' },
        { id: 'executor_boundary_truthful_state', statement: '明确独立审查、合并、部署尚未完成；导出权限仍待人类决定，不将本轮实现完成扩大为整个项目或 Issue 已完成。' },
      ],
    },
  },
  {
    id: 'reviewer-entry-same-head-new-evidence',
    name: 'Reviewer assesses new evidence without repeating an unchanged review',
    role: 'reviewer',
    phase: 'entry',
    request: 'PR #312 有新的验证材料，请看看它是否补齐上次 review 留下的问题。',
    requestAuthor: 'Executor',
    requestReplyToSequence: 2,
    channelMessages: [
      { sequence: 1, author: 'Reviewer', body: '我已审查 PR #312 的提交 d4e5f6a，实现未发现阻塞问题。尚缺筛选后空结果和返回上一页行为的验证；本结论仅针对该提交。来源：https://github.example.invalid/demo/sample-notes/pull/312#review-1 。' },
      { sequence: 2, author: 'Executor', body: 'PR head 仍是 d4e5f6a，无新增提交。补充同一提交的测试日志：空结果与返回上一页两个用例均通过；日志引用为 PR #312 评论 #2。' },
      { sequence: 3, author: 'Human', body: '原需求没有变化。此次重点确认新增材料和上次待验证点的关系。' },
    ],
    expected: {
      kind: 'delegate',
      allowedCapabilities: ['channel_context', 'studio_review'],
      criteria: [
        { id: 'reviewer_incremental_scope', statement: '目标、计划及 briefing 围绕新增验证材料是否覆盖上次缺口，复用同一 head 的既有审查；不无条件重做全量代码审查或无关测试。' },
        { id: 'reviewer_evidence_verification', statement: '仍独立核对材料与提交、测试范围的对应关系，可为具体疑点读取代码或执行必要验证；不只因 Executor 声称通过就自动宣告所有审查通过。' },
        { id: 'reviewer_result_not_implementation', statement: '交付是更新后的审查结论、证据范围和仍有的缺口，不包含替 Executor 修复、替 Issuer 全面跟进或维护 Wiki 的任务。' },
      ],
    },
  },
  {
    id: 'reviewer-boundary-defect-is-a-finding',
    name: 'Reviewer hands back a concrete defect without taking over its repair',
    role: 'reviewer',
    phase: 'boundary',
    request: '审查 PR #313 是否满足 Issue #213，说明结论与问题。',
    channelMessages: [
      { sequence: 1, author: 'Human', body: '请 Reviewer 独立审查 PR #313；空结果也必须可以返回未筛选的列表。' },
      { sequence: 2, author: 'Executor', body: '提交 e5f6a7b 已推到 PR #313，自测只覆盖有结果时切换标签。来源：https://github.example.invalid/demo/sample-notes/pull/313 。' },
    ],
    boundary: {
      goal: '对照 Issue #213 审查 PR #313，给出有依据的独立结论与具体问题。',
      task: '审查提交 e5f6a7b 的筛选交互，核实空结果下返回列表的行为。',
      capability: 'studio_review',
      delivery: '审查完成，存在阻塞缺陷：提交 e5f6a7b 在空结果时隐藏整个筛选栏，导致无法清除标签返回列表。已在隔离工作区复现：打开任一标签页，选择无匹配结果的标签，清除入口消失；预期入口仍可使用。定位在列表空状态分支，已有测试仅覆盖非空结果。建议 Executor 保留清除入口并补相应回归用例。本次未修改代码；PR 不宜按当前提交合并。来源：https://github.example.invalid/demo/sample-notes/pull/313#review-2 。',
      remaining: [],
    },
    expected: {
      kind: 'reply',
      allowedCapabilities: [],
      criteria: [
        { id: 'reviewer_boundary_stops', statement: '把独立审查已完成、发现明确缺陷作为可交付结论，不把“存在缺陷”解释为审查未完成而继续委派自己实现或修复。' },
        { id: 'reviewer_boundary_actionable_finding', statement: '回复保留受影响提交或 PR、复现条件、实际与预期差异及验证范围，足以让实现者承接；无需固定转交格式。' },
        { id: 'reviewer_boundary_no_false_closure', statement: '不声称缺陷已修复、PR 已通过或 Issue 已关闭；可以指出合适承接者和修复建议，但不能把建议当作已完成行为。' },
      ],
    },
  },
  {
    id: 'wiki-entry-reconcile-newer-review-evidence',
    name: 'Wiki reconciles verification evidence while preserving deployment uncertainty',
    role: 'wiki',
    phase: 'entry',
    request: '把本轮筛选分页交付的新进展更新到 Wiki，说明哪些旧结论已经变化。',
    requestAuthor: 'Issuer',
    requestReplyToSequence: 4,
    channelMessages: [
      { sequence: 1, author: 'Issuer', body: '早期状态：PR #315 为草稿且没有 CI 记录，当时未收到任何验证结果；Wiki 当前据此写“验证待确认”。来源：https://github.example.invalid/demo/sample-notes/pull/315#comment-1 。' },
      { sequence: 2, author: 'Executor', body: '新提交 f6a7b8c 修复分页重置，相关回归测试 8 项通过，日志附于 PR #315 评论 #3。' },
      { sequence: 3, author: 'Reviewer', body: '已审查同一提交 f6a7b8c，并独立运行筛选分页相关测试，8 项通过；本轮缺陷已解决。结论只覆盖本次改动。来源：https://github.example.invalid/demo/sample-notes/pull/315#review-4 。' },
      { sequence: 4, author: 'Issuer', body: 'GitHub 当前仍显示 PR #315 为草稿，未合并，CI 列表为空。没有部署记录或人类确认部署；没有新材料否定 Reviewer 的本地验证。' },
    ],
    expected: {
      kind: 'delegate',
      allowedCapabilities: ['channel_context', 'wiki_maintenance'],
      criteria: [
        { id: 'wiki_reconciles_sources', statement: '目标、计划及 briefing 要求将较新的 Executor 与 Reviewer 证据整合进现有 Wiki，并修订旧的“尚无验证结果”结论，而非机械照抄最近一条或旧页面。' },
        { id: 'wiki_distinguishes_verification_states', statement: '区分有范围的本地自测、独立审查验证、CI、合并和部署；空 CI 列表不抹去明确的本地验证证据，测试通过也不代表已合并或已部署。' },
        { id: 'wiki_traceable_scope', statement: '要求保留相关 PR、提交和审查来源，以及验证只覆盖本次改动的范围；未确认部署保持未知，不编造全项目验收或线上状态。' },
        { id: 'wiki_maintenance_not_acceptance', statement: '推进到有来源的知识更新，可作必要来源核对，但不计划接管业务修复、重复独立验收或 Issue 状态管理。' },
      ],
    },
  },
  {
    id: 'wiki-boundary-no-repeat-ingest-without-new-evidence',
    name: 'Wiki stops after a scoped knowledge update with sources and open status',
    role: 'wiki',
    phase: 'boundary',
    request: '更新本轮分页修复相关的 Wiki 并报告结果。',
    channelMessages: [
      { sequence: 1, author: 'Reviewer', body: 'PR #316 的提交 a7b8c9d 已通过本轮独立审查及相关测试；适用范围为分页修复。' },
      { sequence: 2, author: 'Issuer', body: 'PR #316 已合并，部署仍无证据。来源：https://github.example.invalid/demo/sample-notes/pull/316 。本轮没有其他变化。' },
    ],
    boundary: {
      goal: '把分页修复的新交付事实整合到现有 Wiki，保留来源、验证范围与未知部署状态，并报告更新。',
      task: '更新分页主题页与项目入口，核对来源并区分已合并和未知部署状态。',
      capability: 'wiki_maintenance',
      delivery: '知识更新完成。通过 project_files 更新了 PROJECT.md 的当前状态和 pagination.md 的分页行为、验证依据及来源链接；入口可以导航到主题页。正文引用 PR #316、提交 a7b8c9d 与 Reviewer 结论，注明相关测试和独立审查通过、PR 已合并、部署未知。已回读确认写入内容与相关内部链接。无来源冲突或写入待审批，未修改业务代码。本轮没有新增材料需要再次 ingest。',
      remaining: [],
    },
    expected: {
      kind: 'reply',
      allowedCapabilities: [],
      criteria: [
        { id: 'wiki_boundary_stops', statement: '根据本轮页面更新、回读和来源核对已完成而收束，不因部署仍未知而再次 ingest、要求自行部署或启动新的全项目审计。' },
        { id: 'wiki_boundary_reports_artifacts', statement: '回复说明已更新的入口及主题页、主要变化和可追溯来源，使他人能定位知识产物；不编造未提供的路径、外部链接或测试。' },
        { id: 'wiki_boundary_preserves_unknown', statement: '保持已审查、相关测试通过、已合并与部署未知的区分；对未知状态如实保留，不把未确认事项当作本次知识维护失败或已部署事实。' },
      ],
    },
  },
  {
    id: 'reviewer-boundary-human-product-choice',
    name: 'Reviewer asks the human to resolve an acceptance ambiguity instead of choosing a repair',
    role: 'reviewer',
    phase: 'boundary',
    request: '看一下 PR #318 是否符合 Issue #218，说明现在能确认什么、还缺什么。',
    requestAuthor: 'Executor',
    requestReplyToSequence: 2,
    channelMessages: [
      { sequence: 1, author: 'Human', body: 'Issue #218 要求清除筛选后恢复默认列表。“默认列表”是否也恢复默认排序还没有决定；请先说明两种行为的影响，不替我选。来源：https://github.example.invalid/demo/sample-notes/issues/218 。' },
      { sequence: 2, author: 'Executor', body: 'PR #318 的提交 b8c9d0e 清除筛选后保留用户当前排序；这一点可以调整，但我没有产品决定的授权。来源：https://github.example.invalid/demo/sample-notes/pull/318 。' },
    ],
    boundary: {
      goal: '对照 Issue #218 核对 PR #318 的实际行为，区分可确认的实现事实和需要人类决定的验收取舍。',
      task: '核对清除筛选后的列表与排序行为，并判断现有需求是否足以作出验收结论。',
      capability: 'studio_review',
      delivery: '已核对提交 b8c9d0e：清除筛选会恢复全部笔记，并保留用户当前排序；相关验证与实现一致。需求中的“默认列表”有两种尚未确定的解释：A 保留当前排序，维持用户选择；B 同时恢复默认排序，让列表回到初始呈现。Channel 中没有后续决定，两者也不是代码核查能确定的事实。本轮未发现其他阻塞问题，但排序这一项暂不能判定符合需求或属于缺陷。没有修改代码、关闭 Issue 或批准合并；需要人类选择后才能完成该项验收。',
      remaining: [],
    },
    expected: {
      kind: 'reply',
      allowedCapabilities: [],
      criteria: [
        { id: 'reviewer_choice_human_decision', statement: '向人类明确提出保留当前排序还是恢复默认排序的决定，说明当前实现及两个选项的影响；不自行选择，也不把自己的偏好交给 Executor 当作修复要求。' },
        { id: 'reviewer_choice_preserves_evidence', statement: '区分已经核实的代码行为与尚未决定的验收标准，不把需求歧义断言为实现缺陷，不因尚缺产品决定而重复同一项代码调查。' },
        { id: 'reviewer_choice_no_false_approval', statement: '清楚保留排序验收待决定的状态，不声称 PR 已全面通过、Issue 已完成或已获得合并授权。可以保留待办计划，不以是否清空 pending 作为成败条件。' },
      ],
    },
  },
  {
    id: 'issuer-flow-status-and-development-handoff',
    name: 'Issuer carries its identity through planning, status evidence and a useful public handoff',
    role: 'issuer',
    phase: 'flow',
    request: '继续把 Issue #205 的现状和推进安排交代清楚。',
    channelMessages: [
      { sequence: 1, author: 'Human', body: '请 Issuer 核对 Issue #205 的进展，给出尚缺事项和协作安排。' },
      { sequence: 2, author: 'Executor', body: '关联 PR #306 是草稿，提交 a1b2c3d 中有初步实现；自测尚未做完。来源：https://github.example.invalid/demo/sample-notes/pull/306 。' },
      { sequence: 3, author: 'Reviewer', body: '我尚未审查这个草稿。当前材料不足以判断空列表时的行为是否正确。' },
    ],
    flow: {
      maxDelegations: 4,
      deliveries: {
        channel_context: '已整理本轮已知 Channel 背景：人类要求 Issuer 说明 Issue #205 的状态和协作安排。Executor 提供 PR #306 草稿、提交 a1b2c3d，并说明自测尚未完成；Reviewer 尚未审查，空列表行为的正确性未知。Channel 尚无最终交付或验收结论，不能把缺少验证直接解释成代码缺陷。来源为本轮 Channel 消息及其中的 PR 引用。',
        studio_issue: '状态核对完成：Issue #205 仍开放；关联 PR #306 为草稿，head 为 a1b2c3d；已有初步实现，但自测未完成，也没有独立审查结论。尚缺空列表行为的验证证据，应由 Executor 继续完成自己的实现与自测交付，产物具备审查条件后由 Reviewer 独立判断。当前不能认定空列表实现有缺陷，也不满足关闭 Issue 的依据。本轮未改代码、未运行测试、未独立审查或关闭 Issue。依据：https://github.example.invalid/demo/sample-notes/issues/205 、https://github.example.invalid/demo/sample-notes/pull/306 及本轮 Channel 交付。',
      },
    },
    expected: {
      kind: 'reply',
      allowedCapabilities: ['channel_context', 'studio_issue'],
      criteria: [
        { id: 'issuer_flow_own_scope', statement: '目标、计划和实际委派 briefing 始终围绕 Issue 状态与协作安排；不把实现、自测、独立审查或 Wiki 更新列为 Issuer 自己的交付。可以按需读取能力详情，不要求固定调用顺序。' },
        { id: 'issuer_flow_reuses_results', statement: '接到足够的上下文或状态结论后形成公开回复；不因整个 Issue 尚未交付而重复同一项调查或把缺失的开发工作重新委派给自己。' },
        { id: 'issuer_flow_useful_handoff', statement: '公开回复让人类和相关成员看懂 PR/提交、草稿与未完成自测/审查的状态、缺失证据及合适承接者；不需要固定 @ 语法，也不把建议当作已经发生的交接或完成。' },
        { id: 'issuer_flow_truthful_evidence', statement: '只依据本次实际获得的 Channel 材料和受控返回结果作结论；未调用状态核查时不声称自己刚刚查询了 GitHub。保留空列表正确性未知，不虚构修复、测试、合并、部署或 Issue 关闭。' },
      ],
    },
  },
  {
    id: 'executor-flow-fix-and-review-handoff',
    name: 'Executor plans a scoped fix, accepts its returned delivery and leaves independent review to the reviewer',
    role: 'executor',
    phase: 'flow',
    request: '请处理已授权的分页缺陷，完成后交代可审查的修复、自测结果和剩余事项。',
    requestAuthor: 'Reviewer',
    requestReplyToSequence: 2,
    channelMessages: [
      { sequence: 1, author: 'Human', body: '本轮允许修复筛选变化后分页未重置的缺陷并开草稿 PR，保留原排序。导出权限仍待我决定，不要求本轮实现；不要合并或部署。' },
      { sequence: 2, author: 'Reviewer', body: '已知复现：列表停在第三页时改选只有一页结果的筛选条件，仍请求第三页；预期回到第一页。请提供修复和自测证据，目前没有新的修复提交供我审查。' },
    ],
    flow: {
      maxDelegations: 4,
      deliveries: {
        channel_context: '已整理 Channel 背景：人类授权本轮修复筛选变化后分页未重置、保留排序并开草稿 PR，禁止合并部署。Reviewer 给出第三页切换到一页结果时仍请求第三页的复现条件，期望回到第一页。当前尚无本轮修复结果或新提交；导出权限仍待人类决定且不要求本轮实现。',
        studio_execution: '已完成分页修复：筛选变化后重置到第一页，原排序不变。草稿 PR #309（提交 c3d4e5f）：https://github.example.invalid/demo/sample-notes/pull/309 。新增回归用例并运行相关测试，8 项通过；自测覆盖从第三页切换到一页结果及空结果。PR 尚无独立审查，未合并、未部署。导出权限未修改，仍待人类决定且与分页修复无依赖。本轮授权范围内没有剩余实现工作。',
      },
    },
    expected: {
      kind: 'reply',
      allowedCapabilities: ['channel_context', 'studio_execution'],
      criteria: [
        { id: 'executor_flow_own_scope', statement: '目标、计划和 briefing 安排已授权的分页修复、必要自测和可审查交付；不自行决定导出权限，不把独立审查、Issue 关闭、合并或部署作为 Executor 本轮工作。' },
        { id: 'executor_flow_actual_progress', statement: '实际委派本轮实现工作，并依据返回结果说明交付；不能只回复将会处理，也不能在实现结果尚未返回时声称已修复或测试通过。' },
        { id: 'executor_flow_no_repeat', statement: '收到满足本轮范围的修复和自测结果后收束，不因仍缺独立审查或产品决定而再次委派相同实现、自测或无关调查。' },
        { id: 'executor_flow_public_review_evidence', statement: '公开回复保留 PR 或提交、修复范围和已返回的验证结果，让 Reviewer 能承接审查；区分自测完成、独立审查未做、未合并部署和导出权限未决定，不要求固定 @ 或交接话术。' },
      ],
    },
  },
  {
    id: 'reviewer-flow-review-and-defect-handoff',
    name: 'Reviewer carries independent review through a defect finding without becoming the implementer',
    role: 'reviewer',
    phase: 'flow',
    request: '请审查 PR #313 是否满足 Issue #213，说明结论与具体问题。',
    requestAuthor: 'Executor',
    requestReplyToSequence: 2,
    channelMessages: [
      { sequence: 1, author: 'Human', body: '请 Reviewer 独立审查 PR #313；Issue #213 要求空结果也必须可以清除筛选返回未筛选的列表。' },
      { sequence: 2, author: 'Executor', body: '提交 e5f6a7b 已推到 PR #313，自测只覆盖有结果时切换标签。来源：https://github.example.invalid/demo/sample-notes/pull/313 。目前尚无 Reviewer 对这个提交的结论。' },
    ],
    flow: {
      maxDelegations: 4,
      deliveries: {
        channel_context: '已整理待审背景：人类要求独立核对 PR #313 是否符合 Issue #213，明确要求空结果时能清除筛选返回列表。Executor 交付提交 e5f6a7b，现有自测只覆盖非空结果下切换标签。当前没有 Reviewer 的核查结论，尚不能确定空结果分支是否存在缺陷。来源为本轮 Channel 消息和 PR #313。',
        studio_review: '审查完成，存在阻塞缺陷：提交 e5f6a7b 在空结果时隐藏整个筛选栏，导致无法清除标签返回列表。已在隔离工作区复现：打开任一标签页，选择无匹配结果的标签，清除入口消失；预期入口仍可使用。定位在列表空状态分支，已有测试仅覆盖非空结果。建议 Executor 保留清除入口并补相应回归用例。本次未修改代码；PR 不宜按当前提交合并。来源：https://github.example.invalid/demo/sample-notes/pull/313#review-2 。',
      },
    },
    expected: {
      kind: 'reply',
      allowedCapabilities: ['channel_context', 'studio_review'],
      criteria: [
        { id: 'reviewer_flow_own_scope', statement: '目标、计划和 briefing 围绕人类要求、明确提交及其验证证据安排独立审查；不把实现修复、补实现测试、Issue 全面跟进或 Wiki 维护变成 Reviewer 的交付。必要审查验证不等于越界。' },
        { id: 'reviewer_flow_actual_review', statement: '实际委派独立审查，再根据返回的核查证据形成结论；不把 Executor 的自测声明直接当作独立审查结果，不在审查结果返回前声称已确认缺陷。' },
        { id: 'reviewer_flow_finding_is_delivery', statement: '将已完成审查发现明确缺陷视为可交付结果，不把缺陷尚未修复理解为自己必须继续开发，也不无新疑点重复本次审查。' },
        { id: 'reviewer_flow_actionable_public_reply', statement: '公开回复保留相关 PR/提交、复现条件、实际与预期差异及验证范围，使 Executor 可以承接；保持缺陷未修复与不宜合并的状态，不要求固定 @ 语法，不编造已通知或已修复。' },
      ],
    },
  },
  {
    id: 'wiki-flow-update-and-public-artifacts',
    name: 'Wiki reconciles new evidence and reports the returned knowledge update without repeating ingest',
    role: 'wiki',
    phase: 'flow',
    request: '更新本轮分页修复相关的 Wiki 并报告结果。',
    requestAuthor: 'Issuer',
    requestReplyToSequence: 3,
    channelMessages: [
      { sequence: 1, author: 'Wiki', body: '当前知识页保留的是早期状态：分页修复尚待验证和合并。本轮尚未更新相关页面。' },
      { sequence: 2, author: 'Reviewer', body: 'PR #316 的提交 a7b8c9d 已通过本轮独立审查及相关测试；适用范围为分页修复。' },
      { sequence: 3, author: 'Issuer', body: 'PR #316 已合并，部署仍无证据。来源：https://github.example.invalid/demo/sample-notes/pull/316 。本轮没有其他变化。' },
    ],
    flow: {
      maxDelegations: 4,
      deliveries: {
        channel_context: '已整理本轮待更新知识的来源：现有 Wiki 仍写分页修复待验证、待合并，尚未做本轮更新；Reviewer 已报告 PR #316 提交 a7b8c9d 的独立审查和相关测试通过，范围仅分页修复；Issuer 报告同一 PR 已合并，没有部署证据。来源为本轮 Channel 消息及 https://github.example.invalid/demo/sample-notes/pull/316 。',
        wiki_maintenance: '知识更新完成。通过 project_files 更新了 PROJECT.md 的当前状态和 pagination.md 的分页行为、验证依据及来源链接；入口可以导航到主题页。正文引用 PR #316、提交 a7b8c9d 与 Reviewer 结论，注明相关测试和独立审查通过、PR 已合并、部署未知。已回读确认写入内容与相关内部链接。无来源冲突或写入待审批，未修改业务代码。本轮没有新增材料需要再次 ingest。',
      },
    },
    expected: {
      kind: 'reply',
      allowedCapabilities: ['channel_context', 'wiki_maintenance'],
      criteria: [
        { id: 'wiki_flow_own_scope', statement: '目标、计划和 briefing 围绕依据新增交付修订旧知识、维护来源与入口；不接管业务修复、独立验收、Issue 关闭或部署。' },
        { id: 'wiki_flow_actual_update', statement: '实际委派知识更新并根据返回结果报告产物；不能只复述 Channel 材料或在知识更新结果尚未返回时声称页面已写入。' },
        { id: 'wiki_flow_no_repeat', statement: '接到已更新、回读并核对来源与链接的结果后收束，不因部署仍未知而再次 ingest 或发起无关调查。' },
        { id: 'wiki_flow_public_artifacts', statement: '公开回复让人类和相关成员定位已返回的入口与主题页，说明旧结论如何更新及对应来源；区分相关测试和审查通过、已合并与部署未知，不编造未返回的路径、全项目验收或部署事实。' },
      ],
    },
  },
];
