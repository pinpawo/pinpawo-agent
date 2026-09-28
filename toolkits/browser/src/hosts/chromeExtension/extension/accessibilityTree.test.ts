import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAccessibilityTreeSnapshot } from './accessibilityTree';

const loaderId = '6A1F0C3E9B7D41C2A0E5F3B8C1D2E4F6';

type Spec = {
  role: string;
  name?: string;
  value?: string;
  ignored?: boolean;
  backend?: number;
  properties?: Record<string, unknown>;
  children?: Spec[];
};

/** Builds CDP-shaped AXNodes (flat list with childIds) from a nested spec. */
function axNodes(spec: Spec) {
  const nodes: Array<Record<string, unknown>> = [];
  let next = 1;
  const add = (item: Spec, parentId?: string): string => {
    const nodeId = String(next++);
    const node: Record<string, unknown> = {
      nodeId,
      ignored: item.ignored ?? false,
      role: { type: 'role', value: item.role },
      ...(item.name !== undefined ? { name: { type: 'computedString', value: item.name } } : {}),
      ...(item.value !== undefined ? { value: { type: 'string', value: item.value } } : {}),
      ...(item.backend ? { backendDOMNodeId: item.backend } : {}),
      ...(parentId ? { parentId } : {}),
      properties: Object.entries(item.properties ?? {}).map(([name, value]) => ({
        name,
        value: { type: typeof value === 'number' ? 'integer' : 'boolean', value },
      })),
    };
    nodes.push(node);
    node.childIds = (item.children ?? []).map((child) => add(child, nodeId));
    return nodeId;
  };
  add(spec);
  return nodes;
}

const page: Spec = {
  role: 'RootWebArea',
  name: 'Sign in — Example',
  children: [
    {
      role: 'banner',
      children: [
        { role: 'link', name: 'Home', backend: 10, children: [{ role: 'StaticText', name: 'Home', children: [{ role: 'InlineTextBox', name: 'Home' }] }] },
      ],
    },
    {
      role: 'main',
      children: [
        { role: 'heading', name: 'Sign in', properties: { level: 1 }, children: [{ role: 'StaticText', name: 'Sign in' }] },
        {
          role: 'generic',
          children: [
            { role: 'StaticText', name: 'Use your' },
            { role: 'generic', children: [{ role: 'StaticText', name: 'work account.' }] },
          ],
        },
        { role: 'textbox', name: 'Email', value: 'barry@example.com', backend: 20 },
        { role: 'textbox', name: 'Password', value: 'hunter2', backend: 21 },
        { role: 'checkbox', name: 'Remember me', backend: 22, properties: { checked: true } },
        { role: 'button', name: 'Menu', backend: 23, properties: { expanded: false } },
        { role: 'generic', ignored: true, children: [{ role: 'button', name: 'Continue', backend: 24, properties: { disabled: true } }] },
        { role: 'ListMarker', name: '•' },
      ],
    },
  ],
};

test('renders an indented outline of roles, names, states and page text (#873)', () => {
  const snapshot = buildAccessibilityTreeSnapshot(axNodes(page), 'https://example.com/login', {
    loaderId,
    sensitiveNodeIds: new Set([21]),
  });

  assert.equal(snapshot.title, 'Sign in — Example');
  assert.equal(snapshot.source, 'accessibility');
  assert.equal(snapshot.tree, [
    '- banner',
    '  - link "Home" [ref=ax:6A1F0C3E:10:link]',
    '- main',
    '  - heading "Sign in" [level=1]',
    '  - text: "Use your work account."',
    '  - textbox "Email" [value="barry@example.com"] [ref=ax:6A1F0C3E:20:textbox]',
    '  - textbox "Password" [value=redacted] [ref=ax:6A1F0C3E:21:textbox]',
    '  - checkbox "Remember me" [checked] [ref=ax:6A1F0C3E:22:checkbox]',
    '  - button "Menu" [collapsed] [ref=ax:6A1F0C3E:23:button]',
    '  - button "Continue" [disabled] [ref=ax:6A1F0C3E:24:button]',
  ].join('\n'));
  assert.equal(snapshot.refCount, 6);
  assert.equal(snapshot.treeLength, snapshot.tree.length);
});

test('withholds every field value when sensitive inputs could not be determined (#873)', () => {
  const snapshot = buildAccessibilityTreeSnapshot(axNodes(page), 'https://example.com/login', {
    loaderId,
    sensitiveNodeIds: null,
  });
  assert.match(snapshot.tree, /textbox "Email" \[value=redacted\]/);
  assert.doesNotMatch(snapshot.tree, /barry@example\.com|hunter2/);
});

test('offers no refs without a document identity', () => {
  const snapshot = buildAccessibilityTreeSnapshot(axNodes(page), 'https://example.com/login', {
    loaderId: null,
    sensitiveNodeIds: new Set(),
  });
  assert.equal(snapshot.refCount, 0);
  assert.doesNotMatch(snapshot.tree, /\[ref=/);
  assert.match(snapshot.tree, /- link "Home"$/m);
});

test('bounds the tree while reporting its full length', () => {
  const snapshot = buildAccessibilityTreeSnapshot(axNodes(page), 'https://example.com/login', {
    loaderId,
    sensitiveNodeIds: new Set(),
  }, 40);
  assert.ok(new TextEncoder().encode(snapshot.tree).length <= 40);
  assert.ok(snapshot.treeLength > snapshot.tree.length);
});

/** Shapes observed in real Chrome on the #873 verification fixture. */
const chromeShapes: Spec = {
  role: 'RootWebArea',
  name: 'AX fixture',
  children: [
    {
      role: 'paragraph',
      children: [
        { role: 'StaticText', name: 'Use your' },
        { role: 'strong', children: [{ role: 'StaticText', name: 'work' }] },
        { role: 'StaticText', name: 'account.' },
      ],
    },
    {
      role: 'LabelText',
      children: [
        { role: 'StaticText', name: 'Card' },
        // Chrome hangs the field's own value under it as text.
        { role: 'textbox', name: 'Card', value: '4111111111111111', backend: 5, children: [
          { role: 'generic', children: [{ role: 'StaticText', name: '4111111111111111' }] },
        ] },
      ],
    },
    { role: 'combobox', name: 'Plan', value: 'Pro', backend: 7, properties: { expanded: false }, children: [
      { role: 'StaticText', name: 'Pro' },
      { role: 'MenuListPopup', children: [
        { role: 'MenuListOption', name: 'Free', backend: 42 },
        { role: 'MenuListOption', name: 'Pro', backend: 45, properties: { selected: true } },
      ] },
    ] },
    { role: 'group', children: [
      { role: 'DisclosureTriangle', name: 'More options', backend: 30, properties: { expanded: false } },
    ] },
    { role: 'list', children: [
      { role: 'listitem', properties: { level: 1 }, children: [
        { role: 'StaticText', name: 'First item' },
        // A collapsed sublist: present in the tree, with nothing to show.
        { role: 'list', children: [{ role: 'generic' }] },
      ] },
    ] },
  ],
};

test('matches real Chrome shapes: no value text under fields, no formatting or label noise (#873)', () => {
  const snapshot = buildAccessibilityTreeSnapshot(axNodes(chromeShapes), 'http://127.0.0.1/', {
    loaderId,
    sensitiveNodeIds: new Set([5]),
  });

  assert.doesNotMatch(snapshot.tree, /4111111111111111/, 'a redacted value must not leak as child text');
  assert.equal(snapshot.tree, [
    '- paragraph',
    '  - text: "Use your work account."',
    '- text: "Card"',
    '- textbox "Card" [value=redacted] [ref=ax:6A1F0C3E:5:textbox]',
    '- combobox "Plan" [collapsed] [value="Pro"] [ref=ax:6A1F0C3E:7:combobox]',
    '  - MenuListPopup',
    '    - MenuListOption "Free" [ref=ax:6A1F0C3E:42:menulistoption]',
    '    - MenuListOption "Pro" [selected] [ref=ax:6A1F0C3E:45:menulistoption]',
    '- group',
    '  - DisclosureTriangle "More options" [collapsed] [ref=ax:6A1F0C3E:30:disclosuretriangle]',
    '- list',
    '  - listitem',
    '    - text: "First item"',
  ].join('\n'));
});
