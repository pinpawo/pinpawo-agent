import { execFile } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIcons } from './generate-icons.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');
const execFileAsync = promisify(execFile);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await execFileAsync('tsc', ['-p', resolve(root, 'tsconfig.build.json')]);
await generateIcons(resolve(output, 'icons'));
await cp(resolve(root, 'manifest.json'), resolve(output, 'manifest.json'));
await cp(resolve(root, 'README.md'), resolve(output, 'README.md'));
await cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(output, 'THIRD_PARTY_NOTICES.md'));
