/**
 * The business migration report must be plain language: no internal jargon,
 * identifiers or product-internal names may appear in the markdown or the
 * machine JSON for any exercised app. Internal detail lives only in the
 * appendix JSON.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFile } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import {
  buildBusinessMigrationReport,
  businessReportAppendixAsJson,
  businessReportAsJson,
  businessReportAsMarkdown,
} from '../src/business-report.js';
import { BANNED_TERMS } from '../src/report-wording.js';

const root = repoRoot();
const galleryRoot = process.env.C2C_FIXTURES_DIR ? join(process.env.C2C_FIXTURES_DIR, 'gallery') : '';
const gallerySkip = galleryRoot ? false : 'C2C_FIXTURES_DIR/gallery is not available';

function bannedPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = /^\w/.test(term) ? '\\b' : '';
  const right = /\w$/.test(term) ? '\\b' : '';
  return new RegExp(`${left}${escaped}${right}`, 'i');
}

function assertPlain(ds: string, label: string): void {
  const report = buildBusinessMigrationReport(parseFile(ds).ir, { dc: 'in', mail: true });
  const markdown = businessReportAsMarkdown(report);
  const json = businessReportAsJson(report);
  for (const term of BANNED_TERMS) {
    const pattern = bannedPattern(term);
    assert.equal(pattern.test(markdown), false, `${label}: markdown exposes internal term ${JSON.stringify(term)}`);
    assert.equal(pattern.test(json), false, `${label}: JSON exposes internal term ${JSON.stringify(term)}`);
  }
  assert.equal(/"technical"/.test(json), false, `${label}: JSON leaks an appendix-only key`);
}

test('kitchen-sink-gaps report contains no internal jargon', () => {
  assertPlain(join(root, 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds'), 'kitchen-sink-gaps');
});

test('redistributable library app report contains no internal jargon', () => {
  assertPlain(join(root, 'fixtures/redistributable/library-application-system/library_application.ds'), 'library');
});

test('gallery app reports contain no internal jargon', { skip: gallerySkip }, () => {
  for (const [dir, file] of [
    ['course-planner', 'Course_Planner.ds'],
    ['customer-relationship-manager', 'Customer_Relationship_Manager.ds'],
    ['education-management', 'Education_Management.ds'],
  ]) {
    assertPlain(join(galleryRoot, dir, file), dir);
  }
});

test('the appendix JSON keeps the internal detail the business report drops', () => {
  const report = buildBusinessMigrationReport(
    parseFile(join(root, 'fixtures/synthetic/kitchen-sink-gaps/kitchen_sink_gaps.ds')).ir,
    { dc: 'in' },
  );
  const appendix = JSON.parse(businessReportAppendixAsJson(report)) as {
    schema: string;
    items: { section: string; area: string; name: string; technical: string }[];
  };
  assert.equal(appendix.schema, 'c2c-business-migration-report-appendix/1');
  assert.ok(appendix.items.length > 0, 'appendix lists the technical detail for each attention item');
  for (const item of appendix.items) assert.ok(item.technical.length > 0, `appendix item ${item.name} has its technical detail`);
});
