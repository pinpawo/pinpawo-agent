import type { ProtocolEvent } from '@langchain/langgraph';
import type { SubagentToolLifecycleEvent } from '../types/subagent';

/**
 * Translates the v3 protocol `tools` channel into subagent tool lifecycle
 * events. Owns the stateful semantics every consumer needs:
 *
 * - tool names are only carried by `tool-started`; delta/finished/error events
 *   are resolved from per-call-id memory (falling back to arrival order for
 *   events without a call id);
 * - duplicate started/finished emissions for the same call id are dropped;
 * - a `tool-error` whose message is a serialized interrupt payload (human
 *   review pausing a tool) is swallowed — an interrupted tool is not a failed
 *   tool; the interrupt surfaces through the run's interrupt channel.
 *
 * One reader instance per run: the name memory and dedup sets span the run.
 * Used by the subagent bridge today and by the local-agent root-stream
 * operation projection (#322 Phase 3).
 */

type ProtocolToolEventData = {
  event?: unknown;
  tool_call_id?: unknown;
  tool_name?: unknown;
  input?: unknown;
  delta?: unknown;
  output?: unknown;
  message?: unknown;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isSerializedInterruptMessage(message: unknown, toolCallId: string | undefined) {
  if (typeof message !== 'string') {
    return false;
  }
  try {
    const parsed = JSON.parse(message);
    if (!Array.isArray(parsed)) {
      return false;
    }
    return parsed.some((entry) => {
      const value = readRecord(readRecord(entry)?.value);
      if (!value) {
        return false;
      }
      const pendingAction = readRecord(value.pendingAction);
      const actionId = readOptionalString(pendingAction?.actionId);
      return (
        value.kind === 'review'
        || value.type === 'tool'
        || pendingAction !== null
      ) && (!toolCallId || !actionId || actionId === toolCallId);
    });
  } catch {
    return false;
  }
}

export class SubagentProtocolToolEventReader {
  private readonly toolNamesById = new Map<string, string>();
  private readonly toolNamesWithoutId: string[] = [];
  private readonly activeToolCallIds = new Set<string>();
  private readonly finishedToolCallIds = new Set<string>();

  read(event: ProtocolEvent): SubagentToolLifecycleEvent | null {
    if (event.method !== 'tools') {
      return null;
    }
    return this.readToolsData(event.params.data);
  }

  /** Core translation for a `tools` channel payload, however it arrived. */
  readToolsData(rawData: unknown): SubagentToolLifecycleEvent | null {
    const data = readRecord(rawData) as ProtocolToolEventData | null;
    if (!data) {
      return null;
    }
    const toolCallId = readOptionalString(data.tool_call_id);
    switch (data.event) {
      case 'tool-started': {
        const name = readOptionalString(data.tool_name) ?? 'unknown';
        if (toolCallId && this.activeToolCallIds.has(toolCallId)) {
          this.rememberName(toolCallId, name);
          return null;
        }
        if (toolCallId) {
          this.activeToolCallIds.add(toolCallId);
          this.finishedToolCallIds.delete(toolCallId);
        }
        this.rememberName(toolCallId, name);
        return {
          event: 'on_tool_start',
          toolCallId,
          name,
          input: data.input,
        };
      }
      case 'tool-output-delta':
        if (toolCallId && this.finishedToolCallIds.has(toolCallId)) {
          return null;
        }
        return {
          event: 'on_tool_event',
          toolCallId,
          name: this.resolveName(toolCallId, false),
          data: data.delta,
        };
      case 'tool-finished': {
        if (toolCallId && this.finishedToolCallIds.has(toolCallId)) {
          return null;
        }
        const name = this.resolveName(toolCallId, true);
        this.markFinished(toolCallId);
        return {
          event: 'on_tool_end',
          toolCallId,
          name,
          output: data.output,
        };
      }
      case 'tool-error': {
        if (toolCallId && this.finishedToolCallIds.has(toolCallId)) {
          return null;
        }
        if (isSerializedInterruptMessage(data.message, toolCallId)) {
          this.resolveName(toolCallId, true);
          this.markFinished(toolCallId);
          return null;
        }
        const name = this.resolveName(toolCallId, true);
        this.markFinished(toolCallId);
        return {
          event: 'on_tool_error',
          toolCallId,
          name,
          error: readOptionalString(data.message) ?? data.message ?? 'unknown error',
        };
      }
      default:
        return null;
    }
  }

  private rememberName(toolCallId: string | undefined, name: string) {
    if (toolCallId) {
      this.toolNamesById.set(toolCallId, name);
      return;
    }
    this.toolNamesWithoutId.push(name);
  }

  private resolveName(toolCallId: string | undefined, consume: boolean) {
    if (toolCallId) {
      const name = this.toolNamesById.get(toolCallId) ?? 'unknown';
      if (consume) {
        this.toolNamesById.delete(toolCallId);
      }
      return name;
    }
    const name = this.toolNamesWithoutId[0] ?? 'unknown';
    if (consume && this.toolNamesWithoutId.length > 0) {
      this.toolNamesWithoutId.shift();
    }
    return name;
  }

  private markFinished(toolCallId: string | undefined) {
    if (!toolCallId) {
      return;
    }
    this.activeToolCallIds.delete(toolCallId);
    this.finishedToolCallIds.add(toolCallId);
  }
}
