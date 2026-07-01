import React from 'react';
import { Box, Text } from 'ink';
import type { ReviewSpec, ReviewView } from '@pinpawo/pet-agent';
import { TUI_TEXT } from '../render/text';
import { wrapLine } from '../render/terminalText';
import {
  buildApplyPatchDisplayLines,
  patchToneToInkProps,
  type PatchDisplayLine,
} from './applyPatchDisplay';

type ApprovalContentLine = {
  text: string;
  tone?: PatchDisplayLine['tone'];
};

function buildReviewContentLines(view: ReviewView, width: number): ApprovalContentLine[] {
  if (view.kind === 'diff') {
    const intro = [view.title, view.summary].filter(isNonEmpty).join('\n');
    const introLines = wrapTextBlock(intro, width);
    return [
      ...introLines,
      ...(introLines.length > 0 ? [{ text: '' }] : []),
      ...buildApplyPatchDisplayLines({
        patch: view.patch,
        target: view.target,
        width,
        maxLines: 40,
      }),
    ];
  }

  const text = [view.title, view.body].filter(isNonEmpty).join('\n');
  return wrapTextBlock(text, width);
}

function isNonEmpty(line: string | undefined): line is string {
  return Boolean(line && line.trim());
}

function wrapTextBlock(text: string, width: number): ApprovalContentLine[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => wrapLine(line, width).map((wrapped) => ({ text: wrapped })));
}

export function ApprovalPanel(props: {
  review: ReviewSpec;
  petId?: string;
  width: number;
  selectedIndex: number;
}) {
  const options = props.review.options;
  const contentWidth = props.width - 4;
  const promptLines = buildReviewContentLines(props.review.view, contentWidth);
  const selectedIndex = Math.max(0, Math.min(options.length - 1, props.selectedIndex));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      marginTop={1}
      width={props.width}
    >
      <Text color="yellow">
        {TUI_TEXT.approvalHeading(props.petId)}
      </Text>
      {promptLines.map((line, i) => (
        <Text key={`p-${i}`} {...patchToneToInkProps(line.tone)}>
          {line.text || ' '}
        </Text>
      ))}
      <Text>{' '}</Text>
      {options.map((opt, i) => (
        <Box key={`o-${i}`} flexDirection="column">
          <Text color={i === selectedIndex ? 'cyan' : undefined} bold={i === selectedIndex}>
            {i === selectedIndex ? '› ' : '  '}{opt.label}
            {opt.input ? ' …' : ''}
          </Text>
          {opt.description ? (
            <Text dimColor>
              {'    '}{opt.description}
            </Text>
          ) : null}
        </Box>
      ))}
      <Text>{' '}</Text>
      <Text dimColor>{TUI_TEXT.approvalHelp}</Text>
    </Box>
  );
}
