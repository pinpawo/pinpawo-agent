import React from 'react';
import { MessageBlock } from './MessageBlock';
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
  return (
    <MessageBlock
      entry={{
        role: props.entry.role,
        text: props.entry.text,
        createdAt: props.entry.createdAt,
        updatedAt: props.entry.updatedAt,
      }}
      petName={props.petName}
      width={props.width}
    />
  );
}
