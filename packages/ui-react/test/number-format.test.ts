/**
 * The React target carries `format = commadotwestern` onto the field spec and
 * groups that field in report cells. The stored value is unchanged.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { compileTemplateLib, reactAppSpec, templateRuntimeReady, TEMPLATE_DIR, TEMPLATE_MISSING } from '../src/index.js';
import type { AppSpec, ReportSpec } from '../template/lib/c2c-ui/types.js';

const SKIP = templateRuntimeReady() ? false : process.env.CI === 'true' ? false : TEMPLATE_MISSING;

const SOURCE = `application "Shop"
{
form Order
{
Amount
(
type = currency
format = commadotwestern
)
}
list Order_Report
{
show all rows from Order
(
Amount
)
}
}
`;

function shop(): { app: App; model: ReturnType<typeof buildUi>['model'] } {
  const app = deriveIr(parse(SOURCE));
  return { app, model: buildUi(app).model };
}

test('the React field spec copies commadotwestern from the generated field', () => {
  const { app, model } = shop();
  const spec = reactAppSpec(app, model);
  assert.equal(spec.forms.Order!.fields.find((field) => field.name === 'Amount')!.format, 'commadotwestern');
});

test('formattedNumber groups only a plain commadotwestern decimal', async () => {
  const source = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/number-format.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)) as {
    formattedNumber(value: unknown, format: string | undefined): string | undefined;
  };
  assert.equal(mod.formattedNumber('1234567.5', 'commadotwestern'), '1,234,567.5');
  assert.equal(mod.formattedNumber('-1000', 'commadotwestern'), '-1,000');
  assert.equal(mod.formattedNumber({ label: '1' }, 'commadotwestern'), undefined);
  assert.equal(mod.formattedNumber('1234', 'other'), undefined);
});

test('a React report cell groups a commadotwestern currency', { skip: SKIP }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-number-format-'));
  try {
    compileTemplateLib(out);
    const view = (await import(pathToFileURL(join(out, 'lib/c2c-ui/report/ReportView.js')).href)) as {
      reportFieldText(report: ReportSpec, spec: AppSpec, view: undefined, field: string, value: unknown): string;
    };
    const { app, model } = shop();
    const spec = reactAppSpec(app, model);
    const report = spec.reports.Order_Report!;
    assert.equal(view.reportFieldText(report, spec, undefined, 'Amount', '1234567.5'), '1,234,567.5');
    assert.equal(view.reportFieldText(report, spec, undefined, 'Amount', '12.3.4'), '12.3.4');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
