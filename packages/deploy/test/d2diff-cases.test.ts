/**
 * Differential verify-behavior cases (tests/behavior/<app>/d2diff) for five
 * gallery apps: each file is a valid golden and every case is either
 * replayable or carries a skip reason. Replaying them needs the local
 * Creator exports: `c2c verify-behavior <app.ds> --goldens tests/behavior/<app>/d2diff`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import { assertGolden } from '../src/verify-behavior.js';

const APPS = ['admission-management', 'appointment-management', 'approval-management', 'assignment-tracker', 'attendance-management'];

for (const app of APPS) {
  test(`d2diff goldens for ${app} are valid and every case carries the d2diff tag`, () => {
    const golden = JSON.parse(readFileSync(join(repoRoot(), 'tests/behavior', app, 'd2diff/cases.json'), 'utf8'));
    assertGolden(golden);
    assert.ok(golden.cases.length >= 5 && golden.cases.length <= 10);
    for (const c of golden.cases) assert.ok((c.tags ?? []).includes('d2diff'), c.id);
  });
}
