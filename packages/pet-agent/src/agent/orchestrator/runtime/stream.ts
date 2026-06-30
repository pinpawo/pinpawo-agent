import type { OrchestratorGraph } from './graph';

export type OrchestratorGraphStream = AsyncIterable<unknown>;
/** @deprecated Use OrchestratorGraphStream. */
export type OrchestratorTokenUsageStream = OrchestratorGraphStream;

export function streamOrchestratorGraph(
  graph: OrchestratorGraph,
  input: Parameters<OrchestratorGraph['stream']>[0],
  options?: Parameters<OrchestratorGraph['stream']>[1],
): OrchestratorGraphStream {
  return (async function* streamOrchestratorGraphChunks() {
    const innerStream = await graph.stream(input, options);
    for await (const chunk of innerStream as AsyncIterable<unknown>) {
      yield chunk;
    }
  })();
}

/** @deprecated Use streamOrchestratorGraph. */
export const streamOrchestratorGraphWithTokenUsage = streamOrchestratorGraph;
