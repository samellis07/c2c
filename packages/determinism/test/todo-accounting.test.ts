import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, parseFile, parseProject, type App } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { listReportApps } from '../../cli/src/migration-report.js';
import { generate } from '../../deluge/src/generate.js';
import { resolveStatusDir } from '../src/status.js';

/**
 * Every `shim.todo(ctx, "<construct>")` in the generated tree has a counted
 * TODO item of the same construct, so the deterministic flag cannot be true
 * while the output still holds a hole. Items without a call (notes such as
 * `approver-field`) are fine; a call without an item is the bug.
 */
function uncountedHoles(app: App): string[] {
  const result = generate(app);
  const counted = new Set(result.todos.map((item) => item.construct));
  const missing = new Set<string>();
  for (const file of result.files) {
    for (const match of file.source.matchAll(/shim\.todo\(\s*ctx\s*,\s*("(?:\\.|[^"\\])*")/g)) {
      const construct = JSON.parse(match[1]!) as string;
      if (!counted.has(construct)) missing.add(`${file.path}: ${construct}`);
    }
  }
  return [...missing].sort();
}

function loadIr(target: string): App {
  return statSync(target).isDirectory() ? parseProject(target).ir : parseFile(target).ir;
}

const FIELD_RULE = `application "T"
{
\tform Item
\t{
\t\tNotes
\t\t(
\t\t\ttype = text
\t\t)
\t}
\tworkflow
\t{
\t\tform
\t\t{
\t\t\tRules as "Rules"
\t\t\t{
\t\t\t\ttype = form
\t\t\t\tform = Item
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions (unknownCall().missingMethod() > 1)
\t\t\t\t\t{
\t\t\t\t\t\thide Notes;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`;

test('a field-rule hole has a counted TODO item', () => {
  assert.deepEqual(uncountedHoles(deriveIr(parse(FIELD_RULE))), []);
});

test('every shim.todo call in the committed fixtures is a counted TODO item', () => {
  const apps = listReportApps(join(repoRoot(), 'fixtures/redistributable'));
  assert.equal(apps.length, 2);
  for (const app of apps) assert.deepEqual(uncountedHoles(loadIr(app.target)), [], app.name);
});

function galleryDir(): string | undefined {
  const dir = resolveStatusDir(process.env);
  return dir && existsSync(dir) ? dir : undefined;
}

test('every shim.todo call in the gallery is a counted TODO item', { skip: !galleryDir() && 'needs C2C_FIXTURES_DIR or C2C_GALLERY_DIR' }, () => {
  const apps = listReportApps(galleryDir()!);
  assert.ok(apps.length > 0);
  const failures: string[] = [];
  for (const [index, app] of apps.entries()) {
    // Index, not name: gallery app names stay out of test output.
    for (const hole of uncountedHoles(loadIr(app.target))) failures.push(`app #${index}: ${hole}`);
  }
  assert.deepEqual(failures, []);
});

import { reportCriteria } from '../../deluge/src/translate.js';
import { criteriaHasTodo } from '../../shims/src/criteria.js';

test('every conditional format in the gallery is translated or in the manual list', { skip: !galleryDir() && 'needs C2C_FIXTURES_DIR or C2C_GALLERY_DIR' }, () => {
  const apps = listReportApps(galleryDir()!);
  assert.ok(apps.length > 0);
  const failures: string[] = [];
  for (const [index, wrap] of apps.entries()) {
    const app = loadIr(wrap.target);
    const result = generate(app);
    const formatTodos = new Set(result.todos.filter((t) => t.construct === 'report-conditional-format').map((t) => t.start));
    for (const report of app.reports) {
      for (const format of report.conditionalFormats) {
        const c = reportCriteria(format.condition || 'true');
        if (criteriaHasTodo(c) && !formatTodos.has(format.span.start)) {
          failures.push(`app #${index} report ${report.name || 'unnamed'}: conditional format ${format.name || 'unnamed'} is untranslated but has no TODO item`);
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});
