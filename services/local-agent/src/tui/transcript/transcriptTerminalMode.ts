import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';

export const ENTER_TRANSCRIPT_TERMINAL_MODE =
  '\x1B[?1049h\x1B[H\x1B[?1000h\x1B[?1006h';
export const EXIT_TRANSCRIPT_TERMINAL_MODE =
  '\x1B[?1006l\x1B[?1000l\x1B[?1049l';

export function useTranscriptTerminalMode(
  stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>,
) {
  const activeRef = useRef(false);
  const enter = useCallback(() => {
    if (!stdout.isTTY || activeRef.current) return;
    stdout.write(ENTER_TRANSCRIPT_TERMINAL_MODE);
    activeRef.current = true;
  }, [stdout]);
  const leave = useCallback(() => {
    if (!activeRef.current) return;
    stdout.write(EXIT_TRANSCRIPT_TERMINAL_MODE);
    activeRef.current = false;
  }, [stdout]);

  useLayoutEffect(() => leave, [leave]);

  return useMemo(() => ({ enter, leave }), [enter, leave]);
}
