import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const document = await readFile(new URL('./CAPABILITY.md', import.meta.url), 'utf-8');
assert.match(document, /^---\n/);
assert.match(document, /name: web_research_brief/);
assert.match(document, /description:.*网页.*URL.*HTTP.*引用链接/);
assert.match(document, /uses:\n  - bash/);
assert.match(document, /version: 1/);
assert.match(document, /\n---\n\n# Web Research Brief/);
assert.match(document, /http_fetch/);
assert.match(document, /不要用 `run_shell` 拼 `curl`/);
assert.match(document, /浏览器 capability/);
assert.match(document, /结论摘要、关键事实、来源列表/);
assert.doesNotMatch(document, /创建 capability|修改插件文件|保持 manifest/);

console.log('web_research_brief example ok');
