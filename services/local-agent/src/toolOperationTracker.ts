import type { SubagentToolOperationMetadata } from '@pinpawo/pet-agent';
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
  overlayOperationRegistry,
  type OperationRegistry,
} from './events/operationRegistry';

type ActiveTrackedOperation = {
  id: string;
  name: string;
  event: LocalAgentOperationInternalEvent;
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

  /**
   * Merge a per-delegation `subagent_operations` announcement (#322 Phase 4)
   * so delegation-scoped toolset operations resolve display metadata.
   */
  overlayOperations(entries: Record<string, SubagentToolOperationMetadata>) {
    this.operationRegistry = overlayOperationRegistry(this.operationRegistry, entries);
  }

  accept(payload: StreamToolsPayload): LocalAgentOperationInternalEvent {
    const id = this.resolveOperationId(payload);
    const built = buildToolOperationEvent(this.requestId, {
      ...payload,
      toolCallId: id,
    }, this.operationRegistry);
    const event = this.inheritStartedSummary(built, id);
    this.track(event, payload.name, id);
    return event;
  }

  finishActive(phase: TerminalPhase, error?: unknown): LocalAgentOperationInternalEvent[] {
    const active = [...this.activeById.values()];
    this.activeById.clear();
    this.activeIdsByName.clear();
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
   * `on_tool_end` / `on_tool_error` recompute the operation summary from the
   * terminal payload alone, so tools that only describe themselves via
   * `summarizeInput` (e.g. view_file_chunk, http_fetch) lose their `target` /
   * `details` on the result event — the history line collapses to just the
   * title. Backfill those descriptive fields from the still-tracked start/update
   * event so the completed line keeps showing which file/url was touched.
   */
  private inheritStartedSummary(
    event: LocalAgentOperationInternalEvent,
    id: string,
  ): LocalAgentOperationInternalEvent {
    if (event.phase === 'started') return event;
    const previous = this.activeById.get(id)?.event.operation;
    if (!previous) return event;
    const { target, summary, details } = event.operation;
    return {
      ...event,
      operation: {
        ...event.operation,
        target: target ?? previous.target,
        summary: summary ?? previous.summary,
        details: details ?? previous.details,
      },
    };
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

  private track(event: LocalAgentOperationInternalEvent, name: string, id: string) {
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
