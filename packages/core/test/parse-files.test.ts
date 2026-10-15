import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LockedExportError,
  NotFileError,
  addCoverage,
  emptyApp,
  emptyCoverage,
  isStatement,
  listDsFiles,
  listWidgetSidecars,
  mergeCoverage,
  mergeIr,
  parse,
  parseBytes,
  parseFile,
  parseFileOrProjectWithSidecars,
  parseProject,
  parseZml,
  roundTrips,
  runCorpus,
  statementLabel,
  widgetCommandStatus,
  widgetManualItems,
  type App,
  type Statement,
} from '../src/index.js';
import { UnknownDcError, dcEndpoints, normalizeDc, zohoConnectionHostModuleSource, zohoConnectionHosts, zohoDcSpellings } from '../src/dc.js';

const APP = 'application "Demo"\n{\n}\n';
const LOCKED = '<!DOCTYPE html>\n<html><head><title>Access denied</title></head><body>Access denied</body></html>\n';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-core-parse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a byte that is not UTF-8 decodes as latin1 and the file prints back to the same bytes', () => {
  const bytes = Buffer.concat([Buffer.from('application "Caf'), Buffer.from([0xe9]), Buffer.from('"\n{\n}\n')]);
  const file = parseBytes('latin1.ds', bytes);
  assert.equal(file.encoding, 'latin1');
  assert.equal(file.ir.name, 'Café');
  assert.equal(roundTrips(file, bytes), true);
  // One changed byte is a round-trip miss, never a silent pass.
  const changed = Buffer.from(bytes);
  changed[changed.length - 2] = 0x5d;
  assert.equal(roundTrips(file, changed), false);
});

test('parseFile and parseFileOrProjectWithSidecars refuse a FIFO without blocking on it', (t) => {
  const dir = tempDir(t);
  const fifo = join(dir, 'pipe.ds');
  execFileSync('mkfifo', [fifo]);
  assert.throws(() => parseFile(fifo), (err: unknown) => err instanceof NotFileError && err.message === `${fifo} is not a file`);
  assert.throws(() => parseFileOrProjectWithSidecars(fifo), NotFileError);
});

test('parseFile refuses a directory', (t) => {
  const dir = tempDir(t);
  assert.throws(() => parseFile(dir), NotFileError);
});

test('runCorpus lets a locked Marketplace export through as a refusal instead of counting a round-trip miss', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'a.ds'), APP);
  writeFileSync(join(dir, 'b.ds'), LOCKED);
  assert.throws(() => runCorpus(dir), LockedExportError);
  assert.throws(() => parseBytes('b.ds', Buffer.from(LOCKED)), LockedExportError);
  // The same words inside a real export are Deluge text, not a lock page.
  const real = `application "Demo"\n{\n\t// <!DOCTYPE html> Access denied text/html\n}\n`;
  assert.equal(parseBytes('c.ds', Buffer.from(real)).ir.name, 'Demo');
});

test('listDsFiles skips node_modules, .git and exported copies, matches .DS in any case, and sorts', (t) => {
  const dir = tempDir(t);
  for (const sub of ['node_modules', '.git', 'b', 'a']) mkdirSync(join(dir, sub));
  for (const rel of ['node_modules/x.ds', '.git/x.ds', 'b/two.DS', 'a/one.ds', 'a/one.exported.ds', 'a/notes.txt']) writeFileSync(join(dir, rel), APP);
  assert.deepEqual(
    listDsFiles(dir).map((p) => p.slice(dir.length + 1)),
    ['a/one.ds', 'b/two.DS'],
  );
});

test('listDsFiles and parseProject do not follow symlinks: a loop does not crash and an outside file is not read', (t) => {
  const root = tempDir(t);
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(project, 'app.ds'), APP);
  writeFileSync(join(outside, 'secret.ds'), 'application "Secret"\n{\n}\n');
  symlinkSync(outside, join(project, 'linked-dir'), 'dir');
  symlinkSync(join(outside, 'secret.ds'), join(project, 'linked.ds'));
  symlinkSync('.', join(project, 'loop'), 'dir');
  assert.deepEqual(listDsFiles(project), [join(project, 'app.ds')]);
  const { files, ir } = parseProject(project);
  assert.deepEqual(files.map((f) => f.ir.name), ['Demo']);
  assert.deepEqual(ir.files, ['app.ds']);
  assert.equal(ir.widgets, undefined);
});

test('widget sidecars: manifest names are read from BOM, nested and valid json; bad, oversized or dot entries add none', (t) => {
  const dir = tempDir(t);
  const widgets = join(dir, 'sidecars', 'widgets');
  const pkg = (name: string) => {
    mkdirSync(join(widgets, name), { recursive: true });
    return join(widgets, name);
  };
  const full = pkg('chart');
  writeFileSync(join(full, 'index.HTML'), '<html></html>');
  mkdirSync(join(full, 'conf'));
  writeFileSync(join(full, 'conf', 'plugin-manifest.json'), '﻿' + JSON.stringify({ modules: { widgets: [{ name: ' Sales Chart ' }, { name: '' }, null, { name: 7 }] } }));
  const bad = pkg('broken');
  writeFileSync(join(bad, 'manifest.json'), '{ not json');
  writeFileSync(join(bad, 'other.json'), JSON.stringify({ modules: { widgets: { name: 'NotAnArray' } } }));
  const big = pkg('big');
  writeFileSync(join(big, 'index.htm'), '');
  writeFileSync(join(big, 'manifest.json'), JSON.stringify({ modules: { widgets: [{ name: 'TooBig' }] }, pad: 'x'.repeat(1_000_001) }));
  pkg('.hidden');
  writeFileSync(join(widgets, 'stray.json'), '{}');
  const rows = listWidgetSidecars(dir);
  assert.deepEqual(rows, [
    { name: 'big', path: 'sidecars/widgets/big', html: true, json: true },
    { name: 'broken', path: 'sidecars/widgets/broken', html: false, json: true },
    { name: 'chart', path: 'sidecars/widgets/chart', html: true, json: true },
    { name: 'Sales Chart', path: 'sidecars/widgets/chart', html: true, json: true },
  ]);
  assert.deepEqual(
    widgetManualItems(rows).map((r) => [r.name, r.status, r.detail]),
    [
      ['big', 'manual', 'big: widget package (html + json) is not generated; rebuild it by hand'],
      ['broken', 'missing', 'broken: widget package is missing html'],
      ['chart', 'manual', 'chart: widget package (html + json) is not generated; rebuild it by hand'],
      ['Sales Chart', 'manual', 'Sales Chart: widget package (html + json) is not generated; rebuild it by hand'],
    ],
  );
  assert.equal(widgetCommandStatus(rows), 1);
  assert.equal(widgetCommandStatus(rows.filter((r) => r.name !== 'broken')), 0);
  assert.equal(widgetCommandStatus(undefined), 0);
  assert.equal(widgetManualItems([{ name: 'w', path: 'p', html: false, json: false }])[0].detail, 'w: widget package is missing html and json');

  writeFileSync(join(dir, 'app.ds'), APP);
  const single = parseFileOrProjectWithSidecars(join(dir, 'app.ds'));
  assert.equal(single.files.length, 1);
  assert.deepEqual(single.ir.widgets, rows);
  assert.deepEqual(parseFileOrProjectWithSidecars(dir).ir.widgets, rows);
});

test('mergeIr: one dialect wins, two are ambiguous, snippets only when nothing else; shells merge into the full declaration', () => {
  const app = (dialect?: App['dialect']): App => {
    const a = emptyApp('B');
    if (dialect) a.dialect = dialect;
    return a;
  };
  assert.equal(mergeIr([app('D1'), app('snippet'), app()]).dialect, 'D1');
  assert.equal(mergeIr([app('D1'), app('D2')]).dialect, 'ambiguous');
  assert.equal(mergeIr([app('snippet'), app()]).dialect, 'snippet');
  assert.equal(mergeIr([app(), app()]).dialect, undefined);
  assert.equal(mergeIr([app(), app()]).shape, 'B');
  assert.equal(mergeIr([emptyApp('A'), emptyApp('B')]).shape, 'C');
  assert.equal(mergeIr([emptyApp('empty')]).shape, 'empty');

  const [full, shell] = [
    parseBytes('forms/F.ds', Buffer.from('application "Demo"\n{\n\tforms\n\t{\n\t\tform F\n\t\t{\n\t\t\tName\n\t\t\t(\n\t\t\t\ttype = text\n\t\t\t)\n\t\t}\n\t}\n}\n')).ir,
    parseBytes('forms/F-extra.ds', Buffer.from('application "Demo"\n{\n\tforms\n\t{\n\t\tform F\n\t\t{\n\t\t\tsuccess message = "ok"\n\t\t}\n\t}\n}\n')).ir,
  ];
  assert.equal(full.forms[0].fields.length, 1);
  assert.equal(shell.forms[0].fields.length, 0);
  for (const order of [[full, shell], [shell, full]]) {
    const merged = mergeIr(structuredClone(order));
    assert.equal(merged.forms.length, 1);
    assert.equal(merged.forms[0].fields.length, 1);
    assert.ok(merged.forms[0].properties.some((p) => p.key === 'success message'), JSON.stringify(merged.forms[0].properties));
  }

  const withWidget = (path: string): App => ({ ...emptyApp('B'), widgets: [{ name: 'w', path, html: true, json: true }] });
  assert.deepEqual(mergeIr([withWidget('p'), withWidget('p'), withWidget('q')]).widgets?.map((w) => w.path), ['p', 'q']);
});

test('coverage labels carry keywords only: names, strings and odd tokens become <name>', () => {
  const doc = parse(
    'application "SecretApp"\n{\n\tdate format = "dd-MMM-yyyy"\n\tforms\n\t{\n\t\tform Payroll_Secret\n\t\t{\n\t\t\tSalary_Field\n\t\t\t(\n\t\t\t\ttype = number\n\t\t\t)\n\t\t}\n\t}\n}\n',
  );
  const cov = addCoverage(emptyCoverage(), doc, new Map<Statement, string>());
  const text = JSON.stringify(cov);
  for (const secret of ['SecretApp', 'Payroll', 'Salary', 'dd-MMM']) assert.doesNotMatch(text, new RegExp(secret));
  assert.ok(Object.keys(cov.unmodelled).some((k) => k.includes('form <name> {}')), text);
  assert.ok(Object.keys(cov.unmodelled).some((k) => k.includes('<name> ()')), text);
  assert.equal(cov.modelled, 0);
  assert.ok(cov.statements > 0 && cov.blocks > 0);

  const deep = parse('a\n{\n\tb\n\t{\n\t\tc\n\t\t{\n\t\t\td\n\t\t\t{\n\t\t\t\tx = 1\n\t\t\t}\n\t\t}\n\t}\n}\n');
  const deepCov = addCoverage(emptyCoverage(), deep, new Map());
  assert.ok(Object.keys(deepCov.unmodelled).includes('document > a {} > … > d {} > x ='), JSON.stringify(deepCov.unmodelled));

  const twice = mergeCoverage(mergeCoverage(emptyCoverage(), cov), cov);
  assert.equal(twice.statements, cov.statements * 2);
  for (const [k, v] of Object.entries(cov.unmodelled)) assert.equal(twice.unmodelled[k], v * 2);
  for (const [k, [m, p]] of Object.entries(cov.byCstKind)) assert.deepEqual(twice.byCstKind[k as keyof typeof cov.byCstKind], [m * 2, p * 2]);
  const labels = (src: string) => parse(src).children.filter(isStatement).map(statementLabel);
  assert.deepEqual(labels('x = 1\nkey : value\nlist Secret_List\n{\n}\nword\n'), ['x =', 'key :', 'list <name> {}', 'word']);
  assert.deepEqual(labels('(a)\n'), ['(…']);
});

test('the vendored Zoho host module answers exactly like zohoConnectionHosts', async () => {
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(zohoConnectionHostModuleSource()).toString('base64')}`)) as {
    zohoConnectionHosts: (v: unknown) => unknown;
    zohoDcSpellings: () => string[];
  };
  assert.deepEqual(mod.zohoDcSpellings(), [...zohoDcSpellings()]);
  for (const v of [...zohoDcSpellings(), ' EU ', 'COM.AU', 'uk', '', 'hasOwnProperty', '__proto__', 'constructor']) {
    assert.deepEqual(mod.zohoConnectionHosts(v), zohoConnectionHosts(v), v);
  }
  assert.equal(mod.zohoConnectionHosts(42), undefined);
  assert.deepEqual(zohoConnectionHosts('com.au'), { apis: 'https://www.zohoapis.com.au', desk: 'https://desk.zoho.com.au', cliq: 'https://cliq.zoho.com.au' });
  for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(zohoConnectionHosts(v), undefined, v);
    assert.equal(normalizeDc(v), undefined, v);
    assert.throws(() => dcEndpoints(v), UnknownDcError, v);
  }
});

test('parseZml keeps an unterminated CDATA as text and drops an unterminated comment', () => {
  const [cdata] = parseZml('<text><![CDATA[a < b');
  assert.equal(cdata.tag, 'text');
  assert.equal(cdata.text, 'a < b');
  const [comment] = parseZml('<page name="P"><!-- open <form name="Hidden"/>');
  assert.equal(comment.children.length, 0);
});
