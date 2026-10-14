import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DIALECT_MARKERS,
  detectDialect,
  parseFile,
  type App,
} from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturesDir = path.join(root, 'fixtures/dialects');

function stripSpans(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSpans);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'span' || k === 'statementCount' || k === 'dialect') continue;
      out[k] = stripSpans(v);
    }
    return out;
  }
  return node;
}

test('detectDialect: structural markers from §10.2 fire accurately', () => {
  assert.ok(DIALECT_MARKERS.D1_forms_block.test('forms\n{\n  form X {}\n}'));
  assert.ok(DIALECT_MARKERS.D2_section_field.test('section Main_Sec\n{\n}'));
  assert.ok(DIALECT_MARKERS.L1_web_block.test('web\n{\n  menu {}\n}'));
  assert.ok(DIALECT_MARKERS.L2_phone_block.test('\tphone\n\t{\n\t}'));
  assert.ok(DIALECT_MARKERS.L3_tablet_block.test('\ttablet\n\t{\n\t}'));
  assert.ok(DIALECT_MARKERS.L4_pages_block.test('\tpages\n\t{\n\t}'));
  assert.ok(DIALECT_MARKERS.N1_AI_properties.test('field { AI_Properties = ... }'));
  assert.ok(DIALECT_MARKERS.N2_Formula_props.test('Formula_Properties = ...'));
  assert.ok(DIALECT_MARKERS.N3_qrcode.test('type = qrcode'));
  assert.ok(DIALECT_MARKERS.N4_batchworkflow.test('batchworkflow run_nightly {}'));
  assert.ok(DIALECT_MARKERS.N5_blueprint.test('blueprint order_flow {}'));
});

test('detectDialect: snippet classification for non-app files', () => {
  const delugeScript = 'void myFunc() {\n  info "hello";\n}';
  const res = detectDialect(delugeScript);
  assert.equal(res.dialect, 'snippet');
  assert.equal(res.generation, 'SNIPPET');
});

test('detectDialect: D1 generation classification per §10.3', () => {
  const c6D1 = `application "App" {\n  forms {}\n  web {}\n\tphone {}\n\ttablet {}\n}`;
  const c6Res = detectDialect(c6D1);
  assert.equal(c6Res.dialect, 'D1');
  assert.equal(c6Res.generation, 'C6-likely');

  const ambD1 = `application "App" {\n  forms {}\n  web {}\n\tphone {}\n}`;
  const ambRes = detectDialect(ambD1);
  assert.equal(ambRes.dialect, 'D1');
  assert.equal(ambRes.generation, 'AMBIGUOUS');
});

test('detectDialect: D2 generation classification per §10.3', () => {
  const c5D2 = `application "App" {\n  section S {\n    form F {}\n  }\n}`;
  const c5Res = detectDialect(c5D2);
  assert.equal(c5Res.dialect, 'D2');
  assert.equal(c5Res.generation, 'C5-candidate');

  const ambD2 = `application "App" {\n  section S {\n    form F {}\n  }\n\tphone {}\n}`;
  const ambRes = detectDialect(ambD2);
  assert.equal(ambRes.dialect, 'D2');
  assert.equal(ambRes.generation, 'AMBIGUOUS');
});

test('minimal synthetic fixtures: D1 and D2 derive identical logical IR', () => {
  const d1File = parseFile(path.join(fixturesDir, 'd1-minimal.ds'));
  const d2File = parseFile(path.join(fixturesDir, 'd2-minimal.ds'));

  assert.equal(d1File.ir.dialect, 'D1');
  assert.equal(d2File.ir.dialect, 'D2');

  // Both should have shape 'B' and same app name
  assert.equal(d1File.ir.name, 'Synthetic_Dialect_App');
  assert.equal(d2File.ir.name, 'Synthetic_Dialect_App');
  assert.equal(d1File.ir.shape, 'B');
  assert.equal(d2File.ir.shape, 'B');

  // Verify form normalization
  assert.equal(d1File.ir.forms.length, 1);
  assert.equal(d2File.ir.forms.length, 1);
  assert.equal(d1File.ir.forms[0].name, 'Contact');
  assert.equal(d2File.ir.forms[0].name, 'Contact');
  assert.equal(d1File.ir.forms[0].section, 'Main_Section');
  assert.equal(d2File.ir.forms[0].section, 'Main_Section');

  // Verify report normalization
  assert.equal(d1File.ir.reports.length, 1);
  assert.equal(d2File.ir.reports.length, 1);
  assert.equal(d1File.ir.reports[0].name, 'All_Contacts');
  assert.equal(d2File.ir.reports[0].name, 'All_Contacts');
  assert.equal(d1File.ir.reports[0].section, 'Main_Section');
  assert.equal(d2File.ir.reports[0].section, 'Main_Section');
  assert.equal(d1File.ir.reports[0].form, 'Contact');
  assert.equal(d2File.ir.reports[0].form, 'Contact');

  // Verify section normalization
  assert.equal(d1File.ir.sections.length, 1);
  assert.equal(d2File.ir.sections.length, 1);
  assert.equal(d1File.ir.sections[0].name, 'Main_Section');
  assert.equal(d2File.ir.sections[0].name, 'Main_Section');
  assert.deepEqual(
    d1File.ir.sections[0].components,
    d2File.ir.sections[0].components,
  );

  // Verify web device normalization
  const d1Web = d1File.ir.devices.find((d) => d.device === 'web');
  const d2Web = d2File.ir.devices.find((d) => d.device === 'web');
  assert.ok(d1Web, 'd1 has web device');
  assert.ok(d2Web, 'd2 has normalized web device');
  assert.equal(d1Web.sections.length, 1);
  assert.equal(d2Web.sections.length, 1);
  assert.equal(d1Web.sections[0].name, 'Main_Section');
  assert.equal(d2Web.sections[0].name, 'Main_Section');

  // Full logical IR deep equality (excluding spans, dialect tag, and statement count)
  assert.deepEqual(stripSpans(d1File.ir), stripSpans(d2File.ir));
});
