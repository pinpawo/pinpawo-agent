import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { Box, renderToString } from 'ink';
import { createSession } from '../state/tuiState';
import { buildWelcomePanelModel } from '../welcomePanelModel';
import { WelcomePanel } from './WelcomePanel';

test('WelcomePanel stays borderless and stacks title and status before they can collide', () => {
  const columns = 40;
  const model = buildWelcomePanelModel({
    session: createSession({ id: 'chat:pet' }),
    width: columns - 4,
    ready: false,
    connectionStatus: '本地服务暂不可用，5s 后重试 2/5',
  });
  const output = renderToString(
    React.createElement(
      Box,
      { flexDirection: 'column', paddingX: 1 },
      React.createElement(WelcomePanel, { model }),
    ),
    { columns },
  );
  const lines = output.split('\n');

  assert.equal(model.stackHeader, true);
  assert.equal(output.includes('╭'), false);
  assert.equal(output.includes('╰'), false);
  assert.ok(lines.some((line) => line.includes('PinPawo Local Agent')));
  assert.ok(lines.some((line) => line.includes('▄█▄ ▄█▄')));
  assert.ok(lines.some((line) => line.includes('PinPawo · 宠物')));
  assert.ok(lines.some((line) => /版本  v\d+\.\d+\.\d+/.test(line)));
  assert.ok(lines.some((line) => line.includes('· 本地服务暂不…')));
  assert.equal(lines.some((line) => line.includes('Agent本地服务')), false);
  assert.ok(lines.length <= 18);
});
