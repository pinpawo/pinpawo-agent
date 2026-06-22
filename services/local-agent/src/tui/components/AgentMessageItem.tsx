import React from 'react';
import { MessageBlock } from './MessageBlock';
import type { AgentMessageEntry } from '../timeline/agentTimeline';

export function AgentMessageItem(props: {
  entry: AgentMessageEntry;
  petName: string;
  width: number;
}) {
  return (
    <MessageBlock
      entry={{
        kind: props.entry.role,
        timestamp: props.entry.updatedAt ?? props.entry.createdAt,
        text: props.entry.text,
      }}
      petName={props.petName}
      width={props.width}
    />
  );
}
