import { Console } from 'node:console';
import { stderr, stdin, stdout } from 'node:process';
import type { Readable, Writable } from 'node:stream';
import type { LocalAgentServerMessage } from './localAgentProtocol';
import {
  dispatchLocalServerMessage,
  type LocalServerLogError,
  type LocalServerLogWarn,
  type LocalServerPeerHandlers,
  type LocalServerTransportHandlers,
} from './localServerMessageDispatcher';
import type { LocalServerPeer } from './localServerPeer';

const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_INPUT_LINE_BYTES = 8 * 1024 * 1024;

export type LocalServerStdioTransportOptions = {
  input?: Readable;
  output?: Writable;
  diagnostics?: Writable;
  maxPendingBytes?: number;
  maxInputLineBytes?: number;
};

export type LocalServerStdioTransport = {
  peer: LocalServerPeer;
  closed: Promise<void>;
  close: () => void;
};

function writeDiagnostic(stream: Writable, message: string) {
  try {
    stream.write(`${message}\n`);
  } catch {
    // Diagnostics must never be redirected to protocol stdout or crash cleanup.
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function redirectConsoleToStdioDiagnostics(diagnostics: Writable = stderr) {
  const previous = globalThis.console;
  const diagnosticConsole = new Console({
    stdout: diagnostics,
    stderr: diagnostics,
    colorMode: false,
  });
  globalThis.console = diagnosticConsole;
  return () => {
    if (globalThis.console === diagnosticConsole) {
      globalThis.console = previous;
    }
  };
}

export function attachLocalServerStdioTransport(
  handlers: LocalServerTransportHandlers,
  options: LocalServerStdioTransportOptions = {},
): LocalServerStdioTransport {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const diagnostics = options.diagnostics ?? stderr;
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  const maxInputLineBytes = options.maxInputLineBytes ?? DEFAULT_MAX_INPUT_LINE_BYTES;
  const logError: LocalServerLogError = handlers.logError
    ?? ((message, error) => writeDiagnostic(diagnostics, `${message} ${formatError(error)}`));
  const logWarn: LocalServerLogWarn = handlers.logWarn
    ?? ((message) => writeDiagnostic(diagnostics, message));
  const pending: string[] = [];
  const pendingDispatches = new Set<Promise<void>>();
  let pendingBytes = 0;
  let connected = true;
  let backpressured = false;
  let closeStarted = false;
  let inputEnded = false;
  let inputLineBytes = 0;
  let inputLineChunks: Buffer[] = [];
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const finish = () => {
    if (closeStarted) {
      return;
    }
    closeStarted = true;
    connected = false;
    pending.length = 0;
    pendingBytes = 0;
    inputLineChunks = [];
    inputLineBytes = 0;
    output.off('drain', flushPending);
    input.off('data', handleInputData);
    input.off('end', handleInputEnd);
    input.off('close', handleInputClose);
    input.pause();
    Promise.resolve()
      .then(() => handlers.onClose?.(peer))
      .catch((error) => {
        logError('[local-server] handleClose error:', error);
      })
      .then(() => Promise.allSettled(Array.from(pendingDispatches)))
      .finally(resolveClosed);
  };

  const writeNow = (line: string) => {
    try {
      backpressured = !output.write(line);
      return true;
    } catch (error) {
      logError('[local-server] stdio write failed:', error);
      finish();
      return false;
    }
  };

  function flushPending() {
    if (!connected) {
      return;
    }
    backpressured = false;
    while (!backpressured && pending.length > 0) {
      const line = pending.shift()!;
      pendingBytes -= Buffer.byteLength(line);
      if (!writeNow(line)) {
        return;
      }
    }
  }

  function handleInputError(error: Error) {
    logError('[local-server] stdio input failed:', error);
    finish();
  }

  function handleOutputError(error: Error) {
    logError('[local-server] stdio output failed:', error);
    finish();
  }

  const peer: LocalServerPeer = {
    isConnected: () => connected,
    send: (message: LocalAgentServerMessage) => {
      if (!connected) {
        return false;
      }
      let line: string;
      try {
        line = `${JSON.stringify(message)}\n`;
      } catch (error) {
        logError('[local-server] failed to serialize stdio message:', error);
        return false;
      }
      if (!backpressured) {
        return writeNow(line);
      }
      const bytes = Buffer.byteLength(line);
      if (pendingBytes + bytes > maxPendingBytes) {
        logError(
          '[local-server] stdio output backpressure limit exceeded:',
          new Error(`pending bytes exceed ${maxPendingBytes}`),
        );
        finish();
        return false;
      }
      pending.push(line);
      pendingBytes += bytes;
      return true;
    },
  };

  function dispatchInputLine(finalChunk?: Buffer) {
    const totalBytes = inputLineBytes + (finalChunk?.byteLength ?? 0);
    let lineBuffer: Buffer;
    if (inputLineChunks.length === 0) {
      lineBuffer = finalChunk ?? Buffer.alloc(0);
    } else {
      lineBuffer = Buffer.concat(
        finalChunk && finalChunk.byteLength > 0
          ? [...inputLineChunks, finalChunk]
          : inputLineChunks,
        totalBytes,
      );
    }
    if (lineBuffer.at(-1) === 0x0d) {
      lineBuffer = lineBuffer.subarray(0, lineBuffer.byteLength - 1);
    }
    inputLineChunks = [];
    inputLineBytes = 0;

    const dispatched = dispatchLocalServerMessage(
      peer,
      lineBuffer.toString('utf8'),
      handlers,
      logError,
      logWarn,
    );
    pendingDispatches.add(dispatched);
    void dispatched.finally(() => {
      pendingDispatches.delete(dispatched);
    });
  }

  function failInputLineLimit() {
    logError(
      '[local-server] stdio input line limit exceeded:',
      new Error(`line bytes exceed ${maxInputLineBytes}`),
    );
    finish();
  }

  function appendInputSegment(segment: Buffer) {
    if (segment.byteLength === 0) {
      return true;
    }
    const nextBytes = inputLineBytes + segment.byteLength;
    if (nextBytes > maxInputLineBytes) {
      failInputLineLimit();
      return false;
    }
    inputLineChunks.push(Buffer.from(segment));
    inputLineBytes = nextBytes;
    return true;
  }

  function handleInputData(chunk: Buffer | string) {
    if (!connected) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < buffer.byteLength && connected) {
      const newline = buffer.indexOf(0x0a, offset);
      if (newline < 0) {
        appendInputSegment(buffer.subarray(offset));
        return;
      }
      const segment = buffer.subarray(offset, newline);
      if (inputLineBytes + segment.byteLength > maxInputLineBytes) {
        failInputLineLimit();
        return;
      }
      dispatchInputLine(segment);
      offset = newline + 1;
    }
  }

  function handleInputEnd() {
    if (!connected) {
      return;
    }
    inputEnded = true;
    if (inputLineBytes > 0) {
      dispatchInputLine();
    }
    // Let the final line's handler start before disconnect cleanup.
    queueMicrotask(finish);
  }

  function handleInputClose() {
    if (!inputEnded) {
      finish();
    }
  }

  input.on('error', handleInputError);
  output.on('error', handleOutputError);
  output.on('drain', flushPending);
  input.on('data', handleInputData);
  input.on('end', handleInputEnd);
  input.on('close', handleInputClose);

  return {
    peer,
    closed,
    close: finish,
  };
}
