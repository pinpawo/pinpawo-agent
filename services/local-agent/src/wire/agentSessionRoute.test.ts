import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentClientMessage } from '@pinpawo/agent-session';
import { WebSocket } from 'ws';

import {
  readResidentPetIdFromAgentSessionPath,
  startResidentPetAgentSessionTransport,
} from './agentSessionRoute';
import type {
  AgentSessionPeer,
  ResidentPetInteraction,
} from '../residentPetHost';

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

test('a busy Pet refuses the extra connection without taking down the Host', async () => {
  const handled: string[] = [];
  const held = interaction('pet-a', handled);
  let connections = 0;
  // The Host admits one interactive connection per Pet and refuses the rest.
  // connect() signals that synchronously, which must reach the refusing
  // socket and stop there — not escape the 'connection' handler, where
  // nothing catches it and Node exits the whole Host.
  const busy: ResidentPetInteraction = {
    ...held,
    connect: (peer: AgentSessionPeer) => {
      connections += 1;
      if (connections > 1) throw new Error('This Pet already has an interactive client.');
      return held.connect(peer);
    },
  };
  const transport = await startResidentPetAgentSessionTransport(0, new Map([
    ['pet-a', busy],
  ]), {
    authToken: 'test-token',
    log: () => undefined,
    logError: () => undefined,
  });

  try {
    const first = await connect(
      `ws://127.0.0.1:${transport.port}/agent-session/pets/pet-a`,
      'test-token',
    );
    const second = await connect(
      `ws://127.0.0.1:${transport.port}/agent-session/pets/pet-a`,
      'test-token',
    );
    try {
      const refused = await new Promise<number>((resolve, reject) => {
        second.once('close', (code) => resolve(code));
        second.once('error', reject);
      });
      assert.equal(refused, 1011);

      // The Host, and the connection that got there first, are still serving.
      const pong = waitForMessage(first);
      first.send(JSON.stringify({ type: 'ping' }));
      assert.deepEqual(await pong, { type: 'pong' });
      assert.deepEqual(handled, ['pet-a:ping']);
    } finally {
      first.close();
      second.close();
    }
  } finally {
    transport.close();
    await transport.closed;
  }
});

test('an async connect rejection refuses the connection the same way', async () => {
  const handled: string[] = [];
  const held = interaction('pet-a', handled);
  const transport = await startResidentPetAgentSessionTransport(0, new Map([
    ['pet-a', {
      ...held,
      connect: () => Promise.reject(new Error('interaction unavailable')),
    } as ResidentPetInteraction],
  ]), {
    authToken: 'test-token',
    log: () => undefined,
    logError: () => undefined,
  });

  try {
    const ws = await connect(
      `ws://127.0.0.1:${transport.port}/agent-session/pets/pet-a`,
      'test-token',
    );
    const closed = await new Promise<number>((resolve, reject) => {
      ws.once('close', (code) => resolve(code));
      ws.once('error', reject);
    });
    assert.equal(closed, 1011);
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
