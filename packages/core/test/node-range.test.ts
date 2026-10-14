import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nodeSatisfies, REACT_BUILD_NODE_RANGE } from '../src/toolchain.js';

test('REACT_BUILD_NODE_RANGE accepts Node 20.19+ on 20 and 22.12+ from 22 on', () => {
  for (const v of ['v20.19.0', '20.20.1', 'v22.12.0', 'v22.23.3', 'v23.0.0', 'v24.1.0']) assert.equal(nodeSatisfies(v, REACT_BUILD_NODE_RANGE), true, v);
  for (const v of ['v18.20.4', 'v20.18.3', 'v21.0.0', 'v21.7.3', 'v22.11.0', '', 'v22', 'node']) assert.equal(nodeSatisfies(v, REACT_BUILD_NODE_RANGE), false, v);
});

test('nodeSatisfies ANDs space-separated comparators and reads partial bounds', () => {
  const range = '>=20.20 <23';
  for (const v of ['20.20.1', 'v20.20.0', '21.5.0', 'v22.12.0', '22.99.9']) assert.equal(nodeSatisfies(v, range), true, v);
  for (const v of ['18.20.4', '20.19.9', 'v23.0.0', '24.1.0', '', 'v22', 'node']) assert.equal(nodeSatisfies(v, range), false, v);
});

test('nodeSatisfies reads exact, caret and floor terms', () => {
  assert.equal(nodeSatisfies('20.20.1', '20.20.1'), true);
  assert.equal(nodeSatisfies('20.20.2', '20.20.1'), false);
  assert.equal(nodeSatisfies('20.99.0', '^20.19.0'), true);
  assert.equal(nodeSatisfies('21.0.0', '^20.19.0'), false);
  assert.equal(nodeSatisfies('30.0.0', '>=22.12.0'), true);
  assert.equal(nodeSatisfies('20.20.1', 'not-a-range'), false);
});
