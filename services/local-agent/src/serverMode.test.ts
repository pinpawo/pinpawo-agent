import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_SERVER_MODE,
  StudioModeStartupError,
  isServerMode,
  parseServerMode,
  preflightStudioMode,
  resolveStudioModePaths,
} from './serverMode';

let workdir: string;

async function writeStudioConfig(config: unknown) {
  const dir = path.join(workdir, '.pinpawo');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'studio.json'), JSON.stringify(config), 'utf8');
}

async function writePetConfig(config: { petId: string; name: string; capabilities?: string[] }) {
  const dir = path.join(workdir, '.pinpawo', 'pets');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${config.petId}.json`),
    JSON.stringify({ capabilities: [], ...config }),
    'utf8',
  );
}

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-server-mode-'));
});

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

describe('parseServerMode', () => {
  it('defaults to chat when no mode is supplied', () => {
    assert.equal(parseServerMode(undefined), 'chat');
    assert.equal(DEFAULT_SERVER_MODE, 'chat');
  });

  it('accepts both modes case-insensitively', () => {
    assert.equal(parseServerMode('chat'), 'chat');
    assert.equal(parseServerMode('studio'), 'studio');
    assert.equal(parseServerMode(' STUDIO '), 'studio');
  });

  it('rejects unknown modes instead of falling back', () => {
    assert.throws(() => parseServerMode('kitchen-sink'), StudioModeStartupError);
    assert.throws(() => parseServerMode('kitchen-sink'), /Expected one of: chat, studio/);
  });

  it('narrows with isServerMode', () => {
    assert.equal(isServerMode('chat'), true);
    assert.equal(isServerMode('studio'), true);
    assert.equal(isServerMode('nope'), false);
    assert.equal(isServerMode(undefined), false);
  });
});

describe('resolveStudioModePaths', () => {
  it('derives studio.json and pets/ from the workdir', () => {
    const paths = resolveStudioModePaths('/w');
    assert.equal(paths.studioConfigPath, path.join('/w', '.pinpawo', 'studio.json'));
    assert.equal(paths.petsDir, path.join('/w', '.pinpawo', 'pets'));
  });

  it('derives petsDir next to an overridden studio config', () => {
    const paths = resolveStudioModePaths('/w', { studioConfigPath: '/elsewhere/s.json' });
    assert.equal(paths.petsDir, path.join('/elsewhere', 'pets'));
  });
});

describe('preflightStudioMode', () => {
  it('resolves planner and worker sets from a valid config', async () => {
    await writeStudioConfig({
      studioId: 'demo',
      plannerPetId: 'lead',
      agents: ['lead', 'coder', 'writer'],
    });
    await writePetConfig({ petId: 'lead', name: 'Lead' });
    await writePetConfig({ petId: 'coder', name: 'Coder' });
    await writePetConfig({ petId: 'writer', name: 'Writer' });

    const preflight = await preflightStudioMode(workdir);

    assert.equal(preflight.studioId, 'demo');
    assert.equal(preflight.plannerPetId, 'lead');
    // planner is excluded from the worker set but stays in resolved.agents
    assert.deepEqual(preflight.workerPetIds, ['coder', 'writer']);
    assert.equal(preflight.resolved.agents.length, 3);
    assert.equal(preflight.resolved.planner.petId, 'lead');
  });

  it('fails fast when the studio config is missing rather than degrading to chat', async () => {
    await assert.rejects(
      () => preflightStudioMode(workdir),
      (error: unknown) => {
        assert.ok(error instanceof StudioModeStartupError);
        assert.match(error.message, /requires a Studio config/);
        assert.match(error.message, /chat mode/);
        return true;
      },
    );
  });

  it('fails fast when the studio config is not valid JSON', async () => {
    const dir = path.join(workdir, '.pinpawo');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'studio.json'), '{ not json', 'utf8');

    await assert.rejects(
      () => preflightStudioMode(workdir),
      (error: unknown) => {
        assert.ok(error instanceof StudioModeStartupError);
        assert.match(error.message, /not valid JSON/);
        return true;
      },
    );
  });

  it('fails fast when plannerPetId is absent from agents', async () => {
    await writeStudioConfig({
      studioId: 'demo',
      plannerPetId: 'ghost',
      agents: ['coder'],
    });
    await writePetConfig({ petId: 'coder', name: 'Coder' });

    await assert.rejects(
      () => preflightStudioMode(workdir),
      (error: unknown) => {
        assert.ok(error instanceof StudioModeStartupError);
        assert.match(error.message, /plannerPetId "ghost" is not in agents/);
        return true;
      },
    );
  });

  it('fails fast when an agent has no pet config on disk', async () => {
    await writeStudioConfig({
      studioId: 'demo',
      plannerPetId: 'lead',
      agents: ['lead', 'missing'],
    });
    await writePetConfig({ petId: 'lead', name: 'Lead' });

    await assert.rejects(
      () => preflightStudioMode(workdir),
      (error: unknown) => {
        assert.ok(error instanceof StudioModeStartupError);
        assert.match(error.message, /agent "missing" has no matching pet config/);
        return true;
      },
    );
  });

  it('fails fast when the pets directory is entirely absent', async () => {
    await writeStudioConfig({
      studioId: 'demo',
      plannerPetId: 'lead',
      agents: ['lead'],
    });

    await assert.rejects(
      () => preflightStudioMode(workdir),
      (error: unknown) => {
        assert.ok(error instanceof StudioModeStartupError);
        assert.match(error.message, /has no matching pet config/);
        return true;
      },
    );
  });

  it('carries the offending config path on the error for operator diagnostics', async () => {
    await assert.rejects(
      () => preflightStudioMode(workdir),
      (error: unknown) => {
        assert.ok(error instanceof StudioModeStartupError);
        assert.equal(
          error.detail?.configPath,
          path.join(workdir, '.pinpawo', 'studio.json'),
        );
        return true;
      },
    );
  });
});
