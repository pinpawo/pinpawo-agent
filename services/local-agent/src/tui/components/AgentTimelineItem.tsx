import React from 'react';
import { AgentMessageItem } from './AgentMessageItem';
import { AgentOperationItem } from './AgentOperationItem';
import type { AgentTimelineEntry } from '@pinpawo/agent-session';

export function AgentTimelineItem(props: {
  entry: AgentTimelineEntry;
  petName: string;
  now: number;
  width: number;
}) {
  switch (props.entry.type) {
    case 'message':
      return <AgentMessageItem entry={props.entry} petName={props.petName} width={props.width} />;
    case 'operation':
      return <AgentOperationItem entry={props.entry} now={props.now} width={props.width} />;
  }
}
