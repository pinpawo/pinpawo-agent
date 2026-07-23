import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWelcomePanelModel } from './welcomePanelModel';
import { createSession } from './state/tuiState';

test('buildWelcomePanelModel exposes identity, runtime, and high-value shortcuts', () => {
  const session = createSession({
    id: 'chat:pet',
    actor: {
      label: '豆包',
      summary: '擅长拆解任务的本地搭档',
    },
  });
  session.runtime = {
    model: 'gpt-test',
    cwd: '/Users/mac/Develop/pinpawo-agent',
    workspaceName: 'PinPawo Agent',
  };

  const model = buildWelcomePanelModel({
    session,
    width: 80,
    ready: true,
    connectionStatus: '就绪',
  });

  assert.equal(model.compact, false);
  assert.equal(model.stackHeader, false);
  assert.deepEqual(model.pawLines, [
    '   ▄█▄ ▄█▄   ',
    '   ███ ███   ',
    '▄█▄ ▀   ▀ ▄█▄',
    '██▀ ▄███▄ ▀██',
    '  ▄███████▄  ',
    ' ███████████ ',
    '  ▀███▀███▀  ',
  ]);
  assert.equal(model.petName, '豆包');
  assert.equal(model.greeting, '和 豆包 一起完成当前项目里的任务。');
  assert.equal(model.summary, '擅长拆解任务的本地搭档');
  assert.equal(model.status, '就绪');
  assert.equal(model.action, '直接描述任务，按 Enter 发送');
  assert.match(model.details[0]?.value ?? '', /^v\d+\.\d+\.\d+/);
  assert.deepEqual(model.details.slice(1), [
    { label: '模型', value: 'gpt-test' },
    { label: '目录', value: 'PinPawo Agent · /Users/mac/Develop/pinpawo-agent' },
  ]);
  assert.deepEqual(model.shortcuts.map((shortcut) => shortcut.key), ['@', '/', '/resume']);
});

test('buildWelcomePanelModel stays useful while initializing in a narrow terminal', () => {
  const session = createSession({ id: 'chat:pet' });

  const model = buildWelcomePanelModel({
    session,
    width: 36,
    ready: false,
    connectionStatus: '本地服务暂不可用，5s 后重试 2/5',
  });

  assert.equal(model.compact, true);
  assert.equal(model.stackHeader, true);
  assert.equal(model.greeting, '和 宠物 一起开始吧。');
  assert.equal(model.summary, null);
  assert.equal(model.action, '正在准备本地会话…');
  assert.equal(model.details[1]?.value, '加载中…');
  assert.match(model.status, /…$/);
});
