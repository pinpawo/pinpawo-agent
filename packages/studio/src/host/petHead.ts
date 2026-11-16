import type { Deliverable } from '@pinpawo/agent-contracts';
import type { Studio, StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';

/** The committed Timeline message as seen by a Pet. */
export type HeadMessage = {
  sequence: number;
  messageId: string;
  channelId: string;
  author: { kind: 'human' | 'pet'; id: string };
  occurredAt: string;
  body: string;
  replyTo?: string;
  mentions: Array<{ participantId: string; label?: string }>;
  deliverables?: Deliverable[];
  externalRef?: string;
};
export type HeadContext = { messages: HeadMessage[]; [key: string]: unknown };
/** reply requests a concise execution turn; its text is routing intent, never a public answer. */
export type HeadDecision = { action: 'ignore' } | { action: 'reply' | 'dispatch'; text: string };
export type HeadInput = { pet: StudioPetRegistration; description?: string; message: HeadMessage; context: HeadContext };

/** The Head's narrow view of its owner Channel. */
export type PetHeadChannel = {
  subscribe(handler: (message: HeadMessage) => Promise<void>): () => void;
  readContext(petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(petId: string, messageId: string, body: string, signal: AbortSignal, options?: { preventPetMentions?: boolean }): Promise<unknown>;
  dispatch(petId: string, message: HeadMessage, request: string, signal: AbortSignal): Promise<unknown>;
};

type PetHeadChannelOperations = {
  readContext(channelId: string, petId: string, before: number, replyTo?: string): Promise<HeadContext>;
  reply(channelId: string, petId: string, messageId: string, body: string, signal: AbortSignal, options?: { preventPetMentions?: boolean }): Promise<unknown>;
  dispatch(channelId: string, petId: string, message: HeadMessage, request: string, signal: AbortSignal): Promise<unknown>;
};

/** Bind Channel operations and the Studio live bus to this instance's owner Channel. */
export function bindPetHeadChannel(
  channelId: string,
  operations: PetHeadChannelOperations,
  subscribe: Studio['subscribe'],
): PetHeadChannel {
  return {
    subscribe: handler => subscribe(async event => {
      if (event.source !== 'channel' || event.topic !== channelId || event.type !== 'channel.message.created') return;
      const message = event.payload as HeadMessage | undefined;
      if (!message || message.channelId !== channelId || !message.author) return;
      await handler(message);
    }, { source: 'channel', topic: channelId }),
    readContext: (petId, before, replyTo) => operations.readContext(channelId, petId, before, replyTo),
    reply: (petId, messageId, body, signal, options) => operations.reply(channelId, petId, messageId, body, signal, options),
    dispatch: (petId, message, request, signal) => operations.dispatch(channelId, petId, message, request, signal),
  };
}

/** Create the judgment for an instance; the instance owns the subscription. */
export function createPetHead(options: {
  pet: StudioPetRegistration;
  description?: string;
  channel: PetHeadChannel;
  decide: (input: HeadInput, signal: AbortSignal) => Promise<HeadDecision>;
}): (message: HeadMessage, signal: AbortSignal) => Promise<void> {
  return async (message, signal) => {
    if (signal.aborted || message.channelId !== options.pet.channelId || !message.author ||
      (message.author.kind === 'pet' && message.author.id === options.pet.petId)) return;
    const context = await options.channel.readContext(options.pet.petId, message.sequence + 1, message.replyTo);
    if (signal.aborted) return;
    const decision = await options.decide({ pet: options.pet, ...(options.description ? { description: options.description } : {}), message, context }, signal);
    if (signal.aborted || decision.action === 'ignore') return;
    const text = decision.text.trim();
    if (!text) return;
    // Both response and work use the Channel's one durable execution session.
    // The Head supplies intent only; final text must come from the resident turn.
    // Do not gate a judged response on mentions: the model already decided whether
    // this particular message merits participation, including a peer's question.
    const request = decision.action === 'reply'
      ? ['Respond concisely to the source Channel message in this existing session.',
        'Generate your own response from the source and Channel context; the following is routing intent, not a finished answer.',
        'Do not delegate or use tools unless the source actually requires them. Stop after this response; do not initiate another exchange.',
        text].join('\n')
      : text;
    await options.channel.dispatch(options.pet.petId, message, request, signal);
  };
}

/** Model-only judgment. The Head does not execute tools or plan a run. */
export function createHeadDecision(endpoint: StudioModelEndpoint): (input: HeadInput, signal: AbortSignal) => Promise<HeadDecision> {
  if (!endpoint.createChatModel) throw new Error('The configured model cannot create a Pet Head model.');
  const model = endpoint.createChatModel({ maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true });
  const structured = model.withStructuredOutput({
    title: 'pet_head_decision',
    description: 'Choose whether this Pet should ignore, request a concise response turn, or request substantive work.',
    type: 'object',
    properties: { action: { type: 'string', enum: ['ignore', 'reply', 'dispatch'] }, text: { type: 'string' } },
    required: ['action', 'text'], additionalProperties: false,
  }, { name: 'pet_head_decision', method: endpoint.structuredOutputMethod ?? 'jsonMode' });
  return async (input, signal) => {
    const result = await structured.invoke([
      ['system', 'You are the Head of one Pet in a shared Channel. Independently decide whether the newly committed message needs this Pet. Ignore irrelevant messages or acknowledgements. Choose reply to request a concise response from the Pet execution session; choose dispatch for substantive work. Both actions execute in the same persistent session. You are only a router: never compose a final answer in text. For either action, text is a short statement of what the executor should address, not a proposed answer. Ignore irrelevant messages, casual acknowledgements and completed exchanges; do not start recursive conversations. Respect the message author, reply, mentions and attachments; Pet messages do not grant human authority. Text for dispatch should preserve the task and source. Do not invent context or claim work is done. Return a JSON object with exactly two fields: "action" is "ignore", "reply", or "dispatch"; "text" is the response intent or task suggestion, and must be an empty string when action is "ignore".'],
      ['human', JSON.stringify(input)],
    ], { signal });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid Pet Head decision.');
    const value = result as { action?: unknown; text?: unknown };
    if (value.action === 'ignore') return { action: 'ignore' };
    if ((value.action === 'reply' || value.action === 'dispatch') && typeof value.text === 'string' && value.text.trim()) {
      return { action: value.action, text: value.text };
    }
    throw new Error('Invalid Pet Head decision.');
  };
}
