import { z } from 'zod';
import type { StudioModelEndpoint } from '@pinpawo/studio-core';
import type { ChannelMember } from './channelService';
import type { ChannelMessageRow, ChannelRow } from './store/channelStore';

/** Channel routing settings: off by default, so an unaddressed message is only stored. */
export const channelRoutingOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  decider: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('llm'), modelProfileId: z.string().trim().min(1).max(256).optional() }).strict(),
  ]).default({ kind: 'llm' }),
  threshold: z.number().min(0).max(1).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  historyLimit: z.number().int().min(0).max(200).default(20),
  /** One line per Pet id, used only for routing. */
  pets: z.record(z.string().trim().max(1_000)).default({}),
}).strict();
export type ChannelRoutingOptions = z.input<typeof channelRoutingOptionsSchema>;
type ParsedRoutingOptions = z.output<typeof channelRoutingOptionsSchema>;

const DEFAULTS = { llm: { threshold: 0.5, timeoutMs: 10_000 } } as const;
const BODY_LIMIT = 2_000;

export type RouteCandidate = { participantId: string; name: string; description?: string };
/** What a decider sees: public Channel messages and members, nothing of any Pet's process. */
export type RouteInput = {
  channel: { title: string; description?: string };
  message: { author: string; body: string; replyTo?: { author: string; body: string } };
  pets: RouteCandidate[];
  history: Array<{ author: string; body: string }>;
};
export type RouteDecision = {
  /** A candidate's participantId, or `none`. */
  target: string;
  confidence: number;
  reason?: string;
};
export type RouteDecider = (input: RouteInput, signal: AbortSignal) => Promise<RouteDecision>;
export type RouteOutcome =
  | { kind: 'route'; participantId: string; confidence: number; reason?: string }
  | { kind: 'skip'; reason: 'none' | 'low_confidence' | 'invalid' | 'error'; confidence?: number; detail?: string };

export type ChannelRouter = {
  /** Whether this message is one routing decides: a human's message with no mentions in a Channel with a Pet. */
  applies: (message: ChannelMessageRow, members: ChannelMember[]) => boolean;
  decide: (input: RouteInput) => Promise<RouteOutcome>;
  historyLimit: number;
};

export function createChannelRouter(value: ChannelRoutingOptions | undefined, options: {
  decider?: RouteDecider;
  resolveModel?: (profileId?: string) => StudioModelEndpoint;
  fetch?: typeof fetch;
}): ChannelRouter | undefined {
  const settings: ParsedRoutingOptions = channelRoutingOptionsSchema.parse(value ?? {});
  if (!settings.enabled) return undefined;
  const defaults = DEFAULTS[settings.decider.kind];
  const threshold = settings.threshold ?? defaults.threshold;
  const timeoutMs = settings.timeoutMs ?? defaults.timeoutMs;
  const decider = options.decider ?? (() => {
    const { modelProfileId } = settings.decider;
    if (!options.resolveModel) throw new Error('Channel routing with an llm decider needs the Studio model profiles.');
    // Resolve now so a wrong profile id fails at start, not on the first message.
    const endpoint = options.resolveModel(modelProfileId);
    return createLlmRouteDecider(endpoint, options.fetch);
  })();
  return {
    historyLimit: settings.historyLimit,
    applies: (message, members) => message.author.kind === 'human' && message.mentions.length === 0
      && members.some(member => member.kind === 'pet'),
    decide: async (input) => {
      const candidates = new Set(input.pets.map(pet => pet.participantId));
      const pets = input.pets.map(pet => ({ ...pet, ...(settings.pets[petIdOf(pet.participantId)] ? { description: settings.pets[petIdOf(pet.participantId)] } : {}) }));
      let decision: RouteDecision;
      try { decision = await decider({ ...input, pets }, AbortSignal.timeout(timeoutMs)); }
      catch (error) { return { kind: 'skip', reason: 'error', detail: error instanceof Error ? error.message : String(error) }; }
      const confidence = decision.confidence;
      if (decision.target === 'none') return { kind: 'skip', reason: 'none', confidence };
      if (!candidates.has(decision.target) || !Number.isFinite(confidence)) return { kind: 'skip', reason: 'invalid', confidence, detail: decision.target };
      if (confidence < threshold) return { kind: 'skip', reason: 'low_confidence', confidence };
      return { kind: 'route', participantId: decision.target, confidence, ...(decision.reason ? { reason: decision.reason } : {}) };
    },
  };
}

function petIdOf(participantId: string): string {
  return decodeURIComponent(participantId.slice('pet:'.length));
}

/** The decider's view of one Channel message. */
export function routeInput(
  channel: ChannelRow, message: ChannelMessageRow, original: ChannelMessageRow | undefined,
  history: ChannelMessageRow[], members: ChannelMember[],
): RouteInput {
  const labels = new Map(members.map(member => [`${member.kind}:${member.id}`, member.label]));
  const author = (row: ChannelMessageRow) => labels.get(`${row.author.kind}:${row.author.id}`) ?? `${row.author.kind}:${row.author.id}`;
  const clip = (body: string) => body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}…` : body;
  return {
    channel: { title: channel.title, ...(channel.description ? { description: channel.description } : {}) },
    message: {
      author: author(message), body: clip(message.body),
      ...(original ? { replyTo: { author: author(original), body: clip(original.body) } } : {}),
    },
    pets: members.filter(member => member.kind === 'pet').map(member => ({ participantId: member.participantId, name: member.label })),
    history: history.map(row => ({ author: author(row), body: clip(row.body) })),
  };
}

const ROUTE_SYSTEM_PROMPT = [
  'You route one message in a group chat between people and AI agents ("Pets").',
  'The message addressed nobody. Decide which single Pet should answer it, or "none".',
  'Choose "none" for chat between people, thanks, acknowledgements, and anything that needs no action or answer from a Pet.',
  'When a question is about work a Pet did or said earlier in the history, choose that Pet.',
  'Only choose a Pet when you are fairly sure it is the one who should respond.',
  'Answer with JSON only: {"target": "<participantId or none>", "confidence": <0..1>, "reason": "<one short sentence>"}.',
].join('\n');

const decisionSchema = z.object({
  target: z.string(), confidence: z.number().min(0).max(1), reason: z.string().max(500).optional(),
});

/** One direct OpenAI-compatible chat completion; no Agent, tools or retries. */
export function createLlmRouteDecider(endpoint: StudioModelEndpoint, fetchImpl: typeof fetch = fetch): RouteDecider {
  return async (input, signal) => {
    const targets = [...input.pets.map(pet => pet.participantId), 'none'];
    const jsonSchema = {
      type: 'object', additionalProperties: false, required: ['target', 'confidence', 'reason'],
      properties: {
        target: { type: 'string', enum: targets },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string' },
      },
    };
    const method = endpoint.structuredOutputMethod ?? 'jsonMode';
    const output = method === 'jsonSchema'
      ? { response_format: { type: 'json_schema', json_schema: { name: 'channel_route', strict: true, schema: jsonSchema } } }
      : method === 'functionCalling'
        ? {
          tools: [{ type: 'function', function: { name: 'channel_route', description: 'Report the routing decision.', parameters: jsonSchema } }],
          tool_choice: { type: 'function', function: { name: 'channel_route' } },
        }
        : { response_format: { type: 'json_object' } };
    const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: 'system', content: ROUTE_SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ ...input, targets }) },
        ],
        temperature: 0,
        max_tokens: 300,
        ...output,
      }),
    });
    if (!response.ok) throw new Error(`Routing model returned HTTP ${response.status}.`);
    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    };
    const message = body.choices?.[0]?.message;
    const text = message?.tool_calls?.[0]?.function?.arguments ?? message?.content ?? '';
    return decisionSchema.parse(JSON.parse(text));
  };
}
