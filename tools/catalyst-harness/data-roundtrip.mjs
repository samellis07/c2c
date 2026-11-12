#!/usr/bin/env node
/**
 * D6 offline data round trip: seed -> store A -> rollback-export -> re-import
 * into store B -> compare row counts, lookups, subforms, and file cells.
 *
 *   node tools/catalyst-harness/data-roundtrip.mjs [--report <json>] [--md <md>]
 *     [--rows N] [--gallery <dir>] [target .ds|dir ...]
 *
 * Both stores are the in-memory Catalyst row fake; nothing opens a socket.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { parseFileOrProject } = await import(`${root}/dist/core/src/index.js`);
const { generateSchema, columnRenamesOf, STRATUS_KEY_TYPES } = await import(`${root}/dist/schema/src/generator.js`);
const { generateSeed, canonicalSeedJson, seedCompositeMap } = await import(`${root}/dist/data/src/seed.js`);
const { parseSeed, seedStoreColumns, seedFileColumns, migrateSeed } = await import(`${root}/dist/deploy/src/seed.js`);
const { foreignKeysForApp } = await import(`${root}/dist/deploy/src/remap.js`);
const { rollbackExport } = await import(`${root}/dist/deploy/src/rollback.js`);
const { readSourceCsv, migrateLoaded } = await import(`${root}/dist/deploy/src/csv.js`);
const { quirkRowServer } = await import(`${root}/dist/data/test/catalyst-row-fake.js`);

const SCOPE = { org: '1', projectId: '1', token: 'd6-roundtrip' };
const BASE = 'https://catalyst.zoho.in';
const SOURCE_ID = 'c2c_source_id';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--report' && args[i - 1] !== '--md' && args[i - 1] !== '--rows' && args[i - 1] !== '--gallery');
const ROWS = Number(flag('--rows') ?? '2');
const outJson = flag('--report');
const outMd = flag('--md');

function listTargets(gallery) {
  const out = [];
  for (const ent of readdirSync(gallery, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith('.')) continue;
    const path = join(gallery, ent.name);
    if (ent.isDirectory() && readdirSync(path).some((name) => name.toLowerCase().endsWith('.ds'))) out.push(path);
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.ds')) out.push(path);
  }
  return out;
}

/** table -> stored rows, from the fake store's `stored` map. */
function storeRows(store) {
  const out = new Map();
  for (const [key, row] of store.stored) {
    const table = key.slice(0, key.indexOf('\u0000'));
    const list = out.get(table) ?? [];
    list.push(row);
    out.set(table, list);
  }
  return out;
}

const memorySink = () => {
  const objects = new Map();
  return { objects, put: async (key, bytes) => (objects.has(key) ? 'exists' : (objects.set(key, bytes), 'created')) };
};

const sourceId = (row) => (row?.[SOURCE_ID] === undefined || row?.[SOURCE_ID] === null ? '' : String(row[SOURCE_ID]));
const rowid = (row) => String(row?.ROWID ?? '');

async function roundTrip(target) {
  const app = parseFileOrProject(target).ir;
  const plan = generateSchema(app);
  const appTables = plan.tables.filter((table) => !table.nosql && table.role !== 'system');
  const fileColumns = appTables.flatMap((table) => table.columns.filter((column) => STRATUS_KEY_TYPES.includes(column.matrixId) && !column.shadowFor).map((column) => ({ table: table.name, column: column.name })));
  const fks = appTables.flatMap((table) => table.columns.filter((column) => column.relation).map((column) => ({ table: table.name, column: column.name, parent: column.relation.table })));

  const seed = generateSeed(app, { n: ROWS, seed: 'd6' });
  const seedJson = canonicalSeedJson(seed.tables, seed.blockers);
  const tables = seedStoreColumns(parseSeed(seedJson), columnRenamesOf(plan), seedCompositeMap(app, plan));
  const fileCols = seedFileColumns(plan);
  const seedDir = mkdtempSync(join(tmpdir(), 'c2c-d6-seed-'));
  for (const file of seed.fixtureFiles) writeFileSync(join(seedDir, file.name), file.bytes);

  const storeA = quirkRowServer();
  const sink = memorySink();
  const loadA = await migrateSeed({
    tables,
    foreignKeys: foreignKeysForApp(app),
    knownTables: plan.tables.map((table) => table.name),
    dc: 'in', catalystBase: BASE, dryRun: false,
    fetch: storeA.fetch, scope: SCOPE,
    fileColumnsByTable: fileCols, seedDir, sink,
  });
  rmSync(seedDir, { recursive: true, force: true });
  if (!loadA.ok) return { app: app.name, status: 'gap', detail: `seed load refused: ${loadA.error ?? 'unknown'}`, blockers: seed.blockers.map((item) => item.message) };

  const rowsA = storeRows(storeA);
  const exp = rollbackExport(app, rowsA);

  const srcDir = mkdtempSync(join(tmpdir(), 'c2c-d6-src-'));
  try {
    const counts = {};
    for (const item of exp.counts) counts[item.form] = item.rows;
    for (const file of exp.files) {
      if (file.path.startsWith('import/') || file.path.startsWith('manual/')) writeFileSync(join(srcDir, file.path.split('/').pop()), file.body);
    }
    for (const table of appTables) {
      if ((table.role === 'child' || table.role === 'junction') && counts[table.name] === undefined) counts[table.name] = (rowsA.get(table.name) ?? []).length;
    }
    writeFileSync(join(srcDir, 'counts.json'), JSON.stringify({ version: 1, counts }));

    let loaded;
    try {
      loaded = readSourceCsv(srcDir, app);
    } catch (error) {
      return { app: app.name, status: 'fail', detail: `re-import refused the export: ${error instanceof Error ? error.message : String(error)}` };
    }
    const storeB = quirkRowServer();
    const loadB = await migrateLoaded({ app, loaded, dc: 'in', catalystBase: BASE, fetch: storeB.fetch, scope: SCOPE });
    const rowsB = storeRows(storeB);
    return compare({ app, plan, appTables, fileColumns, fks, rowsA, rowsB, loadB, exp, sink });
  } finally {
    rmSync(srcDir, { recursive: true, force: true });
  }
}

function compare({ app, appTables, fileColumns, fks, rowsA, rowsB, loadB, exp, sink }) {
  const checks = [];
  // Rows: identical source-id sets per table between the two stores.
  const rowDetail = [];
  for (const table of appTables) {
    const a = new Set((rowsA.get(table.name) ?? []).map(sourceId));
    const b = new Set((rowsB.get(table.name) ?? []).map(sourceId));
    const missing = [...a].filter((id) => !b.has(id));
    const extra = [...b].filter((id) => !a.has(id));
    if (missing.length || extra.length) rowDetail.push(`${table.name}: ${missing.length} missing ${extra.length} extra`);
  }
  checks.push({ check: 'rows', status: loadB.ok && rowDetail.length === 0 ? 'pass' : 'fail', detail: loadB.ok ? rowDetail.join('; ') || `${[...rowsA.values()].reduce((n, list) => n + list.length, 0)} rows round-tripped` : `re-import failed: ${loadB.error ?? 'unknown'}` });

  // Lookups: every stored foreign key resolves to the same parent source id.
  const byRowid = (rows, table) => new Map((rows.get(table) ?? []).map((row) => [rowid(row), row]));
  const lookupBad = [];
  let lookupCells = 0;
  for (const fk of fks) {
    const aById = byRowid(rowsA, fk.parent);
    const bById = byRowid(rowsB, fk.parent);
    for (const childB of rowsB.get(fk.table) ?? []) {
      const cell = childB[fk.column];
      if (cell === undefined || cell === null || cell === '') continue;
      lookupCells += 1;
      const aChild = (rowsA.get(fk.table) ?? []).find((row) => sourceId(row) === sourceId(childB));
      const expected = sourceId(aById.get(String(aChild?.[fk.column] ?? '')) ?? {});
      const actual = sourceId(bById.get(String(cell)) ?? {});
      if (!expected || expected !== actual) lookupBad.push(`${fk.table}.${fk.column} row ${sourceId(childB)}: ${actual || 'unresolved'} != ${expected || 'no parent'}`);
    }
  }
  checks.push({ check: 'lookups', status: lookupBad.length ? 'fail' : 'pass', detail: lookupBad.length ? lookupBad.slice(0, 5).join('; ') : `${lookupCells} lookup cells remapped` });

  // Subforms: child-table rows landed and point at the right parent.
  const children = appTables.filter((table) => table.role === 'child');
  const subDetail = [];
  let subRows = 0;
  for (const table of children) {
    const parentKey = table.subform?.parentColumn ?? 'parent_id';
    const aRows = rowsA.get(table.name) ?? [];
    const bRows = rowsB.get(table.name) ?? [];
    subRows += aRows.length;
    const bIds = new Set(bRows.map(sourceId));
    const aParents = byRowid(rowsA, table.subform?.parentTable ?? '');
    const bParents = byRowid(rowsB, table.subform?.parentTable ?? '');
    for (const row of aRows) {
      const b = bRows.find((item) => sourceId(item) === sourceId(row));
      if (!b) { subDetail.push(`${table.name}: row ${sourceId(row)} missing`); continue; }
      const expected = sourceId(aParents.get(String(row[parentKey] ?? '')) ?? {});
      const actual = sourceId(bParents.get(String(b[parentKey])) ?? {});
      if (expected !== actual) subDetail.push(`${table.name} row ${sourceId(row)}: parent ${actual || 'unresolved'} != ${expected}`);
    }
    for (const id of [...bIds].filter((id) => !aRows.some((row) => sourceId(row) === id))) subDetail.push(`${table.name}: extra row ${id}`);
  }
  checks.push({ check: 'subforms', status: children.length === 0 ? 'gap' : subDetail.length ? 'fail' : 'pass', detail: children.length === 0 ? 'no subform fields in this app' : subDetail.length ? subDetail.slice(0, 5).join('; ') : `${subRows} subform rows re-linked` });

  // Files: object-key cells never ride a report export; the manifest lists them.
  const fileA = fileColumns.reduce((n, item) => n + (rowsA.get(item.table) ?? []).filter((row) => row[item.column]).length, 0);
  const fileB = fileColumns.reduce((n, item) => n + (rowsB.get(item.table) ?? []).filter((row) => row[item.column]).length, 0);
  const manifests = exp.files.filter((file) => file.path.startsWith('files/')).length;
  checks.push({
    check: 'files',
    status: fileA === 0 && fileColumns.length === 0 ? 'pass' : fileA === fileB && fileA > 0 ? 'pass' : 'gap',
    detail: fileA === 0 ? (fileColumns.length === 0 ? 'no file fields' : 'no file-field cells in the seed') : fileB === fileA ? `${fileA} file cells round-tripped` : `${fileB}/${fileA} file cells round-tripped; ${manifests} files/*.files.csv manifest(s) carry the rest — re-attach is the bytes stage`,
  });

  const status = checks.some((item) => item.status === 'fail') ? 'fail' : checks.some((item) => item.status === 'gap') ? 'gap' : 'pass';
  return { app: app.name, status, checks, exportWarnings: exp.warnings, uploadedObjects: sink.objects.size, loadedError: loadB.ok ? undefined : loadB.error };
}

const gallery = flag('--gallery') ?? process.env.C2C_GALLERY_DIR;
if (!positional.length && !gallery) {
  process.stderr.write('No targets given and no --gallery/C2C_GALLERY_DIR set; pass a .ds path or set the gallery dir.\n');
  process.exit(1);
}
const targets = positional.length ? positional : listTargets(gallery);
const apps = [];
for (const target of targets) {
  const name = target.split('/').pop().replace(/\.ds$/i, '');
  try {
    const result = await roundTrip(target);
    apps.push(result);
    process.stderr.write(`${result.status.toUpperCase().padEnd(4)} ${name}: ${(result.checks ?? []).map((item) => `${item.check}=${item.status}`).join(' ')}\n`);
  } catch (error) {
    apps.push({ app: name, status: 'gap', detail: `checker error: ${error instanceof Error ? error.message : String(error)}` });
    process.stderr.write(`GAP  ${name}: ${error instanceof Error ? error.message.slice(0, 120) : error}\n`);
  }
}

const totals = { pass: 0, fail: 0, gap: 0 };
for (const app of apps) totals[app.status] += 1;
const byCheck = {};
for (const app of apps) {
  for (const item of app.checks ?? []) {
    const bucket = (byCheck[item.check] ??= { pass: 0, fail: 0, gap: 0 });
    bucket[item.status] += 1;
  }
}
const cell = (check) => {
  const bucket = byCheck[check] ?? { pass: 0, fail: 0, gap: 0 };
  const fails = apps.flatMap((app) => (app.checks ?? []).filter((item) => item.check === check && item.status === 'fail').map((item) => `${app.app}: ${item.detail}`));
  return { status: bucket.fail ? 'fail' : bucket.gap && !bucket.pass ? 'gap' : 'pass', pass: bucket.pass, fail: bucket.fail, gap: bucket.gap, evidence: fails.slice(0, 10) };
};
const report = {
  version: 'c2c-d6-data-roundtrip/1',
  dimension: 'D6',
  mode: 'offline',
  seedRows: ROWS,
  apps,
  totals,
  byCheck,
  cells: {
    'D6.row-counts': cell('rows'),
    'D6.lookups': cell('lookups'),
    'D6.subforms': cell('subforms'),
    'D6.files': cell('files'),
  },
};
if (outJson) writeFileSync(resolve(outJson), `${JSON.stringify(report, null, 2)}\n`);
if (outMd) {
  const lines = ['# D6 data round trip (offline)', '', `Apps: ${apps.length} — ${totals.pass} pass, ${totals.fail} fail, ${totals.gap} gap. Seed rows: ${ROWS}/form.`, '', '| check | pass | fail | gap |', '| --- | --- | --- | --- |'];
  for (const [check, bucket] of Object.entries(byCheck).sort()) lines.push(`| ${check} | ${bucket.pass} | ${bucket.fail} | ${bucket.gap} |`);
  for (const app of apps) {
    lines.push('', `## ${app.app}`, '');
    if (app.detail) lines.push(app.detail);
    if (app.checks) lines.push('| check | status | detail |', '| --- | --- | --- |', ...app.checks.map((item) => `| ${item.check} | ${item.status} | ${item.detail.replaceAll('|', '/')} |`));
    if (app.exportWarnings?.length) lines.push('', ...app.exportWarnings.slice(0, 8).map((line) => `- ${line}`));
  }
  writeFileSync(resolve(outMd), `${lines.join('\n')}\n`);
}
process.stdout.write(`${totals.fail === 0 ? 'PASS' : 'FAIL'} ${apps.length} apps: ${totals.pass} pass ${totals.fail} fail ${totals.gap} gap\n`);
