import React from 'react';
import { Box, Text } from 'ink';
import {
  buildAgentOperationDisplayLines,
  OPERATION_STATUS_DOT,
} from './agentTimelineRendering';
import { patchToneToInkProps } from './applyPatchDisplay';
import type { LocalAgentOperationEntry } from '../../localAgentSession';

type OperationPhase = LocalAgentOperationEntry['phase'];

/**
 * Status-dot color per phase, matching the gray/green/red convention:
 * gray = running/pending, green = completed, red = failed, yellow = interrupted.
 */
function statusDotColor(phase: OperationPhase): string | undefined {
  switch (phase) {
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'interrupted':
      return 'yellow';
    case 'started':
    case 'updated':
      // Running/pending: a dim (gray) dot.
      return undefined;
  }
}

export function AgentOperationItem(props: {
  entry: LocalAgentOperationEntry;
  now: number;
  width: number;
}) {
  const lines = buildAgentOperationDisplayLines(props.entry, props.now, props.width);

  return (
    <Box flexDirection="column" marginBottom={1}>
      {lines.map((line) => {
        if (line.statusDot) {
          const dotColor = statusDotColor(line.statusDot);
          return (
            <Text key={line.id}>
              <Text color={dotColor} dimColor={dotColor === undefined}>
                {OPERATION_STATUS_DOT}
              </Text>
              <Text dimColor> {line.text}</Text>
            </Text>
          );
        }
        return (
          <Text key={line.id} {...patchToneToInkProps(line.tone, { dimColor: true })}>
            {line.text}
          </Text>
        );
      })}
    </Box>
  );
}
