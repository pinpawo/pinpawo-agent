import { randomBytes } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PET_CREDENTIALS_KEY_BYTES } from '../pets/petCredentials';

/** Write a new key file; refuses to replace an existing one. */
export async function createStudioCredentialsKey(file: string): Promise<void> {
  await writeFile(file, `${randomBytes(PET_CREDENTIALS_KEY_BYTES).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
}

/** Read the Studio's credentials key. The file must be owner-only and hold 32 base64 bytes. */
export async function readStudioCredentialsKey(file: string): Promise<Uint8Array> {
  if (!path.isAbsolute(file)) throw new Error('Studio credentials keyFile must be an absolute path.');
  let text: string;
  const handle = await open(file, 'r').catch(() => {
    throw new Error(`Studio credentials key file ${file} cannot be read.`);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Studio credentials key file ${file} is not a regular file.`);
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new Error(`Studio credentials key file ${file} must be readable only by its owner (chmod 600).`);
    }
    text = (await handle.readFile('utf8')).trim();
  } finally {
    await handle.close();
  }
  const key = Buffer.from(text, 'base64');
  if (key.byteLength !== PET_CREDENTIALS_KEY_BYTES || key.toString('base64') !== text) {
    throw new Error(`Studio credentials key file ${file} must hold ${PET_CREDENTIALS_KEY_BYTES} bytes in base64.`);
  }
  return new Uint8Array(key);
}
