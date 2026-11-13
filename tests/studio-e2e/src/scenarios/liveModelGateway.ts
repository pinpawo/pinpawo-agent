import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const localKey = 'scenario-local-only';
const maxRequestBytes = 512 * 1024;
const maxResponseBytes = 8 * 1024 * 1024;
const maxEventBytes = 256 * 1024;
const toolFields: Record<string, readonly string[]> = {
  plan_request: ['goal'],
  continue: ['goal'],
  capability_details: ['names'],
  submit_plan: ['tasks', 'capability', 'objective'],
  adjust_plan: ['adjustedGoal', 'reason', 'currentTask', 'tasks', 'capability', 'objective'],
  review_current: ['completed', 'reason'],
  delegate_capability: ['briefing'],
  runtime_budget_status: [],
  synthetic_lookup: ['recordId'],
};
const requestFields = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'temperature', 'top_p',
  'max_tokens', 'max_completion_tokens', 'frequency_penalty', 'presence_penalty', 'seed', 'n',
  'stop', 'response_format', 'parallel_tool_calls', 'reasoning_effort', 'verbosity', 'logprobs', 'top_logprobs',
]);
const schemaFields = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title',
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'uniqueItems', 'anyOf', 'oneOf', 'allOf', 'default', '$schema',
]);

export type LiveScenarioGatewayOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  forbiddenRoots: string[];
  timeoutMs?: number;
  /** Offline tests inject a transport; live runs always use the default HTTPS fetch. */
  fetch?: typeof globalThis.fetch;
};

class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function blocked(): never { throw new GatewayError(400, 'scenario_gateway_blocked'); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: Iterable<string>) {
  const keys = new Set(allowed);
  if (Object.keys(value).some(key => !keys.has(key))) blocked();
}
function safeTool(name: unknown): name is string {
  return typeof name === 'string' && Object.hasOwn(toolFields, name);
}
function validateSchema(value: unknown, fields: readonly string[], depth = 0) {
  if (!record(value) || depth > 16) blocked();
  onlyKeys(value, schemaFields);
  for (const key of ['description', 'title']) if (value[key] !== undefined && typeof value[key] !== 'string') blocked();
  const scalar = (item: unknown) => item === null || ['string', 'number', 'boolean'].includes(typeof item);
  for (const key of ['const', 'default']) if (value[key] !== undefined && !scalar(value[key])) blocked();
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.every(scalar))) blocked();
  if (value.properties !== undefined) {
    if (!record(value.properties)) blocked();
    for (const [key, schema] of Object.entries(value.properties)) {
      if (!fields.includes(key)) blocked();
      validateSchema(schema, fields, depth + 1);
    }
  }
  if (value.additionalProperties !== undefined && value.additionalProperties !== false) blocked();
  if (value.items !== undefined) validateSchema(value.items, fields, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const alternatives = value[key];
    if (alternatives !== undefined) {
      if (!Array.isArray(alternatives)) blocked();
      for (const schema of alternatives) validateSchema(schema, fields, depth + 1);
    }
  }
  if (value.required !== undefined && (!Array.isArray(value.required)
    || value.required.some(key => typeof key !== 'string' || !fields.includes(key)))) blocked();
  // Zod emits a public schema identifier. It is metadata, not scenario content.
  if (value.$schema !== undefined && ![
    'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema',
  ].includes(String(value.$schema))) blocked();
  delete value.$schema;
}
function validateCall(value: unknown) {
  if (!record(value) || value.type !== 'function' || typeof value.id !== 'string' || !record(value.function)) blocked();
  onlyKeys(value, ['id', 'type', 'function']);
  onlyKeys(value.function, ['name', 'arguments']);
  if (!safeTool(value.function.name) || typeof value.function.arguments !== 'string') blocked();
  let args: unknown;
  try { args = JSON.parse(value.function.arguments); } catch { blocked(); }
  if (!record(args)) blocked();
  onlyKeys(args, toolFields[value.function.name]);
  const stringFields = ['goal', 'adjustedGoal', 'reason', 'currentTask', 'briefing', 'recordId'];
  if (stringFields.some(key => args[key] !== undefined && typeof args[key] !== 'string')) blocked();
  if (args.completed !== undefined && typeof args.completed !== 'boolean') blocked();
  if (args.names !== undefined && (!Array.isArray(args.names) || args.names.some(name => typeof name !== 'string'))) blocked();
  if (args.tasks !== undefined) {
    if (!Array.isArray(args.tasks)) blocked();
    for (const task of args.tasks) {
      if (!record(task) || typeof task.capability !== 'string' || typeof task.objective !== 'string') blocked();
      onlyKeys(task, ['capability', 'objective']);
    }
  }
  if (value.function.name === 'synthetic_lookup' && args.recordId !== 'cobalt') blocked();
}
function validateRequest(value: unknown, model: string): asserts value is Record<string, unknown> {
  if (!record(value) || value.model !== model || !Array.isArray(value.messages) || !value.messages.length) blocked();
  onlyKeys(value, requestFields);
  for (const key of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'frequency_penalty', 'presence_penalty', 'seed', 'n', 'top_logprobs']) {
    if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]))) blocked();
  }
  for (const key of ['parallel_tool_calls', 'logprobs']) if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'boolean') blocked();
  for (const key of ['reasoning_effort', 'verbosity']) if (value[key] !== undefined && value[key] !== null && typeof value[key] !== 'string') blocked();
  if (value.stop !== undefined && value.stop !== null && typeof value.stop !== 'string'
    && !(Array.isArray(value.stop) && value.stop.every(item => typeof item === 'string'))) blocked();
  for (const message of value.messages) {
    if (!record(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(message.role))) blocked();
    onlyKeys(message, ['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'refusal', 'reasoning_content']);
    if (message.reasoning_content !== undefined && typeof message.reasoning_content !== 'string') blocked();
    if (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string') blocked();
    if (message.tool_call_id !== undefined && typeof message.tool_call_id !== 'string') blocked();
    if (message.name !== undefined && !safeTool(message.name)
      && !(message.role === 'assistant' && ['runSupervisor', 'model'].includes(String(message.name)))) blocked();
    if (message.content !== null && typeof message.content !== 'string') {
      if (!Array.isArray(message.content)) blocked();
      for (const content of message.content) {
        if (!record(content) || content.type !== 'text' || typeof content.text !== 'string') blocked();
        onlyKeys(content, ['type', 'text']);
      }
    }
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) blocked();
      for (const call of message.tool_calls) validateCall(call);
    }
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) blocked();
    for (const tool of value.tools) {
      if (!record(tool) || tool.type !== 'function' || !record(tool.function) || !safeTool(tool.function.name)) blocked();
      onlyKeys(tool, ['type', 'function']);
      onlyKeys(tool.function, ['name', 'description', 'parameters', 'strict']);
      if (tool.function.description !== undefined && typeof tool.function.description !== 'string') blocked();
      if (tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean') blocked();
      validateSchema(tool.function.parameters, toolFields[tool.function.name]);
    }
  }
  if (record(value.tool_choice)) {
    onlyKeys(value.tool_choice, ['type', 'function']);
    if (value.tool_choice.type !== 'function' || !record(value.tool_choice.function)) blocked();
    onlyKeys(value.tool_choice.function, ['name']);
    if (!safeTool(value.tool_choice.function.name)) blocked();
  } else if (value.tool_choice !== undefined && !['auto', 'none', 'required'].includes(String(value.tool_choice))) blocked();
  if (value.response_format !== undefined) {
    if (!record(value.response_format) || !['text', 'json_object'].includes(String(value.response_format.type))) blocked();
    onlyKeys(value.response_format, ['type']);
  }
  if (value.stream !== undefined && typeof value.stream !== 'boolean') blocked();
  if (value.stream_options !== undefined) {
    if (!record(value.stream_options)) blocked();
    onlyKeys(value.stream_options, ['include_usage']);
    if (value.stream_options.include_usage !== undefined && typeof value.stream_options.include_usage !== 'boolean') blocked();
  }
}

function sanitize(value: unknown, apiKey: string, roots: string[], redacted: () => void, depth = 0): unknown {
  if (depth > 32) blocked();
  if (typeof value === 'string') {
    if (/\\(?:u[\da-f]{4}|x[\da-f]{2})/i.test(value)) {
      const decoded = value.replace(/\\(?:u([\da-f]{4})|x([\da-f]{2}))/gi,
        (_match, unicode: string | undefined, hex: string | undefined) => String.fromCharCode(Number.parseInt(unicode ?? hex!, 16)));
      return sanitize(decoded, apiKey, roots, redacted, depth + 1);
    }
    // Tool arguments and tool results contain JSON inside message strings. Scan
    // decoded values as well so JSON escapes cannot hide paths or credentials.
    if (/^[\s]*[\[{"]/.test(value)) {
      let decoded: unknown;
      try { decoded = JSON.parse(value); } catch { /* Ordinary prose can start with a brace. */ }
      if (decoded !== undefined) return JSON.stringify(sanitize(decoded, apiKey, roots, redacted, depth + 1));
    }
    if (/%[\da-f]{2}/i.test(value)) {
      let decoded = value;
      try { decoded = decodeURIComponent(value); } catch { blocked(); }
      if (decoded !== value) return sanitize(decoded, apiKey, roots, redacted, depth + 1);
    }
    // Reject rather than redact credentials, including ones hidden in a local path.
    if (value.includes(apiKey)
      || /\b(?:sk-[a-z\d_-]{12,}|gh[pousr]_[a-z\d]{20,}|github_pat_[a-z\d_]{20,}|AKIA[A-Z\d]{16})\b/i.test(value)
      || /\b[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\b/.test(value)
      || /\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)
      || /\b(?:api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*["']?[^\s"']{8,}/i.test(value)
      || /[A-Za-z\d_+=-]{48,}/.test(value)) blocked();
    if (/(?:\b[a-z][a-z\d+.-]*:\/\/|\b(?:data|file|mailto):|\bwww\.)/i.test(value)) blocked();
    let text = value;
    for (const root of roots) {
      if (root && text.includes(root)) {
        text = text.split(root).join('/scenario');
        redacted();
      }
    }
    // A path-only string may contain spaces; replace the whole value in that case.
    if (/^(?:\/(?!\/)|[a-z]:[\\/]|\\\\)/i.test(text.trim())) {
      if (text !== '/scenario') redacted();
      return '/scenario';
    }
    // Runtime prompts include paths in prose. Cover POSIX, Windows and UNC roots,
    // independent of the caller's repository, HOME or temporary-directory choice.
    return text.replace(/(?:[a-z]:[\\/]|\\\\)[^\s"'`<>()[\]{},;]+|(?<![\w/])\/(?!\/)[^\s"'`<>()[\]{},;]+/gi,
      path => { if (path !== '/scenario') redacted(); return '/scenario'; });
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, apiKey, roots, redacted, depth + 1));
  if (record(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const cleanKey = sanitize(key, apiKey, roots, redacted, depth + 1) as string;
      if (Object.hasOwn(result, cleanKey)) blocked();
      result[cleanKey] = sanitize(item, apiKey, roots, redacted, depth + 1);
    }
    return result;
  }
  return value;
}

function readRequest(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const fail = (error: GatewayError) => { cleanup(); req.pause(); reject(error); };
    const aborted = () => fail(new GatewayError(504, 'scenario_gateway_timeout'));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxRequestBytes) fail(new GatewayError(413, 'scenario_gateway_request_too_large'));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new GatewayError(400, 'scenario_gateway_invalid_json')); }
    };
    const error = () => fail(new GatewayError(400, 'scenario_gateway_invalid_request'));
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', error);
      signal.removeEventListener('abort', aborted);
    };
    req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', error);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
function fixedError(res: ServerResponse, error: GatewayError) {
  const body = JSON.stringify({ error: { code: error.code, message: error.code, type: 'scenario_gateway' } });
  if (res.headersSent) res.end(`data: ${body}\n\n`);
  else {
    res.writeHead(error.status, { 'content-type': 'application/json', 'connection': 'close' });
    res.end(body);
  }
}
function validCompletion(value: unknown): boolean {
  const hasOnly = (item: Record<string, unknown>, keys: string[]) => Object.keys(item).every(key => keys.includes(key));
  const message = (item: unknown) => {
    if (!record(item) || !hasOnly(item, ['role', 'content', 'refusal', 'reasoning_content', 'tool_calls'])) return false;
    if (['role', 'content', 'refusal', 'reasoning_content'].some(key => item[key] !== undefined && item[key] !== null && typeof item[key] !== 'string')) return false;
    if (item.tool_calls !== undefined) {
      if (!Array.isArray(item.tool_calls)) return false;
      for (const call of item.tool_calls) {
        if (!record(call) || !hasOnly(call, ['id', 'index', 'type', 'function'])) return false;
        if (!record(call.function) || !hasOnly(call.function, ['name', 'arguments'])) return false;
        const name = call.function.name;
        // Providers may split the function name across stream frames.
        if (name !== undefined && (typeof name !== 'string' || !Object.keys(toolFields).some(known => known.includes(name)))) return false;
        if (call.function.arguments !== undefined && typeof call.function.arguments !== 'string') return false;
      }
    }
    return true;
  };
  return record(value) && hasOnly(value, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'])
    && Array.isArray(value.choices) && value.choices.every(choice => record(choice)
      && hasOnly(choice, ['index', 'finish_reason', 'logprobs', 'message', 'delta'])
      && (choice.message === undefined || message(choice.message)) && (choice.delta === undefined || message(choice.delta)));
}
async function forwardResponse(upstream: Response, res: ServerResponse, stream: boolean, apiKey: string, signal: AbortSignal) {
  if (!upstream.ok || upstream.status !== 200 || upstream.redirected || !upstream.body) {
    await upstream.body?.cancel();
    throw new GatewayError(502, 'scenario_gateway_upstream');
  }
  const reader = upstream.body.getReader();
  const aborted = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let pending = '';
  const frames: string[] = [];
  const fragments = new Map<string, string>();
  const inspect = (parsed: unknown) => {
    if (!validCompletion(parsed)) throw new GatewayError(502, 'scenario_gateway_upstream');
    try {
      const clean = sanitize(parsed, apiKey, [], () => {});
      // Accumulate the fields the SDK concatenates. A credential split across
      // otherwise harmless SSE events must never reach the Host's session.
      for (const choice of (parsed as { choices: Record<string, unknown>[] }).choices) {
        const message = choice.delta ?? choice.message;
        if (!record(message)) continue;
        const append = (key: string, value: unknown) => {
          if (typeof value !== 'string') return;
          const field = `${String(choice.index ?? 0)}:${key}`;
          const text = (fragments.get(field) ?? '') + value;
          fragments.set(field, text);
          sanitize(text.slice(-Math.max(512, apiKey.length * 2)), apiKey, [], () => {});
        };
        for (const key of ['content', 'reasoning_content', 'refusal']) append(key, message[key]);
        if (Array.isArray(message.tool_calls)) for (const [callIndex, call] of message.tool_calls.entries()) {
          if (!record(call) || !record(call.function)) continue;
          for (const key of ['name', 'arguments']) append(`tool:${String(call.index ?? callIndex)}:${key}`, call.function[key]);
          const name = fragments.get(`${String(choice.index ?? 0)}:tool:${String(call.index ?? callIndex)}:name`);
          if (name && !Object.keys(toolFields).some(known => known.startsWith(name))) blocked();
        }
      }
      return clean;
    } catch { throw new GatewayError(502, 'scenario_gateway_upstream'); }
  };
  try {
    while (true) {
      if (signal.aborted) throw new GatewayError(504, 'scenario_gateway_timeout');
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxResponseBytes) throw new GatewayError(502, 'scenario_gateway_response_too_large');
      pending += decoder.decode(value, { stream: true });
      if (stream) {
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          if (Buffer.byteLength(frame) > maxEventBytes || frames.length > 2048 || signal.aborted) throw new GatewayError(502, 'scenario_gateway_upstream');
          const lines = frame.split(/\r?\n/);
          if (lines.some(line => /^event:\s*error\s*$/i.test(line))) throw new GatewayError(502, 'scenario_gateway_upstream');
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data && data !== '[DONE]') {
            let parsed: unknown;
            try { parsed = JSON.parse(data); } catch { throw new GatewayError(502, 'scenario_gateway_upstream'); }
            frames.push(`data: ${JSON.stringify(inspect(parsed))}\n\n`);
          } else if (data === '[DONE]') {
            frames.push('data: [DONE]\n\n');
          }
        }
        if (Buffer.byteLength(pending) > maxEventBytes) throw new GatewayError(502, 'scenario_gateway_upstream');
      }
    }
    if (signal.aborted) throw new GatewayError(504, 'scenario_gateway_timeout');
    pending += decoder.decode();
    if (stream) {
      if (pending.trim() || !frames.length) throw new GatewayError(502, 'scenario_gateway_upstream');
      try { for (const text of fragments.values()) sanitize(text, apiKey, [], () => {}); }
      catch { throw new GatewayError(502, 'scenario_gateway_upstream'); }
      // Bound and validate the complete stream before releasing any provider
      // output, including credential prefixes and provider error metadata.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const frame of frames) res.write(frame);
    } else {
      let parsed: unknown;
      try { parsed = JSON.parse(pending); } catch { throw new GatewayError(502, 'scenario_gateway_upstream'); }
      const clean = inspect(parsed);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.write(JSON.stringify(clean));
    }
    res.end();
  } finally {
    signal.removeEventListener('abort', aborted);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Test-only egress boundary for the synthetic Pet Head scenarios. No payloads are logged or retained. */
export async function createLiveScenarioGateway(options: LiveScenarioGatewayOptions) {
  let target: URL;
  try { target = new URL(options.baseUrl); } catch { throw new Error('scenario_gateway_invalid_configuration'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash
    || !options.model.trim() || !options.apiKey || options.apiKey.length > 4096 || /[\r\n]/.test(options.apiKey)
    || target.href.includes(options.apiKey) || options.model.includes(options.apiKey)) {
    throw new Error('scenario_gateway_invalid_configuration');
  }
  target.pathname = `${target.pathname.replace(/\/$/, '')}/chat/completions`;
  const timeoutMs = Math.min(120_000, Math.max(1, options.timeoutMs ?? 30_000));
  const transport = options.fetch ?? globalThis.fetch;
  const stats = { requests: 0, forwarded: 0, blocked: 0, redactions: 0 };
  const active = new Set<AbortController>();
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    stats.requests++;
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    void (async () => {
      try {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions' || req.headers.origin
          || req.headers.authorization !== `Bearer ${localKey}` || !req.headers['content-type']?.startsWith('application/json')) {
          throw new GatewayError(400, 'scenario_gateway_invalid_request');
        }
        const request = await readRequest(req, controller.signal);
        validateRequest(request, options.model);
        const clean = sanitize(request, options.apiKey, options.forbiddenRoots, () => stats.redactions++);
        stats.forwarded++;
        const upstream = await transport(target, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json', 'authorization': `Bearer ${options.apiKey}` },
          body: JSON.stringify(clean),
        });
        await forwardResponse(upstream, res, request.stream === true, options.apiKey, controller.signal);
      } catch (error) {
        const safe = controller.signal.aborted ? new GatewayError(504, 'scenario_gateway_timeout')
          : error instanceof GatewayError ? error : new GatewayError(502, 'scenario_gateway_upstream');
        if (safe.status < 500) stats.blocked++;
        fixedError(res, safe);
      } finally {
        clearTimeout(timer); active.delete(controller); res.off('close', disconnected);
      }
    })();
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('scenario_gateway_start_failed')));
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('scenario_gateway_start_failed');
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, model: options.model, apiKey: localKey, stats,
    close: () => closing ??= new Promise<void>((resolve) => {
      for (const controller of active) controller.abort();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
