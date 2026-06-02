import type { SubagentToolEvent } from '../types/subagent';

type ActiveToolEvent = {
  id: string;
  name: string;
  event: Extract<SubagentToolEvent, { event: 'on_tool_start' | 'on_tool_event' }>;
};

export class SubagentToolEventTracker {
  private sequence = 0;
  private readonly activeById = new Map<string, ActiveToolEvent>();
  private readonly activeIdsByName = new Map<string, string[]>();

  accept(event: SubagentToolEvent): SubagentToolEvent {
    const id = this.resolveToolCallId(event);
    const normalized = {
      ...event,
      toolCallId: id,
    } as SubagentToolEvent;
    this.track(normalized, id);
    return normalized;
  }

  finishActive(
    outcome: 'completed' | 'failed',
    error: unknown = 'subagent finished before tool emitted a terminal event',
  ): SubagentToolEvent[] {
    const active = [...this.activeById.values()];
    this.activeById.clear();
    this.activeIdsByName.clear();
    return active.map((item) => outcome === 'completed'
      ? {
          event: 'on_tool_end',
          toolCallId: item.id,
          name: item.name,
          output: undefined,
        }
      : {
          event: 'on_tool_error',
          toolCallId: item.id,
          name: item.name,
          error,
        });
  }

  private resolveToolCallId(event: SubagentToolEvent) {
    const explicitId = event.toolCallId?.trim();
    if (explicitId) {
      return explicitId;
    }
    const activeId = this.activeIdsByName.get(event.name)?.[0];
    if (event.event !== 'on_tool_start' && activeId) {
      return activeId;
    }
    this.sequence += 1;
    return `subagent-tool-${this.sequence}`;
  }

  private track(event: SubagentToolEvent, id: string) {
    if (event.event === 'on_tool_start' || event.event === 'on_tool_event') {
      this.activeById.set(id, { id, name: event.name, event });
      const ids = this.activeIdsByName.get(event.name) ?? [];
      if (!ids.includes(id)) {
        this.activeIdsByName.set(event.name, [...ids, id]);
      }
      return;
    }
    this.activeById.delete(id);
    const ids = this.activeIdsByName.get(event.name);
    if (!ids) {
      return;
    }
    const nextIds = ids.filter((item) => item !== id);
    if (nextIds.length > 0) {
      this.activeIdsByName.set(event.name, nextIds);
    } else {
      this.activeIdsByName.delete(event.name);
    }
  }
}
