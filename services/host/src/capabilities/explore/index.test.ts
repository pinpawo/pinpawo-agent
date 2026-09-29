import assert from 'node:assert/strict';
import test from 'node:test';
import { createExploreCapability } from './index';

test('explore capability declares immutable instructions and host Toolkits statically', () => {
  const defaultCapability = createExploreCapability();
  assert.deepEqual(
    defaultCapability.uses,
    ['bash', 'git', 'artifact_discovery'],
  );
  assert.equal(defaultCapability.lifecycle, undefined);

  const capability = createExploreCapability({
    uses: ['bash', 'git', 'browser'],
  });

  assert.deepEqual(capability.uses, ['bash', 'git', 'browser']);
  const instructions = capability.instructions.content;
  assert.match(instructions, /只读取、检查、搜索、观察和总结上下文/);
  assert.match(instructions, /gh_pr_view[\s\S]*gh_pr_diff[\s\S]*git_diff[\s\S]*git_show/);
  assert.match(instructions, /不要使用 browser[\s\S]*http_fetch[\s\S]*download_file/);
  assert.match(instructions, /较早执行上下文总结为摘要/);
  assert.match(instructions, /已查看文件列表/);
  assert.match(capability.instructions.digest, /^[a-f0-9]{64}$/);
  assert.equal(capability.lifecycle, undefined);
});
