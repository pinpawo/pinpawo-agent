import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorizedWireRequest } from './wire/auth';

/**
 * HTTP carries one authenticated liveness probe. Conversation capability and
 * the runtime view (including the Host version) are the WebSocket/stdio
 * handler set — see [wire 能力统一](../../../docs/design/host/domains.md) §一.6.
 */
type LocalHttpHandlerOptions = {
  authToken: string;
};

export function handleLocalHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: LocalHttpHandlerOptions,
) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  if (!isAuthorizedWireRequest(req, options.authToken)) {
    writeJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (pathname === '/runtime') {
    writeJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
