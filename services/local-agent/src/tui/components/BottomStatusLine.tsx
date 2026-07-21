import React from 'react';
import { Box, Text } from 'ink';
import {
  formatStatusBarLines,
  type FormattedStatusBarPart,
  type StatusBarModel,
} from '../statusBarModel';

export function BottomStatusLine(props: {
  model: StatusBarModel;
  width: number;
}) {
  const lines = formatStatusBarLines(props.model, props.width);
  return (
    <Box flexDirection="column">
      {lines.map((line) => (
        <Text key={line.id} dimColor={line.muted}>
          {line.parts.map((part, index) => (
            <Text key={`${part.segmentId ?? 'separator'}-${index}`} {...toneProps(part)}>
              {part.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

function toneProps(part: FormattedStatusBarPart) {
  const tone = part.separator ? 'muted' : part.tone;
  switch (tone) {
    case 'danger':
      return { color: 'red' as const };
    case 'warning':
      return { color: 'yellow' as const };
    case 'success':
      return { color: 'green' as const };
    case 'info':
      return { color: 'cyan' as const };
    case 'muted':
      return { dimColor: true };
  }
}
