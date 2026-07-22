import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'manifest.json'), resolve(output, 'manifest.json'));
await cp(resolve(root, 'README.md'), resolve(output, 'README.md'));
await cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(output, 'THIRD_PARTY_NOTICES.md'));
for (const file of ['background.js', 'interaction.js', 'protocol.js', 'snapshot.js']) {
  await cp(resolve(root, 'src', file), resolve(output, file));
}
