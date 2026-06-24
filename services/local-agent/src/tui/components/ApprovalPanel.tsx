import { Box, Text } from 'ink';
import type { ReviewSpec } from '@pinpawo/pet-agent';
import { TUI_TEXT } from '../render/text';
import { wrapLine } from '../render/terminalText';
import {
  buildApplyPatchDisplayLines,
  type PatchDisplayLine,
} from './applyPatchDisplay';

type ApprovalContentLine = {
  text: string;
  tone?: PatchDisplayLine['tone'];
};

function formatReviewView(review: ReviewSpec) {
  return [
    review.view.title,
    review.view.body,
  ].filter((line): line is string => Boolean(line && line.trim())).join('\n');
}

function buildReviewContentLines(review: ReviewSpec, width: number): ApprovalContentLine[] {
  const patchPayload = readPatchReviewPayload(review);
  if (!patchPayload) {
    return wrapTextBlock(formatReviewView(review), width);
  }

  const intro = [
    review.view.title,
    patchPayload.body,
  ].filter((line): line is string => Boolean(line && line.trim())).join('\n');
  const introLines = wrapTextBlock(intro, width);
  return [
    ...introLines,
    ...(introLines.length > 0 ? [{ text: '' }] : []),
    ...buildApplyPatchDisplayLines({
      patch: patchPayload.patch,
      target: patchPayload.target,
      width,
      maxLines: 40,
    }),
  ];
}

function wrapTextBlock(text: string, width: number): ApprovalContentLine[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => wrapLine(line, width).map((wrapped) => ({ text: wrapped })));
}

function readPatchReviewPayload(review: ReviewSpec): {
  body: string;
  patch: string;
  target?: string;
} | null {
  const body = review.view.body;
  const section = readJsonReviewSection(body, 'Details')
    ?? readJsonReviewSection(body, 'Input');
  const patch = section && typeof section.value.patch === 'string'
    ? section.value.patch
    : null;
  if (!section || !patch) return null;

  const rest = { ...section.value };
  delete rest.patch;
  const before = body.slice(0, section.start).trimEnd();
  const after = body.slice(section.jsonEnd).trim();
  const restKeys = Object.keys(rest);
  const restBlock = restKeys.length > 0
    ? `${section.label}:\n${JSON.stringify(rest, null, 2)}`
    : '';
  const target = readReviewTarget(body) ?? readFirstPatchFilePath(rest);
  return {
    body: [before, restBlock, after].filter(Boolean).join('\n\n'),
    patch,
    ...(target ? { target } : {}),
  };
}

function readJsonReviewSection(body: string, label: 'Details' | 'Input'): {
  label: 'Details' | 'Input';
  start: number;
  jsonEnd: number;
  value: Record<string, unknown>;
} | null {
  const marker = `${label}:\n`;
  const start = body.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = firstNonWhitespaceIndex(body, start + marker.length);
  if (jsonStart === -1 || body[jsonStart] !== '{') return null;
  const parsed = parseJsonObjectAt(body, jsonStart);
  return parsed
    ? {
        label,
        start,
        jsonEnd: parsed.end,
        value: parsed.value,
      }
    : null;
}

function firstNonWhitespaceIndex(text: string, start: number) {
  for (let i = start; i < text.length; i += 1) {
    if (!/\s/.test(text[i] ?? '')) return i;
  }
  return -1;
}

function parseJsonObjectAt(text: string, start: number): {
  value: Record<string, unknown>;
  end: number;
} | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, i + 1)) as unknown;
          return value && typeof value === 'object' && !Array.isArray(value)
            ? { value: value as Record<string, unknown>, end: i + 1 }
            : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function readReviewTarget(body: string) {
  return body
    .split('\n')
    .map((line) => line.match(/^Target:\s*(.+)$/)?.[1]?.trim())
    .find((target): target is string => Boolean(target));
}

function readFirstPatchFilePath(details: Record<string, unknown>) {
  const files = details.files;
  if (!Array.isArray(files)) return undefined;
  return files
    .map((file) => file && typeof file === 'object' && 'path' in file
      ? (file as { path?: unknown }).path
      : undefined)
    .find((path): path is string => typeof path === 'string' && path.trim().length > 0);
}

export function ApprovalPanel(props: {
  review: ReviewSpec;
  petId?: string;
  width: number;
  selectedIndex: number;
}) {
  const options = props.review.options;
  const contentWidth = props.width - 4;
  const promptLines = buildReviewContentLines(props.review, contentWidth);
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
        <Text key={`p-${i}`} {...approvalLineToneProps(line.tone)}>
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

function approvalLineToneProps(tone: ApprovalContentLine['tone']) {
  switch (tone) {
    case 'added':
      return { color: 'green' as const };
    case 'removed':
      return { color: 'red' as const };
    case 'muted':
      return { dimColor: true };
    case 'default':
    case undefined:
      return {};
  }
}
