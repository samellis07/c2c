import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { emptyApp, parseFile, parseProject, type App, type FunctionDef, type Workflow } from '../../core/src/index.js';
import { createRuntime } from '../../shims/src/runtime.js';
import { generate } from '../src/generate.js';

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

const Z = { start: 0, end: 0 };

function workflow(partial: Partial<Workflow> & Pick<Workflow, 'name' | 'event'>): Workflow {
  return { deluge: null, properties: [], span: Z, ...partial };
}

function app(partial: Partial<App>): App {
  return { ...emptyApp('empty'), name: 'Demo_App', ...partial };
}

function plainField(name: string, type = 'text', subfields: string[] = []): App['forms'][number]['fields'][number] {
  return {
    name,
    type,
    modifiers: [],
    required: false,
    unique: false,
    properties: [],
    subfields: subfields.map((s) => plainField(s)),
    annotations: [],
    flags: [],
    span: Z,
  };
}

function plainForm(name: string, fields: App['forms'][number]['fields']): App['forms'][number] {
  return { name, properties: [], fields, actions: [], blocks: [], span: Z };
}

function check(source: string, name: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-deluge-'));
  const file = join(dir, name);
  writeFileSync(file, source);
  try {
    const ran = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A call the prefetch endpoint must never run: it writes, sends, or leaves the
 * datastore read surface (thisapp bodies may write). Reads — query, fetch,
 * aggregate, column, field — and zoho.* environment lookups are allowed.
 */
const NONREAD_CALL = /shim\.(?:datastore\.(?:insert|insertRow|insertRows|update|updateRows|delete|deleteRows|writeRow|setField|flush)|mail\.|http\.|zoho\.task|thisapp\.call)\s*\(/;

/** Transcript ops a prefetch must never record. Reads and bookkeeping are absent. */
const NONREAD_OP = new Set([
  'insert',
  'update',
  'delete',
  'store',
  'setField',
  'sendmail',
  'invokeurl',
  'getUrl',
  'zoho.task',
  'thisapp',
  'input.set',
  'input.insert',
  'record.set',
  'counter',
  'autonumber',
  'flush',
  'messaging-guard',
  'live-refused',
]);

function nonReadCallSites(source: string): string[] {
  const clean = stripComments(source).replace(/^[\s]*\*.*$/gm, '').replace(/^[\s]*\/\/.*/gm, '');
  const hits: string[] = [];
  for (const line of clean.split('\n')) {
    const trimmed = line.trim();
    if (NONREAD_CALL.test(trimmed)) hits.push(trimmed.slice(0, 120));
  }
  return hits;
}

interface PrefetchModule {
  prefetch: (ctx: unknown) => Promise<Record<string, unknown>>;
}

/** Write every generated file at its real path so sibling imports (`../thisapp.mjs`) resolve. */
async function writeTree(g: ReturnType<typeof generate>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-prefetch-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(process.cwd(), join(dir, 'node_modules/creator-to-catalyst'));
  for (const file of g.files) {
    if (!file.path.startsWith('functions/') && !file.path.startsWith('runtime/')) continue;
    const dest = join(dir, file.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.source);
  }
  return dir;
}

async function prefetchModules(dir: string, g: ReturnType<typeof generate>): Promise<{ path: string; mod: PrefetchModule }[]> {
  const out: { path: string; mod: PrefetchModule }[] = [];
  for (const file of g.files) {
    if (!file.path.endsWith('-prefetch.mjs')) continue;
    out.push({ path: file.path, mod: (await import(pathToFileURL(join(dir, file.path)).href)) as PrefetchModule });
  }
  return out;
}

/** The on-load guard that auto-enrols the admin user: query, count, guarded insert, ui.add. */
const GUARDED_ENROL = [
  'userRec = Add_User[Contact_Email == zoho.adminuserid];',
  'if(userRec.count() <= 0)',
  '{',
  '\treecID = insert into Add_User',
  '\t[',
  '\t\tName.first_name=zoho.loginuser',
  '\t\tName.last_name=zoho.loginuser',
  '\t\tContact_Email=zoho.loginuserid',
  '\t\tUser_Role="Organizer"',
  '\t\tAdded_User=zoho.loginuser',
  '\t];',
  '\tinput.Organizers:ui.add(reecID);',
  '}',
].join('\n');

const enrolApp = () =>
  app({
    name: 'Enrol_App',
    forms: [
      plainForm('Add_Event', [plainField('Organizers')]),
      plainForm('Add_User', [
        plainField('Contact_Email', 'email'),
        plainField('User_Role'),
        plainField('Added_User'),
        plainField('Name', 'name', ['first_name', 'last_name']),
      ]),
    ],
    workflows: [
      workflow({ name: 'On load', form: 'Add_Event', event: 'on load', recordEvent: 'on add', deluge: { text: GUARDED_ENROL, span: Z } }),
    ],
  });

/** The web-to-case submit: count, guarded caller insert, unconditional case insert, alert. */
const WEB_TO_CASE = [
  'cnt = Callers[Email == input.Email].count();',
  'if(cnt > 0)',
  '{',
  '\tcallerID = Callers[Email == input.Email].ID;',
  '}',
  'else',
  '{',
  '\tcallerID = insert into Callers',
  '\t[',
  '\t\tAdded_User=zoho.loginuser',
  '\t\tPhone=input.Phone_Number',
  '\t\tEmail=input.Email',
  '\t\tName=input.Name',
  '\t];',
  '}',
  'caseID = insert into Add_Case',
  '[',
  '\tAdded_User=zoho.loginuser',
  '\tCaller=callerID',
  '\tCase_Status=input.Case_Status',
  '\tDescription=input.Problem',
  '\tProduct=input.Product',
  '\tSource=input.Source',
  '\tTitle=input.Title',
  '];',
  'alert "We have received your request";',
].join('\n');

const webToCaseApp = () =>
  app({
    name: 'Desk_App',
    forms: [
      plainForm('Web_to_Case', ['Email', 'Phone_Number', 'Name', 'Case_Status', 'Problem', 'Product', 'Source', 'Title'].map((n) => plainField(n))),
      plainForm('Callers', ['Email', 'Phone', 'Name', 'Added_User'].map((n) => plainField(n))),
      plainForm('Add_Case', ['Added_User', 'Caller', 'Case_Status', 'Description', 'Product', 'Source', 'Title', 'Case_ID'].map((n) => plainField(n))),
    ],
    workflows: [
      workflow({ name: 'Submit', form: 'Web_to_Case', event: 'on click', deluge: { text: WEB_TO_CASE, span: Z } }),
    ],
  });

/** An on-load app-function call under a server-read condition. */
const thisappFn: FunctionDef = {
  name: 'settings.update',
  kind: 'deluge',
  signature: 'void settings.update()',
  deluge: [{ text: 'x = 1;', span: Z }],
  properties: [],
  span: Z,
};

const thisappApp = () =>
  app({
    name: 'Tracker_App',
    forms: [plainForm('Home', [plainField('Dummy')]), plainForm('Task', [plainField('Status'), plainField('Title')])],
    functions: [thisappFn],
    workflows: [
      workflow({
        name: 'On load',
        form: 'Home',
        event: 'on load',
        deluge: { text: 'n = Task[Status == "Open"].count();\nif (n > 0)\n{\n\tthisapp.settings.update();\n}', span: Z },
      }),
    ],
  });

test('a guarded write is never hoisted into a page prefetch', async (t) => {
  const dir = await writeTree(generate(enrolApp()));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const g = generate(enrolApp());
  const prefetch = g.files.find((f) => f.path === 'functions/aio/add-event/on-load-prefetch.mjs');
  const server = g.files.find((f) => f.path === 'functions/aio/add-event/on-load.mjs');
  const client = g.files.find((f) => f.path === 'client/handlers/add-event/on-load.mjs');
  assert.ok(prefetch, 'on-load prefetch module');
  assert.ok(server, 'on-load server module');
  assert.ok(client, 'on-load client module');
  check(prefetch.source, 'enrol-prefetch.mjs');
  check(server.source, 'enrol-server.mjs');
  check(client.source, 'enrol-client.mjs');

  // Static: no non-read call site inside any generated prefetch module.
  for (const file of g.files.filter((f) => f.path.endsWith('-prefetch.mjs'))) {
    assert.deepEqual(nonReadCallSites(file.source), [], file.path);
  }

  // Dynamic: running prefetch(ctx) records only reads on the shim transcript.
  const runtime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Add_User: [] } });
  for (const { path, mod } of await prefetchModules(dir, g)) {
    const slots = await mod.prefetch(runtime.context({ record: {}, old: { __c2c: 'dry-run-old', loaded: false }, principal: { profile: 'Admin' } }));
    assert.ok(slots && typeof slots === 'object', path);
    const writes = runtime.transcript.filter((entry) => NONREAD_OP.has(entry.op));
    assert.deepEqual(writes, [], `${path} non-read ops: ${JSON.stringify(writes)}`);
  }

  // The write stays on the server path, under its source guard.
  const srv = stripComments(server.source);
  assert.match(srv, /if \(\(await shim\.datastore\.aggregate\([^)]*\) <= 0\)\) \{\s*var reecID = await shim\.datastore\.insert\(ctx, "Add_User"/);
  // The client keeps the :ui.add under the prefetched slot, not the insert id.
  const cli = stripComments(client.source);
  assert.doesNotMatch(cli, /datastore\.insert/);
  assert.match(cli, /if \(slots\["c\d+"\]\)/);
  assert.match(cli, /op: "ui", method: "add"/);
});

test('insert-bearing on click and on-load thisapp.call keep writes off the prefetch', async (t) => {
  // The submit handler's writes stay server-side; any prefetch it emits carries none.
  const desk = generate(webToCaseApp());
  const deskDir = await writeTree(desk);
  t.after(() => rmSync(deskDir, { recursive: true, force: true }));
  for (const file of desk.files.filter((f) => f.path.endsWith('-prefetch.mjs'))) {
    assert.deepEqual(nonReadCallSites(file.source), [], file.path);
  }
  const deskRuntime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Callers: [] } });
  for (const { path, mod } of await prefetchModules(deskDir, desk)) {
    await mod.prefetch(deskRuntime.context({ record: {}, old: { __c2c: 'dry-run-old', loaded: false }, principal: { profile: 'Admin' } }));
    const writes = deskRuntime.transcript.filter((entry) => NONREAD_OP.has(entry.op));
    assert.deepEqual(writes, [], `${path} non-read ops: ${JSON.stringify(writes)}`);
  }
  const deskServer = desk.files.find((f) => f.path === 'functions/aio/web-to-case/on-click.mjs');
  assert.ok(deskServer);
  const deskSrv = stripComments(deskServer.source);
  assert.match(deskSrv, /else \{\s*callerID = await shim\.datastore\.insert\(ctx, "Callers"/);
  assert.match(deskSrv, /var caseID = await shim\.datastore\.insert\(ctx, "Add_Case"/);
  check(deskServer.source, 'desk-server.mjs');

  // A thisapp.* call under a server-read condition is never replayed by the prefetch.
  const trk = generate(thisappApp());
  const trkDir = await writeTree(trk);
  t.after(() => rmSync(trkDir, { recursive: true, force: true }));
  for (const file of trk.files.filter((f) => f.path.endsWith('-prefetch.mjs'))) {
    assert.deepEqual(nonReadCallSites(file.source), [], file.path);
    assert.doesNotMatch(stripComments(file.source), /\bfunctions\./, file.path);
  }
  const trkRuntime = createRuntime({ dryRun: true, appTimeZone: 'UTC', seed: { Task: [] } });
  for (const { path, mod } of await prefetchModules(trkDir, trk)) {
    await mod.prefetch(trkRuntime.context({ record: {}, old: { __c2c: 'dry-run-old', loaded: false }, principal: { profile: 'Admin' } }));
    const writes = trkRuntime.transcript.filter((entry) => NONREAD_OP.has(entry.op));
    assert.deepEqual(writes, [], `${path} non-read ops: ${JSON.stringify(writes)}`);
  }
  const trkServer = trk.files.find((f) => f.path === 'functions/aio/home/on-load.mjs');
  assert.ok(trkServer);
  const trkSrv = stripComments(trkServer.source);
  assert.match(trkSrv, /if \(\(n > 0\)\) \{\s*await shim\.thisapp\.call\(ctx, \["settings","update"\]/);
  check(trkServer.source, 'trk-server.mjs');
});

/** Every committed corpus app the suite ships: no prefetch may contain a non-read call site. */
function corpusTargets(): { name: string; app: App }[] {
  const targets: { name: string; app: App }[] = [];
  const push = (name: string, path: string) => {
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) return;
    targets.push({ name, app: st.isDirectory() ? parseProject(path).ir : parseFile(path).ir });
  };
  for (const name of readdirSync('fixtures/dialects')) {
    if (name.endsWith('.ds')) push(`dialects/${name}`, join('fixtures/dialects', name));
  }
  for (const name of readdirSync('fixtures/redistributable')) {
    const dir = join('fixtures/redistributable', name);
    if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) push(`redistributable/${name}`, dir);
  }
  push('golden/c2c-golden', 'tests/golden/c2c-golden.ds');
  push('matrix/builtin-app', 'tests/matrix/fixtures/builtin-app.ds');
  return targets;
}

test('no committed-corpus prefetch module contains a non-read call site', { timeout: 300000 }, () => {
  const counts: string[] = [];
  for (const { name, app: corpus } of corpusTargets()) {
    const g = generate(corpus);
    const prefetches = g.files.filter((f) => f.path.endsWith('-prefetch.mjs'));
    let hits = 0;
    for (const file of prefetches) {
      const found = nonReadCallSites(file.source);
      assert.deepEqual(found, [], `${name} ${file.path}`);
      hits += found.length;
    }
    counts.push(`${name} prefetches=${prefetches.length} nonread=${hits}`);
  }
  console.log(counts.join('\n'));
});

function galleryDir(): string | undefined {
  const fromEnv = process.env.C2C_GALLERY_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const fixtures = process.env.C2C_FIXTURES_DIR;
  if (!fixtures) return undefined;
  const fallback = join(fixtures, 'gallery');
  return existsSync(fallback) ? fallback : undefined;
}

// The apps a live measurement reported non-read prefetch call sites for. This is
// a per-app count only, not a full sweep: it names nine apps and stops.
test('named gallery apps: prefetch non-read call-site count is zero', { skip: !galleryDir(), timeout: 300000 }, () => {
  const root = galleryDir();
  assert.ok(root);
  const named = [
    'support-desk',
    'project-tracker',
    'university-event-organizer',
    'library-management',
    'donor-management',
    'freight-forwarding',
    'real-estate-management',
    'education-management',
    'library-application-system',
  ];
  const local = join('fixtures', 'redistributable');
  const counts: string[] = [];
  for (const name of named) {
    const galleryPath = join(root, name);
    const localPath = join(local, name);
    const target = existsSync(galleryPath) ? galleryPath : existsSync(localPath) ? localPath : null;
    if (!target) {
      counts.push(`${name} (absent)`);
      continue;
    }
    const g = generate(parseProject(target).ir);
    let hits = 0;
    for (const file of g.files.filter((f) => f.path.endsWith('-prefetch.mjs'))) {
      hits += nonReadCallSites(file.source).length;
    }
    counts.push(`${name} nonread=${hits}`);
  }
  const report = counts.join('\n');
  console.log(report);
  for (const line of counts) assert.match(line, /nonread=0|absent/, report);
});
