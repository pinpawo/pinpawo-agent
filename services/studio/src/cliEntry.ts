#!/usr/bin/env node

import { runStudioHostCli } from './index';

try {
  await runStudioHostCli();
} catch (error) {
  console.error(
    '[studio] command failed:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
}
