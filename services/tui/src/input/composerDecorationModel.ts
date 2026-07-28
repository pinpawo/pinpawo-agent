import stringWidth from 'string-width';

export type ComposerDecorationTone =
  | 'code'
  | 'command'
  | 'heading'
  | 'link'
  | 'marker'
  | 'mention'
  | 'quote'
  | 'strong';

export type ComposerDecoration = {
  line: number;
  start: number;
  end: number;
  tone: ComposerDecorationTone;
  priority: number;
};

export function buildComposerDecorations(
  text: string,
): ComposerDecoration[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const decorations: ComposerDecoration[] = [];
  let fence: {
    marker: '`' | '~';
    length: number;
  } | null = null;

  lines.forEach((line, lineIndex) => {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const fenceText = fenceMatch?.[1];
    const fenceMarker = fenceText?.[0] as '`' | '~' | undefined;
    if (fence) {
      const closesFence = fenceMarker === fence.marker
        && (fenceText?.length ?? 0) >= fence.length
        && line.slice(fenceMatch?.[0].length ?? 0).trim() === '';
      addDecoration(
        decorations,
        lineIndex,
        line,
        0,
        line.length,
        'code',
        closesFence ? 30 : 10,
      );
      if (closesFence) fence = null;
      return;
    }
    if (fenceMarker && fenceText) {
      addDecoration(
        decorations,
        lineIndex,
        line,
        0,
        line.length,
        'code',
        30,
      );
      fence = {
        marker: fenceMarker,
        length: fenceText.length,
      };
      return;
    }

    const heading = /^\s{0,3}#{1,6}(?:\s|$)/.exec(line);
    if (heading) {
      addDecoration(
        decorations,
        lineIndex,
        line,
        0,
        line.length,
        'heading',
        10,
      );
      addMatchDecoration(
        decorations,
        lineIndex,
        line,
        heading,
        'marker',
        30,
      );
    }

    const quote = /^\s{0,3}>\s?/.exec(line);
    if (quote) {
      addDecoration(
        decorations,
        lineIndex,
        line,
        0,
        line.length,
        'quote',
        10,
      );
      addMatchDecoration(
        decorations,
        lineIndex,
        line,
        quote,
        'marker',
        30,
      );
    }

    const listMarker = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.exec(line);
    if (listMarker) {
      addMatchDecoration(
        decorations,
        lineIndex,
        line,
        listMarker,
        'marker',
        30,
      );
    }

    if (lines.length === 1) {
      const command =
        /^\s*\/[A-Za-z][A-Za-z0-9_-]*(?=\s|$)/.exec(line);
      if (command) {
        addMatchDecoration(
          decorations,
          lineIndex,
          line,
          command,
          'command',
          40,
        );
      }
    }

    addPatternDecorations(
      decorations,
      lineIndex,
      line,
      /(?<!\S)@[^\s@]+/gu,
      'mention',
      25,
    );
    addPatternDecorations(
      decorations,
      lineIndex,
      line,
      /`[^`\n]+`/gu,
      'code',
      25,
    );
    addPatternDecorations(
      decorations,
      lineIndex,
      line,
      /\[[^\]\n]+\]\([^)]+\)/gu,
      'link',
      25,
    );
    addPatternDecorations(
      decorations,
      lineIndex,
      line,
      /(\*\*|__)\S(?:.*?\S)?\1/gu,
      'strong',
      20,
    );
  });

  return decorations.sort((left, right) => (
    left.line - right.line
    || left.start - right.start
    || left.priority - right.priority
  ));
}

function addPatternDecorations(
  decorations: ComposerDecoration[],
  lineIndex: number,
  line: string,
  pattern: RegExp,
  tone: ComposerDecorationTone,
  priority: number,
) {
  for (const match of line.matchAll(pattern)) {
    addMatchDecoration(
      decorations,
      lineIndex,
      line,
      match,
      tone,
      priority,
    );
  }
}

function addMatchDecoration(
  decorations: ComposerDecoration[],
  lineIndex: number,
  line: string,
  match: RegExpMatchArray,
  tone: ComposerDecorationTone,
  priority: number,
) {
  const start = match.index ?? 0;
  addDecoration(
    decorations,
    lineIndex,
    line,
    start,
    start + match[0].length,
    tone,
    priority,
  );
}

function addDecoration(
  decorations: ComposerDecoration[],
  lineIndex: number,
  line: string,
  startIndex: number,
  endIndex: number,
  tone: ComposerDecorationTone,
  priority: number,
) {
  const start = stringWidth(line.slice(0, startIndex));
  const end = start + stringWidth(line.slice(startIndex, endIndex));
  if (end <= start) return;
  decorations.push({
    line: lineIndex,
    start,
    end,
    tone,
    priority,
  });
}
