import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve(process.cwd(), '..', '..', 'tools', 'chrome-extension', 'dist');
const destination = resolve(process.cwd(), 'dist', 'toolkits', 'browser', 'chrome-extension');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log(`[browser:extension] copied ${source} -> ${destination}`);
