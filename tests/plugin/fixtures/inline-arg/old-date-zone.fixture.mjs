/**
 * Fixture: copy of the pre-fix zone test for the report date display change.
 * It passed the 316 KB client runtime inside one `node -e` argument. macOS
 * allows that; Linux caps one argument at 128 KB, so Linux CI failed while
 * local runs passed. The fixed test writes the runtime to a file under a
 * mkdtempSync directory and spawns the file instead.
 *
 * This file is never executed. It lives under the inline-arg guard's own
 * test data, which the tree scan skips; tests/plugin/hygiene.test.mjs feeds
 * it to scanInlineArgs directly and requires at least one hit.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { clientRuntimeSource } from '../../../../packages/ui/src/generate.js';

// The runtime the app ships: the base script and every client part, about
// 316 KB, far larger than one Linux argument (128 KB).
const SOURCE = clientRuntimeSource();

test('a DATE field shows the same calendar day in every zone', () => {
  const seen = ['America/Los_Angeles', 'Asia/Kolkata'].map((zone) => {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
      globalThis.CSS = { escape: (s) => s };
      const display = new Function(${JSON.stringify(SOURCE)} + '; return displayDateValue;')();
      globalThis.C2C_DATE_FORMAT = 'dd-MMM-yyyy';
      process.stdout.write(JSON.stringify([display('2026-10-17', 'date'), display('2026-01-01T00:00:00', 'date')]));
    `], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  });
  for (const [date, newYear] of seen) {
    assert.equal(date, '17-Oct-2026');
    assert.equal(newYear, '01-Jan-2026');
  }
});
