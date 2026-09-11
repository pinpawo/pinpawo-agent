import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorizedLocalServerRequest } from './wire/auth';
import type { PetIdentityDeps, RuntimeProjectionDeps } from './serverTypes';
import { buildLocalHttpRuntimeProjection } from './configProjection';

/**
 * HTTP carries one operational read: which build this process is running.
 * Conversation capability is the WebSocket/stdio handler set — see
 * [wire 能力统一](../../../docs/design/local-agent/domains.md) §一.6.
 */
type LocalHttpHandlerOptions = {
  authToken: string;
};

export function handleLocalHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PetIdentityDeps & RuntimeProjectionDeps,
  options: LocalHttpHandlerOptions,
) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  if (!isAuthorizedLocalServerRequest(req, options.authToken)) {
    writeJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (pathname === '/runtime') {
    writeJson(res, 200, buildLocalHttpRuntimeProjection(deps));
    return true;
  }

  return false;
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
