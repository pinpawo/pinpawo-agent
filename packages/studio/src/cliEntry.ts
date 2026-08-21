#!/usr/bin/env node

import { runStudioHostCli } from './cli';

try {
  await runStudioHostCli();
} catch (error) {
  console.error(
    '[studio] startup failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}
