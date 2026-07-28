import {
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import {
  Command,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type {
  AgentChannelSetup,
} from '../../../local-agent/src/agentChannel';
import type {
  LocalAgentGraphService,
  LocalAgentGraphThreadState,
} from '../../../local-agent/src/agentGraphService';

export const PERSISTENT_HOST_INPUT = 'Persist this host conversation.';
export const PERSISTENT_HOST_CONTINUATION = 'Continue after the host restart.';
export const PERSISTENT_HOST_REPLY = 'Persisted host reply.';
export const PERSISTENT_HOST_CONTINUATION_REPLY = 'Continued host reply.';

export function createPersistentHostGraphService() {
  const graphs = new Map<string, ReturnType<typeof createGraph>>();

  const graphFor = (setup: AgentChannelSetup) => {
    const cached = graphs.get(setup.graphKey);
    if (cached) return cached;
    const graph = createGraph(setup);
    graphs.set(setup.graphKey, graph);
    return graph;
  };

  return {
    async streamEvents(
      setup: AgentChannelSetup,
      inputOverride?: unknown,
    ) {
      return await graphFor(setup).streamEvents(
        inputOverride ?? { messages: setup.input.messages },
        {
          version: 'v3',
          signal: setup.input.signal,
          configurable: configurable(setup),
        },
      );
    },
    async readThreadState(
      setup: AgentChannelSetup,
    ): Promise<LocalAgentGraphThreadState> {
      const snapshot = await graphFor(setup).getState({
        configurable: configurable(setup),
      });
      const values = snapshot.values as {
        messages?: unknown;
      };
      return {
        messages: Array.isArray(values.messages)
          ? values.messages as BaseMessage[]
          : [],
        pendingHumanReview: null,
        hasPendingContinuation: false,
      };
    },
    buildResumeCommand(resume: unknown) {
      return new Command({ resume });
    },
  } as unknown as LocalAgentGraphService;
}

function createGraph(setup: AgentChannelSetup) {
  if (!setup.graphConfig.checkpoint) {
    throw new Error('persistent host fixture requires a production checkpointer');
  }
  return new StateGraph(MessagesAnnotation)
    .addNode('answer', (state) => {
      const input = String(state.messages.at(-1)?.content ?? '');
      const continuation = input.includes(PERSISTENT_HOST_CONTINUATION);
      return {
        messages: [new AIMessage({
          content: continuation
            ? PERSISTENT_HOST_CONTINUATION_REPLY
            : PERSISTENT_HOST_REPLY,
          usage_metadata: {
            input_tokens: continuation ? 6 : 4,
            output_tokens: 3,
            total_tokens: continuation ? 9 : 7,
          },
        })],
      };
    })
    .addEdge(START, 'answer')
    .addEdge('answer', END)
    .compile({
      checkpointer: setup.graphConfig.checkpoint,
    });
}

function configurable(setup: AgentChannelSetup) {
  return {
    thread_id: setup.input.threadId,
  };
}
