/**
 * The synthetic kitchen-sink app (fixtures/synthetic/kitchen-sink) is the live
 * end-to-end input: one app that uses every mapped field type, every generated
 * workflow event kind, a report with criteria, a page, and roles. It must
 * analyze to zero TODOs, regenerate byte-identically, and plan offline with no
 * budget warning. A new field-type row or storage kind in the schema mapping
 * fails here until the fixture uses it or it is listed as excluded with a reason.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isApprovalWorkflow, isBlueprintWorkflow, parse, parseFile, print, type App, type Workflow } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { eventKind, generate } from '../../deluge/src/generate.js';
import type { Io } from '../../deploy/src/cli.js';
import { planCli } from '../../deploy/src/offline-plan.js';
import { generateSchema } from '../../schema/src/generator.js';
import { FIELD_TYPES, fieldTypeById } from '../../schema/src/mapping.js';
import { analyze, analyzeAsJson, analyzeAsText } from '../src/analyze.js';

const DS = join(repoRoot(), 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds');

/**
 * Field-type rows the kitchen sink does not use. Each needs an external
 * service, is not generated, or is a legacy integration, so it cannot be a
 * zero-TODO offline field. Every other row must appear in the fixture.
 */
const EXCLUDED_ROWS: Record<string, string> = {
  integration: 'needs a connected external service',
  prediction: 'unsupported: not generated',
  keyword: 'AI field: needs the Zia service',
  sentiment: 'AI field: needs the Zia service',
  ocr: 'AI field: needs the Zia service',
  'object-detection': 'AI field: needs the Zia service',
  barcode: 'scanner field: device input only',
  geolocation: 'unsupported: no column is invented',
  'legacy-crm': 'legacy integration',
  'legacy-crm-link': 'legacy integration',
};

/** Workflow kinds the generator emits handlers for. Approval and payment are shim-only and excluded. */
const EVENT_KINDS = ['addrow', 'click', 'delete', 'deleterow', 'input', 'load', 'rules', 'schedule', 'submit', 'success', 'validate'];

/** The workflow bucket, as tools/workflow-event-coverage.mjs counts it. */
function kindOf(w: Workflow): string {
  const blob = `${w.container ?? ''} ${w.type ?? ''}`;
  if (/\bpayments?\b/i.test(`${blob} ${w.event} ${w.name}`)) return 'payment';
  if (isBlueprintWorkflow(w)) return 'blueprint';
  if (isApprovalWorkflow(w)) return 'approval';
  if (/\bschedule\b/i.test(blob)) return 'schedule';
  const kind = eventKind(w.event || '');
  if (kind === 'handler') return w.event ? 'other' : 'rules';
  return kind;
}

function load(): App {
  return parseFile(DS).ir;
}

function offlineIo(): Io {
  const refuse = (what: string) => async () => {
    throw new Error(`network refused in kitchen-sink plan: ${what}`);
  };
  return { stdout: () => {}, stderr: () => {}, env: {}, spawn: refuse('spawn'), fetch: refuse('fetch') };
}

function hashTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else out.push(`${createHash('sha256').update(readFileSync(join(dir, next))).digest('hex')}  ${next}`);
    }
  };
  walk('');
  return out;
}

test('kitchen sink parses losslessly with nothing unknown', () => {
  const src = readFileSync(DS, 'utf8');
  assert.equal(print(parse(src)), src);
  const app = load();
  assert.deepEqual(app.unknown, []);
  assert.deepEqual(app.unmodelled, []);
});

test('kitchen sink analyzes to zero TODOs, deterministically', () => {
  const r = analyze(load());
  assert.equal(r.deluge.todo, 0);
  assert.equal(r.determinism.todoCount, 0);
  assert.deepEqual(r.blockers, []);
  assert.equal(analyzeAsJson(analyze(load())), analyzeAsJson(r));
  assert.equal(analyzeAsText(analyze(load())), analyzeAsText(r));
});

test('kitchen sink regenerates byte-identically', () => {
  const files = (app: App) => generate(app).files.map((f) => `${f.path}\n${f.source}`);
  assert.deepEqual(files(load()), files(load()));
});

test('kitchen sink uses every field-type row and storage kind in the schema mapping', () => {
  const plan = generateSchema(load());
  const used = new Set(plan.fields.map((f) => f.matrixId));
  for (const id of Object.keys(EXCLUDED_ROWS)) {
    assert.ok(fieldTypeById(id), `excluded row ${id} is no longer in the mapping`);
    assert.equal(used.has(id), false, `excluded row ${id} is used; drop it from EXCLUDED_ROWS`);
  }
  const missing = FIELD_TYPES.filter((row) => !used.has(row.id) && !(row.id in EXCLUDED_ROWS)).map((row) => row.id);
  assert.deepEqual(missing, [], 'field-type rows the kitchen sink does not use');
  const kinds = new Set([...used].map((id) => fieldTypeById(id)!.kind));
  const allKinds = [...new Set(FIELD_TYPES.map((row) => row.kind))].sort();
  assert.deepEqual([...kinds].sort(), allKinds, 'storage kinds the kitchen sink does not use');
  assert.deepEqual(plan.issues.filter((issue) => issue.severity === 'unsupported'), []);
});

test('kitchen sink has one workflow per generated event kind, a criteria report, a page and roles', () => {
  const app = load();
  assert.deepEqual([...new Set(app.workflows.map(kindOf))].sort(), EVENT_KINDS);
  assert.ok(app.reports.some((r) => r.criteria), 'no report with criteria');
  assert.ok(app.pages.length > 0, 'no page');
  assert.ok(app.roles.length > 0, 'no roles');
  assert.ok(app.profiles.some((p) => p.name !== 'Administrator'), 'no non-admin profile');
});

test('kitchen sink plans offline, byte-identically, with no budget warning', async () => {
  const outs = [0, 1].map(() => mkdtempSync(join(tmpdir(), 'c2c-kitchen-sink-plan-')));
  try {
    for (const out of outs) assert.equal(await planCli([DS, '--out', out, '--dc', 'in'], offlineIo()), 0);
    assert.deepEqual(hashTree(outs[0]!), hashTree(outs[1]!));
    const md = readFileSync(join(outs[0]!, 'plan.md'), 'utf8');
    assert.doesNotMatch(md, /\[(WARN|FAIL)\]/);
  } finally {
    for (const out of outs) rmSync(out, { recursive: true, force: true });
  }
});
