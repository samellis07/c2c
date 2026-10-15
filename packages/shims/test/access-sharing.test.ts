/**
 * Record sharing and the Create / Edit split in the access policy: owner
 * scope by intent, add-only grants, reply projection, and a scoped read that
 * compiles to valid ZCQL (no literal `true`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RecordAccessError,
  authorizeDelete,
  authorizeRead,
  authorizeWrite,
  projectReadable,
  type AccessPolicy,
} from '../src/access.js';
import { compileCriteria } from '../src/criteria.js';

const policy: AccessPolicy = {
  roles: [],
  profiles: {
    Own: { Ticket: { write: true, delete: true, ownerScope: 'view' } },
    ModifyOwn: { Ticket: { write: true, delete: true, ownerScope: 'modify', create: false } },
    AddOnly: { Ticket: { read: false, write: true, edit: false, fields: ['Title', 'Secret'], writable: ['Title'] } },
    Filtered: { Ticket: { recordFilter: { op: '==', field: 'Region', value: 'north' }, ownerScope: 'view', fields: ['Title'] } },
  },
};

const owner = (user: string) => ({ op: '==', field: 'Added_User', value: user });

test('ownerScope view narrows every read and every modify to the caller\'s own rows', () => {
  const principal = { profile: 'Own', loginUser: 'a@example.test' };
  assert.deepEqual(authorizeRead(policy, principal, 'Ticket', { op: 'true' }).criteria, owner('a@example.test'));
  const byId = { op: '==' as const, field: 'ROWID', value: '7' };
  assert.deepEqual(authorizeRead(policy, principal, 'Ticket', byId, undefined, 'modify').criteria, {
    op: 'and',
    args: [byId, owner('a@example.test')],
  });
  // A caller who cannot own a row reads nothing.
  assert.throws(() => authorizeRead(policy, { profile: 'Own' }, 'Ticket', { op: 'true' }), RecordAccessError);
});

test('ownerScope modify reads every row and narrows only an edit or delete', () => {
  const principal = { profile: 'ModifyOwn', loginUser: 'a@example.test' };
  assert.deepEqual(authorizeRead(policy, principal, 'Ticket', { op: 'true' }).criteria, { op: 'true' });
  assert.deepEqual(authorizeRead(policy, principal, 'Ticket', { op: 'true' }, undefined, 'modify').criteria, owner('a@example.test'));
});

test('a scoped read never compiles to a literal true', () => {
  const principal = { profile: 'Filtered', loginUser: 'a@example.test' };
  const where = compileCriteria(authorizeRead(policy, principal, 'Ticket', { op: 'true' }).criteria);
  assert.doesNotMatch(where, /\btrue\b/);
  assert.match(where, /Region = 'north'/);
  assert.match(where, /Added_User = 'a@example.test'/);
});

test('Create and Edit are separate grants on a write', () => {
  const own = { profile: 'Own', loginUser: 'a@example.test' };
  assert.deepEqual(authorizeWrite(policy, own, 'Ticket', { Title: 'x' }, undefined, 'insert').values, { Title: 'x' });
  assert.deepEqual(authorizeWrite(policy, own, 'Ticket', { Title: 'x' }, undefined, 'update').values, { Title: 'x' });
  const modifyOwn = { profile: 'ModifyOwn', loginUser: 'a@example.test' };
  assert.throws(() => authorizeWrite(policy, modifyOwn, 'Ticket', { Title: 'x' }, undefined, 'insert'), /cannot add Ticket/);
  assert.deepEqual(authorizeWrite(policy, modifyOwn, 'Ticket', { Title: 'x' }, undefined, 'update').values, { Title: 'x' });
  // No op given: only the write bit is checked, as before.
  assert.deepEqual(authorizeWrite(policy, modifyOwn, 'Ticket', { Title: 'x' }).values, { Title: 'x' });
});

test('an add-only grant inserts writable fields and reads nothing', () => {
  const principal = { profile: 'AddOnly', loginUser: 'a@example.test' };
  assert.deepEqual(authorizeWrite(policy, principal, 'Ticket', { Title: 'x' }, undefined, 'insert').values, { Title: 'x' });
  assert.throws(() => authorizeWrite(policy, principal, 'Ticket', { Title: 'x' }, undefined, 'update'), /cannot edit Ticket/);
  assert.throws(() => authorizeWrite(policy, principal, 'Ticket', { Secret: 'x' }, undefined, 'insert'), RecordAccessError);
  assert.throws(() => authorizeRead(policy, principal, 'Ticket', { op: 'true' }), /cannot read Ticket/);
  assert.throws(() => authorizeDelete(policy, principal, 'Ticket'), /cannot delete Ticket/);
});

test('a write reply carries only readable fields and the row identity', () => {
  const stored = { ROWID: '9', ID: '9', Title: 't', Secret: 's', Region: 'north', Added_User: 'a@example.test' };
  assert.deepEqual(projectReadable(policy, { profile: 'Filtered' }, 'Ticket', stored), {
    ID: '9',
    ROWID: '9',
    Added_User: 'a@example.test',
    Title: 't',
  });
  assert.deepEqual(projectReadable(policy, { profile: 'AddOnly' }, 'Ticket', stored, ['Title']), { ID: '9', ROWID: '9', Title: 't' });
  assert.deepEqual(projectReadable(policy, { profile: 'Own' }, 'Ticket', stored), stored);
  assert.deepEqual(projectReadable(policy, { profile: 'Nobody' }, 'Ticket', stored), { ID: '9', ROWID: '9' });
});

test('an unconditional field rule refuses writes to the hidden or disabled field, naming it', () => {
  const rules: AccessPolicy = {
    roles: [],
    profiles: { Staff: { Ticket: { write: true } } },
  };
  const principal = { profile: 'Staff', loginUser: 'a@example.test' };
  const schema = {
    fieldNames: ['Title', 'Secret', 'Locked', 'Lines'],
    fields: [
      { name: 'Title' },
      { name: 'Secret' },
      { name: 'Locked' },
      { name: 'Lines', kind: 'subform' as const, fields: [{ name: 'Qty' }, { name: 'Note' }] },
    ],
    ruleDenied: [
      { field: 'Secret', action: 'hide' as const },
      { field: 'Locked', action: 'disable' as const, ops: ['insert' as const] },
      { field: 'Lines.Qty', action: 'disable' as const },
    ],
  };
  // The denial names the field and the rule kind.
  assert.throws(
    () => authorizeWrite(rules, principal, 'Ticket', { Secret: 'x' }, schema, 'insert'),
    /Ticket\.Secret is hidden by a field rule/,
  );
  assert.throws(
    () => authorizeWrite(rules, principal, 'Ticket', { Locked: 1 }, schema, 'insert'),
    /Ticket\.Locked is disabled by a field rule/,
  );
  // An insert-scoped denial does not refuse an update.
  assert.deepEqual(authorizeWrite(rules, principal, 'Ticket', { Locked: 1 }, schema, 'update').values, { Locked: 1 });
  // No op given: a denial listed for either op applies.
  assert.throws(() => authorizeWrite(rules, principal, 'Ticket', { Locked: 1 }, schema), /disabled by a field rule/);
  // A rule naming a subform column refuses that column in every row; a
  // sibling column still writes.
  assert.throws(
    () => authorizeWrite(rules, principal, 'Ticket', { Lines: [{ Qty: 1, Note: 'n' }] }, schema, 'insert'),
    /Ticket\.Lines\[0\]\.Qty is disabled by a field rule/,
  );
  assert.deepEqual(authorizeWrite(rules, principal, 'Ticket', { Lines: [{ Note: 'n' }] }, schema, 'insert').values, {
    Lines: [{ Note: 'n' }],
  });
  // Writable fields are unchanged.
  assert.deepEqual(authorizeWrite(rules, principal, 'Ticket', { Title: 't' }, schema, 'insert').values, { Title: 't' });
});

test('zoho.adminuser binds resolve from the deploy environment, sentinel by default', () => {
  const principal = { profile: 'Filtered', loginUser: 'a@example.test' };
  const admin = { op: '==' as const, field: 'Owner', value: { __bind: 'adminUserId' as const } };
  const previous = process.env.C2C_ADMIN_USER_ID;
  delete process.env.C2C_ADMIN_USER_ID;
  try {
    const scoped = authorizeRead(policy, principal, 'Ticket', admin);
    const leaf = scoped.criteria.op === 'and' ? scoped.criteria.args[0] : scoped.criteria;
    assert.deepEqual(leaf, { op: '==', field: 'Owner', value: '<c2c-dry-run:adminuserid>' });
    process.env.C2C_ADMIN_USER_ID = 'owner@example.test';
    const bound = authorizeRead(policy, principal, 'Ticket', admin);
    const leaf2 = bound.criteria.op === 'and' ? bound.criteria.args[0] : bound.criteria;
    assert.deepEqual(leaf2, { op: '==', field: 'Owner', value: 'owner@example.test' });
  } finally {
    if (previous === undefined) delete process.env.C2C_ADMIN_USER_ID;
    else process.env.C2C_ADMIN_USER_ID = previous;
  }
});

test('a dependent record query marker fails closed like an unmigrated criteria', () => {
  const principal = { profile: 'Filtered', loginUser: 'a@example.test' };
  const marker = { __rows: { form: 'Parent', criteria: { op: 'true' as const }, path: ['Field'] } };
  assert.throws(
    () => authorizeRead(policy, principal, 'Ticket', { op: '==', field: 'Ref', value: marker }),
    /record filter for Ticket could not be applied/,
  );
  const filtered: AccessPolicy = {
    roles: [],
    profiles: { F: { Ticket: { recordFilter: { op: '==', field: 'Ref', value: marker } } } },
  };
  assert.throws(
    () => authorizeRead(filtered, { profile: 'F' }, 'Ticket', { op: 'true' }),
    /record filter for Ticket could not be applied/,
  );
});
