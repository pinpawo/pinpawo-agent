import { expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { NoticeOverlayView } from './noticeOverlayView';

test('interrupt and error notices remain bounded across resize', async () => {
  const setup = await createTestRenderer({
    width: 60,
    height: 24,
    screenMode: 'split-footer',
    footerHeight: 9,
  });
  const view = new NoticeOverlayView(setup.renderer);
  setup.renderer.root.add(view.frame);
  try {
    view.render({
      phase: 'interrupting',
      requestId: 'run-1',
      pendingTooLong: false,
    }, 60);
    await setup.renderOnce();
    expect(setup.captureCharFrame().trimEnd().split('\n')).toHaveLength(9);

    setup.resize(28, 18);
    view.render({
      phase: 'interrupting',
      requestId: 'run-1',
      pendingTooLong: true,
    }, 28);
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    const lines = frame.trimEnd().split('\n');
    expect(lines).toHaveLength(9);
    for (const line of lines) {
      expect(Bun.stringWidth(line)).toBeLessThanOrEqual(28);
    }

    view.render(openError(), 28);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('Error');
  } finally {
    setup.renderer.destroy();
  }
});

function openError() {
  return {
    phase: 'error' as const,
    source: 'local' as const,
    message: 'A narrow terminal error stays inside the fixed footer.',
  };
}
