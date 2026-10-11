import assert from 'node:assert/strict';
import { applyDiscount } from './src/price.js';

assert.equal(applyDiscount(100, 10), 90);
assert.equal(applyDiscount(19.99, 25), 14.99);
assert.equal(applyDiscount(50, 0), 50);
console.log('all tests passed');
