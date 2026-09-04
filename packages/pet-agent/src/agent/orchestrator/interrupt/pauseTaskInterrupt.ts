import type { BaseMessage } from '@langchain/core/messages';
import type { CapabilityArtifactRef } from '../../../types/artifact';
import { z } from 'zod';
import type { AgentInterrupt } from './agentInterrupt';

export const PAUSE_TASK_INTERRUPT_KIND = 'pause_task' as const;
export const PAUSE_TASK_INTERRUPT_STATE_KEY = 'pauseTaskInterrupt' as const;

export type PauseTaskInterruptPayload = {
  kind: typeof PAUSE_TASK_INTERRUPT_KIND;
};

export const PauseTaskInterruptStateSchema = z.object({
  [PAUSE_TASK_INTERRUPT_STATE_KEY]: z.object({
    kind: z.literal(PAUSE_TASK_INTERRUPT_KIND),
  }).nullable().default(null),
});

export type PauseTaskInterruptCommand = {
  action: 'continue';
  guidance?: string;
};

export type PauseTaskInterruptResolution = {
  type: 'continue';
  guidance: string | null;
};

export type PausedSubagentState = {
  messages: BaseMessage[];
  artifacts: CapabilityArtifactRef[];
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isPauseTaskInterruptPayload(
  value: unknown,
): value is PauseTaskInterruptPayload {
  const record = readRecord(value);
  return record?.kind === PAUSE_TASK_INTERRUPT_KIND
    && Object.keys(record).every((key) => key === 'kind');
}

export function readPauseTaskInterrupt(
  value: unknown,
): PauseTaskInterruptPayload | null {
  const record = readRecord(value);
  const payload = record?.[PAUSE_TASK_INTERRUPT_STATE_KEY];
  return isPauseTaskInterruptPayload(payload) ? payload : null;
}

/**
 * Runtime-private control signal used only across the createSubagent/capability
 * function boundary. It is caught before control returns to LangGraph.
 */
export class PauseTaskInterruptSignal extends Error {
  readonly payload: PauseTaskInterruptPayload;
  readonly state: PausedSubagentState;

  constructor(payload: PauseTaskInterruptPayload, state: PausedSubagentState) {
    super('Subagent paused with unfinished work.');
    this.name = 'PauseTaskInterruptSignal';
    this.payload = payload;
    this.state = state;
  }
}

export function propagatePauseTaskInterrupt(
  graphResult: unknown,
  state: PausedSubagentState,
): void {
  const payload = readPauseTaskInterrupt(graphResult);
  if (payload) {
    throw new PauseTaskInterruptSignal(payload, state);
  }
}

export function readPauseTaskInterruptSignal(
  value: unknown,
): PauseTaskInterruptSignal | null {
  return value instanceof PauseTaskInterruptSignal ? value : null;
}

/**
 * Owns task-pause requests and their materialization policy. Callers express a
 * semantic pause and must not choose END or another dynamic interrupt.
 */
export class PauseTaskInterrupt implements AgentInterrupt<
  PauseTaskInterruptPayload,
  PauseTaskInterruptResolution
> {
  readonly kind = PAUSE_TASK_INTERRUPT_KIND;

  interaction(): PauseTaskInterruptPayload {
    return { kind: this.kind };
  }

  enter<TUpdate extends Record<string, unknown>>(update: TUpdate) {
    return {
      ...update,
      [PAUSE_TASK_INTERRUPT_STATE_KEY]: this.interaction(),
      jumpTo: 'end' as const,
    };
  }

  resume(value: unknown): PauseTaskInterruptResolution {
    const command = readRecord(value);
    if (
      command?.action !== 'continue'
      || !Object.keys(command).every((key) => key === 'action' || key === 'guidance')
      || (command.guidance !== undefined && typeof command.guidance !== 'string')
    ) {
      throw new Error('PauseTaskInterrupt requires a canonical continue command.');
    }
    const guidance = typeof command.guidance === 'string'
      ? command.guidance.trim() || null
      : null;
    return { type: 'continue', guidance };
  }
}

export const pauseTaskInterrupt = new PauseTaskInterrupt();
