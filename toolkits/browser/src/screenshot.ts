import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

const MAX_BROWSER_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export type BrowserScreenshotData = {
  mimeType: 'image/jpeg' | 'image/png';
  data: string;
};

export type PersistedBrowserScreenshot = {
  path: string;
  mimeType: BrowserScreenshotData['mimeType'];
  byteLength: number;
  sha256: string;
};

function screenshotDirectory(workdir: string) {
  return resolve(workdir, '.pinpawo', 'browser', 'screenshots');
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMimeType(value: unknown): value is BrowserScreenshotData['mimeType'] {
  return value === 'image/jpeg' || value === 'image/png';
}

function parsePersistedBrowserScreenshot(value: unknown): PersistedBrowserScreenshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.path !== 'string'
    || !isAbsolute(record.path)
    || !isMimeType(record.mimeType)
    || !Number.isInteger(record.byteLength)
    || (record.byteLength as number) <= 0
    || (record.byteLength as number) > MAX_BROWSER_SCREENSHOT_BYTES
    || typeof record.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.sha256)
  ) {
    return null;
  }
  return {
    path: record.path,
    mimeType: record.mimeType,
    byteLength: record.byteLength as number,
    sha256: record.sha256,
  };
}

export function parseBrowserScreenshot(
  serialized: string,
): PersistedBrowserScreenshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error('browser screenshot payload must be valid JSON');
  }
  const screenshot = parsePersistedBrowserScreenshot(parsed);
  if (!screenshot) {
    throw new Error('browser screenshot payload is invalid');
  }
  return screenshot;
}

export async function readBrowserScreenshotData(
  screenshot: PersistedBrowserScreenshot,
  workdir = process.cwd(),
): Promise<BrowserScreenshotData> {
  const root = screenshotDirectory(workdir);
  const target = resolve(screenshot.path);
  const pathFromRoot = relative(root, target);
  if (
    !pathFromRoot
    || pathFromRoot.startsWith('..')
    || isAbsolute(pathFromRoot)
  ) {
    throw new Error('browser screenshot path is outside the screenshot directory');
  }
  const fileStat = await lstat(target);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error('browser screenshot reference is not a regular file');
  }
  const bytes = await readFile(target);
  if (
    bytes.length !== screenshot.byteLength
    || bytes.length === 0
    || bytes.length > MAX_BROWSER_SCREENSHOT_BYTES
    || digest(bytes) !== screenshot.sha256
  ) {
    throw new Error('browser screenshot reference failed integrity validation');
  }
  return {
    mimeType: screenshot.mimeType,
    data: bytes.toString('base64'),
  };
}

/**
 * Build the graph messages for one screenshot: the tool result itself, plus a
 * user message carrying the image.
 *
 * The image rides a HumanMessage rather than the ToolMessage because provider
 * transports disagree about images inside tool results — the OpenAI Chat
 * Completions converter drops every non-text block from a tool result. A user
 * message is accepted everywhere, so this needs no per-provider branch.
 *
 * LangChain keeps recent messages intact and renders older image blocks as
 * `[image]` when it summarizes them, so no provider-specific media marker is
 * needed here.
 */
export async function buildBrowserScreenshotMessages(
  serialized: string,
  toolCallId: string,
  workdir = process.cwd(),
): Promise<BaseMessage[]> {
  const screenshot = parseBrowserScreenshot(serialized);
  const toolMessage = new ToolMessage({
    content: `Browser screenshot saved.\n${serialized}`,
    name: 'browser_screenshot',
    tool_call_id: toolCallId,
  });
  let image: BrowserScreenshotData;
  try {
    image = await readBrowserScreenshotData(screenshot, workdir);
  } catch {
    return [
      toolMessage,
      new HumanMessage({
        content: 'The browser screenshot could not be loaded. Do not claim to have inspected it; call browser_screenshot again before making a visual judgment.',
      }),
    ];
  }
  return [
    toolMessage,
    new HumanMessage({
      content: [
        {
          type: 'text',
          text: 'Browser screenshot from the preceding tool result. Inspect the visible page using this image.',
        },
        { type: 'image', mimeType: image.mimeType, data: image.data },
      ],
      response_metadata: { output_version: 'v1' },
    }),
  ];
}

export async function persistBrowserScreenshot(
  input: BrowserScreenshotData,
  workdir = process.cwd(),
): Promise<string> {
  if (input.mimeType !== 'image/jpeg' && input.mimeType !== 'image/png') {
    throw new Error('browser screenshot mimeType must be image/jpeg or image/png');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) {
    throw new Error('browser screenshot data must be base64');
  }
  const bytes = Buffer.from(input.data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BROWSER_SCREENSHOT_BYTES) {
    throw new Error(`browser screenshot must contain 1-${MAX_BROWSER_SCREENSHOT_BYTES} bytes`);
  }
  const directory = screenshotDirectory(workdir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const extension = input.mimeType === 'image/png' ? 'png' : 'jpg';
  const path = resolve(directory, `${Date.now()}-${randomUUID()}.${extension}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return JSON.stringify({
    path,
    mimeType: input.mimeType,
    byteLength: bytes.length,
    sha256: digest(bytes),
  }, null, 2);
}
