import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentClientMessage } from '@pinpawo/agent-session';
import { WebSocket } from 'ws';

import {
  readResidentPetIdFromAgentSessionPath,
  startResidentPetAgentSessionTransport,
} from './residentPetAgentSessionTransport';
import type {
  AgentSessionPeer,
  ResidentPetInteraction,
} from './residentPetHost';

function connect(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    ws.once('error', reject);
  });
}

function interaction(petId: string, handled: string[]): ResidentPetInteraction {
  return {
    connect: () => undefined,
    handle: (peer: AgentSessionPeer, message: AgentClientMessage) => {
      handled.push(`${petId}:${message.type}`);
      if (message.type === 'ping') peer.send({ type: 'pong' });
      return Promise.resolve();
    },
    disconnect: () => undefined,
    close: async () => undefined,
  };
}

test('Agent Session route selects one resident Pet for the whole connection', async () => {
  const handled: string[] = [];
  const transport = await startResidentPetAgentSessionTransport(0, new Map([
    ['pet-a', interaction('pet-a', handled)],
    ['planner-2', interaction('planner-2', handled)],
  ]), {
    authToken: 'test-token',
    log: () => undefined,
  });

  try {
    const petA = await connect(
      `ws://127.0.0.1:${transport.port}/agent-session/pets/pet-a`,
      'test-token',
    );
    const petB = await connect(
      `ws://127.0.0.1:${transport.port}/agent-session/pets/planner-2`,
      'test-token',
    );
    try {
      const pongA = waitForMessage(petA);
      const pongB = waitForMessage(petB);
      petA.send(JSON.stringify({ type: 'ping' }));
      petB.send(JSON.stringify({ type: 'ping' }));
      assert.deepEqual(await pongA, { type: 'pong' });
      assert.deepEqual(await pongB, { type: 'pong' });
      assert.deepEqual(handled, ['pet-a:ping', 'planner-2:ping']);
    } finally {
      petA.close();
      petB.close();
    }
  } finally {
    transport.close();
    await transport.closed;
  }
});

test('Agent Session route rejects unknown Pets before WebSocket binding', async () => {
  const transport = await startResidentPetAgentSessionTransport(0, new Map(), {
    authToken: 'test-token',
    log: () => undefined,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${transport.port}/agent-session/pets/missing`,
        { headers: { Authorization: 'Bearer test-token' } },
      );
      ws.once('unexpected-response', (_request, response) => {
        try {
          assert.equal(response.statusCode, 404);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          response.destroy();
        }
      });
      ws.once('open', () => reject(new Error('unknown Pet route unexpectedly opened')));
      ws.once('error', () => undefined);
    });
  } finally {
    transport.close();
    await transport.closed;
  }
});

test('Agent Session path parsing is strict and decodes the Pet identity once', () => {
  assert.equal(readResidentPetIdFromAgentSessionPath('/agent-session/pets/pet-a'), 'pet-a');
  assert.equal(readResidentPetIdFromAgentSessionPath('/agent-session/pets/planner-2'), 'planner-2');
  assert.equal(readResidentPetIdFromAgentSessionPath('/agent-session/pets/pet%2Fb'), null);
  assert.equal(readResidentPetIdFromAgentSessionPath('/agent-session/pets/'), null);
  assert.equal(readResidentPetIdFromAgentSessionPath('/agent-session/pets/a/b'), null);
  assert.equal(readResidentPetIdFromAgentSessionPath('/studio/pets/pet-a'), null);
});
