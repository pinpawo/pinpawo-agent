import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { StudioAgent, StudioContext } from '../../types/studio';
import type { SubagentToolEventHandler } from '../../types/subagent';
import { createPlanCapability } from './planCapability';
import type {
  ExecuteAction,
  PetAgentRuntime,
  PetAgentRuntimeDescriptor,
  StudioDispatchState,
  StudioOrchestrator,
  StudioOrchestratorConfig,
  StudioOrchestratorInvokeInput,
  StudioTask,
  StudioTaskPlan,
  StudioTurnEvent,
  StudioTurnEventHandler,
  StudioTurnOutcome,
  StudioTurnResult,
  StudioTurnState,
} from './types';
import { createSkeletonWikiCurator, ensureWikiSkeleton } from './wikiCurator';
import type { WikiCurator } from './wikiCurator';

const DEFAULT_MAX_ITERATION_COUNT = 32;
const DEFAULT_MAX_RETRY_PER_TASK = 2;

function toStudioAgent(descriptor: PetAgentRuntimeDescriptor): StudioAgent {
  return {
    petId: descriptor.petId,
    userId: descriptor.userId,
    name: descriptor.name,
    personality: descriptor.personality,
    stage: descriptor.stage,
    species: descriptor.species,
    role: descriptor.role ?? null,
    serviceSummary: descriptor.serviceSummary ?? null,
    startupMode: descriptor.startupMode,
    status: descriptor.status,
    capabilities: descriptor.capabilities,
  };
}

function isDispatchable(descriptor: PetAgentRuntimeDescriptor): boolean {
  return (
    descriptor.startupMode !== 'disabled'
    && (descriptor.status === 'standby' || descriptor.status === 'degraded')
  );
}

function buildWikiRoot(baseDir: string, conversationId: string): string {
  return path.resolve(baseDir, 'conv', conversationId, 'wiki');
}

function findNextPendingIndex(state: StudioTurnState): number {
  if (!state.plan) return -1;
  return state.plan.tasks.findIndex((task) => task.status === 'pending');
}

/**
 * 内部状态机:基于当前 state 决定下一个 ExecuteAction。
 * 不引入 LLM,纯规则:
 * - 有 pending task → dispatch(by index)
 * - 所有 task 处理完 + 有 satisfied dispatch → finish
 * - 否则 → stop
 *
 * task 的身份是 plan.tasks 数组下标——稳定、唯一、由数据结构保证。
 */
function decideExecuteAction(state: StudioTurnState): ExecuteAction {
  if (!state.plan) {
    return { type: 'stop', reason: 'no plan' };
  }
  const pendingIndex = findNextPendingIndex(state);
  if (pendingIndex >= 0) {
    const task = state.plan.tasks[pendingIndex];
    return { type: 'dispatch', taskIndex: pendingIndex, brief: task.goal };
  }
  const satisfiedDispatches = state.dispatches.filter(
    (dispatch) => dispatch.status === 'finished' && dispatch.resultText,
  );
  if (satisfiedDispatches.length > 0) {
    return { type: 'finish', finalDispatchId: satisfiedDispatches[satisfiedDispatches.length - 1].id };
  }
  return { type: 'stop', reason: 'plan 全部 task 失败,无可作交付的产出' };
}

/**
 * 把可选的 onTurnEvent 包成一个稳定的同步可调用对象。
 * 不 await — handler 若返回 promise,Studio 不阻塞编排。
 * handler 抛错也不影响主流程。
 */
function makeEmitter(handler: StudioTurnEventHandler | undefined): (event: StudioTurnEvent) => void {
  if (!handler) return () => {};
  return (event) => {
    try {
      const ret = handler(event);
      if (ret && typeof (ret as Promise<void>).catch === 'function') {
        (ret as Promise<void>).catch(() => {});
      }
    } catch {
      // 不让 handler 抛错影响 turn
    }
  };
}


export function createStudioOrchestrator(config: StudioOrchestratorConfig): StudioOrchestrator {
  const agentsByPetId = new Map<string, PetAgentRuntime>();
  for (const agent of config.agents) {
    const descriptor = agent.descriptor();
    if (agentsByPetId.has(descriptor.petId)) {
      throw new Error(`Duplicate pet agent id in studio: ${descriptor.petId}`);
    }
    agentsByPetId.set(descriptor.petId, agent);
  }

  // plannerPetId 在用 planner 流程时必须解析到一个注册的 agent。延迟到
  // invoke 时校验,允许 caller 在测试 / debug 路径下传入显式 plan 跳过 planner。

  const maxIterationCount = config.maxIterationCount ?? DEFAULT_MAX_ITERATION_COUNT;
  const maxRetryPerTask = config.maxRetryPerTask ?? DEFAULT_MAX_RETRY_PER_TASK;
  const curator: WikiCurator = config.curator ?? createSkeletonWikiCurator();

  function listAgents(): PetAgentRuntimeDescriptor[] {
    return config.agents.map((agent) => agent.descriptor());
  }

  function context(): StudioContext {
    return {
      studioId: config.studioId,
      ownerUserId: config.ownerUserId,
      defaultPetId: config.defaultPetId ?? null,
      agents: listAgents().map(toStudioAgent),
    };
  }

  async function runDispatch(
    state: StudioTurnState,
    action: Extract<ExecuteAction, { type: 'dispatch' }>,
    signal: AbortSignal | undefined,
    onToolEvent: SubagentToolEventHandler | undefined,
    emit: (event: StudioTurnEvent) => void,
  ): Promise<StudioDispatchState> {
    if (!state.plan) {
      throw new Error('runDispatch called without a plan');
    }
    const task = state.plan.tasks[action.taskIndex];
    if (!task) {
      throw new Error(`task at index ${action.taskIndex} not found in plan`);
    }
    const taskIndex = action.taskIndex;

    function changeTaskStatus(nextStatus: StudioTask['status']): void {
      task.status = nextStatus;
      emit({ type: 'task_status_changed', taskIndex, status: nextStatus });
    }

    const agent = agentsByPetId.get(task.petId);
    const dispatch: StudioDispatchState = {
      id: randomUUID().slice(0, 8),
      taskIndex,
      petId: task.petId,
      status: 'running',
      brief: action.brief,
      startedAt: new Date().toISOString(),
    };
    state.dispatches.push(dispatch);
    emit({ type: 'dispatch_started', dispatchId: dispatch.id, taskIndex, petId: task.petId });

    if (!agent) {
      dispatch.status = 'cancelled';
      dispatch.errorMessage = `agent_not_found:${task.petId}`;
      dispatch.finishedAt = new Date().toISOString();
      changeTaskStatus('failed');
      emit({
        type: 'dispatch_finished',
        dispatchId: dispatch.id,
        status: 'cancelled',
        errorMessage: dispatch.errorMessage,
      });
      return dispatch;
    }

    const descriptor = agent.descriptor();
    if (!isDispatchable(descriptor)) {
      dispatch.status = 'cancelled';
      dispatch.errorMessage = `agent_not_dispatchable:${descriptor.status}`;
      dispatch.finishedAt = new Date().toISOString();
      changeTaskStatus('failed');
      emit({
        type: 'dispatch_finished',
        dispatchId: dispatch.id,
        status: 'cancelled',
        errorMessage: dispatch.errorMessage,
      });
      return dispatch;
    }

    try {
      const result = await agent.invoke({
        brief: action.brief,
        wikiRoot: state.wikiRoot,
        signal,
        onToolEvent,
        threadId: `studio:${config.studioId}:thread:${state.conversationId}:pet:${task.petId}:dispatch:${dispatch.id}`,
        workdir: config.workdir,
      });
      dispatch.status = 'finished';
      dispatch.resultText = result.reply;
      dispatch.finishedAt = new Date().toISOString();
      changeTaskStatus('satisfied');
    } catch (error) {
      dispatch.status = 'finished';
      dispatch.errorMessage = error instanceof Error ? error.message : String(error);
      dispatch.finishedAt = new Date().toISOString();
      task.retryCount += 1;
      if (task.retryCount >= maxRetryPerTask) {
        changeTaskStatus('failed');
      }
    }

    try {
      const curateResult = await curator.curate({ wikiRoot: state.wikiRoot, dispatch });
      if (curateResult.changedPaths.length > 0) {
        emit({ type: 'wiki_updated', changedPaths: curateResult.changedPaths });
      }
    } catch (curatorError) {
      dispatch.errorMessage = dispatch.errorMessage
        ?? `wiki_curator_failed:${(curatorError as Error).message}`;
    }

    emit({
      type: 'dispatch_finished',
      dispatchId: dispatch.id,
      status: dispatch.status === 'finished' ? 'finished' : 'cancelled',
      resultText: dispatch.resultText,
      errorMessage: dispatch.errorMessage,
    });

    return dispatch;
  }

  function buildOutcome(state: StudioTurnState, action: ExecuteAction): StudioTurnOutcome {
    if (action.type === 'finish') {
      const dispatch = state.dispatches.find((d) => d.id === action.finalDispatchId);
      return {
        outcome: 'done',
        finalDispatchId: action.finalDispatchId,
        reply: dispatch?.resultText ?? '',
      };
    }
    if (action.type === 'stop') {
      const lastFinished = state.dispatches.filter((d) => d.status === 'finished' && d.resultText).pop();
      return {
        outcome: 'stopped',
        reason: action.reason,
        reply: lastFinished?.resultText ?? `(stopped: ${action.reason})`,
      };
    }
    return { outcome: 'stopped', reason: 'unexpected execute action', reply: '' };
  }

  async function obtainPlan(params: {
    userRequest: string;
    explicit: StudioTaskPlan | undefined;
    wikiRoot: string;
    signal?: AbortSignal;
    onToolEvent?: SubagentToolEventHandler;
    conversationId: string;
  }): Promise<{ plan: StudioTaskPlan | null; plannerReply: string | null }> {
    if (params.explicit) {
      return {
        plan: {
          tasks: params.explicit.tasks.map<StudioTask>((task) => ({
            ...task,
            status: task.status ?? 'pending',
            retryCount: task.retryCount ?? 0,
          })),
        },
        plannerReply: null,
      };
    }

    const planner = agentsByPetId.get(config.plannerPetId);
    if (!planner) {
      throw new Error(`plannerPetId "${config.plannerPetId}" not found in registered agents`);
    }
    let capturedPlan: StudioTaskPlan | null = null;
    const planCapability = createPlanCapability({
      onSubmit: (plan) => {
        capturedPlan = plan;
      },
      availableAgents: listAgents().map((descriptor) => ({
        petId: descriptor.petId,
        role: descriptor.role ?? null,
        serviceSummary: descriptor.serviceSummary ?? null,
      })),
    });

    const result = await planner.invoke({
      brief: params.userRequest,
      wikiRoot: params.wikiRoot,
      signal: params.signal,
      onToolEvent: params.onToolEvent,
      threadId: `studio:${config.studioId}:thread:${params.conversationId}:planner`,
      workdir: config.workdir,
      extraCapabilities: [planCapability],
      // 强制 planCapability 成为 userIntentDecision 候选,绕过 keyword 搜索 ——
      // 用户请求文本(例如"做一支秋日食材短视频")无法匹到 studio_plan 描述,
      // 不强制注入就会被错误地 delegate 到 general lane,planner 永远不会
      // 调 submit_plan。
      forcedCapabilityNames: [planCapability.name],
    });

    return { plan: capturedPlan, plannerReply: result.reply };
  }

  async function invoke(input: StudioOrchestratorInvokeInput): Promise<StudioTurnResult> {
    const turnId = input.turnId ?? randomUUID();
    const conversationId = input.conversationId ?? turnId;
    const wikiRoot = buildWikiRoot(config.wikiBaseDir, conversationId);
    await ensureWikiSkeleton(wikiRoot);

    const emit = makeEmitter(input.onTurnEvent);
    emit({ type: 'turn_started', turnId, userRequest: input.userRequest });

    const { plan, plannerReply } = await obtainPlan({
      userRequest: input.userRequest,
      explicit: input.plan,
      wikiRoot,
      signal: input.signal,
      onToolEvent: input.onToolEvent,
      conversationId,
    });

    if (!plan) {
      const reason = plannerReply
        ? `planner did not submit a plan: ${plannerReply}`
        : 'planner did not submit a plan';
      emit({ type: 'turn_finished', outcome: 'stopped' });
      return {
        turnId,
        state: {
          turnId,
          conversationId,
          userRequest: input.userRequest,
          plan: null,
          dispatches: [],
          wikiRoot,
          iterationCount: 0,
        },
        outcome: {
          outcome: 'stopped',
          reason,
          reply: plannerReply ?? `(stopped: ${reason})`,
        },
        studio: context(),
      };
    }

    emit({ type: 'plan_set', plan });

    const state: StudioTurnState = {
      turnId,
      conversationId,
      userRequest: input.userRequest,
      plan,
      dispatches: [],
      wikiRoot,
      iterationCount: 0,
    };

    let outcome: StudioTurnOutcome | null = null;

    while (state.iterationCount < maxIterationCount) {
      state.iterationCount += 1;

      const action = decideExecuteAction(state);

      if (action.type === 'finish' || action.type === 'stop') {
        outcome = buildOutcome(state, action);
        break;
      }

      const dispatch = await runDispatch(state, action, input.signal, input.onToolEvent, emit);

      if (input.signal?.aborted) {
        outcome = {
          outcome: 'stopped',
          reason: 'aborted by signal',
          reply: dispatch.resultText ?? '',
        };
        break;
      }
    }

    if (!outcome) {
      outcome = {
        outcome: 'stopped',
        reason: `max iteration count ${maxIterationCount} reached`,
        reply: '',
      };
    }

    emit({
      type: 'turn_finished',
      outcome: outcome.outcome,
      ...(outcome.outcome === 'done' ? { finalDispatchId: outcome.finalDispatchId } : {}),
    });

    return {
      turnId,
      state,
      outcome,
      studio: context(),
    };
  }

  return {
    context,
    listAgents,
    invoke,
  };
}
