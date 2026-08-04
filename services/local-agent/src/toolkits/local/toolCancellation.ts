import type { StructuredTool } from '@langchain/core/tools';

/**
 * Tools report failures by returning an `Error: ...` string so the model can
 * see what went wrong and retry. That convention is right for execution
 * failures, but it also swallows cancellation: when a run is interrupted the
 * abort surfaces inside the tool as a rejected promise, gets caught by the
 * tool's own catch block, and comes back as an ordinary result. LangGraph then
 * treats the interrupted call as a successful one and keeps the run going.
 *
 * This wrapper closes that gap at the toolkit boundary instead of asking every
 * tool to handle it. Whatever a tool returns or throws, an aborted signal turns
 * the call into a thrown `AbortError` so the graph unwinds.
 */

export function createAbortError() {
  const error = new Error('tool call aborted');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(err: unknown) {
  return err instanceof Error && err.name === 'AbortError';
}

function readSignal(config: unknown): AbortSignal | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const signal = (config as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * Wrap a tool so cancellation always propagates.
 *
 * Rather than inspecting how a tool handles its own errors, this checks the
 * signal at the call boundary: if the run was aborted, the tool's outcome is
 * discarded and an `AbortError` is thrown. A tool that already propagates
 * `AbortError` passes through unchanged.
 *
 * Execution failures are untouched — a non-zero exit code, a timeout, or a
 * missing file still reaches the model as its usual string result.
 */
export function wrapToolCancellation<TTool extends StructuredTool>(tool: TTool): TTool {
  return new Proxy(tool, {
    get(target, prop, receiver) {
      if (prop !== 'invoke') {
        return Reflect.get(target, prop, receiver);
      }
      const invoke = Reflect.get(target, prop, receiver) as TTool['invoke'];
      if (typeof invoke !== 'function') {
        return invoke;
      }
      return async function invokeWithCancellation(
        this: unknown,
        input: unknown,
        config?: unknown,
      ) {
        const signal = readSignal(config);
        if (signal?.aborted) {
          throw createAbortError();
        }
        try {
          const result = await (invoke as (i: unknown, c?: unknown) => Promise<unknown>)
            .call(this === receiver ? target : this, input, config);
          // The tool may have caught the abort internally and returned a
          // normal value; the signal is the authority on whether the result
          // is still wanted.
          if (signal?.aborted) {
            throw createAbortError();
          }
          return result;
        } catch (err) {
          if (signal?.aborted && !isAbortError(err)) {
            throw createAbortError();
          }
          throw err;
        }
      };
    },
  });
}
