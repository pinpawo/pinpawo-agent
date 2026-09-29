import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve(
  process.cwd(),
  '..',
  '..',
  'toolkits',
  'browser',
  'dist',
  'hosts',
  'chrome-extension',
);
const destination = resolve(process.cwd(), 'dist', 'toolkits', 'browser');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await copyFile(
  resolve(source, 'native-host.js'),
  resolve(destination, 'native-host.js'),
);
await cp(
  resolve(source, 'extension'),
  resolve(destination, 'extension'),
  { recursive: true },
);
console.log(`[browser:host] copied ${source} -> ${destination}`);
