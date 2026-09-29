import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

// pet-agent is the runtime-independent core: Hosts depend on it, never the
// reverse, and anything that touches the machine belongs to a Host.
const sourceRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(sourceRoot, '..');

const HOST_SIDE_PACKAGES = [/^pinpawo(\/|$)/, /^@pinpawo\/(studio|tui)(\/|$)/, /^@pinpawo-(toolkit|plugin|tests)\//];
const MACHINE_MODULES = /^(node:)?(fs|fs\/promises|child_process|os|net|http|https)$/;

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function importsOf(file: string) {
  return ts.preProcessFile(readFileSync(file, 'utf8')).importedFiles.map(({ fileName }) => fileName);
}

test('pet-agent source stays inside its package and never imports Host-side packages', () => {
  for (const file of listSourceFiles(sourceRoot)) {
    const where = relative(packageRoot, file);
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('.')) {
        const target = relative(packageRoot, resolve(dirname(file), specifier));
        assert.ok(!target.startsWith('..'), `${where} imports ${specifier} outside pet-agent`);
      }
      assert.ok(!HOST_SIDE_PACKAGES.some((pattern) => pattern.test(specifier)), `${where} imports Host-side ${specifier}`);
    }
  }
});

test('pet-agent runtime source does not touch the machine', () => {
  for (const file of listSourceFiles(sourceRoot).filter((path) => !path.endsWith('.test.ts'))) {
    for (const specifier of importsOf(file)) {
      assert.ok(!MACHINE_MODULES.test(specifier), `${relative(packageRoot, file)} imports ${specifier}`);
    }
  }
});
