import test from 'node:test';
import assert from 'node:assert/strict';

import { createPetProfileToolkit } from './toolkits/petProfile';

test('pet profile toolkit exposes local operation metadata', () => {
  const toolkit = createPetProfileToolkit({
    actor: {
      petId: 'pet-1',
      userId: null,
      name: '小羊',
      personality: '认真',
      stage: 'sprout',
      species: 'sheep',
    },
  });

  assert.equal(toolkit.name, 'pet_profile');
  assert.ok(Array.isArray(toolkit.tools));
  assert.equal(toolkit.tools[0]?.name, 'describe_pet_profile');
  assert.equal(toolkit.operations?.describe_pet_profile?.title, '读取宠物资料');
});
