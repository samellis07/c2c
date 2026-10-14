/**
 * Generated regression suite for the sample feature app (Creator app and migrated Slate app).
 *
 * The suite is built from the parsed app IR. TC01-TC05 are fixed instruction
 * cases; every field, form and report they reference must exist in
 * the IR, otherwise generation throws.
 *
 * Targets:
 *   creator   Playwright spec against a Zoho Creator app URL. Selectors are
 *             accessible labels and roles (getByLabel / getByRole), not DOM ids.
 *   catalyst  Playwright spec against the built Slate app served on loopback.
 *             Selectors are the attributes the Slate runtime renders
 *             (packages/ui/src/client-runtime.js); checkCatalystSelectors()
 *             verifies them against the built bundle.
 *
 * API tests call the migrated on-validate client handler in-process and assert
 * the actions it returns. They do not hit the network.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../../core/src/ir.js';
import { toolchainBannerLines } from '../../core/src/toolchain.js';
import { generate as generateDeluge } from '../../deluge/src/generate.js';
import { generateUi } from '../../ui/src/index.js';

export type E2eTarget = 'creator' | 'catalyst';

export type E2eStep =
  | { op: 'open_form'; form: string }
  | { op: 'open_report'; report: string }
  | { op: 'fill'; form: string; field: string; value: string }
  | { op: 'select'; form: string; field: string; value: string }
  | { op: 'check'; form: string; field: string }
  | { op: 'click'; button: string }
  | { op: 'expect_text'; text: string }
  | { op: 'expect_url_contains'; fragment: string }
  | { op: 'expect_row'; report: string; match: string; cells: Record<string, string> }
  | { op: 'expect_no_row'; report: string; match: string }
  | { op: 'edit_row'; report: string; match: string }
  | { op: 'delete_row'; report: string; match: string };

export interface E2eInstructionCase {
  id: string;
  name: string;
  targets: E2eTarget[];
  steps: E2eStep[];
}

export interface GeneratedFile {
  path: string;
  data: string;
}

export interface E2eOptions {
  creatorUrl?: string;
  catalystBaseUrl?: string;
}

/**
 * Placeholder Creator app URL baked into a generated config when the caller
 * passes no `creatorUrl`. A real run sets `CREATOR_APP_URL` (read by the
 * generated config at test time) or passes `creatorUrl` explicitly.
 */
export const CREATOR_APP_URL = 'https://creatorapp.zoho.com/<owner>/<app-link>/';
export const CATALYST_BASE_URL = 'http://127.0.0.1:4173';

const FORM = 'Sample_Item';
const REPORT = 'All_Sample_Items';

export const E2E_INSTRUCTION_CASES: E2eInstructionCase[] = [
  {
    id: 'TC01',
    name: 'TC01_Happy_Path_Submit',
    targets: ['creator', 'catalyst'],
    steps: [
      { op: 'open_form', form: FORM },
      { op: 'fill', form: FORM, field: 'Item_Name', value: 'Widget Alpha' },
      { op: 'fill', form: FORM, field: 'Customer_Email', value: 'alpha.buyer@example.com' },
      { op: 'fill', form: FORM, field: 'Quantity', value: '10' },
      { op: 'fill', form: FORM, field: 'Unit_Price', value: '25.50' },
      { op: 'select', form: FORM, field: 'Priority', value: 'High' },
      { op: 'check', form: FORM, field: 'Is_Urgent' },
      { op: 'fill', form: FORM, field: 'Order_Date', value: '06-Oct-2026' },
      { op: 'fill', form: FORM, field: 'Notes', value: 'Synthetic test item for regression suite' },
      { op: 'click', button: 'Submit' },
      { op: 'expect_text', text: 'Test Item Added Successfully!' },
      { op: 'open_report', report: REPORT },
      {
        op: 'expect_row',
        report: REPORT,
        match: 'Widget Alpha',
        cells: { Status: 'Submitted', 'Total Amount': '255.00' },
      },
    ],
  },
  {
    id: 'TC02',
    name: 'TC02_Validation_Quantity_Zero',
    targets: ['creator', 'catalyst'],
    steps: [
      { op: 'open_form', form: FORM },
      { op: 'fill', form: FORM, field: 'Item_Name', value: 'Zero Qty Item' },
      { op: 'fill', form: FORM, field: 'Quantity', value: '0' },
      { op: 'fill', form: FORM, field: 'Unit_Price', value: '15.00' },
      { op: 'click', button: 'Submit' },
      { op: 'expect_text', text: 'Quantity must be greater than zero' },
      { op: 'expect_url_contains', fragment: FORM },
      { op: 'open_report', report: REPORT },
      { op: 'expect_no_row', report: REPORT, match: 'Zero Qty Item' },
    ],
  },
  {
    id: 'TC03',
    name: 'TC03_Validation_Negative_Price',
    targets: ['creator', 'catalyst'],
    steps: [
      { op: 'open_form', form: FORM },
      { op: 'fill', form: FORM, field: 'Item_Name', value: 'Negative Price Item' },
      { op: 'fill', form: FORM, field: 'Quantity', value: '5' },
      { op: 'fill', form: FORM, field: 'Unit_Price', value: '-10.00' },
      { op: 'click', button: 'Submit' },
      { op: 'expect_text', text: 'Unit price cannot be negative' },
      { op: 'expect_url_contains', fragment: FORM },
    ],
  },
  {
    id: 'TC04',
    name: 'TC04_Report_Edit_and_Status_Update',
    targets: ['creator'],
    steps: [
      { op: 'open_report', report: REPORT },
      { op: 'edit_row', report: REPORT, match: 'Widget Alpha' },
      { op: 'select', form: FORM, field: 'Status', value: 'Approved' },
      { op: 'click', button: 'Update' },
      { op: 'open_report', report: REPORT },
      { op: 'expect_row', report: REPORT, match: 'Widget Alpha', cells: { Status: 'Approved' } },
    ],
  },
  {
    id: 'TC05',
    name: 'TC05_Record_Delete',
    targets: ['creator'],
    steps: [
      { op: 'open_report', report: REPORT },
      { op: 'delete_row', report: REPORT, match: 'Widget Alpha' },
      { op: 'click', button: 'Delete' },
      { op: 'expect_no_row', report: REPORT, match: 'Widget Alpha' },
    ],
  },
];

/** Emit `value` as a string literal that survives quotes, backslashes and newlines. */
function str(value: string): string {
  return JSON.stringify(value);
}

/** Keep `text` safe inside a `//` comment. */
function comment(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

interface IrField {
  name: string;
  displayName?: string;
  type?: string;
  choices?: string[];
}

interface IrForm {
  name: string;
  fields: IrField[];
}

function irForms(app: App): IrForm[] {
  return app.forms.map((form) => ({
    name: form.name,
    fields: form.fields.map((field) => ({
      name: field.name,
      displayName: field.displayName,
      type: field.type,
      choices: field.choices,
    })),
  }));
}

function irField(app: App, form: string, field: string): IrField {
  const found = irForms(app)
    .find((f) => f.name === form)
    ?.fields.find((f) => f.name === field);
  if (!found) throw new Error(`Regression case references unknown field ${form}.${field}`);
  return found;
}

function labelFor(app: App, form: string, field: string): string {
  const found = irField(app, form, field);
  return found.displayName || found.name;
}

/** The option a checkbox step ticks: the first choice the app defines for the field. */
function checkboxValue(app: App, form: string, field: string): string {
  const choice = irField(app, form, field).choices?.[0];
  if (choice === undefined) throw new Error(`Regression case checks ${form}.${field}, which has no choices`);
  return choice;
}

/** Creator date fields take dd-MMM-yyyy typed in; the Slate date input takes yyyy-mm-dd. */
export function isoDate(value: string): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim());
  if (!m) return value;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[2].toLowerCase());
  if (month < 0) return value;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * Builds the regression suite from the app IR. Throws when a case references a
 * form, report or field the app does not define.
 */
export function deriveInstructionSuite(app: App): { name: string; app: string; cases: E2eInstructionCase[] } {
  const forms = irForms(app);
  const reports = new Set(app.reports.map((r) => r.name));
  for (const tc of E2E_INSTRUCTION_CASES) {
    for (const step of tc.steps) {
      if ('form' in step) {
        const f = forms.find((x) => x.name === step.form);
        if (!f) throw new Error(`${tc.id} references unknown form ${step.form}`);
        if ('field' in step && !f.fields.some((x) => x.name === step.field)) {
          throw new Error(`${tc.id} references unknown field ${step.form}.${step.field}`);
        }
      }
      if ('report' in step && !reports.has(step.report)) {
        throw new Error(`${tc.id} references unknown report ${step.report}`);
      }
    }
  }
  return { name: `${app.name ?? 'unnamed'} regression suite`, app: app.name ?? 'unnamed', cases: E2E_INSTRUCTION_CASES };
}

/**
 * Creator helpers, emitted once per creator spec. In the Creator UI,
 * picklists are select2 widgets with no <select>,
 * report rows are Handsontable rows, and record actions sit behind a hover icon.
 */
export const CREATOR_HELPERS = [
  'async function rowAction(page, text, el) {',
  "  const row = page.getByRole('row').filter({ hasText: text });",
  '  await row.hover();',
  '  await page.waitForTimeout(500);',
  "  await row.locator('a.zc-edit-record-icon').first().click({ force: true });",
  '  await page.waitForTimeout(800);',
  '  await page.locator(`[elname="${el}"]:visible`).first().click();',
  '  await page.waitForTimeout(2500);',
  '}',
  'async function pick(page, link, val) {',
  '  await page.locator(`[zc-field-container="${link}"] .select2-choice`).click();',
  '  await page.waitForTimeout(600);',
  "  await page.locator('.select2-drop-active .select2-result-label').filter({ hasText: new RegExp('^\\\\s*' + val + '\\\\s*$') }).first().click();",
  '  await page.waitForTimeout(300);',
  '}',
];

function creatorStep(app: App, step: E2eStep): string[] {
  switch (step.op) {
    case 'open_form':
      return [`await page.goto(${str(`#Form:${step.form}`)});`];
    case 'open_report':
      return [`await page.goto(${str(`#View:${step.report}`)});`];
    case 'fill':
      return [`await page.getByLabel(${str(labelFor(app, step.form, step.field))}, { exact: true }).fill(${str(step.value)});`];
    case 'select':
      return [`await pick(page, ${str(step.field)}, ${str(step.value)});`];
    case 'check':
      return [
        `await page.locator(${str(`input[name="${step.field}"][value="${checkboxValue(app, step.form, step.field)}"]`)}).check({ force: true });`,
      ];
    case 'click':
      if (step.button === 'Delete') {
        return [
          `await page.getByRole('button', { name: /^\\s*(Delete|Yes|OK)\\s*$/ }).last().click();`,
          'await page.waitForTimeout(3000);',
        ];
      }
      return [`await page.getByRole('button', { name: ${str(step.button)}, exact: true }).click();`];
    case 'expect_text':
      return [`await expect(page.getByText(${str(step.text)}).first()).toBeVisible();`];
    case 'expect_url_contains':
      return [`await expect(page).toHaveURL(new RegExp(${str(escapeRegExp(step.fragment))}));`];
    case 'expect_row': {
      const lines = [`const row = page.getByRole('row').filter({ hasText: ${str(step.match)} });`, 'await expect(row).toHaveCount(1);'];
      for (const [column, text] of Object.entries(step.cells)) {
        lines.push(`await expect(row).toContainText(${str(text)});`);
        lines.push(`// column ${comment(column)}`);
      }
      return lines;
    }
    case 'expect_no_row':
      return [`await expect(page.getByRole('row').filter({ hasText: ${str(step.match)} })).toHaveCount(0);`];
    case 'edit_row':
      return [`await rowAction(page, ${str(step.match)}, ${str('zc-showEditFormEl')});`];
    case 'delete_row':
      return [`await rowAction(page, ${str(step.match)}, ${str('zc-deleteRecordEl')});`];
  }
}

function catalystStep(app: App, step: E2eStep): string[] {
  switch (step.op) {
    case 'open_form':
      return [`await page.goto(${str(`/#/form/${step.form}`)});`];
    case 'open_report':
      return [`await page.goto(${str(`/#/report/${step.report}`)});`];
    case 'fill': {
      const isDate = irField(app, step.form, step.field).type === 'date';
      const value = isDate ? isoDate(step.value) : step.value;
      return [`await page.locator(${str(catalystFieldSelector(step))}).fill(${str(value)});`];
    }
    case 'select':
      return [`await page.locator(${str(catalystFieldSelector(step))}).selectOption(${str(step.value)});`];
    case 'check':
      return [`await page.locator(${str(catalystCheckSelector(app, step))}).check();`];
    case 'click':
      return [`await page.locator('form button[type="submit"]').click();`, `// button ${comment(step.button)}`];
    case 'expect_text':
      return [`await expect(page.locator('[data-banner]').first()).toContainText(${str(step.text)});`];
    case 'expect_url_contains':
      return [`await expect(page).toHaveURL(new RegExp(${str(escapeRegExp(`/form/${step.fragment}`))}));`];
    case 'expect_row': {
      const lines = [`const row = page.locator(${str(catalystRowSelector(step.report))}).filter({ hasText: ${str(step.match)} });`, 'await expect(row).toHaveCount(1);'];
      for (const text of Object.values(step.cells)) lines.push(`await expect(row).toContainText(${str(text)});`);
      return lines;
    }
    case 'expect_no_row':
      return [`await expect(page.locator(${str(catalystRowSelector(step.report))}).filter({ hasText: ${str(step.match)} })).toHaveCount(0);`];
    case 'edit_row':
    case 'delete_row':
      return [`// unsupported on the Slate target: ${step.op}`];
  }
}

function catalystFieldSelector(step: Extract<E2eStep, { field: string }>): string {
  return `form[data-form="${step.form}"] [name="${step.field}"]`;
}

function catalystCheckSelector(app: App, step: Extract<E2eStep, { op: 'check' }>): string {
  return `form[data-form="${step.form}"] input[type="checkbox"][name="${step.field}"][value="${checkboxValue(app, step.form, step.field)}"]`;
}

function catalystRowSelector(report: string): string {
  return `section[data-report="${report}"] [data-rows] tbody tr`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

function applies(tc: E2eInstructionCase, target: E2eTarget): boolean {
  return tc.targets.includes(target);
}

/** Emits the Playwright spec for one target. Strings go through JSON.stringify. */
export function generatePlaywrightSpec(app: App, target: E2eTarget): string {
  const suite = deriveInstructionSuite(app);
  const lines: string[] = [
    ...toolchainBannerLines().map((l) => `// ${l}`),
    "import { test, expect } from '@playwright/test';",
    '',
    ...(target === 'creator' ? CREATOR_HELPERS : []),
    '',
    `test.describe(${str(`${suite.name} (${target})`)}, () => {`,
  ];
  for (const tc of suite.cases) {
    if (!applies(tc, target)) continue;
    lines.push(`  test(${str(tc.name)}, async ({ page }) => {`);
    for (const step of tc.steps) {
      const emitted = target === 'creator' ? creatorStep(app, step) : catalystStep(app, step);
      for (const line of emitted) lines.push(`    ${line}`);
    }
    lines.push('  });');
    lines.push('');
  }
  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

/** Emits the Playwright runner config with one project per target. */
export function generatePlaywrightConfig(options: E2eOptions = {}): string {
  const creatorUrl = options.creatorUrl ?? CREATOR_APP_URL;
  const catalystBaseUrl = options.catalystBaseUrl ?? CATALYST_BASE_URL;
  return [
    ...toolchainBannerLines().map((l) => `// ${l}`),
    "import { defineConfig, devices } from '@playwright/test';",
    '',
    'export default defineConfig({',
    "  testDir: '.',",
    '  timeout: 60000,',
    '  retries: process.env.CI ? 1 : 0,',
    "  reporter: [['list'], ['html', { open: 'never' }]],",
    '  projects: [',
    '    {',
    "      name: 'creator',",
    `      testMatch: 'regression-creator.spec.ts',`,
    `      use: { ...devices['Desktop Chrome'], baseURL: process.env.CREATOR_APP_URL ?? ${str(creatorUrl)}, storageState: process.env.CREATOR_STORAGE_STATE },`,
    '    },',
    '    {',
    "      name: 'catalyst',",
    "      testMatch: 'regression-catalyst.spec.ts',",
    `      use: { ...devices['Desktop Chrome'], baseURL: process.env.CATALYST_BASE_URL ?? ${str(catalystBaseUrl)}, storageState: process.env.CATALYST_STORAGE_STATE },`,
    '    },',
    '  ],',
    '});',
    '',
  ].join('\n');
}

/**
 * API tests for the migrated on-validate handler. The handler module is imported
 * in-process; its returned actions are asserted exactly. Shim input is plain
 * numbers, as Creator passes numeric fields.
 */
/** Browser exact-decimal source, inlined so a temp-dir suite does not import the repo. */
function clientDecimalSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../ui/src/client-runtime.js'),
    join(here, '../../../packages/ui/src/client-runtime.js'),
  ];
  let src = '';
  for (const path of candidates) {
    try {
      src = readFileSync(path, 'utf8');
      break;
    } catch {
      /* next candidate */
    }
  }
  const marker = 'export function clientDecimal(';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('clientDecimal missing from client runtime');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return 'function clientDecimal(' + src.slice(start + marker.length, i + 1);
    }
  }
  throw new Error('clientDecimal unterminated');
}

export function generateApiSuite(app: App): string {
  const deluge = generateDeluge(app);
  const onValidate = deluge.files.find((f) => f.path.startsWith('client/handlers/') && /on-validate\.mjs$/.test(f.path));
  if (!onValidate) throw new Error('app has no on validate handler to test');
  const handlerImport = `../../${onValidate.path}`;
  const lines = [
    ...toolchainBannerLines().map((l) => `// ${l}`),
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    `import { clientActions } from ${str(handlerImport)};`,
    '',
    clientDecimalSource(),
    '',
    'const shim = {',
    '  decimal: clientDecimal(),',
    '  input: {',
    '    get: (ctx, name) => ctx.input[name],',
    '    set: (ctx, names, value) => {',
    '      ctx.input[names[0]] = value;',
    '    },',
    '  },',
    '};',
    '',
    'async function run(input) {',
    '  const ctx = { shim, input: { ...input } };',
    '  const actions = await clientActions(ctx);',
    '  return { actions, input: ctx.input };',
    '}',
    '',
  ];
  const cases: { id: string; input: Record<string, unknown>; expectInput?: Record<string, unknown>; actions: unknown[] }[] = [
    {
      id: 'TC01',
      input: { Item_Name: 'Widget Alpha', Quantity: 10, Unit_Price: 25.5 },
      expectInput: { Total_Amount: '255.0', Status: 'Submitted' },
      actions: [],
    },
    {
      id: 'TC02',
      input: { Item_Name: 'Zero Qty Item', Quantity: 0, Unit_Price: 15 },
      actions: [
        { op: 'alert', message: 'Quantity must be greater than zero' },
        { op: 'cancelSubmit' },
      ],
    },
    {
      id: 'TC03',
      input: { Item_Name: 'Negative Price Item', Quantity: 5, Unit_Price: -10 },
      actions: [
        { op: 'alert', message: 'Unit price cannot be negative' },
        { op: 'cancelSubmit' },
      ],
    },
  ];
  for (const tc of cases) {
    lines.push(`test(${str(`${tc.id} on-validate returns the expected actions`)}, async () => {`);
    lines.push(`  const result = await run(${JSON.stringify(tc.input)});`);
    lines.push(`  assert.deepEqual(result.actions, ${JSON.stringify(tc.actions)});`);
    if (tc.expectInput) {
      for (const [key, value] of Object.entries(tc.expectInput)) {
        lines.push(`  assert.equal(result.input[${str(key)}], ${JSON.stringify(value)});`);
      }
    }
    lines.push('});');
    lines.push('');
  }
  return lines.join('\n');
}

interface RenderedElement {
  tagName: string;
  multiple?: boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

interface DomDocument {
  body: { innerHTML: string };
  querySelector(selector: string): unknown;
  querySelectorAll(selector: string): unknown;
}

interface RuntimeExports {
  renderForm(form: unknown): string;
  renderReport(report: unknown): string;
}

function dataModuleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

const TEXT_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'date', 'datetime-local', 'time', 'password', 'search']);

/**
 * Checks every catalyst-target selector against the Slate output. Attribute
 * names must appear in the built runtime, and each form and report must appear
 * in the model. Then the built runtime is run in jsdom and each selector is
 * matched against the markup it renders for that field: a text field must be a
 * text-like input or textarea, a picklist a single select, and a checkbox step a
 * checkbox input with the choice's value. A checkbox rendered as a radio or a
 * checkbox group rendered as a multi-select fails here. Returns the mismatches.
 */
export async function checkCatalystSelectors(app: App, built: { path: string; data: string | Buffer }[]): Promise<string[]> {
  const text = (p: (s: string) => boolean): string =>
    built.filter((f) => p(f.path)).map((f) => String(f.data)).join('\n');
  const runtime = text((p) => /assets\/runtime\..*\.js$/.test(p) || p === 'slate/index.html');
  const model = text((p) => /assets\/model\..*\.js$/.test(p));
  const runtimeFile = built.find((f) => /assets\/runtime\..*\.js$/.test(f.path));
  const missing: string[] = [];
  const attrs = new Set<string>();
  const names = new Set<string>();
  const cases = E2E_INSTRUCTION_CASES.filter((tc) => tc.targets.includes('catalyst'));
  for (const tc of cases) {
    for (const step of tc.steps) {
      const selectors = catalystStep(app, step).join(' ');
      for (const m of selectors.matchAll(/\[(data-[a-z-]+|name|type)[=\]]/g)) attrs.add(m[1]);
      for (const m of selectors.matchAll(/\[(?:data-form|data-report|name)="([^"]+)"\]/g)) names.add(m[1]);
    }
  }
  for (const attr of attrs) {
    if (!runtime.includes(attr)) missing.push(`attribute ${attr} not in built runtime`);
  }
  for (const name of names) {
    if (!model.includes(name)) missing.push(`name ${name} not in built model`);
  }
  if (!runtimeFile) return [...missing, 'runtime bundle not in built output'];

  const ui = generateUi(app);
  const modelFile = built.find((f) => /assets\/model\..*\.js$/.test(f.path));
  if (!modelFile) return [...missing, 'model bundle not in built output'];
  const modelUrl = dataModuleUrl(String(modelFile.data));
  const runtimeSource = String(runtimeFile.data).replace(/from\s+"\.\/model\.[0-9a-f]+\.js"/, `from "${modelUrl}"`);
  const runtimeModule = (await import(dataModuleUrl(runtimeSource))) as RuntimeExports;
  const jsdomSpecifier = 'jsdom';
  const { JSDOM } = (await import(jsdomSpecifier)) as { JSDOM: new (html: string) => { window: { document: DomDocument } } };
  const document = new JSDOM('<!doctype html><body></body>').window.document;
  const within = (html: string): void => {
    document.body.innerHTML = html;
  };
  const found = (css: string): RenderedElement[] => Array.from(document.querySelectorAll(css) as unknown as ArrayLike<RenderedElement>);

  for (const tc of cases) {
    for (const step of tc.steps) {
      if (!('form' in step) && !('report' in step)) continue;
      if ('form' in step) {
        const form = ui.model.forms.find((f) => f.name === step.form);
        if (!form) {
          missing.push(`${tc.id} ${step.op} references form ${step.form}, which the model does not have`);
          continue;
        }
        within(runtimeModule.renderForm(form));
        if (!document.querySelector('form[data-form] [data-banner]')) missing.push(`${tc.id} form ${step.form} has no [data-banner]`);
      }
      if ('report' in step) {
        const report = ui.model.reports.find((r) => r.name === step.report);
        if (!report) {
          missing.push(`${tc.id} ${step.op} references report ${step.report}, which the model does not have`);
          continue;
        }
        within(runtimeModule.renderReport(report));
        const rows = found(`section[data-report="${report.name}"] [data-rows] tbody`);
        if (rows.length !== 1) missing.push(`${tc.id} report ${report.name} has no [data-rows] tbody`);
        if (!('form' in step)) continue;
      }
      if (step.op === 'fill' || step.op === 'select' || step.op === 'check') {
        const css = step.op === 'check' ? catalystCheckSelector(app, step) : catalystFieldSelector(step);
        const matches = found(css);
        const where = `${tc.id} ${step.op} ${css}`;
        if (matches.length !== 1) {
          missing.push(`${where} matches ${matches.length} elements, expected 1`);
          continue;
        }
        const el = matches[0];
        const type = (el.getAttribute('type') ?? '').toLowerCase();
        if (step.op === 'fill') {
          const isText = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(type));
          if (!isText) missing.push(`${where} is ${el.tagName.toLowerCase()}[type=${type || 'none'}], not a text field`);
        } else if (step.op === 'select') {
          if (el.tagName !== 'SELECT' || el.multiple || el.hasAttribute('multiple')) {
            missing.push(`${where} is not a single select (${el.tagName.toLowerCase()})`);
          }
        } else {
          if (el.tagName !== 'INPUT' || type !== 'checkbox') missing.push(`${where} is ${el.tagName.toLowerCase()}[type=${type || 'none'}], not a checkbox`);
        }
      }
    }
  }
  return missing;
}

/** Emits the suite files. The API test is emitted as .mjs so it runs without a TS loader. */
export function generateE2eFiles(app: App, options: E2eOptions = {}): GeneratedFile[] {
  const suite = deriveInstructionSuite(app);
  return [
    { path: 'tests/e2e/regression-cases.json', data: `${JSON.stringify(suite, null, 2)}\n` },
    { path: 'tests/e2e/playwright.config.ts', data: generatePlaywrightConfig(options) },
    { path: 'tests/e2e/regression-creator.spec.ts', data: generatePlaywrightSpec(app, 'creator') },
    { path: 'tests/e2e/regression-catalyst.spec.ts', data: generatePlaywrightSpec(app, 'catalyst') },
    { path: 'tests/api/regression-handlers.test.mjs', data: generateApiSuite(app) },
  ];
}
