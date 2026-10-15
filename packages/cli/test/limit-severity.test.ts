/**
 * Precheck severity follows the Catalyst limit row.
 * A finding whose check is the limit id is a blocker when that row is
 * verified and a warning when it is not. The cases are the rows of
 * CATALYST_LIMITS, so a row added later is included.
 * An unsplittable field group is the separate check catalyst-column-cap.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import {
  CATALYST_LIMITS,
  LONGEST_KEPT_TABLE_NAME,
  TABLE_NAME_LENGTH_UNVERIFIED,
  type CatalystLimit,
} from '../../schema/src/limits.js';
import { precheck, type PrecheckFinding } from '../src/precheck.js';

function app(body: string): string {
  return `application "Demo"\n{\n${body}\n}\n`;
}

function textFields(count: number, prefix = 'F'): string {
  return Array.from({ length: count }, (_, index) => `\t\t${prefix}${index}\n\t\t(\n\t\t\ttype = text\n\t\t)`).join('\n');
}

function form(name: string, inner: string): string {
  return `\tform ${name}\n\t{\n${inner}\n\t}`;
}

function plain(): string {
  return app(form('Item', textFields(1, 'Name')));
}

function withFunction(): string {
  return app(
    `${form('Item', textFields(1, 'Name'))}\n\tfunctions\n\t{\n\t\tDeluge\n\t\t{\n\t\t\tvoid Util.ping(string code)\n\t\t\t{\n\t\t\t\tinfo code;\n\t\t\t}\n\t\t}\n\t}`,
  );
}

function overCount(row: CatalystLimit): string {
  if (row.value === null) throw new Error(`${row.id} has no numeric value`);
  return app(form('Item', textFields(row.value + 1)));
}

function lookups(count: number): string {
  const fields = Array.from({ length: count }, (_, index) => `\t\tL${index}\n\t\t(\n\t\t\ttype = picklist\n\t\t\tvalues = Ref.Name\n\t\t)`).join('\n');
  return app(`${form('Ref', textFields(1, 'Name'))}\n${form('Item', fields)}`);
}

/** One Creator app that exceeds the row. A row with no stated number has no count to pass. Undefined when the row has no fixture. */
function exceedingSource(row: CatalystLimit): string | undefined {
  switch (row.id) {
    case 'datastore.columns_per_table': {
      if (row.value === null) throw new Error(row.id);
      const parts = Array.from({ length: row.value }, (_, index) => `\t\t\tP${index}\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)`).join('\n');
      return app(form('Item', `\t\tWho\n\t\t(\n\t\t\ttype = name\n${parts}\n\t\t)`));
    }
    case 'datastore.columns_per_table_default':
    case 'datastore.columns_per_table_ceiling':
    case 'datastore.text_columns':
    case 'zcql.select_columns':
      return overCount(row);
    case 'datastore.varchar_chars': {
      if (row.value === null) throw new Error(row.id);
      const choice = 'A'.repeat(row.value + 1);
      return app(form('Item', `\t\tHue\n\t\t(\n\t\t\ttype = picklist\n\t\t\tvalues = {"${choice}"}\n\t\t)`));
    }
    case 'datastore.text_chars': {
      if (row.value === null) throw new Error(row.id);
      const body = 'B'.repeat(row.value + 1);
      return app(form('Item', `\t\tNote\n\t\t(\n\t\t\ttype = text\n\t\t\tinitial value = "${body}"\n\t\t)`));
    }
    case 'datastore.unique_text_columns': {
      if (row.value === null) throw new Error(row.id);
      const fields = Array.from({ length: row.value + 1 }, (_, index) => `\t\tunique U${index}\n\t\t(\n\t\t\ttype = text\n\t\t)`).join('\n');
      return app(form('Item', fields));
    }
    case 'datastore.fk_columns':
      if (row.value === null) throw new Error(row.id);
      return lookups(row.value + 1);
    case 'zcql.joins':
      if (row.value === null) throw new Error(row.id);
      return lookups(row.value + 1);
    case 'datastore.tables_per_org':
      return app(`${form('Item', textFields(1, 'Name'))}\n${form('Other', textFields(1, 'Name'))}`);
    case 'function.concurrency_dev':
    case 'function.timeout_seconds':
      return withFunction();
    case 'datastore.write_requests_per_minute':
    case 'datastore.rows_per_table_dev':
    case 'datastore.concurrency_dev':
    case 'api.calls_dev':
    case 'url.throttle':
    case 'job.timeout_minutes':
    case 'bulk.rows_per_call':
      return plain();
    case TABLE_NAME_LENGTH_UNVERIFIED:
      return app(form('N'.repeat(LONGEST_KEPT_TABLE_NAME.length + 1), textFields(1, 'Name')));
    default:
      return undefined;
  }
}

/** Checks precheck uses for this row. The column cap is catalyst-column-cap, not the row id. */
function checksFor(row: CatalystLimit): Set<string> {
  const checks = new Set<string>([row.id]);
  if (row.id === 'datastore.unique_text_columns') checks.add('unique-varchar-budget');
  return checks;
}

function hitsFor(row: CatalystLimit, findings: readonly PrecheckFinding[]): PrecheckFinding[] {
  const checks = checksFor(row);
  return findings.filter((finding) => checks.has(finding.check));
}

test('each Catalyst limit row is a precheck blocker only when the row is verified', () => {
  const sources = new Map<string, string>();
  for (const row of CATALYST_LIMITS) {
    const source = exceedingSource(row);
    if (source !== undefined) sources.set(row.id, source);
  }
  const missing = CATALYST_LIMITS.filter((row) => !sources.has(row.id)).map((row) => row.id);
  assert.deepEqual(missing, [], `no precheck fixture for: ${missing.join(', ')}`);
  const seen = new Set<string>();
  for (const row of CATALYST_LIMITS) {
    seen.add(row.id);
    const source = sources.get(row.id)!;
    const report = precheck(deriveIr(parse(source)), source);
    const hits = hitsFor(row, report.findings);
    const expected = row.verified ? 'blocker' : 'warning';
    if (row.verified) {
      assert.ok(hits.length > 0, `${row.id} is verified and must be a precheck blocker`);
      for (const hit of hits) assert.equal(hit.severity, 'blocker', row.id);
    } else {
      for (const hit of hits) assert.equal(hit.severity, 'warning', `${row.id} is unverified`);
      assert.equal(hits.some((hit) => hit.severity === 'blocker'), false, row.id);
    }
    if (row.id === TABLE_NAME_LENGTH_UNVERIFIED || row.id === 'datastore.unique_text_columns') {
      assert.ok(hits.length > 0, row.id);
      assert.deepEqual(
        hits.map((hit) => hit.severity),
        hits.map(() => expected),
        row.id,
      );
    }
  }
  assert.equal(seen.size, CATALYST_LIMITS.length);
});
