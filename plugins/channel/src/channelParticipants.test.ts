import assert from 'node:assert/strict';
import test from 'node:test';
import { channelParticipantId, parseChannelMentions, type ChannelParticipant } from './channelParticipants';

const participants: ChannelParticipant[] = [
  { participantId: 'pet:one', kind: 'pet', id: 'one', label: 'Same name' },
  { participantId: 'pet:two', kind: 'pet', id: 'two', label: 'Same name' },
  { participantId: 'human:owner', kind: 'human', id: 'owner', label: 'Owner' },
];

test('identity-bearing mentions route independently of duplicate and changed labels, normalize targets and include humans', () => {
  const body = '[@Old name](participant:pet:two) handle this. [@Me](participant:human:owner) gets the result.';
  const result = parseChannelMentions(body, [{ petId: 'two' }, { participantId: 'pet:one' }], participants);
  assert.deepEqual(result.map(item => item.participantId), ['pet:two', 'pet:one', 'human:owner']);
  assert.equal(result[0]?.label, 'Same name');
  const renamed = participants.map(item => item.id === 'two' ? { ...item, label: 'Renamed' } : item);
  assert.equal(parseChannelMentions(body, [], renamed)[0]?.participantId, 'pet:two');
  assert.equal(parseChannelMentions(body, [], renamed)[0]?.label, 'Renamed');
  assert.equal(channelParticipantId('pet', 'id with /'), 'pet:id%20with%20%2F');
});

test('code, quoted reports, Markdown quotations and bare labels never address participants', () => {
  const mention = '[@Same name](participant:pet:one)';
  for (const body of ['@one', '`'+mention+'`', '```md\n'+mention+'\n```', '> '+mention, 'They wrote "'+mention+'".', "They wrote '"+mention+"'.", '转述：“'+mention+'”', '转述：‘'+mention+'’']) {
    assert.deepEqual(parseChannelMentions(body, [], participants), [], body);
  }
  assert.equal(parseChannelMentions('Example:\n> '+mention+'\n\n'+mention+' do this.', [], participants).length, 1);
  assert.equal(parseChannelMentions("It's ready. "+mention+" Don't delay.", [], participants).length, 1);
  assert.throws(() => parseChannelMentions('[@Same name](participant:pet:missing)', [], participants), /Unknown Channel participant/);
  assert.throws(() => parseChannelMentions('work', [{ participantId: 'pet:missing' }], participants), /Unknown Channel participant/);
});
