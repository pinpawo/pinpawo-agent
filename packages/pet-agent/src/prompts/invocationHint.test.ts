import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildInvocationHintContext } from './invocationHint';
import { escapeXmlAttribute, xmlTextBlock } from './xml';

test('external instruction and model focus retain separate provenance and escaped data boundaries', () => {
  const hint = { source: `${randomUUID()}"<>&`, instruction: `${randomUUID()}]]>`, focus: randomUUID() };
  for (const audience of ['entry', 'supervisor'] as const) {
    const rendered = buildInvocationHintContext(hint, audience);
    assert.ok(rendered.includes(`source="${escapeXmlAttribute(hint.source)}"`));
    const unindented = rendered.replace(/^  /gm, '');
    assert.ok(unindented.includes(xmlTextBlock('instruction', hint.instruction, ' origin="external_provider"')));
    assert.ok(unindented.includes(xmlTextBlock('focus', hint.focus, ' origin="routing_model" role="suggestion"')));
    assert.equal(rendered.split(hint.focus).length - 1, 1);
    const withoutFocus = buildInvocationHintContext({ source: hint.source, instruction: hint.instruction }, audience);
    assert.equal(withoutFocus.includes('<focus'), false);
    assert.equal(withoutFocus.includes(hint.focus), false);
  }
});
