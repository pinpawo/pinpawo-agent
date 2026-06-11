import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const TOKEN_BYTES = 32;
const TOKEN_FILE = resolve(homedir(), '.pinpawo', 'local-server-token');

export function createLocalServerAuthToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function writeLocalServerAuthToken(token: string, path = TOKEN_FILE) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

export function ensureLocalServerAuthToken(path = TOKEN_FILE) {
  const token = createLocalServerAuthToken();
  writeLocalServerAuthToken(token, path);
  return token;
}

export function readLocalServerAuthToken(path = TOKEN_FILE) {
  try {
    const token = readFileSync(path, 'utf-8').trim();
    return token || null;
  } catch {
    return null;
  }
}

export function buildLocalServerAuthHeaders(token: string | null | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function isAuthorizedLocalServerRequest(req: IncomingMessage, expectedToken: string) {
  const provided = readBearerToken(req);
  return typeof provided === 'string' && safeTokenEqual(provided, expectedToken);
}

export function isAllowedLocalServerOrigin(req: IncomingMessage, port: number) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin) || !origin.trim()) return false;

  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') {
      return false;
    }
    const originPort = parsed.port
      ? Number(parsed.port)
      : (parsed.protocol === 'https:' ? 443 : 80);
    return originPort === port;
  } catch {
    return false;
  }
}

function readBearerToken(req: IncomingMessage) {
  const authorization = req.headers.authorization;
  if (Array.isArray(authorization)) return null;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function safeTokenEqual(provided: string, expected: string) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
}
