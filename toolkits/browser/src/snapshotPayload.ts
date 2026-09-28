/** Characters of the page tree a snapshot shows the model. */
export const MAX_BROWSER_SNAPSHOT_TREE_LENGTH = 50_000;
export const DEFAULT_BROWSER_EXTRACT_TEXT_LIMIT = 50_000;
export const MAX_BROWSER_EXTRACT_TEXT_LIMIT = 100_000;
const MAX_RAW_TREE_LENGTH = 2_000_000;

export interface BrowserExtractOptions {
  selector?: string;
  offset?: number;
  limit?: number;
}

export type BrowserRawExtract = {
  title: string;
  url: string;
  selector?: string;
  text: string;
  textLength: number;
  offset: number;
  limit: number;
  textSource?: string;
};

/**
 * A page snapshot as the extension returns it (#873): an indented outline of
 * the page's accessibility tree, `- role "name" [state] [ref=…]` per node and
 * `- text: "…"` for page text. `source` is `dom` when Chrome's tree was
 * unavailable and the page-side snapshot stood in, in the same shape.
 */
export type BrowserRawSnapshot = {
  title: string;
  url: string;
  tree: string;
  /** Full rendered length when the backend had to bound the raw IPC tree. */
  treeLength: number;
  refCount: number;
  source: 'accessibility' | 'dom';
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

export function parseBrowserRawSnapshot(value: unknown): BrowserRawSnapshot {
  if (!isRecord(value)) {
    throw new Error('browser snapshot result must be an object');
  }
  const { title, url, tree, treeLength, refCount, source } = value;
  if (typeof title !== 'string' || typeof url !== 'string' || typeof tree !== 'string') {
    throw new Error('browser snapshot title, url and tree must be strings');
  }
  if (tree.length > MAX_RAW_TREE_LENGTH) {
    throw new Error(`browser snapshot tree exceeds ${MAX_RAW_TREE_LENGTH} characters`);
  }
  if (!Number.isInteger(treeLength) || (treeLength as number) < tree.length) {
    throw new Error('browser snapshot treeLength must cover the returned tree');
  }
  if (!Number.isInteger(refCount) || (refCount as number) < 0) {
    throw new Error('browser snapshot refCount must be a non-negative integer');
  }
  if (source !== 'accessibility' && source !== 'dom') {
    throw new Error('browser snapshot source must be accessibility or dom');
  }
  return {
    title,
    url,
    tree,
    treeLength: treeLength as number,
    refCount: refCount as number,
    source,
  };
}

export function normalizeBrowserExtractOptions(options: BrowserExtractOptions = {}): TextWindow {
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
  const { offset, limit } = normalizeBrowserExtractOptions(options);
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

/**
 * The model-facing snapshot. The tree is cut at a line boundary within
 * {@link MAX_BROWSER_SNAPSHOT_TREE_LENGTH}; a cut tree says how to see more.
 */
export function buildBrowserSnapshotPayload(input: BrowserRawSnapshot) {
  let tree = input.tree;
  if (tree.length > MAX_BROWSER_SNAPSHOT_TREE_LENGTH) {
    const cut = tree.lastIndexOf('\n', MAX_BROWSER_SNAPSHOT_TREE_LENGTH);
    tree = tree.slice(0, cut > 0 ? cut : MAX_BROWSER_SNAPSHOT_TREE_LENGTH);
  }
  const truncated = tree.length < input.treeLength;
  return {
    title: input.title,
    url: input.url,
    source: input.source,
    tree,
    treeLength: input.treeLength,
    returnedTreeLength: tree.length,
    truncated,
    refCount: input.refCount,
    ...(truncated
      ? {
          note: `Showing the first ${tree.length} of ${input.treeLength} characters of the page tree. `
            + 'Read long text with browser_extract; elements further down need a new snapshot after scrolling.',
        }
      : {}),
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

export function parseBrowserRawExtract(value: unknown): BrowserRawExtract {
  if (!isRecord(value)) {
    throw new Error('browser extract result must be an object');
  }
  const { title, url, selector, text, textLength, offset, limit, textSource } = value;
  if (typeof title !== 'string' || typeof url !== 'string' || typeof text !== 'string') {
    throw new Error('browser extract title, url and text must be strings');
  }
  if (selector !== undefined && typeof selector !== 'string') {
    throw new Error('browser extract selector must be a string');
  }
  if (textSource !== undefined && typeof textSource !== 'string') {
    throw new Error('browser extract textSource must be a string');
  }
  if (!Number.isInteger(textLength) || (textLength as number) < 0) {
    throw new Error('browser extract textLength must be a non-negative integer');
  }
  if (!Number.isInteger(offset) || (offset as number) < 0) {
    throw new Error('browser extract offset must be a non-negative integer');
  }
  if (
    !Number.isInteger(limit)
    || (limit as number) <= 0
    || (limit as number) > MAX_BROWSER_EXTRACT_TEXT_LIMIT
  ) {
    throw new Error(`browser extract limit must be between 1 and ${MAX_BROWSER_EXTRACT_TEXT_LIMIT}`);
  }
  if ((offset as number) > (textLength as number) || (offset as number) + text.length > (textLength as number)) {
    throw new Error('browser extract text window must fit within textLength');
  }
  return {
    title,
    url,
    selector: selector as string | undefined,
    text,
    textLength: textLength as number,
    offset: offset as number,
    limit: limit as number,
    textSource: textSource as string | undefined,
  };
}

export function buildBrowserExtractPayloadFromRaw(input: BrowserRawExtract) {
  const textEndOffset = input.offset + input.text.length;
  const hasMore = textEndOffset < input.textLength;
  return {
    title: input.title,
    url: input.url,
    selector: input.selector,
    textSource: input.textSource,
    offset: input.offset,
    limit: input.limit,
    text: input.text,
    textLength: input.textLength,
    returnedTextLength: input.text.length,
    textEndOffset,
    truncated: input.offset > 0 || hasMore,
    hasMore,
    nextOffset: hasMore ? textEndOffset : null,
  };
}
