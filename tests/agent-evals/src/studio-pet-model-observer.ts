import { createHash } from 'node:crypto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

export type StudioPetModelStage = 'entry' | 'supervisor-entry' | 'supervisor-boundary' | 'capability' | 'unknown';
export type StudioPetPromptSource = { id: string; owner?: string; content: string };

type ObservedMessage = {
  role: string;
  contentSha256: string;
  text?: string;
};
type ObservedCall = {
  name: string | null;
  id: string | null;
  argsSha256: string;
  args?: unknown;
  errorSha256?: string;
  error?: string;
};
type ObservedResponse = {
  promptIndex: number;
  completionIndex: number;
  contentSha256: string;
  text?: string;
  toolCalls: ObservedCall[];
  invalidToolCalls: ObservedCall[];
  rawToolCalls: ObservedCall[];
  finishReason: string | null;
  providerRequestId: string | null;
};

export type StudioPetModelObservation = {
  sequence: number;
  runId: string;
  parentRunId: string | null;
  petRole: string;
  stage: StudioPetModelStage;
  frameworkComponent: string | null;
  supervisorMode: string | null;
  boundToolNames: string[];
  prompts: Array<{
    messages: ObservedMessage[];
    sources: Array<{ id: string; owner: string | null; sha256: string; locations: Array<{
      messageIndex: number; role: string; occurrences: number; representation: 'literal' | 'json-string';
    }> }>;
  }>;
  responses: ObservedResponse[];
  status: 'started' | 'completed' | 'error';
  errorName?: string;
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;

function stage(metadata: Record<string, unknown>, fallback: StudioPetModelStage): StudioPetModelStage {
  // These are runtime node identities, not matches against prompt wording.
  const node = string(metadata.langgraph_node);
  const namespace = string(metadata.langgraph_checkpoint_ns) ?? '';
  const nodes = namespace.split('|').map(part => part.split(':')[0]);
  if (node === 'capability' || nodes.includes('capability')) return 'capability';
  if (metadata.frameworkComponent === 'run_supervisor') {
    if (metadata.supervisorMode === 'boundary') return 'supervisor-boundary';
    if (metadata.supervisorMode === 'entry') return 'supervisor-entry';
  }
  if (node === 'entryAnswer' || nodes.includes('entryAnswer')) return 'entry';
  return fallback;
}

/**
 * Observe final model inputs without wrapping the model or changing bindTools.
 * Unknown metadata, headers and serialized provider configuration are discarded.
 * Only an explicitly synthetic evaluation may retain prompt text/tool arguments.
 */
export function createStudioPetModelObserver(options: {
  petRole: string;
  sources?: readonly StudioPetPromptSource[];
  captureSyntheticContent?: boolean;
  defaultStage?: StudioPetModelStage;
}) {
  const capture = options.captureSyntheticContent === true;
  const sources = (options.sources ?? []).map(source => ({ ...source }));
  const records: StudioPetModelObservation[] = [];
  const byRun = new Map<string, StudioPetModelObservation>();
  const call = (value: unknown): ObservedCall => {
    const item = object(value);
    return {
      name: string(item.name), id: string(item.id), argsSha256: digest(item.args),
      ...(capture ? { args: structuredClone(item.args) } : {}),
      ...(typeof item.error === 'string' ? { errorSha256: digest(item.error), ...(capture ? { error: item.error } : {}) } : {}),
    };
  };
  const project = (message: BaseMessage): ObservedMessage => ({
    role: message._getType(), contentSha256: digest(message.content), ...(capture ? { text: message.text } : {}),
  });
  const callback = BaseCallbackHandler.fromMethods({
    handleChatModelStart(_llm, batches, runId, parentRunId, extra, _tags, metadata = {}) {
      const invocation = object(extra?.invocation_params);
      const tools = Array.isArray(invocation.tools) ? invocation.tools : [];
      const record: StudioPetModelObservation = {
        sequence: records.length + 1, runId, parentRunId: parentRunId ?? null, petRole: options.petRole,
        stage: stage(metadata, options.defaultStage ?? 'unknown'),
        frameworkComponent: string(metadata.frameworkComponent), supervisorMode: string(metadata.supervisorMode),
        boundToolNames: tools.flatMap(tool => {
          const item = object(tool);
          const name = string(object(item.function).name) ?? string(item.name);
          return name ? [name] : [];
        }),
        prompts: batches.map(messages => ({
          messages: messages.map(project),
          sources: sources.map(source => ({
            id: source.id, owner: source.owner ?? null, sha256: createHash('sha256').update(source.content).digest('hex'),
            locations: messages.flatMap((message, messageIndex) => {
              if (!source.content) return [];
              const literal = message.text.split(source.content).length - 1;
              const encoded = JSON.stringify(source.content).slice(1, -1);
              const occurrences = literal || (encoded !== source.content ? message.text.split(encoded).length - 1 : 0);
              return occurrences ? [{ messageIndex, role: message._getType(), occurrences,
                representation: literal ? 'literal' as const : 'json-string' as const }] : [];
            }),
          })),
        })),
        responses: [], status: 'started',
      };
      records.push(record);
      byRun.set(runId, record);
    },
    handleLLMEnd(output, runId) {
      const record = byRun.get(runId);
      if (!record) return;
      record.responses = output.generations.flatMap((generations, promptIndex) => generations.map((generation, completionIndex) => {
        const message = 'message' in generation ? generation.message as BaseMessage : undefined;
        const ai = message && AIMessage.isInstance(message) ? message : undefined;
        const metadata = object(message?.response_metadata);
        const info = object(generation.generationInfo);
        const llmOutput = object(output.llmOutput);
        const raw = ai?.additional_kwargs.tool_calls;
        return {
          promptIndex, completionIndex, contentSha256: digest(message?.content ?? generation.text),
          ...(capture ? { text: message?.text ?? generation.text } : {}),
          toolCalls: (ai?.tool_calls ?? []).map(call),
          invalidToolCalls: (ai?.invalid_tool_calls ?? []).map(call),
          rawToolCalls: Array.isArray(raw) ? raw.map(value => {
            const item = object(value), fn = object(item.function);
            return call({ id: item.id, name: fn.name, args: fn.arguments });
          }) : [],
          finishReason: string(metadata.finish_reason) ?? string(info.finish_reason) ?? string(info.finishReason),
          providerRequestId: string(metadata.request_id) ?? string(metadata.requestId)
            ?? string(info.request_id) ?? string(llmOutput.request_id) ?? string(llmOutput.requestId),
        };
      }));
      record.status = 'completed';
    },
    handleLLMError(error, runId) {
      const record = byRun.get(runId);
      if (!record) return;
      record.status = 'error';
      record.errorName = error.name;
    },
  });
  return { callback, read: (): StudioPetModelObservation[] => structuredClone(records) };
}
