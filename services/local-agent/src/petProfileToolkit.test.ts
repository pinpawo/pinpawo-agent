import test from 'node:test';
import assert from 'node:assert/strict';

import { createPetProfileToolkit } from './toolkits/petProfile';

test('pet profile toolkit exposes local operation metadata', () => {
  const toolkit = createPetProfileToolkit({
    actor: {
      userId: null,
      name: '小羊',
      personality: '认真',
      stage: 'sprout',
      species: 'sheep',
    },
  });

  assert.equal(toolkit.name, 'pet_profile');
  assert.ok(Array.isArray(toolkit.tools));
  assert.equal(toolkit.tools[0]?.tool.name, 'describe_pet_profile');
  assert.equal(toolkit.tools[0]?.operation?.title, '读取宠物资料');
});
