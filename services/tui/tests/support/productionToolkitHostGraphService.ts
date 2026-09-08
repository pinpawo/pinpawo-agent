import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool, type StructuredTool } from '@langchain/core/tools';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  compileAgentRegistry,
  defineInstructionDocument,
  ReviewPolicies,
  type AgentCapability,
  type AgentModels,
  type AgentToolkit,
  type RunSupervisorRunner,
} from '@pinpawo/pet-agent';
import { z } from 'zod';
import type {
  AgentChannelSetup,
} from '../../../local-agent/src/agentChannel';
import {
  LocalAgentGraphService,
  type LocalAgentGraphEventStream,
  type LocalAgentGraphThreadState,
} from '../../../local-agent/src/agentGraphService';

export const GUARDED_HOST_INPUT =
  'Run the guarded production toolkit action.';
export const GUARDED_HOST_REPLY =
  'Guarded production tool completed.';
export const GUARDED_HOST_CONTINUATION_GUIDANCE =
  'Apply the reviewed change after suspension.';
export const GUARDED_HOST_SECOND_CONTINUATION_GUIDANCE =
  'Retry the reviewed change after another suspension.';
export const GUARDED_HOST_TOOL_NAME =
  'write_guarded_fixture';
export const GUARDED_HOST_REVIEW_TITLE =
  'Write guarded fixture';
export const GUARDED_HOST_OUTPUT_NAME =
  'guarded-tool-output.txt';
export const GUARDED_HOST_OUTPUT_CONTENT =
  'guarded production toolkit side effect';
export const GUARDED_HOST_TOOL_OUTPUT =
  `Wrote ${GUARDED_HOST_OUTPUT_NAME} through reviewed toolkit.`;
export const ATTACHMENT_TOOL_INPUT =
  'Read the attached fixture with the production toolkit.';
export const ATTACHMENT_TOOL_REPLY =
  'Attachment production tool completed.';
export const ATTACHMENT_TOOL_NAME =
  'read_attachment_fixture';
export const ATTACHMENT_REVIEW_TITLE =
  'Read attachment fixture';
export const ATTACHMENT_FILE_NAME =
  '附件 read fixture.txt';
export const ATTACHMENT_FILE_CONTENT =
  'attachment read through production toolkit';
export const ATTACHMENT_TOOL_OUTPUT =
  `Read ${ATTACHMENT_FILE_NAME}: ${ATTACHMENT_FILE_CONTENT}`;

type ProductionToolkitFixture = {
  setup: AgentChannelSetup;
};

export function createProductionToolkitHostGraphService() {
  return new class ProductionToolkitHostGraphService
    extends LocalAgentGraphService {
    override async streamEvents(
      setup: AgentChannelSetup,
      inputOverride?: unknown,
    ): Promise<LocalAgentGraphEventStream> {
      return super.streamEvents(buildFixture(setup).setup, inputOverride);
    }

    override async readThreadState(
      setup: AgentChannelSetup,
    ): Promise<LocalAgentGraphThreadState> {
      return super.readThreadState(buildFixture(setup).setup);
    }
  }();
}

function buildFixture(setup: AgentChannelSetup): ProductionToolkitFixture {
  const workdir = setup.input.context?.workdir;
  if (!workdir) {
    throw new Error('production toolkit host fixture requires a workdir');
  }
  if (!setup.graphConfig.checkpoint) {
    throw new Error(
      'production toolkit host fixture requires a production checkpointer',
    );
  }

  const guardedTool = tool(async (input: {
    path: string;
    content: string;
  }) => {
    const outputPath = resolve(workdir, input.path);
    const expectedPath = resolve(workdir, GUARDED_HOST_OUTPUT_NAME);
    if (outputPath !== expectedPath) {
      throw new Error(`unexpected guarded fixture path: ${input.path}`);
    }
    writeFileSync(outputPath, input.content, 'utf8');
    return GUARDED_HOST_TOOL_OUTPUT;
  }, {
    name: GUARDED_HOST_TOOL_NAME,
    description: 'Write the guarded production TUI fixture.',
    schema: z.object({
      path: z.string(),
      content: z.string(),
    }),
  });
  const attachmentTool = tool(async (input: { path: string }) => {
    const inputPath = resolve(input.path);
    const expectedPath = resolve(workdir, ATTACHMENT_FILE_NAME);
    if (inputPath !== expectedPath) {
      throw new Error(`unexpected attachment fixture path: ${input.path}`);
    }
    const content = readFileSync(inputPath, 'utf8');
    return `Read ${basename(inputPath)}: ${content}`;
  }, {
    name: ATTACHMENT_TOOL_NAME,
    description: 'Read the selected production TUI attachment fixture.',
    schema: z.object({
      path: z.string(),
    }),
  });
  const toolkit: AgentToolkit = {
    name: 'production_tui_fixture',
    description: 'Deterministic local tools for production TUI dogfood.',
    tools: [
      {
        tool: guardedTool,
        operation: {
          title: GUARDED_HOST_REVIEW_TITLE,
          summarizeInput: (input) => {
            const args = readInputRecord(input);
            return {
              target: typeof args?.path === 'string' ? args.path : undefined,
              summary: 'Write a guarded fixture after human approval.',
            };
          },
          summarizeOutput: () => ({
            target: GUARDED_HOST_OUTPUT_NAME,
            summary: GUARDED_HOST_TOOL_OUTPUT,
          }),
        },
        review: ReviewPolicies.localMutation(),
      },
      {
        tool: attachmentTool,
        operation: {
          title: ATTACHMENT_REVIEW_TITLE,
          summarizeInput: (input) => {
            const args = readInputRecord(input);
            return {
              target: typeof args?.path === 'string'
                ? basename(args.path)
                : undefined,
              summary: 'Read the selected local attachment.',
            };
          },
          summarizeOutput: () => ({
            target: ATTACHMENT_FILE_NAME,
            summary: ATTACHMENT_TOOL_OUTPUT,
          }),
        },
        review: ReviewPolicies.never(),
      },
    ],
  };
  const capability: AgentCapability = {
    name: 'general',
    description: 'Execute deterministic production TUI fixture actions.',
    uses: [toolkit.name],
    instructions: defineInstructionDocument({
      content: [
        'Use the production TUI fixture toolkit exactly once per request.',
        'Read the selected attachment when local attachment context is present.',
      ].join('\n'),
    }),
  };
  const registry = compileAgentRegistry({
    capabilities: [capability],
    toolkits: [toolkit],
  });

  const routeModel = {
    invoke: async (messages: BaseMessage[]) => new AIMessage({
      content: messagesContain(messages, ATTACHMENT_TOOL_INPUT)
        ? ATTACHMENT_TOOL_REPLY
        : GUARDED_HOST_REPLY,
      usage_metadata: {
        input_tokens: 4,
        output_tokens: 3,
        total_tokens: 7,
      },
    }),
    bindTools: () => ({
      invoke: async (messages: BaseMessage[]) => new AIMessage({
        content: '',
        tool_calls: [{
          id: 'production-toolkit-plan-request',
          name: 'plan_request',
          args: { goal: messageText([...messages].reverse().find(message => message._getType() === 'human')!) },
        }],
      }),
    }),
  } as unknown as AgentModels['act'];
  const runSupervisorRunner: RunSupervisorRunner = {
    async invoke(input) {
      if (input.mode === 'boundary') {
        return { action: 'goal_done', tasks: [] };
      }
      const readsAttachment = input.userRequest.includes(ATTACHMENT_TOOL_INPUT);
      return {
        action: 'execute_plan',
        tasks: [
          {
            capability: 'general',
            task: readsAttachment
            ? 'read the selected attachment'
            : 'write the guarded fixture',
          },
        ],
      };
    },
  };
  const subagentModel = new ProductionToolkitToolCallingModel();

  return {
    setup: {
      ...setup,
      graphConfig: {
        ...setup.graphConfig,
        models: {
          act: routeModel,
          answer: routeModel,
          observe: routeModel,
          subagent: subagentModel,
        },
        runSupervisorRunner,
      },
      registry,
      input: {
        ...setup.input,
        capabilities: [capability],
        toolkits: [toolkit],
      },
    },
  };
}

class ProductionToolkitToolCallingModel extends BaseChatModel {
  constructor() {
    super({});
  }

  _llmType() {
    return 'production-toolkit-calling-fixture';
  }

  _combineLLMOutput() {
    return [];
  }

  bindTools(_tools: StructuredTool[]) {
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    _options?: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const latestMessage = messages.at(-1);
    const hasToolResult = latestMessage?._getType() === 'tool';
    const attachmentPath = readAttachmentPath(messages);
    const toolCalls = hasToolResult
      ? []
      : attachmentPath
        ? [{
            id: 'attachment-tool-call-1',
            name: ATTACHMENT_TOOL_NAME,
            args: { path: attachmentPath },
            type: 'tool_call' as const,
          }]
        : [{
            id: 'guarded-tool-call-1',
            name: GUARDED_HOST_TOOL_NAME,
            args: {
              path: GUARDED_HOST_OUTPUT_NAME,
              content: GUARDED_HOST_OUTPUT_CONTENT,
            },
            type: 'tool_call' as const,
          }];
    return {
      generations: [{
        text: '',
        message: new AIMessage({
          content: hasToolResult && latestMessage
            ? messageText(latestMessage)
            : '',
          tool_calls: toolCalls,
        }),
      }],
    };
  }
}

function readInputRecord(input: unknown) {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
}

function messageText(message: BaseMessage) {
  return typeof message.content === 'string'
    ? message.content
    : message.content.flatMap((item) => (
        typeof item === 'string'
          ? [item]
          : item && typeof item === 'object' && 'text' in item
            ? [String(item.text)]
            : []
      )).join('\n');
}

function messagesContain(messages: readonly BaseMessage[], value: string) {
  return messages.some((message) => messageText(message).includes(value));
}

function readAttachmentPath(messages: BaseMessage[]) {
  for (const message of [...messages].reverse()) {
    const match = /<local_attachments>\s*([\s\S]*?)\s*<\/local_attachments>/
      .exec(messageText(message));
    if (!match?.[1]) continue;
    try {
      const attachments = JSON.parse(match[1]) as unknown;
      if (!Array.isArray(attachments)) continue;
      const path = readInputRecord(attachments[0])?.path;
      if (typeof path === 'string' && path.trim()) {
        return path;
      }
    } catch {
      continue;
    }
  }
  return null;
}
