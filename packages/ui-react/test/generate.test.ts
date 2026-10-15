import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { serviceWorker } from '../../ui/src/generate.js';
import { GENERATED_MANIFEST, HandEditedError, TEMPLATE_DIR, generateReactApp, reactAppSpec, writeReactApp, type ReactFile } from '../src/index.js';
import { REACT_BUILD_NODE_RANGE } from '../../core/src/toolchain.js';

function field(name: string, type: string, extra = '', modifiers = ''): string {
  const head = modifiers ? `${modifiers} ${name}` : name;
  const lines = extra ? `\t\t\ttype = ${type}\n${extra}` : `\t\t\ttype = ${type}`;
  return `\t\t${head}\n\t\t(\n${lines}\n\t\t)`;
}

function source(opts: { formName?: string; extraForm?: boolean; appName?: string } = {}): string {
  const form = opts.formName ?? 'New_Contact';
  const second = opts.extraForm
    ? `\tform Note\n\t{\n\t\tdisplayname = "Note"\n${field('Title', 'text')}\n\t}\n`
    : '';
  return `application "${opts.appName ?? 'Contacts'}"
{
\tform ${form}
\t{
\t\tdisplayname = "New Contact"
${field('Full_Name', 'text', '\t\t\tdisplayname = "Full Name"', 'must have')}
${field('Email', 'email', '\t\t\tdisplayname = "Email"')}
${field('Kind', 'picklist', '\t\t\tdisplayname = "Kind"\n\t\t\tvalues = {"Friend","Work"}')}
${field('Birthday', 'date')}
${field('Owner_Ref', 'list', '\t\t\tvalues = Person.Name')}
\t\tactions
\t\t{
\t\t\ton add
\t\t\t{
\t\t\t\tsubmit
\t\t\t\t(
\t\t\t\t\ttype = submit
\t\t\t\t\tdisplayname = "Save"
\t\t\t\t)
\t\t\t\treset
\t\t\t\t(
\t\t\t\t\ttype = reset
\t\t\t\t\tdisplayname = "Clear"
\t\t\t\t)
\t\t\t}
\t\t\ton edit
\t\t\t{
\t\t\t\tupdate
\t\t\t\t(
\t\t\t\t\ttype = submit
\t\t\t\t\tdisplayname = "Update"
\t\t\t\t)
\t\t\t}
\t\t}
\t}
${second}\tform Person
\t{
${field('Name', 'text')}
\t}
\tlist All_Contacts
\t{
\t\tdisplayname = "All Contacts"
\t\tshow all rows from ${form}
\t\t(
\t\t\tFull_Name
\t\t\tEmail
\t\t\tKind
\t\t\tBirthday
\t\t\tOwner_Ref
\t\t)
\t}
}
`;
}

function appOf(text = source()): App {
  return deriveIr(parse(text));
}

function digest(files: readonly ReactFile[]): string[] {
  return files.map((f) => `${createHash('sha256').update(f.data).digest('hex')}  ${f.owner}  ${f.path}`);
}

function text(files: readonly ReactFile[], path: string): string {
  const file = files.find((f) => f.path === path);
  assert.ok(file, `missing ${path}`);
  return String(file.data);
}

test('two generations of the same app are byte-identical and sorted', () => {
  const a = generateReactApp(appOf());
  const b = generateReactApp(appOf());
  assert.deepEqual(digest(a), digest(b));
  const paths = a.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(new Set(paths).size, paths.length, 'no duplicate paths');
});

test('ownership split: app-specific output is generated; platform and custom files never depend on the app', () => {
  const one = generateReactApp(appOf());
  const other = generateReactApp(appOf(source({ formName: 'Lead', extraForm: true, appName: 'Leads' })));
  for (const file of one) {
    if (file.owner === 'generated') {
      assert.ok(/^(src\/generated\/|index\.html$|public\/)/.test(file.path), `generated file outside the generated area: ${file.path}`);
    } else if (file.owner === 'custom') {
      assert.ok(file.path.startsWith('src/custom/'), file.path);
    } else {
      assert.ok(!file.path.startsWith('src/generated/') && !file.path.startsWith('src/custom/'), file.path);
    }
  }
  const shared = (files: readonly ReactFile[]) => digest(files.filter((f) => f.owner !== 'generated'));
  assert.deepEqual(shared(one), shared(other), 'platform and custom bytes are the same for every app');
  assert.notDeepEqual(digest(one.filter((f) => f.owner === 'generated')), digest(other.filter((f) => f.owner === 'generated')));
});

test('the spec carries Creator order, labels, buttons, phone columns and the c2c_api endpoints', () => {
  const app = appOf();
  const spec = reactAppSpec(app);
  const form = spec.forms.New_Contact!;
  assert.equal(form.label, 'New Contact');
  assert.deepEqual(form.fields.map((f) => f.name), ['Full_Name', 'Email', 'Kind', 'Birthday', 'Owner_Ref']);
  assert.equal(form.fields[0]!.required, true);
  assert.deepEqual(form.fields.find((f) => f.name === 'Kind')!.choices, ['Friend', 'Work']);
  assert.equal(form.submitEndpoint, '/forms/New_Contact/submit');
  assert.deepEqual(form.buttons.add.map((b) => [b.label, b.type]), [['Save', 'submit'], ['Clear', 'reset']]);
  assert.deepEqual(form.buttons.edit.map((b) => [b.label, b.type]), [['Update', 'submit']]);
  // A lookup is a picker over its parent's paged lookup endpoint.
  const lookup = form.fields.find((f) => f.name === 'Owner_Ref')!;
  assert.equal(lookup.generated, true);
  assert.deepEqual(lookup.lookup, { form: 'Person', display: 'Name', endpoint: '/lookups/Person/Name' });
  const report = spec.reports.All_Contacts!;
  assert.equal(report.view, 'list');
  assert.equal(report.queryEndpoint, '/reports/All_Contacts');
  // Column labels are the model's, exactly what the vanilla table prints: the
  // field display name, the column's `as` alias, or the link name verbatim.
  assert.deepEqual(report.columns.map((c) => [c.label, c.phone]), [['Full Name', true], ['Email', true], ['Kind', true], ['Birthday', true], ['Owner_Ref', false]]);
});

test('a web quick view narrows the report columns to the configured set, like vanilla', () => {
  // The export's report column list is everything the report can return; the
  // web quick view's datablock fields are the columns the layout shows
  // (decorations/report-views.ts). The vanilla table renders the configured
  // set; the React spec must carry the same columns or a wide report's header
  // row overlaps.
  const src = source().replace(/\}\n$/, `\tweb
\t{
\t\treports
\t\t{
\t\t\treport All_Contacts
\t\t\t{
\t\t\t\tquickview
\t\t\t\t(
\t\t\t\t\tlayout
\t\t\t\t\t(
\t\t\t\t\t\tdatablock1
\t\t\t\t\t\t(
\t\t\t\t\t\t\ttitle = "Overview"
\t\t\t\t\t\t\tfields
\t\t\t\t\t\t\t(
\t\t\t\t\t\t\t\tFull_Name as "Contact Name"
\t\t\t\t\t\t\t\tEmail
\t\t\t\t\t\t\t\tBirthday
\t\t\t\t\t\t\t)
\t\t\t\t\t\t)
\t\t\t\t\t)
\t\t\t\t)
\t\t\t}
\t\t}
\t}
}\n`);
  const spec = reactAppSpec(appOf(src));
  const report = spec.reports.All_Contacts!;
  assert.deepEqual(
    report.columns.map((c) => [c.field, c.label]),
    [
      ['Full_Name', 'Contact Name'],
      ['Email', 'Email'],
      ['Birthday', 'Birthday'],
    ],
  );
  // With no phone quick view the first four configured columns are the phone card's.
  assert.deepEqual(report.columns.map((c) => c.phone), [true, true, true]);
});

test('the report template keeps vanilla parity: search, pagination, and headers that wrap', () => {
  const view = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/report/ReportView.tsx'), 'utf8');
  assert.match(view, /type="search"/, 'search input');
  assert.match(view, /className="c2c-pages"/, 'Previous / Page N / Next');
  const css = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/arc/components/sortable-data-table/sortable-data-table.module.css'), 'utf8');
  const headRule = /\.table th \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(headRule, 'a .table th rule exists');
  assert.doesNotMatch(headRule, /white-space:\s*nowrap/, 'a header cell must wrap, never overlap the next');
  assert.match(headRule, /overflow-wrap:\s*anywhere/, 'a long header breaks inside its column');
});

test('generated modules: one per form and report, routes by key, Creator field order in the form JSX', () => {
  const files = generateReactApp(appOf());
  const formTsx = text(files, 'src/generated/forms/New_Contact.tsx');
  const order = [...formTsx.matchAll(/<Field name="([^"]+)" \/>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Full_Name', 'Email', 'Kind', 'Birthday', 'Owner_Ref']);
  assert.match(formTsx, /^\/\/ Generated by c2c/);
  const routes = text(files, 'src/generated/routes.tsx');
  assert.match(routes, /"form\/New_Contact": NewContactForm/);
  assert.match(routes, /"record\/New_Contact": NewContactRecordSummary/);
  assert.match(text(files, 'src/generated/records/New_Contact.tsx'), /RecordSummary form=\{form\} rowId=\{record\}/);
  assert.match(routes, /"report\/All_Contacts": AllContactsReport/);
  const html = text(files, 'index.html');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Contacts<\/title>/);
  assert.match(html, /<a class="skip-link" href="#main">/);
  assert.match(html, /<main id="main">/);
  assert.match(html, /name="viewport" content="width=device-width/);
  assert.match(html, /<script type="module" src="\/src\/main\.tsx"><\/script>/);
  // Sign-in by default; --no-auth leaves the SDK out.
  assert.match(text(files, 'public/c2c-config.js'), /catalystWebSDK/);
  assert.doesNotMatch(text(generateReactApp(appOf(), { auth: false }), 'public/c2c-config.js'), /catalystWebSDK/);
  assert.equal(text(files, 'lib/c2c-ui/pwa/sw.template.js'), serviceWorker());
  const manifest = JSON.parse(text(files, GENERATED_MANIFEST)) as { files: Record<string, string> };
  for (const file of files.filter((f) => f.owner === 'generated' && f.path !== GENERATED_MANIFEST)) {
    assert.equal(manifest.files[file.path], createHash('sha256').update(file.data).digest('hex'), file.path);
  }
});

test('regeneration rewrites generated files only, keeps custom edits, and stops on a hand-edited generated file', () => {
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-react-'));
  try {
    const first = writeReactApp(out, generateReactApp(appOf(source({ extraForm: true }))));
    assert.equal(first.kept.length, 0);
    assert.ok(existsSync(join(out, 'src/generated/forms/Note.tsx')));

    // The user customizes: their file survives every regeneration.
    const custom = join(out, 'src/custom/index.tsx');
    writeFileSync(custom, "import { defineCustomization } from '@c2c/ui';\nexport default defineCustomization({ nav: (s) => s });\n");
    // A platform file the user changed is kept unless the platform is upgraded.
    const vite = join(out, 'vite.config.ts');
    writeFileSync(vite, `${readFileSync(vite, 'utf8')}// local\n`);

    // The Creator app drops the Note form: its form and record-summary modules go.
    const second = writeReactApp(out, generateReactApp(appOf()));
    assert.deepEqual(second.removed, ['src/generated/forms/Note.tsx', 'src/generated/records/Note.tsx']);
    assert.ok(!existsSync(join(out, 'src/generated/forms/Note.tsx')));
    assert.ok(!existsSync(join(out, 'src/generated/records/Note.tsx')));
    assert.match(readFileSync(custom, 'utf8'), /nav: \(s\) => s/);
    assert.match(readFileSync(vite, 'utf8'), /\/\/ local\n$/);
    assert.ok(second.written.every((path) => !path.startsWith('src/custom/')));

    // A hand edit under src/generated is detected, not silently overwritten.
    const route = join(out, 'src/generated/routes.tsx');
    writeFileSync(route, `${readFileSync(route, 'utf8')}// hand edit\n`);
    assert.throws(() => writeReactApp(out, generateReactApp(appOf())), (err: unknown) => err instanceof HandEditedError && err.paths.join() === 'src/generated/routes.tsx');
    assert.match(readFileSync(route, 'utf8'), /hand edit/);
    writeReactApp(out, generateReactApp(appOf()), { force: true });
    assert.doesNotMatch(readFileSync(route, 'utf8'), /hand edit/);

    // An explicit platform upgrade replaces platform files and still keeps custom ones.
    writeReactApp(out, generateReactApp(appOf()), { upgradePlatform: true });
    assert.doesNotMatch(readFileSync(vite, 'utf8'), /\/\/ local/);
    assert.match(readFileSync(custom, 'utf8'), /nav: \(s\) => s/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the template pins exact versions, commits its lockfile, and every package licence is permissive', () => {
  const pkg = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
  const lock = JSON.parse(readFileSync(join(TEMPLATE_DIR, 'package-lock.json'), 'utf8')) as {
    lockfileVersion: number;
    packages: Record<string, { version?: string; license?: string; dev?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
  };
  assert.equal(lock.lockfileVersion, 3);
  for (const block of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(pkg[block] ?? {})) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
      assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `${name} lockfile matches package.json`);
    }
  }
  assert.deepEqual(lock.packages['']!.dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages['']!.devDependencies, pkg.devDependencies);
  // Shipped code: permissive only. Build-only tools may also be MPL-2.0 (lightningcss); they never reach the bundle.
  const shipped = new Set(['MIT', 'ISC', '0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    const allowed = entry.dev ? new Set([...shipped, 'MPL-2.0']) : shipped;
    assert.ok(entry.license && allowed.has(entry.license), `${path}: licence ${entry.license ?? 'missing'}`);
  }
  // The template carries the shared build range; the generator stamps the same constant.
  assert.equal(pkg.engines!.node, REACT_BUILD_NODE_RANGE);
  assert.equal((lock.packages[''] as { engines?: { node?: string } }).engines?.node, REACT_BUILD_NODE_RANGE);
});

test('Arc components are vendored at a recorded commit with their licence and notices', () => {
  const upstream = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/ARC-UPSTREAM.md'), 'utf8');
  assert.match(upstream, /Pinned upstream commit: `[0-9a-f]{40}`/);
  assert.match(readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/arc/LICENSE'), 'utf8'), /MIT License[\s\S]*Elia Kuratli/);
  for (const name of ['button', 'input', 'alert', 'empty-state', 'sortable-data-table']) {
    assert.ok(existsSync(join(TEMPLATE_DIR, `lib/c2c-ui/arc/components/${name}/${name}.tsx`)), name);
    assert.match(upstream, new RegExp(`\`${name}\``), `${name} listed in ARC-UPSTREAM.md`);
  }
  const notices = text(generateReactApp(appOf()), 'THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Arc Library[\s\S]*MIT License/);
  assert.match(readFileSync('THIRD_PARTY_NOTICES.md', 'utf8'), /Arc Library[\s\S]*kuratlielia\/arc-library[\s\S]*MIT/);
});

test('a form with no fields generates a module that type-checks: no unused import, no required children', () => {
  const files = generateReactApp(appOf(source().replace('\tform Person\n\t{\n', '\tform Empty\n\t{\n\t}\n\tform Person\n\t{\n')));
  const empty = text(files, 'src/generated/forms/Empty.tsx');
  assert.doesNotMatch(empty, /\bField\b/);
  assert.match(empty, /<FormView form=\{form\} edit=\{edit\} \/>/);
  const formView = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/form/FormView.tsx'), 'utf8');
  assert.match(formView, /children\?: ReactNode/);
});

test('a generated React app type-checks with tsc --noEmit, including signature-pad SVG and G refs', () => {
  const tscBin = join(TEMPLATE_DIR, 'node_modules/.bin/tsc');
  assert.ok(existsSync(tscBin), 'the React template build dependencies are not installed; run `npm ci --prefix packages/ui-react/template`');
  const out = mkdtempSync(join(tmpdir(), 'c2c-ui-react-tsc-'));
  try {
    writeReactApp(out, generateReactApp(appOf()));
    symlinkSync(join(TEMPLATE_DIR, 'node_modules'), join(out, 'node_modules'), 'dir');
    const clean = spawnSync(tscBin, ['-p', 'tsconfig.json', '--noEmit'], { cwd: out, encoding: 'utf8' });
    assert.equal(clean.status, 0, `${clean.stdout}${clean.stderr}`);

    const sigPath = join(out, 'lib/c2c-ui/arc/components/signature-pad/signature-pad.tsx');
    const orig = readFileSync(sigPath, 'utf8');
    assert.match(orig, /useRef<SVGSVGElement>\(null\)/);
    assert.match(orig, /useRef<SVGGElement>\(null\)/);
    writeFileSync(sigPath, orig.replace('useRef<SVGSVGElement>(null)', 'useRef<HTMLDivElement>(null)'));
    const broken = spawnSync(tscBin, ['-p', 'tsconfig.json', '--noEmit'], { cwd: out, encoding: 'utf8' });
    assert.notEqual(broken.status, 0, 'mismatched HTMLDivElement ref on <svg> must fail tsc');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('empty Creator choices are dropped, and every choice control carries a name', () => {
  const spec = reactAppSpec(appOf(source().replace(`${field('Birthday', 'date')}`, `${field('Birthday', 'date')}\n${field('Days', 'checkboxes', '\t\t\tvalues = {""}')}`)));
  const days = spec.forms.New_Contact!.fields.find((f) => f.name === 'Days')!;
  assert.equal(days.choices, undefined);
  const widget = readFileSync(join(TEMPLATE_DIR, 'lib/c2c-ui/form/fields.tsx'), 'utf8');
  assert.match(widget, /\(field\.choices \?\? \[\]\)\.map/);
});

test('React client handlers ship the exact modules the vanilla target emits', async () => {
  const app = appOf(`\tform Item
\t{
\t\tStatus
\t\t(
\t\t\ttype = picklist
\t\t\tvalues = {"Open","Closed"}
\t\t)
\t\tSecret
\t\t(
\t\t\ttype = text
\t\t)
\t\tLocked
\t\t(
\t\t\ttype = text
\t\t)
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
\t\t\t\trecord event = on add or edit
\t\t\t\tfield rules
\t\t\t\t{
\t\t\t\t\tactions
\t\t\t\t\t{
\t\t\t\t\t\thide Secret;
\t\t\t\t\t\tdisable Locked;
\t\t\t\t\t}
\t\t\t\t\tactions (Status == "Closed")
\t\t\t\t\t{
\t\t\t\t\t\tshow Notes;
\t\t\t\t\t\thide Status;
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}`);
  // Parity by construction: the React target lazily loads the same generated
  // client-handler modules the vanilla target ships, so every field-rule op
  // and target the vanilla client runs is the one React runs.
  const { generate } = await import('../../deluge/src/index.js');
  const out = generate(app);
  const vanilla = out.files.filter((f) => /client\/handlers\/.*\.mjs$/.test(f.path) && f.source.includes('actions.push'));
  assert.ok(vanilla.length, 'expected a generated client handler carrying the field-rule actions');
  const files = generateReactApp(app, { auth: false });
  for (const mod of vanilla) {
    const key = mod.path.slice('client/handlers/'.length).replace(/\.mjs$/, '');
    const emitted = files.find((f) => f.path === `src/generated/handlers/${key}.ts`);
    assert.ok(emitted, `React app is missing generated handler ${key}`);
    assert.ok(String(emitted.data).endsWith(mod.source), `${key}: React handler diverges from the vanilla module`);
  }
});
