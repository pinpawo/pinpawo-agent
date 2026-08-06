import { execFile } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIcons } from './generate-icons.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'src', 'hosts', 'chromeExtension', 'extension');
const output = resolve(root, 'dist', 'hosts', 'chrome-extension', 'extension');
const execFileAsync = promisify(execFile);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await execFileAsync('tsc', ['-p', resolve(root, 'tsconfig.extension.build.json')]);
await generateIcons(resolve(output, 'icons'));
await cp(resolve(source, 'manifest.json'), resolve(output, 'manifest.json'));
await cp(resolve(source, 'README.md'), resolve(output, 'README.md'));
await cp(resolve(source, 'THIRD_PARTY_NOTICES.md'), resolve(output, 'THIRD_PARTY_NOTICES.md'));
