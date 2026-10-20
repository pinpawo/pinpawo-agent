import type { SubagentToolOperationMetadata } from '@pinpawo/pet-agent';
import {
  buildToolOperationEvent,
  type StreamToolsPayload,
} from './agent/agentStreamEvents';
import type {
  AgentOperationEvent,
  AgentOperationPhase,
} from '@pinpawo/agent-session';
import {
  emptyOperationRegistry,
  overlayOperationRegistry,
  type OperationRegistry,
} from './events/operationRegistry';

type ActiveTrackedOperation = {
  id: string;
  name: string;
  event: AgentOperationEvent;
};

type OperationSummaryFields = Pick<AgentOperationEvent['operation'], 'target' | 'summary' | 'blocks'>;

type TerminalPhase = Extract<AgentOperationPhase, 'completed' | 'failed' | 'interrupted'>;

export class ToolOperationTracker {
  private sequence = 0;
  private readonly activeById = new Map<string, ActiveTrackedOperation>();
  private readonly activeIdsByName = new Map<string, string[]>();
  private readonly summaryById = new Map<string, OperationSummaryFields>();
  private operationRegistry: OperationRegistry;

  constructor(
    private readonly requestId: string,
    operationRegistry: OperationRegistry = emptyOperationRegistry,
  ) {
    this.operationRegistry = operationRegistry;
  }

  setOperationRegistry(operationRegistry: OperationRegistry) {
    this.operationRegistry = operationRegistry;
  }

  /**
   * Merge a per-delegation `subagent_operations` announcement (#322 Phase 4)
   * so delegation-scoped toolkit operations resolve display metadata.
   */
  overlayOperations(entries: Record<string, SubagentToolOperationMetadata>) {
    this.operationRegistry = overlayOperationRegistry(this.operationRegistry, entries);
  }

  accept(payload: StreamToolsPayload): AgentOperationEvent {
    const id = this.resolveOperationId(payload);
    const built = buildToolOperationEvent(this.requestId, {
      ...payload,
      toolCallId: id,
    }, this.operationRegistry);
    const event = this.withCallSummary(built, id);
    this.track(event, payload.name, id);
    return event;
  }

  finishActive(phase: TerminalPhase, error?: unknown): AgentOperationEvent[] {
    const active = [...this.activeById.values()];
    this.activeById.clear();
    this.activeIdsByName.clear();
    this.summaryById.clear();
    return active.map((item) => ({
      ...item.event,
      phase,
      raw: {
        input: item.event.raw?.input,
        output: phase === 'completed' ? item.event.raw?.output : undefined,
        error: phase === 'failed' ? error : undefined,
      },
    }));
  }

  /**
   * A toolkit summarizes the call's arguments. The first event that carries
   * valid arguments fixes the summary for the whole call, and every later
   * event reuses it, so the result line keeps showing which file or url was
   * touched. An event without arguments yields no summary and fixes nothing.
   */
  private withCallSummary(
    event: AgentOperationEvent,
    id: string,
  ): AgentOperationEvent {
    const cached = this.summaryById.get(id);
    if (cached) return { ...event, operation: { ...event.operation, ...cached } };
    const { target, summary, blocks } = event.operation;
    if (target !== undefined || summary !== undefined || blocks !== undefined) {
      this.summaryById.set(id, {
        ...(target !== undefined ? { target } : {}),
        ...(summary !== undefined ? { summary } : {}),
        ...(blocks !== undefined ? { blocks } : {}),
      });
    }
    return event;
  }

  private resolveOperationId(payload: StreamToolsPayload) {
    const explicitId = payload.toolCallId?.trim();
    if (explicitId) {
      return explicitId;
    }
    const activeId = this.activeIdsByName.get(payload.name)?.[0];
    if (payload.event !== 'on_tool_start' && activeId) {
      return activeId;
    }
    this.sequence += 1;
    return `tool-${this.sequence}`;
  }

  private track(event: AgentOperationEvent, name: string, id: string) {
    if (event.phase === 'started') {
      this.activeById.set(id, { id, name, event });
      const ids = this.activeIdsByName.get(name) ?? [];
      this.activeIdsByName.set(name, [...ids, id]);
      return;
    }
    if (event.phase === 'updated') {
      const active = this.activeById.get(id);
      if (active) {
        this.activeById.set(id, { ...active, event });
      } else {
        this.activeById.set(id, { id, name, event });
      }
      const ids = this.activeIdsByName.get(name) ?? [];
      if (!ids.includes(id)) {
        this.activeIdsByName.set(name, [...ids, id]);
      }
      return;
    }
    this.activeById.delete(id);
    this.summaryById.delete(id);
    const ids = this.activeIdsByName.get(name);
    if (!ids) {
      return;
    }
    const nextIds = ids.filter((item) => item !== id);
    if (nextIds.length > 0) {
      this.activeIdsByName.set(name, nextIds);
    } else {
      this.activeIdsByName.delete(name);
    }
  }
}
