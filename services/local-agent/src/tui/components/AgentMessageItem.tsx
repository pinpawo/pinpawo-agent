import React from 'react';
import { MessageBlock } from './MessageBlock';
import { formatMessageTimestamp } from '../render/terminalText';
import type { LocalAgentMessageEntry } from '../../localAgentSession';
import { SubagentMessageItem } from './SubagentMessageItem';

export function AgentMessageItem(props: {
  entry: LocalAgentMessageEntry;
  petName: string;
  width: number;
}) {
  if (props.entry.role === 'subagent') {
    return <SubagentMessageItem entry={props.entry} width={props.width} />;
  }
  const timestamp = props.entry.updatedAt ?? props.entry.createdAt;
  return (
    <MessageBlock
      entry={{
        kind: props.entry.role,
        timestamp: timestamp ? formatMessageTimestamp(timestamp) : undefined,
        text: props.entry.text,
      }}
      petName={props.petName}
      width={props.width}
    />
  );
}
