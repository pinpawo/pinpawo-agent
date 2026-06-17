import {
  buildToolOperationEvent,
  type StreamToolsPayload,
} from './agentStreamEvents';
import type {
  LocalAgentOperationInternalEvent,
  LocalAgentOperationPhase,
} from './events/localAgentEvent';
import {
  emptyOperationRegistry,
  type OperationRegistry,
} from './events/operationRegistry';

type ActiveTrackedOperation = {
  id: string;
  name: string;
  event: LocalAgentOperationInternalEvent;
  startedAt: number;
};

type TerminalPhase = Extract<LocalAgentOperationPhase, 'completed' | 'failed' | 'interrupted'>;

export class ToolOperationTracker {
  private sequence = 0;
  private readonly activeById = new Map<string, ActiveTrackedOperation>();
  private readonly activeIdsByName = new Map<string, string[]>();
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

  accept(payload: StreamToolsPayload): LocalAgentOperationInternalEvent {
    const id = this.resolveOperationId(payload);
    const event = buildToolOperationEvent(this.requestId, {
      ...payload,
      toolCallId: id,
    }, this.operationRegistry);
    const trackedEvent = this.addTerminalDuration(event, id);
    this.track(trackedEvent, payload.name, id);
    return trackedEvent;
  }

  finishActive(phase: TerminalPhase, error?: unknown): LocalAgentOperationInternalEvent[] {
    const active = [...this.activeById.values()];
    this.activeById.clear();
    this.activeIdsByName.clear();
    const finishedAt = Date.now();
    return active.map((item) => {
      const durationMs = Math.max(0, finishedAt - item.startedAt);
      return {
        ...item.event,
        phase,
        operation: {
          ...item.event.operation,
          output: {
            ...item.event.operation.output,
            status: phase,
            durationMs,
          },
        },
        raw: {
          input: item.event.raw?.input,
          output: phase === 'completed' ? item.event.raw?.output : undefined,
          error: phase === 'failed' ? error : undefined,
        },
      };
    });
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

  private addTerminalDuration(
    event: LocalAgentOperationInternalEvent,
    id: string,
  ): LocalAgentOperationInternalEvent {
    if (event.phase !== 'completed' && event.phase !== 'failed' && event.phase !== 'interrupted') {
      return event;
    }
    const active = this.activeById.get(id);
    if (!active) return event;
    return {
      ...event,
      operation: {
        ...event.operation,
        output: {
          ...event.operation.output,
          durationMs: Math.max(0, Date.now() - active.startedAt),
        },
      },
    };
  }

  private track(event: LocalAgentOperationInternalEvent, name: string, id: string) {
    if (event.phase === 'started') {
      this.activeById.set(id, { id, name, event, startedAt: Date.now() });
      const ids = this.activeIdsByName.get(name) ?? [];
      this.activeIdsByName.set(name, [...ids, id]);
      return;
    }
    if (event.phase === 'updated') {
      const active = this.activeById.get(id);
      if (active) {
        this.activeById.set(id, { ...active, event });
      } else {
        this.activeById.set(id, { id, name, event, startedAt: Date.now() });
      }
      const ids = this.activeIdsByName.get(name) ?? [];
      if (!ids.includes(id)) {
        this.activeIdsByName.set(name, [...ids, id]);
      }
      return;
    }
    this.activeById.delete(id);
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
