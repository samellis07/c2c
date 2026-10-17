/**
 * Offline schema-change runner: change the app later without losing data.
 *
 * Deploys an app to the in-process Catalyst harness (the generated c2c_api
 * function over the offline SDK stand-in), seeds rows through the API, then
 * applies a sequence of Creator-side changes to a copy of the .ds. The target
 * form, its fields and the seed rows are derived from the parsed model
 * (`deriveScenarios`); a scenario the app has no form or field for is a
 * counted gap with the reason. Each change
 * goes through `c2c plan --previous`, the schema delta is applied to the
 * harness store, and the new tree is redeployed and read back. Additive
 * changes must keep every row and value; a drop or rename must be refused
 * without --allow-destructive and a verified backup, and the backup must exist
 * before the store changes. Anything c2c cannot do yet is a counted gap.
 * Nothing here opens a socket beyond 127.0.0.1 or reads a credential.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseCst } from '../../core/src/cst.js';
import { closedChoices, deriveIr, unquote, type App, type Field, type Form } from '../../core/src/ir.js';
import { generateSeed, type SeedResult } from '../../data/src/seed.js';
import { generateSchema, type SchemaColumn, type SchemaTable } from '../../schema/src/generator.js';
import { deployCli, loadApp, type Io } from './cli.js';
import { applySchemaDelta, modelPlan, planDelta, type StoreDriver } from './delta.js';
import type { FieldRename } from './edit.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from './guards.js';
import { parseCsv } from './csv.js';
import { planCli } from './offline-plan.js';
import { childIndex, recordPlan, seedRecord } from './perf-seed.js';
import { deployFiles, writeDeployTree } from './plan.js';
import { rollbackBackupProblem, rollbackExport, STORE_SYSTEM_COLUMNS } from './rollback.js';

const ORG = '10000000000';
const DC = 'in';
const SESSION = 'c2c-schema-change';

export interface SchemaChange {
  id: string;
  title: string;
  kind: 'additive' | 'destructive';
  /** Rewrites the previous .ds text into the re-export. Throws when the anchor is missing. */
  apply(ds: string): string;
  renames?: FieldRename[];
}

export interface ScenarioResult {
  id: string;
  title: string;
  kind: SchemaChange['kind'];
  status: 'PASS' | 'FAIL';
  evidence: string[];
  /** Seeded values neither in the store nor in a verified backup. Must be empty. */
  lost: string[];
  rows: { before: Record<string, number>; after: Record<string, number> };
}

export interface SchemaChangeGap {
  id: string;
  scenario: string;
  detail: string;
}

export interface SchemaChangeReport {
  schema: 'c2c-scorecard-d12/1';
  app: string;
  /** The form and fields the scenarios were derived for; absent when no form qualifies. */
  target?: ScenarioTarget;
  /** Seed cells left out because the app's admin profile may not write them (`Form.Field[.part]`). */
  seedSkipped: string[];
  /** Forms left out because the deployed API refused their seed row, with the refusal. */
  seedRefused: string[];
  scenarios: ScenarioResult[];
  gaps: SchemaChangeGap[];
  summary: { pass: number; fail: number; gaps: number };
}

type Row = Record<string, unknown>;

interface FakeSdk {
  setSession(token: string, user: unknown): void;
  state(): { tables: Record<string, Row[]> };
}

/** The scenario ids, in run order. */
export const SCENARIO_IDS = ['add-field', 'add-form', 'picklist-add', 'picklist-remove', 'rename-field', 'delete-field'] as const;

/** Seed rows per form: one row holds the choice the picklist-remove step drops. */
const SEED_ROWS = 3;
const SEED_TAG = 'c2c-schema-change';

/** Field types whose seeded cell is one scalar the store keeps as written. */
const SCALAR_TYPES = new Set(['text', 'textarea', 'email', 'number', 'decimal', 'currency', 'percent', 'url', 'phonenumber', 'date']);

/** Field types the offline seed posts no cell for: no Stratus objects and no user list offline. */
const UNSEEDED_TYPES = new Set(['upload file', 'image', 'audio', 'video', 'signature', 'users']);

/** The form the scenarios run against and the fields each scenario changes. */
export interface ScenarioTarget {
  form: string;
  /** Text field the rename-field step renames. */
  text?: string;
  /** Closed-choice picklist the picklist steps change. */
  picklist?: string;
  /** The choice a seeded row holds, removed by picklist-remove. */
  removedChoice?: string;
  addedChoice?: string;
  /** Optional scalar field the delete-field step drops. */
  deletable?: string;
  addedField: string;
  addedForm: string;
  renamedTo?: string;
}

export interface DerivedScenarios {
  target?: ScenarioTarget;
  changes: SchemaChange[];
  /** One gap per scenario the app has no form or field for. */
  gaps: SchemaChangeGap[];
  seed: SeedResult;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A line that names the field and nothing else: its declaration (after any modifiers) or a report or layout column. */
function bareLine(name: string, flags = 'm'): RegExp {
  return new RegExp(`^(\\s*(?:[a-z]+\\s+)*)${escapeRegExp(name)}((?:\\s+as\\s+"(?:[^"\\\\\\n]|\\\\.)*")?[ \\t]*)$`, flags);
}

const LABEL_LINE = /^\s*(?:displayname|description|tooltip|placeholder)\s*=\s*"/i;
/** The export header and script comments: `/* ... *\/` lines and `//` lines name no field. */
const COMMENT_LINE = /^\s*(?:\/\*|\*|\/\/)/;

/**
 * True when the field is referenced only by bare lines (its declaration and
 * report or layout columns) and display labels, so a text edit of those lines
 * renames or removes every reference. A criteria, lookup, formula, script or
 * page that names the field makes it unsuitable. With `noColumnOptions`, a
 * column line may not open an options block either (a delete would orphan it).
 */
function onlyBareReferences(ds: string, name: string, noColumnOptions: boolean): boolean {
  const word = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const bare = bareLine(name, '');
  const lines = ds.split('\n');
  let blocks = 0;
  for (const [i, line] of lines.entries()) {
    if (!word.test(line)) continue;
    if (LABEL_LINE.test(line) || COMMENT_LINE.test(line)) continue;
    if (!bare.test(line)) return false;
    const next = lines.slice(i + 1).find((l) => l.trim() !== '');
    if (next?.trim().startsWith('(')) blocks += 1;
  }
  return noColumnOptions ? blocks === 1 : blocks >= 1;
}

function freshName(ds: string, base: string): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}_${i}`;
    if (!new RegExp(`\\b${escapeRegExp(name)}\\b`).test(ds)) return name;
  }
}

function freshChoice(choices: readonly string[], base: string): string {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base} ${i}`;
    if (!choices.includes(name)) return name;
  }
}

function modelOf(ds: string): App {
  return deriveIr(parseCst(ds));
}

function fieldIn(ds: string, form: string, field: string): Field {
  const found = modelOf(ds).forms.find((f) => f.name === form)?.fields.find((f) => f.name === field);
  if (!found) throw new Error(`schema change anchor not found: ${form}.${field}`);
  return found;
}

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

function indentAt(text: string, at: number): string {
  const start = lineStart(text, at);
  return /^[ \t]*/.exec(text.slice(start))![0];
}

/** Rewrites the `values = {...}` list inside one field's declaration. */
function editChoices(ds: string, form: string, field: string, edit: (tokens: string[]) => string[]): string {
  const span = fieldIn(ds, form, field).span;
  const body = ds.slice(span.start, span.end);
  const match = /values\s*=\s*\{([^}]*)\}/.exec(body);
  if (!match) throw new Error(`schema change anchor not found: ${form}.${field} values`);
  const tokens = match[1]!.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  const at = span.start + match.index + match[0].indexOf('{');
  return `${ds.slice(0, at)}{${edit(tokens).join(',')}}${ds.slice(at + match[0].length - match[0].indexOf('{'))}`;
}

function quoteChoice(choice: string): string {
  return `"${choice.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function gap(id: string, detail: string): SchemaChangeGap {
  return { id: `no-${id}`, scenario: id, detail };
}

/**
 * The six scenarios for one app, from its parsed model. The target is the
 * first form (declaration order) with the most of: a renameable text field,
 * a closed-choice picklist with two or more choices, and a deletable optional
 * scalar field; only forms the seed can fill count (`refusedForms`: forms whose
 * seed rows the deployed API refused, with the refusal). A scenario the target
 * cannot carry is a gap with the reason, never a pass.
 */
export function deriveScenarios(app: App, ds: string, refusedForms: ReadonlyMap<string, string> = new Map()): DerivedScenarios {
  const seed = generateSeed(app, { n: SEED_ROWS, seed: SEED_TAG });
  const blocked = new Set(seed.blockers.map((b) => b.form));
  const seeded = new Map(seed.tables.map((t) => [t.form, t]));
  const names = new Map<string, number>();
  for (const form of app.forms) for (const field of form.fields) names.set(field.name, (names.get(field.name) ?? 0) + 1);
  const unique = (field: Field) => names.get(field.name) === 1 && !/[^A-Za-z0-9_]/.test(field.name);
  const type = (field: Field) => (field.type ?? '').trim().toLowerCase();
  const held = (form: string, field: string) => seeded.get(form)?.rows.map((r) => r.columns[field]).find((v) => v !== undefined && v !== '');

  const byName = new Map(app.forms.map((f) => [f.name, f]));
  const fieldsOf = (form: Form) => form.fields.flatMap((f) => [f, ...f.subfields]);
  // Why the API seed cannot fill a form (undefined when it can): the form or a
  // form its seed rows look up is blocked, has no seeded rows, has a required
  // cell the offline seed leaves out (file, image, users ...), or refused a seed
  // row; or the rows look each other up in a cycle (no posting order exists).
  const unfillable = (name: string): string | undefined => {
    const deps = seedDependencies(seed, name);
    if (!seedOrder(seed, [...deps])) return `${name}: its seed rows and the rows they look up (${[...deps].sort(compareText).join(', ')}) look each other up in a cycle`;
    for (const dep of deps) {
      const form = byName.get(dep);
      if (!form) continue;
      const via = dep === name ? '' : ` (looked up by ${name})`;
      if (refusedForms.has(dep)) return `${dep}${via}: the deployed API refused a seed row: ${refusedForms.get(dep)}`;
      if (blocked.has(dep)) return `${dep}${via}: ${seed.blockers.find((b) => b.form === dep)!.message}`;
      if (!seeded.get(dep)?.rows.length) return `${dep}${via}: the seed generates no rows`;
      const unseeded = fieldsOf(form).find((f) => f.required && UNSEEDED_TYPES.has(type(f)));
      if (unseeded) return `${dep}${via}: required ${type(unseeded)} field ${unseeded.name} has no offline seed value`;
    }
    return undefined;
  };
  const refused: string[] = [];
  let best: { form: Form; text?: Field; picklist?: Field; deletable?: Field; score: number } | undefined;
  for (const form of app.forms) {
    const why = form.fields.length ? unfillable(form.name) : `${form.name}: no fields`;
    if (why) {
      refused.push(why);
      continue;
    }
    const text = form.fields.find((f) => type(f) === 'text' && unique(f) && held(form.name, f.name) !== undefined && onlyBareReferences(ds, f.name, false));
    const picklist = form.fields.find((f) => (closedChoices(f)?.length ?? 0) >= 2 && held(form.name, f.name) !== undefined);
    const deletable = [...form.fields]
      .reverse()
      .find((f) => f !== text && f !== picklist && SCALAR_TYPES.has(type(f)) && !f.required && !f.unique && unique(f) && held(form.name, f.name) !== undefined && onlyBareReferences(ds, f.name, true));
    const score = Number(!!text) + Number(!!picklist) + Number(!!deletable);
    if (!best || score > best.score) best = { form, text, picklist, deletable, score };
  }

  const gaps: SchemaChangeGap[] = [];
  if (!best) {
    const detail = `no form the seed can fill${refused.length ? `: ${refused.join('; ')}` : ' (the app declares no form)'}`;
    for (const id of SCENARIO_IDS) gaps.push(gap(id, detail));
    return { changes: [], gaps, seed };
  }
  const form = best.form.name;
  const choices = best.picklist ? closedChoices(best.picklist)! : [];
  const target: ScenarioTarget = {
    form,
    addedField: freshName(ds, 'Added_Field'),
    addedForm: freshName(ds, 'Added_Form'),
    ...(best.text ? { text: best.text.name, renamedTo: freshName(ds, `${best.text.name}_Renamed`) } : {}),
    ...(best.picklist ? { picklist: best.picklist.name, removedChoice: held(form, best.picklist.name)!, addedChoice: freshChoice(choices, 'Added Choice') } : {}),
    ...(best.deletable ? { deletable: best.deletable.name } : {}),
  };
  const changes: SchemaChange[] = [
    {
      id: 'add-field',
      title: `add field ${form}.${target.addedField}`,
      kind: 'additive',
      apply: (text) => {
        const fields = modelOf(text).forms.find((f) => f.name === form)?.fields ?? [];
        const last = fields[fields.length - 1];
        if (!last) throw new Error(`schema change anchor not found: ${form} fields`);
        const ind = indentAt(text, last.span.start);
        const block = `\n${ind}${target.addedField}\n${ind}(\n${ind}\ttype = text\n${ind}\tdisplayname = "${target.addedField.replace(/_/g, ' ')}"\n${ind})`;
        return text.slice(0, last.span.end) + block + text.slice(last.span.end);
      },
    },
    {
      id: 'add-form',
      title: `add form ${target.addedForm}`,
      kind: 'additive',
      apply: (text) => {
        const at = modelOf(text).forms.find((f) => f.name === form)?.span.start;
        if (at === undefined) throw new Error(`schema change anchor not found: form ${form}`);
        const ind = indentAt(text, at);
        const start = lineStart(text, at);
        const block = `${ind}form ${target.addedForm}\n${ind}{\n${ind}\tName_Text\n${ind}\t(\n${ind}\t\ttype = text\n${ind}\t\tdisplayname = "Name Text"\n${ind}\t)\n${ind}}\n`;
        return text.slice(0, start) + block + text.slice(start);
      },
    },
  ];
  if (target.picklist) {
    const field = target.picklist;
    changes.push(
      {
        id: 'picklist-add',
        title: `add choice "${target.addedChoice}" to ${form}.${field}`,
        kind: 'additive',
        apply: (text) => editChoices(text, form, field, (tokens) => [...tokens, quoteChoice(target.addedChoice!)]),
      },
      {
        id: 'picklist-remove',
        title: `remove choice "${target.removedChoice}" from ${form}.${field} (a seeded row holds it)`,
        kind: 'additive',
        apply: (text) =>
          editChoices(text, form, field, (tokens) => {
            const kept = tokens.filter((t) => unquote(t) !== target.removedChoice);
            if (kept.length === tokens.length) throw new Error(`schema change anchor not found: ${form}.${field} choice ${target.removedChoice}`);
            return kept;
          }),
      },
    );
  } else {
    const reason = `form ${form} has no closed-choice picklist with two or more choices that the seed fills`;
    gaps.push(gap('picklist-add', reason), gap('picklist-remove', reason));
  }
  if (target.text) {
    const from = target.text;
    const to = target.renamedTo!;
    changes.push({
      id: 'rename-field',
      title: `rename field ${form}.${from} -> ${to}`,
      kind: 'destructive',
      apply: (text) => {
        const bare = bareLine(from, 'gm');
        if (!bare.test(text)) throw new Error(`schema change anchor not found: ${form}.${from}`);
        return text.replace(bare, `$1${to}$2`);
      },
      renames: [{ form, from, to }],
    });
  } else {
    gaps.push(gap('rename-field', `form ${form} has no text field with seeded values whose only references are its declaration and report columns`));
  }
  if (target.deletable) {
    const name = target.deletable;
    changes.push({
      id: 'delete-field',
      title: `delete field ${form}.${name}`,
      kind: 'destructive',
      apply: (text) => {
        const span = fieldIn(text, form, name).span;
        const end = text[span.end] === '\n' ? span.end + 1 : span.end;
        const cut = text.slice(0, lineStart(text, span.start)) + text.slice(end);
        return cut.replace(new RegExp(`${bareLine(name).source}\\n`, 'gm'), '');
      },
    });
  } else {
    gaps.push(gap('delete-field', `form ${form} has no optional, non-unique scalar field with seeded values whose only references are its declaration and report columns`));
  }
  changes.sort((a, b) => SCENARIO_IDS.indexOf(a.id as (typeof SCENARIO_IDS)[number]) - SCENARIO_IDS.indexOf(b.id as (typeof SCENARIO_IDS)[number]));
  return { target, changes, gaps, seed };
}

function guardFor(app: App): GuardOk {
  return {
    org: ORG,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: DC,
    registry: { org: ORG, env: 'Development', projects: {}, dc: DC },
  };
}

/** An Io that refuses any network or process: the runner is offline. */
function offlineIo(): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    spawn: () => {
      throw new Error('schema-change runner: no process spawn offline');
    },
    fetch: () => Promise.reject(new Error('schema-change runner: no network offline')),
  } as Io & { out: string[]; err: string[] };
}

/** The in-process harness: one deployed c2c_api at a time over the shared offline SDK. */
class Harness {
  private server: Server | undefined;
  private port = 0;
  readonly sdk: FakeSdk;
  private readonly restore: () => void;
  readonly columns = new Map<string, string[]>();

  constructor(private readonly sdkPath: string) {
    const moduleAny = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
    const original = moduleAny._resolveFilename;
    moduleAny._resolveFilename = function resolveFake(this: unknown, request: string, ...rest: unknown[]) {
      if (request === 'zcatalyst-sdk-node') return sdkPath;
      return original.call(this, request, ...rest);
    };
    this.restore = () => {
      moduleAny._resolveFilename = original;
    };
    this.sdk = createRequire(import.meta.url)(sdkPath) as FakeSdk;
    for (const rows of Object.values(this.sdk.state().tables)) rows.splice(0);
    this.sdk.setSession(SESSION, { user_id: '1', email_id: 'admin@example.test', role_details: { role_name: 'App Administrator' } });
  }

  /** Empties every table (the column lists stay). */
  clear(): void {
    for (const rows of Object.values(this.sdk.state().tables)) rows.splice(0);
  }

  tables(): Record<string, Row[]> {
    return this.sdk.state().tables;
  }

  private routes: Record<string, string> = {};

  /** The path when the deployed c2c_api serves `POST path`. */
  route(path: string): string | undefined {
    return this.routes[`POST ${path}`] ? path : undefined;
  }

  async deploy(app: App, dir: string): Promise<void> {
    await this.stop();
    writeDeployTree(dir, deployFiles(app, guardFor(app), false, { mode: 'live' }).files);
    this.routes = JSON.parse(readFileSync(join(dir, 'functions/c2c_api/routes.json'), 'utf8')) as Record<string, string>;
    const entry = createRequire(import.meta.url)(join(dir, 'functions/c2c_api/index.js')) as (rq: IncomingMessage, rs: ServerResponse) => Promise<void>;
    this.server = createServer((rq, rs) => void entry(rq, rs));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  async post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`http://127.0.0.1:${this.port}/server/c2c_api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `c2c-harness-session=${SESSION}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = { raw };
    }
    return { status: res.status, body: parsed };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  async close(): Promise<void> {
    await this.stop();
    this.restore();
  }

  /** A StoreDriver over the harness tables; column lists are tracked beside the rows. */
  driver(): StoreDriver {
    const rows = (table: string) => this.tables()[table] ?? [];
    const filled = (value: unknown) => value !== undefined && value !== null && value !== '';
    return {
      columns: async (table) => this.columns.get(table)?.slice(),
      rowCount: async (table) => rows(table).length,
      valueCount: async (table, column) => rows(table).filter((row) => filled(row[column])).length,
      createTable: async (table: SchemaTable) => {
        this.columns.set(table.name, table.columns.map((c) => c.name));
      },
      addColumn: async (table: string, column: SchemaColumn) => {
        this.columns.get(table)!.push(column.name);
      },
      renameColumn: async (table, from, to) => {
        this.columns.set(table, this.columns.get(table)!.map((c) => (c === from ? to : c)));
        for (const row of rows(table)) {
          if (from in row) {
            row[to] = row[from];
            delete row[from];
          }
        }
      },
      alterColumn: async () => {},
      dropColumn: async (table, column) => {
        this.columns.set(table, this.columns.get(table)!.filter((c) => c !== column));
        for (const row of rows(table)) delete row[column];
      },
      dropTable: async (table) => {
        this.columns.delete(table);
        rows(table).splice(0);
      },
    };
  }
}

function snapshot(tables: Record<string, Row[]>): Map<string, Map<string, Row>> {
  const out = new Map<string, Map<string, Row>>();
  for (const [table, list] of Object.entries(tables)) {
    out.set(table, new Map(list.map((row) => [String(row.ROWID), { ...row }])));
  }
  return out;
}

function counts(snap: Map<string, Map<string, Row>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, rows] of [...snap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) if (rows.size) out[table] = rows.size;
  return out;
}

/** Per table, per ROWID, the exported cell of each column (header = field name). */
type BackupCells = Map<string, Map<string, Map<string, string>>>;

/**
 * Read a rollback export back: import/<Form>.csv row i is ids/<Form>.ids.csv
 * row i, which carries the store ROWID.
 */
function backupCells(app: App, files: readonly { path: string; body: string }[]): BackupCells {
  const out: BackupCells = new Map();
  const body = new Map(files.map((file) => [file.path, file.body]));
  for (const table of generateSchema(app).tables) {
    if (table.role !== 'form') continue;
    const data = body.get(`import/${table.form}.csv`);
    const ids = body.get(`ids/${table.form}.ids.csv`);
    if (!data || !ids) continue;
    const [header, ...rows] = parseCsv(data);
    const [idHeader, ...idRows] = parseCsv(ids);
    const rowidAt = idHeader!.indexOf('ROWID');
    const cells = new Map<string, Map<string, string>>();
    rows.forEach((row, i) => {
      const rowid = idRows[i]?.[rowidAt];
      if (rowid) cells.set(rowid, new Map(header!.map((name, j) => [name, row[j] ?? ''])));
    });
    out.set(table.name, cells);
  }
  return out;
}

/**
 * Seeded values that the store no longer holds (under the same or the renamed
 * column), unless the delta drops that column and the verified backup holds the value.
 */
function lostValues(before: Map<string, Map<string, Row>>, after: Map<string, Map<string, Row>>, renames: readonly { table: string; from: string; to: string }[], dropped: ReadonlySet<string>, backup: BackupCells | undefined): string[] {
  const lost: string[] = [];
  for (const [table, rows] of before) {
    for (const [rowid, row] of rows) {
      const now = after.get(table)?.get(rowid);
      for (const [column, value] of Object.entries(row)) {
        if (STORE_SYSTEM_COLUMNS.has(column) || value === undefined || value === null || value === '') continue;
        const moved = renames.find((r) => r.table === table && r.from === column)?.to ?? column;
        if (now && now[moved] === value) continue;
        // Only a column the delta drops may leave the store, and only into the backup.
        if (dropped.has(`${table}.${column}`) && backup?.get(table)?.get(rowid)?.get(column) === String(value)) continue;
        lost.push(`${table}.${column} row ${rowid}: ${JSON.stringify(value)}${now ? '' : ' (row gone)'}`);
      }
    }
  }
  return lost;
}

/**
 * The other forms one form's seed rows (and their subform and multi-lookup
 * rows, `<Form>__<Field>` tables) look up: a seed id cell names the looked-up
 * row as `<Form>#<tag>#<n>`.
 */
function seedLookups(seed: SeedResult, form: string): Set<string> {
  const owner = new Map<string, string>();
  for (const table of seed.tables) for (const row of table.rows) owner.set(row.id, table.form);
  const out = new Set<string>();
  for (const table of seed.tables) {
    if (table.form !== form && table.form.split('__')[0] !== form) continue;
    for (const row of table.rows) {
      for (const value of Object.values(row.columns)) {
        const dep = owner.get(value);
        if (dep && dep !== form) out.add(dep);
      }
    }
  }
  return out;
}

/** The forms in posting order, each after every form its rows look up; undefined on a lookup cycle. */
function seedOrder(seed: SeedResult, forms: readonly string[]): string[] | undefined {
  const pending = [...forms];
  const order: string[] = [];
  while (pending.length) {
    const next = pending.findIndex((name) => [...seedLookups(seed, name)].every((dep) => order.includes(dep)));
    if (next < 0) return undefined;
    order.push(pending.splice(next, 1)[0]!);
  }
  return order;
}

/** The form and every form its seed rows look up, transitively. */
export function seedDependencies(seed: SeedResult, form: string): Set<string> {
  const out = new Set<string>();
  const visit = (name: string) => {
    if (out.has(name)) return;
    out.add(name);
    for (const dep of seedLookups(seed, name)) visit(dep);
  };
  visit(form);
  return out;
}

/** The `Field[.part]` a 403 record-access refusal (field permission or field rule) names for this form, if any. */
function unwritable(form: string, res: { status: number; body: Record<string, unknown> }): string | undefined {
  if (res.status !== 403) return undefined;
  const match = /^record access: (?:profile .* cannot write (\S+)|(\S+) is (?:hidden|disabled) by a field rule)$/.exec(String(res.body.message ?? ''));
  const cell = match?.[1] ?? match?.[2];
  return cell?.startsWith(`${form}.`) ? cell.slice(form.length + 1) : undefined;
}

/** Removes `Field` or `Field.part` from a seed record; false when it is not there. */
function dropCell(record: Row, cell: string): boolean {
  const [field, part] = cell.split('.', 2) as [string, string | undefined];
  if (!(field in record)) return false;
  const group = record[field];
  if (part === undefined || typeof group !== 'object' || group === null) {
    delete record[field];
    return true;
  }
  if (!(part in group)) return false;
  delete (group as Row)[part];
  if (!Object.keys(group).length) delete record[field];
  return true;
}

/**
 * Posts the target form's seed rows and the rows they look up, parents first.
 * Returns the first refusal (form and response) or undefined when every row landed.
 */
async function seedTarget(harness: Harness, app: App, derived: DerivedScenarios, skipped: string[]): Promise<{ form: string; detail: string } | undefined> {
  if (!derived.target) return undefined;
  const plan = recordPlan(app, derived.seed);
  const children = childIndex(derived.seed, plan);
  const rowIds = new Map<string, string>();
  const needed = seedDependencies(derived.seed, derived.target.form);
  const order = seedOrder(derived.seed, plan.forms.filter((name) => needed.has(name)));
  if (!order) return { form: derived.target.form, detail: 'its seed rows look each other up in a cycle' };
  for (const form of order) {
    for (const row of derived.seed.tables.find((t) => t.form === form)?.rows ?? []) {
      const record = seedRecord(form, row, plan, rowIds, children);
      // A form with an on-success workflow takes its writes on /success.
      const route = harness.route(`/forms/${form}/success`) ?? `/forms/${form}/submit`;
      let res = await harness.post(route, { record });
      // The app's own field permissions bind the seed too: leave out a cell the admin profile cannot write.
      for (let cell = unwritable(form, res); cell && dropCell(record, cell); cell = unwritable(form, res)) {
        if (!skipped.includes(`${form}.${cell}`)) skipped.push(`${form}.${cell}`);
        res = await harness.post(route, { record });
      }
      // No principal is the harness session, not the app refusing a row.
      if (res.status === 401) throw new Error(`seed ${form}: the harness session is not signed in (${String(res.body.message ?? res.status)})`);
      if (res.status !== 200) return { form, detail: `${res.status} ${String(res.body.message ?? JSON.stringify(res.body))}` };
      const rowid = (res.body.values as { ROWID?: unknown } | undefined)?.ROWID;
      if (rowid !== undefined) rowIds.set(row.id, String(rowid));
    }
  }
  return undefined;
}

export interface RunOptions {
  /** The deployed .ds. */
  ds: string;
  /** Scratch directory for the copies, plans, deploy trees and backups. */
  workDir: string;
  /** Path to the offline SDK stand-in (tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs). */
  sdkPath: string;
  /** Run these changes instead of the ones derived from the model (the runner's own tests). */
  changes?: readonly SchemaChange[];
  /** Fault injection for the runner's own tests: wrap the store driver. */
  wrapDriver?: (driver: StoreDriver) => StoreDriver;
  /** Fault injection: apply destructive changes without taking the backup first. */
  skipBackup?: boolean;
}

export async function runSchemaChangeScenarios(opts: RunOptions): Promise<SchemaChangeReport> {
  mkdirSync(opts.workDir, { recursive: true });
  let prevPath = join(opts.workDir, '0-deployed', 'app.ds');
  mkdirSync(dirname(prevPath), { recursive: true });
  let prevText = readFileSync(opts.ds, 'utf8');
  writeFileSync(prevPath, prevText);
  let prev = loadApp(prevPath);
  const harness = new Harness(opts.sdkPath);
  const scenarios: ScenarioResult[] = [];
  const seedSkipped: string[] = [];
  const refusedForms = new Map<string, string>();
  let derived = deriveScenarios(prev, prevText, refusedForms);
  const gaps: SchemaChangeGap[] = [];
  try {
    await harness.deploy(prev, join(opts.workDir, '0-deployed', 'tree'));
    for (const table of generateSchema(prev).tables) harness.columns.set(table.name, table.columns.map((c) => c.name));
    // A form whose seed row the app refuses (a validate script, say) is left
    // out and the target chosen again from the rest, on an empty store.
    for (let refusal = await seedTarget(harness, prev, derived, seedSkipped); refusal; refusal = await seedTarget(harness, prev, derived, seedSkipped)) {
      refusedForms.set(refusal.form, refusal.detail);
      harness.clear();
      seedSkipped.splice(0);
      derived = deriveScenarios(prev, prevText, refusedForms);
    }
    if (!opts.changes) gaps.push(...derived.gaps);
    const driver = opts.wrapDriver ? opts.wrapDriver(harness.driver()) : harness.driver();
    const changes = opts.changes ?? derived.changes;

    for (const [index, change] of changes.entries()) {
      const dir = join(opts.workDir, `${index + 1}-${change.id}`);
      mkdirSync(dir, { recursive: true });
      const evidence: string[] = [];
      let ok = true;
      const check = (cond: boolean, line: string) => {
        evidence.push(`${cond ? 'ok' : 'FAIL'}: ${line}`);
        if (!cond) ok = false;
      };
      const before = snapshot(harness.tables());
      const nextText = change.apply(prevText);
      const nextPath = join(dir, 'app.ds');
      writeFileSync(nextPath, nextText);
      const next = loadApp(nextPath);
      const renameArgs = (change.renames ?? []).flatMap((r) => ['--rename', `${r.form}.${r.from}=${r.to}`]);
      const plan = async (extra: string[]) => {
        const io = offlineIo();
        const code = await planCli([nextPath, '--out', join(dir, 'plan'), '--dc', DC, '--previous', prevPath, '--allow-budget-fail', ...renameArgs, ...extra], io);
        return { code, out: io.out.join(''), err: io.err.join('') };
      };
      let backup: BackupCells | undefined;
      const delta = planDelta(modelPlan(prev, DC), modelPlan(next, DC), { app: next.name || 'app', edits: [], renames: change.renames ?? [] });
      const schemaOps = [...delta.tables.map((t) => `${t.op} table ${t.table}`), ...delta.columns.map((c) => (c.op === 'rename' ? `rename ${c.table}.${c.from}->${c.to}` : `${c.op} ${c.table}.${'column' in c ? c.column : ''}`))];
      evidence.push(`schema delta: ${schemaOps.length ? schemaOps.join(', ') : 'none'}`);
      let backedUp: Set<string> | undefined;

      if (change.kind === 'additive') {
        const first = await plan([]);
        check(first.code === 0, `c2c plan --previous exits 0 without --allow-destructive (exit ${first.code}${first.err ? `: ${first.err.trim().split('\n')[0]}` : ''})`);
        for (const line of first.out.split('\n').filter((l) => l.startsWith('note: '))) evidence.push(`plan ${line}`);
      } else {
        const refused = await plan([]);
        check(refused.code === 1 && /next steps:/.test(refused.err) && /c2c rollback-export/.test(refused.err), `c2c plan --previous refuses without --allow-destructive and names the next step (exit ${refused.code})`);
        const noBackup = await plan(['--allow-destructive']);
        check(noBackup.code === 1 && /needs --backup/.test(noBackup.err), `--allow-destructive alone is refused: a backup is required (exit ${noBackup.code})`);
        const bogus = join(dir, 'not-a-backup');
        mkdirSync(bogus, { recursive: true });
        const badBackup = await plan(['--allow-destructive', '--backup', bogus]);
        check(badBackup.code === 1 && /not a verified export|no readable/.test(badBackup.err), `an unverified --backup is refused (exit ${badBackup.code})`);
        const backupDir = join(dir, 'backup');
        if (!opts.skipBackup) {
          const rows = new Map(Object.entries(harness.tables()).map(([table, list]) => [table, list.map((row) => ({ ...row }))]));
          const exported = rollbackExport(prev, rows);
          for (const file of [...exported.files, exported.manifest]) {
            const path = join(backupDir, file.path);
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, file.body);
          }
          backup = backupCells(prev, exported.files);
          backedUp = new Set(Object.keys((JSON.parse(exported.manifest.body) as { tables: Record<string, string> }).tables));
        }
        const problem = rollbackBackupProblem(backupDir, prev);
        check(problem === undefined, `a verified rollback export exists before the store changes${problem ? ` (${problem})` : ` (${backupDir})`}`);
        const allowed = await plan(['--allow-destructive', '--backup', backupDir]);
        check(allowed.code === 0, `c2c plan --previous --allow-destructive --backup exits 0 (exit ${allowed.code}${allowed.err ? `: ${allowed.err.trim().split('\n')[0]}` : ''})`);
        const deployIo = offlineIo();
        const deployCode = await deployCli([nextPath, '--previous', prevPath, '--dc', DC, ...renameArgs], deployIo);
        const refusal = deployIo.err.join('').split('\n').filter((l) => l.startsWith('- '));
        evidence.push(`c2c deploy --previous (live table step) exit ${deployCode}${refusal.length ? `: ${refusal.join('; ')}` : ''}`);
        if (deployCode !== 0) for (const line of refusal) gaps.push({ id: `live-${change.id}`, scenario: change.id, detail: line.slice(2) });
      }

      if (ok) {
        try {
          const applied = await applySchemaDelta(delta, generateSchema(next), driver, { confirm: change.kind === 'destructive', ...(backedUp ? { backedUp } : {}) });
          evidence.push(`store delta applied: ${applied.applied.length ? applied.applied.join(', ') : 'nothing to change'}${applied.skipped.length ? `; skipped: ${applied.skipped.join(', ')}` : ''}`);
        } catch (err) {
          check(false, `store delta: ${err instanceof Error ? err.message : String(err)}`);
        }
        await harness.deploy(next, join(dir, 'tree'));
        const form = derived.target?.form;
        const table = generateSchema(next).tables.find((t) => t.role === 'form' && t.form === form)?.name;
        const sample = table ? [...(before.get(table)?.keys() ?? [])][0] : undefined;
        if (form && sample) {
          const read = await harness.post(`/forms/${form}/record`, { ROWID: sample });
          check(read.status === 200, `redeployed c2c_api reads ${form} row ${sample} back (HTTP ${read.status})`);
        }
      }
      const after = snapshot(harness.tables());
      const renamed = delta.columns.flatMap((c) => (c.op === 'rename' ? [{ table: c.table, from: c.from, to: c.to }] : []));
      const dropped = new Set(delta.columns.flatMap((c) => (c.op === 'drop' ? [`${c.table}.${c.column}`] : [])));
      const lost = lostValues(before, after, renamed, dropped, backup);
      check(lost.length === 0, `no seeded value lost (rows ${JSON.stringify(counts(before))} -> ${JSON.stringify(counts(after))})`);
      scenarios.push({ id: change.id, title: change.title, kind: change.kind, status: ok ? 'PASS' : 'FAIL', evidence, lost, rows: { before: counts(before), after: counts(after) } });
      if (change.id === 'picklist-remove') {
        gaps.push({ id: 'picklist-stored-values', scenario: change.id, detail: 'a removed choice is reported as a plan note; c2c does not list or remap the stored rows that still hold it' });
      }
      if (ok) {
        prevText = nextText;
        prevPath = nextPath;
        prev = next;
      }
    }
  } finally {
    await harness.close();
  }
  gaps.push({ id: 'deployed-model-not-recorded', scenario: '*', detail: 'the deploy state keeps a bundle digest, not the deployed model: the operator must pass the deployed .ds as --previous' });
  gaps.push({ id: 'creator-rename-undetectable', scenario: 'rename-field', detail: 'a .ds re-export carries no rename record: without --rename Form.Old=New a renamed field reads as a drop plus an add' });
  const pass = scenarios.filter((s) => s.status === 'PASS').length;
  return { schema: 'c2c-scorecard-d12/1', app: prev.name || 'app', ...(derived.target ? { target: derived.target } : {}), seedSkipped, seedRefused: [...refusedForms].map(([form, detail]) => `${form}: ${detail}`), scenarios, gaps, summary: { pass, fail: scenarios.length - pass, gaps: gaps.length } };
}

export function formatSchemaChangeReport(report: SchemaChangeReport): string {
  const lines = [`# D12 schema change + redeploy (offline): ${report.app}`, '', `PASS ${report.summary.pass}, FAIL ${report.summary.fail}, gaps ${report.summary.gaps}`, ''];
  const t = report.target;
  lines.push(
    t
      ? `Target form ${t.form}: text ${t.text ?? '(none)'}, picklist ${t.picklist ?? '(none)'}${t.removedChoice ? ` (removes "${t.removedChoice}")` : ''}, deletable ${t.deletable ?? '(none)'}`
      : 'Target form: none (no form the seed can fill)',
    '',
  );
  if (report.seedRefused.length) lines.push(`Forms left out (the deployed API refused a seed row): ${report.seedRefused.join('; ')}`, '');
  if (report.seedSkipped.length) lines.push(`Seed cells the app's admin profile may not write (left out): ${report.seedSkipped.join(', ')}`, '');
  lines.push('| # | Scenario | Kind | Result | Rows before -> after | Lost values |', '|---|---|---|---|---|---|');
  for (const [i, s] of report.scenarios.entries()) {
    lines.push(`| ${i + 1} | ${s.title} | ${s.kind} | ${s.status} | ${JSON.stringify(s.rows.before)} -> ${JSON.stringify(s.rows.after)} | ${s.lost.length} |`);
  }
  for (const s of report.scenarios) {
    lines.push('', `## ${s.id}: ${s.status}`, '', ...s.evidence.map((e) => `- ${e}`), ...s.lost.map((l) => `- lost: ${l}`));
  }
  lines.push('', '## Gaps (counted)', '', ...report.gaps.map((g, i) => `${i + 1}. ${g.id} (${g.scenario}): ${g.detail}`), '');
  return lines.join('\n');
}
