import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

test('TUI source does not import host implementation files', () => {
  const sourceRoot = new URL('./', import.meta.url);
  const forbiddenPath = ['services', 'host', 'src'].join('/');
  const forbiddenRelativeImport = ['..', '..', 'host'].join('/');

  for (const file of listTypeScriptFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8');
    assert.equal(
      source.includes(forbiddenPath) || source.includes(forbiddenRelativeImport),
      false,
      `${file.pathname} crosses the TUI/host package boundary`,
    );
  }
});

function listTypeScriptFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(entry.name, ensureTrailingSlash(directory));
    if (entry.isDirectory()) {
      return listTypeScriptFiles(new URL(`${entry.name}/`, ensureTrailingSlash(directory)));
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [child] : [];
  });
}

function ensureTrailingSlash(url: URL) {
  return url.pathname.endsWith('/') ? url : new URL(`${url.pathname}/`, url);
}
