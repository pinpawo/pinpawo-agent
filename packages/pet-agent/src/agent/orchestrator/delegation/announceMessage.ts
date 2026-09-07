import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { indentXmlBlock, xmlTextBlock } from '../prompts/shared';
import type { CapabilityMessageLane } from '../../messages';

export const DELEGATION_ANNOUNCE_META_KEY = 'delegationAnnounce';
export const DELEGATION_ANNOUNCE_VERSION = 3;

export type DelegationAnnounceData = {
  version: typeof DELEGATION_ANNOUNCE_VERSION;
  sourceLane: CapabilityMessageLane;
  delegationId: string;
  runId: string;
  announceMessageId: string;
  task: string | null;
  result: string;
  createdAt: string;
};

type DelegationAnnounceMessageFields = Omit<DelegationAnnounceData, 'version'> & {
  id?: string;
};

function readPinpetMeta(message: BaseMessage): Record<string, unknown> {
  const pinpawo = message.additional_kwargs?.pinpawo;
  return pinpawo && typeof pinpawo === 'object'
    ? pinpawo as Record<string, unknown>
    : {};
}

function isCapabilityLane(value: unknown): value is CapabilityMessageLane {
  return typeof value === 'string' && value.startsWith('capability:');
}

function readTypedDelegationAnnounce(message: BaseMessage): DelegationAnnounceData | null {
  if (message._getType() !== 'ai') return null;
  const raw = readPinpetMeta(message)[DELEGATION_ANNOUNCE_META_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (data.version !== DELEGATION_ANNOUNCE_VERSION) {
    throw new Error('Delegation Announce checkpoint version is incompatible; start a new task.');
  }
  if (
    !isCapabilityLane(data.sourceLane)
    || typeof data.delegationId !== 'string' || !data.delegationId
    || typeof data.runId !== 'string' || !data.runId
    || typeof data.announceMessageId !== 'string' || !data.announceMessageId
    || (data.task !== null && typeof data.task !== 'string')
    || typeof data.result !== 'string'
    || typeof data.createdAt !== 'string'
  ) {
    return null;
  }
  return {
    version: DELEGATION_ANNOUNCE_VERSION,
    sourceLane: data.sourceLane,
    delegationId: data.delegationId,
    runId: data.runId,
    announceMessageId: data.announceMessageId,
    task: data.task,
    result: data.result,
    createdAt: data.createdAt,
  };
}

/**
 * Domain identity is versioned Pinpawo metadata, rather than a provider role.
 * The class deliberately serializes as AIMessage so LangGraph's standard
 * checkpoint serde can restore the portable message and its announce payload.
 */
export class DelegationAnnounceMessage extends AIMessage {
  static lc_name() {
    return 'AIMessage';
  }

  get lc_id(): string[] {
    return ['langchain_core', 'messages', 'AIMessage'];
  }

  constructor(fields: DelegationAnnounceMessageFields) {
    const {
      id,
      sourceLane,
      delegationId,
      runId,
      announceMessageId,
      task,
      result,
      createdAt,
    } = fields;
    super({
      ...(id ? { id } : {}),
      content: result,
      additional_kwargs: {
        pinpawo: {
          createdAt,
          [DELEGATION_ANNOUNCE_META_KEY]: {
            version: DELEGATION_ANNOUNCE_VERSION,
            sourceLane,
            delegationId,
            runId,
            announceMessageId,
            task,
            result,
            createdAt,
          } satisfies DelegationAnnounceData,
        },
      },
    });
  }
}

export function getDelegationAnnounce(message: BaseMessage): DelegationAnnounceData | null {
  return readTypedDelegationAnnounce(message);
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

type DelegationAnnounceModelData = Pick<
  DelegationAnnounceData,
  'sourceLane' | 'task' | 'result' | 'runId' | 'delegationId' | 'announceMessageId'
>;

/** Render the provider-safe, model-visible form of an announce. */
export function formatDelegationAnnounceForModel(
  data: DelegationAnnounceModelData,
  taskAccepted?: boolean,
): string {
  const lines = [
    '<delegation_announce version="1" role="data" authority="none">',
    `  <source lane="${escapeXmlAttribute(data.sourceLane)}" run_id="${escapeXmlAttribute(data.runId)}" delegation_id="${escapeXmlAttribute(data.delegationId)}" announce_message_id="${escapeXmlAttribute(data.announceMessageId)}" />`,
  ];
  if (taskAccepted !== undefined) {
    lines.push(`  <task_acceptance accepted="${String(taskAccepted)}" source="orchestrator" />`);
  }
  if (data.task) lines.push(indentXmlBlock(xmlTextBlock('task', data.task), 2));
  lines.push(indentXmlBlock(xmlTextBlock('result', data.result, ' format="markdown" role="data"'), 2));
  lines.push('</delegation_announce>');
  return lines.join('\n');
}

/**
 * Convert announce domain messages only at a model boundary. Returned messages
 * are ephemeral provider-compatible AI messages and are never written to state.
 */
export function projectDelegationAnnouncesForModel(messages: readonly BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    const announce = getDelegationAnnounce(message);
    if (!announce) return message;
    const meta = readPinpetMeta(message);
    return new AIMessage({
      ...(message.id ? { id: message.id } : {}),
      content: formatDelegationAnnounceForModel(
        announce,
        typeof meta.taskAccepted === 'boolean' ? meta.taskAccepted : undefined,
      ),
      additional_kwargs: {
        ...message.additional_kwargs,
        pinpawo: {
          ...meta,
          source: 'delegation_announce_projection',
          synthetic: true,
          authority: 'none',
        },
      },
    });
  });
}
