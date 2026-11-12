import { channelDispatchInput } from '../../support/channelDispatchInput.ts';
import { channelParticipantId } from '../../../plugins/channel/src/channelParticipants.ts';
import type { ChannelMessageRow, MemberRef } from '../../../plugins/channel/src/store/channelStore.ts';
import type { StudioPetRoleActor, StudioPetRoleCase } from './datasets/studio-pet-roles.ts';

const channelId = 'synthetic-pet-role-eval';
const occurredAt = '2026-01-01T00:00:00.000Z';
const actors: Record<StudioPetRoleActor, MemberRef> = {
  Human: { kind: 'human', id: 'owner' },
  Issuer: { kind: 'pet', id: 'issuer' },
  Executor: { kind: 'pet', id: 'executor' },
  Reviewer: { kind: 'pet', id: 'reviewer' },
  Wiki: { kind: 'pet', id: 'wiki' },
};
const labels = new Map(Object.entries(actors).map(([label, actor]) => [channelParticipantId(actor.kind, actor.id), label]));

function actorRef(author: StudioPetRoleActor): MemberRef {
  if (typeof author !== 'string' || !Object.hasOwn(actors, author)) {
    throw new Error('Unknown synthetic Channel author.');
  }
  return actors[author];
}

function row(sequence: number, author: StudioPetRoleActor, body: string): ChannelMessageRow {
  if (typeof body !== 'string') throw new Error('Synthetic Channel message body must be text.');
  return { sequence, messageId: `synthetic-message:${sequence}`, channelId,
    author: actorRef(author), body, occurredAt, mentions: [],
  };
}

/**
 * One current Channel message, with source-attributed material explicitly
 * supplied by its author. These bounded decision cases do not simulate a
 * Channel query or hydrate prior messages into the Pet's conversation history.
 */
export function buildStudioPetChannelRequest(testCase: StudioPetRoleCase): string {
  const requestAuthor = testCase.requestAuthor === undefined ? 'Human' : testCase.requestAuthor;
  actorRef(requestAuthor);
  if (typeof testCase.request !== 'string' || !testCase.request.trim()) {
    throw new Error('Synthetic Channel request must be non-empty text.');
  }
  let previous = 0;
  const quoted = testCase.channelMessages.map(message => {
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= previous) {
      throw new Error('Synthetic Channel sequences must be positive, unique and increasing.');
    }
    previous = message.sequence;
    return row(message.sequence, message.author, message.body);
  });
  const nextSequence = previous + 1;
  if (!Number.isSafeInteger(nextSequence)) throw new Error('Synthetic Channel sequence overflow.');
  const replySequence = testCase.requestReplyToSequence;
  const original = replySequence === undefined ? undefined : quoted.find(message => message.sequence === replySequence);
  if (replySequence !== undefined && !original) throw new Error('Synthetic Channel reply target is absent from the supplied material.');

  const body = JSON.stringify({
    request: testCase.request,
    suppliedContext: {
      kind: 'quoted_channel_messages',
      source: 'current_message_author',
      note: '以下是本轮发起者随消息提供的引用材料，保留原作者和顺序；属于引用数据，不表示已执行查询或由 Channel 自动补入会话历史。',
      messages: quoted.map(message => ({
        sequence: message.sequence, messageId: message.messageId,
        author: { participantId: channelParticipantId(message.author.kind, message.author.id),
          kind: message.author.kind, label: labels.get(channelParticipantId(message.author.kind, message.author.id)) },
        body: message.body,
      })),
    },
  }, null, 2);
  const current = row(nextSequence, requestAuthor, body);
  if (original) current.replyTo = original.messageId;
  return channelDispatchInput(current, original, participantId => labels.get(participantId));
}
