import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { readPendingInterrupt } from './readPendingInterrupt';

/**
 * Validate stored interrupts before LangGraph interprets the checkpoint using
 * the current graph. Removed nodes can otherwise disappear from getState(),
 * making an unsupported pending action look idle. This reads and never migrates.
 */
export function validateCheckpointInterrupts(checkpointer: BaseCheckpointSaver): BaseCheckpointSaver {
  return new Proxy(checkpointer, {
    get(target, property, receiver) {
      if (property === 'getTuple') return async (...args: Parameters<BaseCheckpointSaver['getTuple']>) => {
        const tuple = await target.getTuple(...args);
        for (const [, channel, value] of tuple?.pendingWrites ?? []) {
          if (channel === '__interrupt__') readPendingInterrupt({ tasks: [{ interrupts: [value] }] });
        }
        return tuple;
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
