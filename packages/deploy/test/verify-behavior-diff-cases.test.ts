/**
 * Differential cases (tests/behavior-diff/<app>/creator/cases.json) for five
 * gallery apps, replayed offline by `runBehavior`. Expectations come from the
 * .ds source; cases whose name starts with [UNVERIFIED] are guesses about
 * Creator behaviour. The cases that currently differ are pinned in KNOWN_OPEN:
 * the test fails when a case starts passing (shrink the list) or a new one
 * differs (new regression), so the list is the open-defect ledger.
 */
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../../core/src/toolchain.js';
import { loadApp } from '../src/cli.js';
import { loadGoldens, runBehavior, startOfflineBackend } from '../src/verify-behavior.js';

const root = repoRoot();

function fixturesDir(): string | undefined {
  if (process.env.C2C_FIXTURES_DIR) return process.env.C2C_FIXTURES_DIR;
  const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  for (const candidate of ['c2c-fixtures-local', '../c2c-fixtures-local', '../../../c2c-fixtures-local']) {
    const dir = join(here, candidate);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return dir;
  }
  return undefined;
}
const FIXTURES = fixturesDir();

const APPS: { app: string; ds: string; open: string[]; skipped: number }[] = [
  { app: 'bill-of-materials', ds: 'Bill_Of_Materials.ds', open: ['bom-lookup-nonexistent-parent', 'bom-mandatory-grid-absent', 'user-email-format'], skipped: 0 },
  { app: 'bug-tracker', ds: 'Bug_Tracker.ds', open: ['user-email-format'], skipped: 1 },
  { app: 'business-finance-tracker', ds: 'Business_Finance_Tracker.ds', open: ['income-lookup-criteria'], skipped: 0 },
  { app: 'call-logs', ds: 'Call_Logs.ds', open: [], skipped: 0 },
  { app: 'conference-room-booking', ds: 'Conference_Room_Booking.ds', open: ['booking-email-format'], skipped: 0 },
];

for (const { app, ds, open, skipped } of APPS) {
  const file = FIXTURES ? join(FIXTURES, 'gallery', app, ds) : '';
  const skip = !file || !existsSync(file) ? 'C2C_FIXTURES_DIR gallery fixture not available' : false;
  test(`differential cases: ${app} differs only in the pinned open cases`, { skip }, async () => {
    const golden = loadGoldens(join(root, 'tests/behavior-diff', app, 'creator'));
    const parsed = loadApp(file);
    const backend = await startOfflineBackend(parsed);
    try {
      const { report } = await runBehavior(parsed, golden, backend, 'offline');
      const failing = [...new Set(report.findings.map((f) => f.case))].sort();
      assert.deepEqual(failing, [...open].sort());
      assert.equal(report.skipped?.length ?? 0, skipped);
    } finally {
      await backend.close();
    }
  });
}
