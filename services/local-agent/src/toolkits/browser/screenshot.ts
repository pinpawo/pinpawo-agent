import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { getLocalToolsWorkdir } from '../local/pathUtils';

const MAX_BROWSER_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export const BROWSER_SCREENSHOT_ARTIFACT_TYPE = 'pinpawo.browser-screenshot.v1';

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

export type BrowserScreenshotArtifact = {
  type: typeof BROWSER_SCREENSHOT_ARTIFACT_TYPE;
  screenshot: PersistedBrowserScreenshot;
};

function screenshotDirectory() {
  return resolve(getLocalToolsWorkdir(), '.pinpawo', 'browser', 'screenshots');
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

export function createBrowserScreenshotArtifact(
  serialized: string,
): BrowserScreenshotArtifact {
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
  return {
    type: BROWSER_SCREENSHOT_ARTIFACT_TYPE,
    screenshot,
  };
}

export function readBrowserScreenshotArtifact(
  value: unknown,
): BrowserScreenshotArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== BROWSER_SCREENSHOT_ARTIFACT_TYPE) return null;
  const screenshot = parsePersistedBrowserScreenshot(record.screenshot);
  return screenshot
    ? { type: BROWSER_SCREENSHOT_ARTIFACT_TYPE, screenshot }
    : null;
}

export async function readBrowserScreenshotDataUrl(
  screenshot: PersistedBrowserScreenshot,
) {
  const root = screenshotDirectory();
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
  return `data:${screenshot.mimeType};base64,${bytes.toString('base64')}`;
}

export async function buildBrowserScreenshotToolMessage(
  serialized: string,
  toolCallId: string,
) {
  const artifact = createBrowserScreenshotArtifact(serialized);
  const imageUrl = await readBrowserScreenshotDataUrl(artifact.screenshot);
  return new ToolMessage({
    contentBlocks: [
      {
        type: 'text',
        text: `Browser screenshot from the current viewport.\n${serialized}`,
      },
      {
        type: 'image',
        url: imageUrl,
        mimeType: artifact.screenshot.mimeType,
        metadata: { detail: 'auto' },
      },
    ],
    artifact,
    name: 'browser_screenshot',
    tool_call_id: toolCallId,
  });
}

export async function persistBrowserScreenshot(input: BrowserScreenshotData): Promise<string> {
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
  const directory = screenshotDirectory();
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
