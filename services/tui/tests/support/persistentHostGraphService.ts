import { resolve } from 'node:path';
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
export const PERSISTENT_HOST_ATTACHMENT_INPUT =
  'Persist the selected host attachments.';
export const PERSISTENT_HOST_ATTACHMENT_NAMES = [
  'first file.txt',
  '第二资料.md',
] as const;
export const PERSISTENT_HOST_REMOVED_ATTACHMENT_NAME = 'remove me.tmp';
export const PERSISTENT_HOST_ATTACHMENT_REPLY =
  'Persisted selected host attachments.';
export const PERSISTENT_HOST_INVALID_ATTACHMENT_REPLY =
  'Host attachment selection did not match.';
export const PERSISTENT_HOST_MENTION_NAME = '指南 文档.md';
export const PERSISTENT_HOST_MENTION_INPUT =
  `Inspect @${PERSISTENT_HOST_MENTION_NAME} carefully.`;
export const PERSISTENT_HOST_MENTION_REPLY =
  'Persisted completed workspace mention.';
export const PERSISTENT_HOST_EDITOR_INITIAL = 'original editor draft';
export const PERSISTENT_HOST_EDITOR_INPUT =
  'Edited by VISUAL.\n第二行。';
export const PERSISTENT_HOST_EDITOR_REPLY =
  'Persisted external editor draft.';

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
          content: selectReply(input, setup.input.workdir),
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

function selectReply(input: string, workdir?: string) {
  if (input.includes(PERSISTENT_HOST_CONTINUATION)) {
    return PERSISTENT_HOST_CONTINUATION_REPLY;
  }
  if (input.includes(PERSISTENT_HOST_ATTACHMENT_INPUT)) {
    const validSelection = input.includes('<local_attachments>')
      && typeof workdir === 'string'
      && PERSISTENT_HOST_ATTACHMENT_NAMES.every(
        (name) => input.includes(resolve(workdir, name)),
      )
      && !input.includes(PERSISTENT_HOST_REMOVED_ATTACHMENT_NAME);
    return validSelection
      ? PERSISTENT_HOST_ATTACHMENT_REPLY
      : PERSISTENT_HOST_INVALID_ATTACHMENT_REPLY;
  }
  if (input === PERSISTENT_HOST_MENTION_INPUT) {
    return PERSISTENT_HOST_MENTION_REPLY;
  }
  if (input === PERSISTENT_HOST_EDITOR_INPUT) {
    return PERSISTENT_HOST_EDITOR_REPLY;
  }
  return PERSISTENT_HOST_REPLY;
}

function configurable(setup: AgentChannelSetup) {
  return {
    thread_id: setup.input.threadId,
  };
}
