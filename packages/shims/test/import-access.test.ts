import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canImport, canListUsers, principalFromRequest, type AccessPolicy, type Principal } from '../src/access.js';

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

test('canImport requires exact admin match via canListUsers with no case-insensitive or developer fallback', () => {
  const cases: Array<[Principal | undefined, AccessPolicy | undefined]> = [
    [undefined, undefined],
    [undefined, policy],
    [{ profile: '' }, policy],
    [{ profile: 'Administrator' }, undefined],
    [{ profile: 'Administrator' }, policy],
    [{ profile: 'administrator' }, policy],
    [{ profile: 'Administrator ' }, policy],
    [{ profile: 'Developer' }, policy],
    [{ profile: 'developer' }, policy],
    [{ profile: 'User' }, policy],
    [{ profile: 'Import Manager' }, policy],
  ];
  for (const [princ, pol] of cases) {
    assert.equal(canImport(princ, pol), canListUsers(princ, pol));
  }
});
