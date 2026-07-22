import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getLocalToolsWorkdir } from '../local/pathUtils';

const MAX_BROWSER_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export type BrowserScreenshotData = {
  mimeType: 'image/jpeg' | 'image/png';
  data: string;
};

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
  const directory = resolve(getLocalToolsWorkdir(), '.pinpawo', 'browser', 'screenshots');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const extension = input.mimeType === 'image/png' ? 'png' : 'jpg';
  const path = resolve(directory, `${Date.now()}-${randomUUID()}.${extension}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return JSON.stringify({
    path,
    mimeType: input.mimeType,
    byteLength: bytes.length,
  }, null, 2);
}
