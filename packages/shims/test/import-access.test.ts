import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canImport, principalFromRequest, type AccessPolicy } from '../src/access.js';

const policy: AccessPolicy = { roles: [], profiles: {}, admins: ['Administrator', 'Import Manager'] };

for (const profile of ['Administrator ', 'administrator', 'aDmInIsTrAtOr', 'Developer', 'User', 'Import Manager ', 'import manager']) {
  test(`import denies a profile not exactly in policy.admins: ${JSON.stringify(profile)}`, () => {
    const principal = principalFromRequest({ user: { profile } });
    assert.equal(principal?.profile, profile);
    assert.equal(canImport(principal ?? undefined, policy), false);
  });
}

for (const profile of policy.admins!) {
  test(`import accepts an exact generated administrator: ${profile}`, () => {
    assert.equal(canImport({ profile }, policy), true);
  });
}

test('import fails closed without a principal or administrator policy', () => {
  assert.equal(canImport(undefined, policy), false);
  assert.equal(canImport({ profile: '' }, policy), false);
  assert.equal(canImport({ profile: 'Administrator' }), false);
  assert.equal(canImport({ profile: 'Administrator' }, { roles: [], profiles: {} }), false);
  assert.equal(canImport({ profile: 'Administrator' }, { ...policy, admins: [] }), false);
});

test('import does not normalize generated administrator entries', () => {
  assert.equal(canImport({ profile: 'Administrator' }, { ...policy, admins: ['Administrator '] }), false);
  assert.equal(canImport({ profile: 'Administrator' }, { ...policy, admins: ['administrator'] }), false);
});
