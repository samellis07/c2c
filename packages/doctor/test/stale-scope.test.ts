/** A stored doctor.json scope never poisons a later run with another scope. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeDoctorFile, staleScopeNotice } from '../src/report.js';
import type { DoctorFile } from '../src/types.js';

function file(scope: DoctorFile['scope']): DoctorFile {
  return { c2c: '0.0.0', at: new Date(0).toISOString(), host: 'unknown', scope, checks: [], green: true } as DoctorFile;
}

test('an org-scoped run drops the project scope an earlier project run stored', () => {
  const previous = file({ dc: 'in', org: '10000000000', project: '10000000000013200' });
  const next = file({ dc: 'in', org: '10000000000' });
  assert.equal(mergeDoctorFile(previous, next).scope.project, undefined);
  assert.match(staleScopeNotice(previous, next) ?? '', /ignored the stored project scope/);
});

test('a project-scoped run after an org-scoped run records the project and prints no notice', () => {
  const previous = file({ dc: 'in', org: '10000000000' });
  const next = file({ dc: 'in', org: '10000000000', project: '10000000000013200' });
  assert.equal(mergeDoctorFile(previous, next).scope.project, '10000000000013200');
  assert.equal(staleScopeNotice(previous, next), undefined);
});
