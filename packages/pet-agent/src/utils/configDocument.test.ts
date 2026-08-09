import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConfigDocumentError,
  defineConfigSchema,
  parseConfigDocument,
  parseConfigValue,
} from './configDocument';

type Demo = {
  id: string;
  label?: string;
  tags: string[];
  limit?: number;
  nested?: { path?: string };
};

const demoSchema = defineConfigSchema<Demo>({
  kind: 'demo config',
  parse: (reader) => {
    const nested = reader.optionalSection('nested');
    return {
      id: reader.requiredString('id'),
      ...(reader.optionalString('label') !== undefined
        ? { label: reader.optionalString('label') }
        : {}),
      tags: reader.requiredStringArray('tags'),
      ...(reader.optionalPositiveInteger('limit') !== undefined
        ? { limit: reader.optionalPositiveInteger('limit') }
        : {}),
      ...(nested ? { nested: { path: nested.optionalString('path') } } : {}),
    };
  },
});

test('parseConfigDocument reads a valid document', () => {
  const value = parseConfigDocument({
    content: JSON.stringify({
      id: 'a',
      label: 'A',
      tags: ['x', 'y'],
      limit: 3,
      nested: { path: 'p.md' },
    }),
    source: '/cfg.json',
    schema: demoSchema,
  });

  assert.deepEqual(value, {
    id: 'a',
    label: 'A',
    tags: ['x', 'y'],
    limit: 3,
    nested: { path: 'p.md' },
  });
});

test('parseConfigDocument omits absent optional fields rather than defaulting them', () => {
  const value = parseConfigDocument({
    content: JSON.stringify({ id: 'a', tags: [] }),
    source: '/cfg.json',
    schema: demoSchema,
  });

  assert.deepEqual(value, { id: 'a', tags: [] });
});

test('parseConfigDocument reports invalid JSON with the source', () => {
  assert.throws(
    () => parseConfigDocument({ content: '{ not json', source: '/cfg.json', schema: demoSchema }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigDocumentError);
      assert.match(error.message, /demo config \/cfg\.json is not valid JSON/);
      assert.equal(error.source, '/cfg.json');
      return true;
    },
  );
});

test('parseConfigValue rejects non-object documents', () => {
  for (const raw of ['"text"', '42', '[]', 'null']) {
    assert.throws(
      () => parseConfigDocument({ content: raw, source: '/cfg.json', schema: demoSchema }),
      /demo config at \/cfg\.json is not a JSON object/,
    );
  }
});

test('field errors carry a uniform prefix and the offending field', () => {
  assert.throws(
    () => parseConfigValue({ tags: [] }, demoSchema, '/cfg.json'),
    (error: unknown) => {
      assert.ok(error instanceof ConfigDocumentError);
      assert.equal(error.message, 'demo config /cfg.json: missing required string "id"');
      assert.equal(error.field, 'id');
      return true;
    },
  );

  assert.throws(
    () => parseConfigValue({ id: 'a', tags: 'nope' }, demoSchema, '/cfg.json'),
    /"tags" must be a string\[\]/,
  );

  assert.throws(
    () => parseConfigValue({ id: 'a', tags: [], label: '' }, demoSchema, '/cfg.json'),
    /"label" must be a non-empty string when present/,
  );

  for (const limit of [0, -1, 1.5, '3']) {
    assert.throws(
      () => parseConfigValue({ id: 'a', tags: [], limit }, demoSchema, '/cfg.json'),
      /"limit" must be a positive integer when present/,
      `expected limit=${JSON.stringify(limit)} to be rejected`,
    );
  }
});

test('nested section errors keep the qualified field path', () => {
  assert.throws(
    () => parseConfigValue({ id: 'a', tags: [], nested: { path: '' } }, demoSchema, '/cfg.json'),
    (error: unknown) => {
      assert.ok(error instanceof ConfigDocumentError);
      // 嵌套字段要能定位到具体路径，否则用户只知道“某处有问题”。
      assert.equal(error.field, 'nested.path');
      assert.match(error.message, /demo config \/cfg\.json \(nested\): "path" must be/);
      return true;
    },
  );

  assert.throws(
    () => parseConfigValue({ id: 'a', tags: [], nested: [] }, demoSchema, '/cfg.json'),
    /"nested" must be an object when present/,
  );
});

test('schemas can express cross-field constraints through fail()', () => {
  const schema = defineConfigSchema<{ a: string; b: string }>({
    kind: 'pair config',
    parse: (reader) => {
      const a = reader.requiredString('a');
      const b = reader.requiredString('b');
      if (a === b) reader.fail('"a" and "b" must differ', 'b');
      return { a, b };
    },
  });

  assert.throws(
    () => parseConfigValue({ a: 'x', b: 'x' }, schema, '/cfg.json'),
    (error: unknown) => {
      assert.ok(error instanceof ConfigDocumentError);
      assert.equal(error.message, 'pair config /cfg.json: "a" and "b" must differ');
      assert.equal(error.field, 'b');
      return true;
    },
  );
});

test('readers expose the raw record for structures the primitives do not cover', () => {
  const schema = defineConfigSchema<{ extras: string[] }>({
    kind: 'raw config',
    parse: (reader) => ({ extras: Object.keys(reader.raw).sort() }),
  });

  assert.deepEqual(
    parseConfigValue({ b: 1, a: 2 }, schema, '/cfg.json'),
    { extras: ['a', 'b'] },
  );
});
