import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const document = await readFile(new URL('./CAPABILITY.md', import.meta.url), 'utf-8');
assert.match(document, /^---\n/);
assert.match(document, /name:\s*web_research_brief/);
assert.match(document, /uses:\n(?:\s+-\s+.+\n)+/);
assert.match(document, /version:\s*1/);
assert.match(document, /\n---\n\n# /);

console.log('web_research_brief example ok');
