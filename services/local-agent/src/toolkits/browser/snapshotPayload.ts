export const MAX_BROWSER_SNAPSHOT_TEXT_LENGTH = 50_000;
export const MAX_BROWSER_INTERACTIVE_ELEMENTS = 20;
export const DEFAULT_BROWSER_EXTRACT_TEXT_LIMIT = 50_000;
export const MAX_BROWSER_EXTRACT_TEXT_LIMIT = 100_000;
const MAX_RAW_INTERACTIVE_ELEMENTS = 200;
const MAX_RAW_TEXT_LENGTH = 2_000_000;

export interface BrowserExtractOptions {
  selector?: string;
  offset?: number;
  limit?: number;
}

export type BrowserInteractiveElement = {
  index: number;
  tag: string;
  text: string;
  type: string | null;
  placeholder: string | null;
  hint: string;
  backendNodeId?: number;
  frameId?: string;
};

export type BrowserRawSnapshot = {
  title: string;
  url: string;
  text: string;
  /** Full source length when the backend had to bound the raw IPC text. */
  textLength?: number;
  interactive: BrowserInteractiveElement[];
  interactiveCount?: number;
  textSource?: string;
  textUnavailableReason?: string;
};

type TextWindow = {
  offset: number;
  limit: number;
};

export type BrowserTextChunk = TextWindow & {
  text: string;
  textLength: number;
  returnedTextLength: number;
  textEndOffset: number;
  truncated: boolean;
  hasMore: boolean;
  nextOffset: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`browser snapshot ${key} must be a string`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`browser snapshot interactive.${key} must be a string or null`);
  }
  return value;
}

function parseInteractiveElement(value: unknown): BrowserInteractiveElement {
  if (!isRecord(value)) {
    throw new Error('browser snapshot interactive entry must be an object');
  }
  const { index, tag, text, hint, backendNodeId, frameId } = value;
  if (!Number.isInteger(index) || (index as number) <= 0) {
    throw new Error('browser snapshot interactive.index must be a positive integer');
  }
  if (typeof tag !== 'string' || typeof text !== 'string' || typeof hint !== 'string') {
    throw new Error('browser snapshot interactive tag, text and hint must be strings');
  }
  if (backendNodeId !== undefined && (!Number.isInteger(backendNodeId) || (backendNodeId as number) <= 0)) {
    throw new Error('browser snapshot interactive.backendNodeId must be a positive integer');
  }
  if (frameId !== undefined && typeof frameId !== 'string') {
    throw new Error('browser snapshot interactive.frameId must be a string');
  }
  return {
    index: index as number,
    tag,
    text,
    type: readNullableString(value, 'type'),
    placeholder: readNullableString(value, 'placeholder'),
    hint,
    backendNodeId: backendNodeId as number | undefined,
    frameId: frameId as string | undefined,
  };
}

export function parseBrowserRawSnapshot(value: unknown): BrowserRawSnapshot {
  if (!isRecord(value)) {
    throw new Error('browser snapshot result must be an object');
  }
  const { title, url, text, textLength, interactive, interactiveCount } = value;
  if (typeof title !== 'string' || typeof url !== 'string' || typeof text !== 'string') {
    throw new Error('browser snapshot title, url and text must be strings');
  }
  if (text.length > MAX_RAW_TEXT_LENGTH) {
    throw new Error(`browser snapshot text exceeds ${MAX_RAW_TEXT_LENGTH} characters`);
  }
  if (
    textLength !== undefined
    && (!Number.isInteger(textLength) || (textLength as number) < text.length)
  ) {
    throw new Error('browser snapshot textLength must cover the returned text');
  }
  if (!Array.isArray(interactive) || interactive.length > MAX_RAW_INTERACTIVE_ELEMENTS) {
    throw new Error(`browser snapshot interactive must contain at most ${MAX_RAW_INTERACTIVE_ELEMENTS} entries`);
  }
  if (
    interactiveCount !== undefined
    && (!Number.isInteger(interactiveCount) || (interactiveCount as number) < interactive.length)
  ) {
    throw new Error('browser snapshot interactiveCount must cover returned interactive entries');
  }
  const parsedInteractive = interactive.map(parseInteractiveElement);
  if (new Set(parsedInteractive.map((element) => element.index)).size !== parsedInteractive.length) {
    throw new Error('browser snapshot interactive indexes must be unique');
  }
  return {
    title,
    url,
    text,
    textLength: textLength as number | undefined,
    interactive: parsedInteractive,
    interactiveCount: interactiveCount as number | undefined,
    textSource: readOptionalString(value, 'textSource'),
    textUnavailableReason: readOptionalString(value, 'textUnavailableReason'),
  };
}

function normalizeTextWindow(options: BrowserExtractOptions = {}): TextWindow {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_BROWSER_EXTRACT_TEXT_LIMIT;

  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('browser_extract offset must be a non-negative integer');
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_BROWSER_EXTRACT_TEXT_LIMIT) {
    throw new Error(
      `browser_extract limit must be an integer between 1 and ${MAX_BROWSER_EXTRACT_TEXT_LIMIT}`,
    );
  }

  return { offset, limit };
}

export function buildBrowserTextChunk(
  text: string,
  options: BrowserExtractOptions = {},
): BrowserTextChunk {
  const { offset, limit } = normalizeTextWindow(options);
  const safeOffset = Math.min(offset, text.length);
  const textEndOffset = Math.min(safeOffset + limit, text.length);
  const chunk = text.slice(safeOffset, textEndOffset);
  const hasMore = textEndOffset < text.length;

  return {
    offset: safeOffset,
    limit,
    text: chunk,
    textLength: text.length,
    returnedTextLength: chunk.length,
    textEndOffset,
    truncated: safeOffset > 0 || hasMore,
    hasMore,
    nextOffset: hasMore ? textEndOffset : null,
  };
}

function buildSnapshotTextFields(text: string, fullTextLength = text.length) {
  const chunk = buildBrowserTextChunk(text, {
    offset: 0,
    limit: MAX_BROWSER_SNAPSHOT_TEXT_LENGTH,
  });
  return {
    text: chunk.text,
    textLength: fullTextLength,
    returnedTextLength: chunk.returnedTextLength,
    textOffset: chunk.offset,
    textEndOffset: chunk.textEndOffset,
    textLimit: MAX_BROWSER_SNAPSHOT_TEXT_LENGTH,
    truncated: chunk.hasMore || fullTextLength > text.length,
    hasMore: chunk.hasMore || fullTextLength > text.length,
    nextTextOffset: chunk.hasMore || fullTextLength > text.length
      ? chunk.textEndOffset
      : null,
  };
}

export function buildBrowserSnapshotPayload(input: BrowserRawSnapshot) {
  const interactive = input.interactive
    .slice(0, MAX_BROWSER_INTERACTIVE_ELEMENTS)
    .map((element) => {
      const hint = element.hint.replace(/^\[\d+\]\s*/, '').trim();
      return {
        ...element,
        hint: `[${element.index}]${hint ? ` ${hint}` : ''}`,
      };
    });
  const interactiveCount = input.interactiveCount ?? input.interactive.length;
  return {
    title: input.title,
    url: input.url,
    interactive,
    interactiveCount,
    returnedInteractiveCount: interactive.length,
    interactiveTruncated: interactiveCount > interactive.length,
    ...buildSnapshotTextFields(input.text, input.textLength),
    textSource: input.textSource,
    textUnavailableReason: input.textUnavailableReason,
  };
}

export function buildBrowserExtractPayload(
  input: {
    title: string;
    url: string;
    text: string;
    selector?: string;
    offset?: number;
    limit?: number;
    textSource?: string;
  },
) {
  const chunk = buildBrowserTextChunk(input.text, input);
  return {
    title: input.title,
    url: input.url,
    selector: input.selector,
    textSource: input.textSource,
    ...chunk,
  };
}
