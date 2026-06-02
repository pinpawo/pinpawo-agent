import {
  buildToolOperationEvent,
  type StreamToolsPayload,
} from './agentStreamEvents';
import type {
  LocalAgentOperationEvent,
  LocalAgentOperationPhase,
} from './events/localAgentEvent';

type ActiveTrackedOperation = {
  id: string;
  name: string;
  event: LocalAgentOperationEvent;
};

type TerminalPhase = Extract<LocalAgentOperationPhase, 'completed' | 'failed' | 'interrupted'>;

export class ToolOperationTracker {
  private sequence = 0;
  private readonly activeById = new Map<string, ActiveTrackedOperation>();
  private readonly activeIdsByName = new Map<string, string[]>();

  constructor(private readonly requestId: string) {}

  accept(payload: StreamToolsPayload): LocalAgentOperationEvent {
    const id = this.resolveOperationId(payload);
    const event = buildToolOperationEvent(this.requestId, {
      ...payload,
      toolCallId: id,
    });
    this.track(event, payload.name, id);
    return event;
  }

  finishActive(phase: TerminalPhase, error?: unknown): LocalAgentOperationEvent[] {
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

  private track(event: LocalAgentOperationEvent, name: string, id: string) {
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
