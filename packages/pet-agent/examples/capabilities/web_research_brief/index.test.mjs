import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCapability } from './index.js';

const capability = createCapability();
assert.equal(capability.name, 'web_research_brief');
assert.match(capability.description, /网页|URL|HTTP|调研/);
assert.equal(typeof capability.createRuntime, 'function');

const availability = await capability.availability.check();
assert.equal(availability.available, true);

const runtime = await capability.createRuntime({});
assert.deepEqual(capability.uses, ['bash']);
assert.ok(Array.isArray(runtime.instructions));

const instructions = runtime.instructions.join('\n');
assert.match(instructions, /http_fetch/);
assert.match(instructions, /不要用 run_shell 拼 curl/);
assert.match(instructions, /浏览器 capability/);
assert.match(instructions, /结论摘要、关键事实、来源列表/);
assert.doesNotMatch(instructions, /创建 capability|修改插件文件|保持 manifest/);

const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf-8'));
assert.equal(manifest.id, capability.name);
assert.equal(manifest.builtIn, false);
assert.match(manifest.description, /公开网页|URL|HTTP|引用链接/);

console.log('web_research_brief example ok');
