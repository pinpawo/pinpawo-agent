import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseAgentClientMessage } from '@pinpawo/agent-session';
import type { ResidentPetInteraction } from '../residentPetHost';
import { isAllowedLocalServerOrigin, isAuthorizedLocalServerRequest } from './auth';

/** HTTP transport only: session semantics remain in the shared interaction. */
export async function handleAgentSessionHttp(
  request: IncomingMessage,
  response: ServerResponse,
  interactions: ReadonlyMap<string, ResidentPetInteraction>,
  authToken: string,
): Promise<void> {
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  if (!isAllowedLocalServerOrigin(request, request.socket.localPort ?? 0)) {
    json(403, { error: 'Forbidden origin' }); return;
  }
  if (!isAuthorizedLocalServerRequest(request, authToken)) {
    json(401, { error: 'Unauthorized' }); return;
  }
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const match = /^\/agent-session\/pets\/([^/]+)\/(snapshot|events|messages)$/.exec(pathname);
  let petId: string;
  try { petId = match ? decodeURIComponent(match[1]!) : ''; } catch {
    json(400, { error: 'Invalid Pet path' }); return;
  }
  const interaction = interactions.get(petId);
  if (!match || !interaction) { json(404, { error: 'Unknown Agent Session route' }); return; }
  const resource = match[2];
  if (request.method === 'GET' && resource === 'snapshot') {
    const result = await interaction.snapshot();
    json(result.type === 'session.snapshot.result' ? 200 : 500, {
      ...result, queue: interaction.getQueueSnapshot(),
    });
    return;
  }
  if (request.method === 'GET' && resource === 'events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    response.write(': connected\n\n');
    const unsubscribe = interaction.subscribe((message) => {
      if (!response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`)) response.destroy();
    });
    const heartbeat = setInterval(() => {
      if (!response.write(': heartbeat\n\n')) response.destroy();
    }, 15_000);
    response.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
    return;
  }
  if (request.method !== 'POST' || resource !== 'messages') {
    json(405, { error: 'Method not allowed' }); return;
  }
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    json(415, { error: 'Content-Type must be application/json' }); return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) { json(413, { error: 'Message exceeds 1 MiB' }); return; }
    chunks.push(Buffer.from(chunk));
  }
  const message = parseAgentClientMessage(Buffer.concat(chunks).toString('utf8'));
  if (!message || !('requestId' in message) || !message.requestId?.trim()) {
    json(400, { error: 'Expected an AgentClientMessage with requestId' }); return;
  }
  // The Host owns this operation, independently of either HTTP connection.
  const operation = interaction.request(message);
  json(202, { requestId: message.requestId });
  void operation.catch((error) => {
    console.error('[agent-session] HTTP command failed:', error instanceof Error ? error.message : error);
  });
}
