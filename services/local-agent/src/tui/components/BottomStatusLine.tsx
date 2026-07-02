import React from 'react';
import { Text } from 'ink';
import {
  formatStatusBarParts,
  type FormattedStatusBarPart,
  type StatusBarModel,
} from '../statusBarModel';

export function BottomStatusLine(props: {
  model: StatusBarModel;
  width: number;
}) {
  const parts = formatStatusBarParts(props.model, props.width);
  return (
    <Text>
      {parts.map((part, index) => (
        <Text key={`${part.segmentId ?? 'separator'}-${index}`} {...toneProps(part)}>
          {part.text}
        </Text>
      ))}
    </Text>
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
