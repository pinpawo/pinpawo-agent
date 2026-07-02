import React from 'react';
import { MessageBlock } from './MessageBlock';
import { formatMessageTimestamp } from '../render/terminalText';
import type { AgentMessageEntry } from '../timeline/agentTimeline';

export function AgentMessageItem(props: {
  entry: AgentMessageEntry;
  petName: string;
  width: number;
}) {
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
