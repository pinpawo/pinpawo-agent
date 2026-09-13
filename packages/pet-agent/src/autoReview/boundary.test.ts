import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

test('auto review and its local dependencies do not import orchestrator or Toolkit runtime', () => {
  const domain = dirname(fileURLToPath(import.meta.url));
  const source = resolve(domain, '..');
  const visited = new Set<string>();
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    assert.ok(!file.startsWith(resolve(source, 'agent') + '/'), `Domain imports Agent implementation: ${file}`);
    assert.notEqual(file, resolve(source, 'types/toolkit.ts'));
    assert.notEqual(file, resolve(source, 'types/agent.ts'));
    for (const ref of ts.preProcessFile(readFileSync(file, 'utf8')).importedFiles) {
      if (!ref.fileName.startsWith('.')) continue;
      const target = resolve(dirname(file), ref.fileName);
      const candidates = [target + '.ts', resolve(target, 'index.ts'), target];
      const found = candidates.find(path => { try { return statSync(path).isFile(); } catch { return false; } });
      assert.ok(found, `Unresolved local import ${ref.fileName} from ${file}`);
      visit(found);
    }
  }
  function scan(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = resolve(dir, item.name);
      if (item.isDirectory()) scan(file);
      else if (item.name.endsWith('.ts') && !item.name.endsWith('.test.ts')) visit(file);
    }
  }
  scan(domain);
});
