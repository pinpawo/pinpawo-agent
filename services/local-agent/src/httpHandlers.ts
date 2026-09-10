import type { IncomingMessage, ServerResponse } from 'node:http';
import { readAgentActivityHealthFields } from './operationActivityState';
import { isAuthorizedLocalServerRequest } from './wire/auth';
import type { ServerDeps } from './serverTypes';
import { buildLocalHttpRuntimeProjection } from './configProjection';

/**
 * HTTP carries the operational surface only: is this process alive, and which
 * build is it. Conversation capability is the WebSocket/stdio handler set —
 * see [wire 能力统一](../../../docs/design/local-agent/domains.md) §一.6.
 */
type LocalHttpHandlerOptions = {
  authToken: string;
};

export function handleLocalHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  options: LocalHttpHandlerOptions,
) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  if (!isAuthorizedLocalServerRequest(req, options.authToken)) {
    writeJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  if (pathname === '/health') {
    writeJson(res, 200, {
      status: 'ok',
      pet_id: deps.petId,
      pet_name: deps.petName,
      ...readAgentActivityHealthFields(),
    });
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
