import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { parseFile } from '../../core/src/parse.js';
import type { App } from '../../core/src/ir.js';
import { generate as generateDeluge } from '../../deluge/src/generate.js';
import { buildUi } from '../../ui/src/index.js';
import {
  checkCatalystSelectors,
  deriveInstructionSuite,
  generateApiSuite,
  generateE2eFiles,
  generatePlaywrightConfig,
  generatePlaywrightSpec,
  isoDate,
} from '../src/e2e.js';

interface SampleAppGenerator {
  sampleItemForm(): string[];
  sampleItemReport(): string[];
  sampleWorkflow(): string[];
}

async function loadGenerator(): Promise<SampleAppGenerator> {
  const url = new URL('../../../fixtures/sample-app/sample-app.mjs', import.meta.url).href;
  return (await import(url)) as SampleAppGenerator;
}

function dsSource(gen: SampleAppGenerator): string {
  return [
    'application "sample-app"',
    '{',
    '\tforms',
    '\t{',
    ...gen.sampleItemForm(),
    '\t}',
    '\treports',
    '\t{',
    ...gen.sampleItemReport(),
    '\t}',
    ...gen.sampleWorkflow(),
    '}',
    '',
  ].join('\n');
}

function loadApp(source: string): App {
  const dir = mkdtempSync(join(tmpdir(), 'sample-ds-'));
  try {
    const file = join(dir, 'sample-app.ds');
    writeFileSync(file, source);
    return parseFile(file).ir;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function sampleApp(): Promise<App> {
  return loadApp(dsSource(await loadGenerator()));
}

function syntaxErrors(source: string, fileName: string): string[] {
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    fileName,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  return (out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

test('workflow emits one event handler per workflow block and no on success handler', async () => {
  const gen = await loadGenerator();
  const blocks = gen.sampleWorkflow().join('\n');
  const workflowBlocks = blocks.split(/\n\t\t\t[A-Za-z_]+ as "/).slice(1);
  assert.equal(workflowBlocks.length, 1, 'one workflow block');
  assert.equal((blocks.match(/record event = /g) ?? []).length, 1);
  assert.equal((blocks.match(/\bon validate\b/g) ?? []).length, 1, 'one on validate handler');
  assert.equal((blocks.match(/\bon success\b/g) ?? []).length, 0, 'no on success handler');
});

test('parsed app exposes the sample form, its fields and report', async () => {
  const app = await sampleApp();
  const form = app.forms.find((f) => f.name === 'Sample_Item');
  assert.ok(form, 'form present');
  assert.ok(form.fields.some((f) => f.name === 'Total_Amount'));
  assert.ok(app.reports.some((r) => r.name === 'All_Sample_Items'));
});

test('deriveInstructionSuite emits TC01-TC05 and rejects references to unknown fields', async () => {
  const app = await sampleApp();
  const suite = deriveInstructionSuite(app);
  assert.deepEqual(
    suite.cases.map((c) => c.name),
    [
      'TC01_Happy_Path_Submit',
      'TC02_Validation_Quantity_Zero',
      'TC03_Validation_Negative_Price',
      'TC04_Report_Edit_and_Status_Update',
      'TC05_Record_Delete',
    ],
  );
  const broken = structuredClone(app);
  broken.forms[0].fields = broken.forms[0].fields.filter((f) => f.name !== 'Quantity');
  assert.throws(() => deriveInstructionSuite(broken), /unknown field Sample_Item\.Quantity/);
});

test('creator spec uses label/role selectors and the Creator form route', async () => {
  const app = await sampleApp();
  const spec = generatePlaywrightSpec(app, 'creator');
  assert.match(spec, /getByLabel\("Item Name", \{ exact: true \}\)/);
  assert.match(spec, /page\.goto\("#Form:Sample_Item"\)/);
  assert.match(spec, /getByRole\('button', \{ name: "Submit", exact: true \}\)/);
  assert.match(spec, /TC05|TC05_Record_Delete/);
  assert.deepEqual(syntaxErrors(spec, 'regression-creator.spec.ts'), []);
});

test('catalyst spec targets Slate routes and omits Creator-only edit and delete cases', async () => {
  const app = await sampleApp();
  const spec = generatePlaywrightSpec(app, 'catalyst');
  assert.match(spec, /page\.goto\("\/#\/form\/Sample_Item"\)/);
  assert.match(spec, /page\.goto\("\/#\/report\/All_Sample_Items"\)/);
  assert.match(spec, /form\[data-form=\\"Sample_Item\\"\] \[name=\\"Quantity\\"\]/);
  assert.doesNotMatch(spec, /TC04_Report_Edit/);
  assert.doesNotMatch(spec, /TC05_Record_Delete/);
  assert.deepEqual(syntaxErrors(spec, 'regression-catalyst.spec.ts'), []);
});

test('quotes, backslashes and newlines in labels stay inside string literals', async () => {
  const app = await sampleApp();
  const tricky = structuredClone(app);
  const item = tricky.forms[0].fields.find((f) => f.name === 'Item_Name');
  assert.ok(item);
  item.displayName = `Bob's "Item" \\ back\nline`;
  const spec = generatePlaywrightSpec(tricky, 'creator');
  assert.match(spec, /getByLabel\("Bob's \\"Item\\" \\\\ back\\nline"/);
  assert.deepEqual(syntaxErrors(spec, 'regression-creator.spec.ts'), []);
  assert.deepEqual(syntaxErrors(generatePlaywrightConfig(), 'playwright.config.ts'), []);
});

test('api suite calls the migrated on-validate handler and asserts its actions', async () => {
  const app = await sampleApp();
  const suite = generateApiSuite(app);
  assert.match(suite, /import \{ clientActions \} from "\.\.\/\.\.\/client\/handlers\/sample-item\/on-validate\.mjs";/);
  assert.match(suite, /assert\.deepEqual\(result\.actions, \[\{"op":"alert","message":"Quantity must be greater than zero"\},\{"op":"cancelSubmit"\}\]\);/);
  assert.match(suite, /assert\.equal\(result\.input\["Total_Amount"\], "255\.0"\);/);
});

test('generated api tests execute against the generated handler and pass', async () => {
  const app = await sampleApp();
  const root = mkdtempSync(join(tmpdir(), 'sample-run-'));
  try {
    const handler = generateDeluge(app).files.find((f) => /client\/handlers\/.*on-validate\.mjs$/.test(f.path));
    assert.ok(handler, 'on-validate handler generated');
    const files = [
      { path: handler.path, data: handler.source },
      ...generateE2eFiles(app).filter((f) => f.path.endsWith('.mjs')),
    ];
    for (const file of files) {
      const abs = join(root, file.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.data);
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--max-old-space-size=2048', '--test-timeout=120000', '--test', join(root, 'tests/api/regression-handlers.test.mjs')], { encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /# pass 3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('catalyst selectors match the elements the built Slate runtime renders', async () => {
  const app = await sampleApp();
  const built = buildUi(app).files;
  assert.deepEqual(await checkCatalystSelectors(app, built), []);
  const runtimeOnly = built.filter((f) => !/runtime\..*\.js$/.test(f.path) && f.path !== 'slate/index.html');
  assert.ok((await checkCatalystSelectors(app, runtimeOnly)).length > 0, 'a bundle without the runtime must fail the check');
});

test('checkCatalystSelectors fails when a checkbox group renders as a radio or a multi-select', async () => {
  const app = await sampleApp();
  const radio = structuredClone(app);
  radio.forms[0].fields.find((f) => f.name === 'Is_Urgent')!.type = 'radio';
  const radioErrors = await checkCatalystSelectors(radio, buildUi(radio).files);
  assert.ok(
    radioErrors.some((e) => /Is_Urgent/.test(e) && /matches 0 elements/.test(e)),
    radioErrors.join('\n'),
  );
  const multi = structuredClone(app);
  multi.forms[0].fields.find((f) => f.name === 'Is_Urgent')!.type = 'multi-select';
  const multiErrors = await checkCatalystSelectors(multi, buildUi(multi).files);
  assert.ok(multiErrors.some((e) => /Is_Urgent/.test(e)), multiErrors.join('\n'));
});

test('checkCatalystSelectors fails when a picklist renders as a checkbox group', async () => {
  const app = await sampleApp();
  const broken = structuredClone(app);
  broken.forms[0].fields.find((f) => f.name === 'Priority')!.type = 'checkboxes';
  const errors = await checkCatalystSelectors(broken, buildUi(broken).files);
  assert.ok(errors.some((e) => /Priority/.test(e)), errors.join('\n'));
});

test('Creator spec pins the live Creator facts: select2 picklists, checkbox inputs, Handsontable rows, hover actions', async () => {
  const app = await sampleApp();
  const spec = generatePlaywrightSpec(app, 'creator');
  assert.doesNotMatch(spec, /selectOption/, 'Creator picklists are select2, not <select>');
  assert.match(spec, /\[zc-field-container="\$\{link\}"\] \.select2-choice/);
  assert.match(spec, /\.select2-drop-active \.select2-result-label/);
  assert.match(spec, /await pick\(page, "Priority", "High"\);/);
  assert.match(spec, /await pick\(page, "Status", "Approved"\);/);
  assert.ok(
    spec.includes('page.locator("input[name=\\"Is_Urgent\\"][value=\\"Yes\\"]").check({ force: true });'),
    'checkbox ticked by name and value, forced',
  );
  assert.match(spec, /getByRole\('row'\)\.filter\(\{ hasText: "Widget Alpha" \}\)/);
  assert.match(spec, /a\.zc-edit-record-icon/);
  assert.match(spec, /\[elname="\$\{el\}"\]:visible/);
  assert.ok(spec.includes('rowAction(page, "Widget Alpha", "zc-showEditFormEl");'));
  assert.ok(spec.includes('rowAction(page, "Widget Alpha", "zc-deleteRecordEl");'));
  assert.match(spec, /getByRole\('button', \{ name: \/\^\\s\*\(Delete\|Yes\|OK\)\\s\*\$\/ \}\)/, 'delete needs a confirm button');
  assert.ok(spec.includes('page.goto("#View:All_Sample_Items");'));
  assert.ok(spec.includes('page.goto("#Form:Sample_Item");'));
  assert.ok(spec.includes('.fill("06-Oct-2026");'), 'Creator date takes typed dd-MMM-yyyy');
  assert.doesNotMatch(spec, /getByRole\('checkbox'\)/);
  assert.deepEqual(syntaxErrors(spec, 'regression-creator.spec.ts'), []);
});

test('catalyst spec emits runtime-native selectors: checkbox inputs, ISO dates, plain selects', async () => {
  const app = await sampleApp();
  const spec = generatePlaywrightSpec(app, 'catalyst');
  assert.ok(spec.includes('form[data-form=\\"Sample_Item\\"] input[type=\\"checkbox\\"][name=\\"Is_Urgent\\"][value=\\"Yes\\"]'));
  assert.ok(spec.includes('.fill("2026-10-06");'), 'Slate date input takes yyyy-mm-dd');
  assert.doesNotMatch(spec, /06-Oct-2026/);
  assert.doesNotMatch(spec, /zc-field-container|select2/, 'no Creator selectors in the Slate spec');
});

test('the form success message and checkbox group reach the Slate model', async () => {
  const app = await sampleApp();
  const { model } = buildUi(app);
  const form = model.forms.find((f) => f.name === 'Sample_Item');
  assert.equal(form?.successMessage, 'Test Item Added Successfully!');
  const urgent = form?.fields.find((f) => f.name === 'Is_Urgent');
  assert.equal(urgent?.matrixId, 'checkbox-multi');
  assert.deepEqual(urgent?.choices, ['Yes']);
});

test('isoDate converts Creator dd-MMM-yyyy to yyyy-mm-dd and leaves other text alone', () => {
  assert.equal(isoDate('06-Oct-2026'), '2026-10-06');
  assert.equal(isoDate('1-jan-2027'), '2027-01-01');
  assert.equal(isoDate('2026-10-06'), '2026-10-06');
  assert.equal(isoDate('not a date'), 'not a date');
});

test('generateE2eFiles emits the Playwright config, both specs and the api test', async () => {
  const app = await sampleApp();
  const paths = generateE2eFiles(app).map((f) => f.path);
  assert.deepEqual(paths, [
    'tests/e2e/regression-cases.json',
    'tests/e2e/playwright.config.ts',
    'tests/e2e/regression-creator.spec.ts',
    'tests/e2e/regression-catalyst.spec.ts',
    'tests/api/regression-handlers.test.mjs',
  ]);
});
