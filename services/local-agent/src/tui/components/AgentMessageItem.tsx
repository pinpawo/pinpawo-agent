import React from 'react';
import { MessageBlock } from './MessageBlock';
import type { AgentMessageEntry } from '@pinpawo/agent-session';
import { SubagentMessageItem } from './SubagentMessageItem';

export function AgentMessageItem(props: {
  entry: AgentMessageEntry;
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
