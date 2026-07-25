import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import React from 'react';
import { Text, render } from 'ink';
import {
  ENTER_TRANSCRIPT_TERMINAL_MODE,
  EXIT_TRANSCRIPT_TERMINAL_MODE,
  useTranscriptTerminalMode,
} from './transcriptTerminalMode';

type TranscriptTerminalModeControls = ReturnType<typeof useTranscriptTerminalMode>;

function TranscriptTerminalModeHarness(props: {
  content: string;
  stdout: NodeJS.WriteStream;
  onControls: (controls: TranscriptTerminalModeControls) => void;
}) {
  const controls = useTranscriptTerminalMode(props.stdout);
  props.onControls(controls);
  return <Text>{props.content}</Text>;
}

async function waitForInkRender() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('transcript terminal mode switches buffers before rendering each screen', async () => {
  const chunks: string[] = [];
  let controls: TranscriptTerminalModeControls | undefined;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, {
    columns: 80,
    rows: 24,
    isTTY: true,
  });
  stdout.on('data', (chunk) => {
    chunks.push(String(chunk));
  });

  const instance = render(
    <TranscriptTerminalModeHarness
      content="inline"
      stdout={stdout}
      onControls={(nextControls) => {
        controls = nextControls;
      }}
    />,
    {
      stdout,
      patchConsole: false,
    },
  );
  await waitForInkRender();
  assert.ok(controls);
  chunks.length = 0;

  controls.enter();
  instance.rerender(
    <TranscriptTerminalModeHarness
      content="viewer"
      stdout={stdout}
      onControls={(nextControls) => {
        controls = nextControls;
      }}
    />,
  );
  await waitForInkRender();
  const openedOutput = chunks.join('');
  assert.ok(
    openedOutput.indexOf(ENTER_TRANSCRIPT_TERMINAL_MODE)
      < openedOutput.indexOf('viewer'),
  );
  chunks.length = 0;

  controls.leave();
  instance.rerender(
    <TranscriptTerminalModeHarness
      content="inline"
      stdout={stdout}
      onControls={(nextControls) => {
        controls = nextControls;
      }}
    />,
  );
  await waitForInkRender();
  const closedOutput = chunks.join('');
  assert.ok(
    closedOutput.indexOf(EXIT_TRANSCRIPT_TERMINAL_MODE)
      < closedOutput.indexOf('inline'),
  );

  instance.unmount();
  instance.cleanup();
});
