/**
 * Pre-migration readiness report for one app. Parse-only: no deploy, no network.
 *
 * Inputs are the existing pipeline outputs: feature detectors (core), Deluge
 * translation (deluge generate), schema plan (schema) and UI summary (ui).
 * Every number is a count; no source text is emitted.
 *
 * Verdict per matrix row: verified or migrated → supported; adapter-written → adapter;
 * built-in-Creator (Catalyst lacks it; a fill is designed, not verified) → gap;
 * unknown (matrix status not yet assessed) → needs-assessment, listed apart, not a blocker;
 * hard-gap (documented hard gap, no adapter design) → blocker. "not a Creator feature" rows are excluded.
 * Statuses come from the committed matrix snapshot (see MATRIX_SNAPSHOT); verdicts are provisional until it is refreshed.
 *
 * Score (0..100, integers): readiness = round(0.5 * features + 0.5 * deluge)
 *   features: mean weight over observed matrix features (supported 1, adapter 0.75,
 *             needs-assessment 0.5, gap 0.25, blocker 0); 100 when no matrix feature is observed.
 *   deluge:   (translated + 0.8 * shimmed) / statements * 100; 100 when no statements.
 *   band:     ready when readiness >= 85 and no blockers; needs-work when >= 60; otherwise blocked.
 *
 * Effort and resources are estimates. Weights are the constants in EFFORT_WEIGHTS.
 */

import { FEATURES, appFacts, widgetManualItems, type App, type Dialect, type RawDeluge } from '../../core/src/index.js';
import { compareEnUs } from '../../core/src/order.js';
import { dedupeTodos, generate, reportLock, residualDeterminism, type FillLock, type TodoItem } from '../../deluge/src/index.js';
import { fieldGapsOf, generateSchema, type FieldGap } from '../../schema/src/index.js';
import { buildUi, type UiTodo } from '../../ui/src/index.js';
import { FEATURE_MATRIX, MATRIX_SNAPSHOT, type MatrixSnapshot } from './feature-matrix.js';
import { ownerScope, type ScopeEntry } from './scope-labels.js';

export type Verdict = 'supported' | 'adapter' | 'needs-assessment' | 'gap' | 'blocker';

const VERDICT_OF_STATUS: Record<string, Verdict | undefined> = {
  verified: 'supported',
  migrated: 'supported',
  'adapter-written': 'adapter',
  'built-in-Creator': 'gap',
  unknown: 'needs-assessment',
  'hard-gap': 'blocker',
};

const WEIGHT: Record<Verdict, number> = { supported: 1, adapter: 0.75, 'needs-assessment': 0.5, gap: 0.25, blocker: 0 };

export const EFFORT_WEIGHTS = {
  hoursPerFeature: { supported: 0, adapter: 2, 'needs-assessment': 4, gap: 8, blocker: 16 },
  hoursPerShimmedStatement: 0.1,
  hoursPerTodoStatement: 1,
  hoursPerSchemaTable: 0.5,
  hoursPerTodoForm: 4,
  hoursPerTodoReport: 4,
  hoursPerTodoPage: 8,
  hoursPerCronJob: 1,
} as const;

const SHIMMED_CREDIT = 0.8;

/** FEATURES row (`area|feature`) → matrix row (`area|feature`) when the names differ. */
const FEATURE_ALIAS: Record<string, string> = {
  'Deluge|File tasks (upload, download)': 'Deluge|File tasks',
  'Deluge|sendsms': 'Deluge|SMS (sendsms / twilio.sms.send etc.)',
  'Field property|System Added Time / Modified Time': 'Field property|System Added / Modified Time',
  'Field type|Barcode / QR code': 'Field type|QR / Barcode field (generated code image)',
  'Field type|Checkbox': 'Field type|Checkbox (multi)',
  'Field type|Geolocation (distinct field)': 'Field type|Geolocation (Address geo capture / Added Location)',
  'Field type|Integration': 'Field type|Integration field',
  'Field type|Lookup multi (multi select or checkbox)': 'Field type|Lookup multi',
  'Field type|Lookup single (dropdown or radio)': 'Field type|Lookup single',
  'Mobile and locale|Barcode scan on mobile': 'Mobile and locale|Barcode / QR scan on mobile',
  'Report|Switch view (list, spreadsheet, kanban, calendar, timeline)': 'Report|Switch view',
  'Workflow|Approval with 2+ levels (not a matrix row)': 'Workflow|Approval (multi-level)',
};

export interface FeatureUse {
  id: number;
  area: string;
  feature: string;
  status: string;
  verdict: Verdict;
  uses: number;
}

export interface DelugeLocation {
  location: string;
  construct: string;
  /**
   * `unit` — the hole sits in a workflow or function script.
   * `app` — the hole is application-level (a report criteria or named filter).
   * `ui` — the hole is one generated UI stub. The location names the field, report, or page.
   */
  scope: 'app' | 'unit' | 'ui';
}

export interface Blocker {
  /**
   * `feature` — a matrix blocker. `deluge` — a residual hole in a script or an
   * application-level construct. `ui` — a residual hole that is one generated
   * UI stub.
   */
  kind: 'feature' | 'deluge' | 'ui';
  label: string;
  detail: string;
  /** Residual-hole blockers only. Same meaning as `DelugeLocation.scope`. */
  scope?: 'app' | 'unit' | 'ui';
}

export interface TodoKind {
  construct: string;
  count: number;
}

/**
 * Deterministic-migration flag. `deterministic` is true only when the app has
 * zero residual TODO items and no fill-todos lock entries are applied to it.
 * Any lock fill — even for a construct with vector coverage — is a
 * host-authored overlay, so it disqualifies the app.
 */
export interface DeterminismInfo {
  deterministic: boolean;
  todoCount: number;
  fillLockEntries: number;
  todoKinds: TodoKind[];
  /**
   * Generated UI stubs, one per unmigrated field, report, page, or ZML item.
   * Each stub is also one residual hole (scope `ui`), so it is included in
   * `todoCount` and an app with any stub is not deterministic.
   */
  uiTodoCount: number;
}

export interface AnalyzeReport {
  schema: 'c2c-analyze/1';
  app: { name: string | null; shape: string; dialect: Dialect };
  matrix: MatrixSnapshot;
  features: {
    used: FeatureUse[];
    counts: Record<Verdict, number>;
    needsAssessment: { id: number; area: string; feature: string; uses: number }[];
    /** Owner scope. Same list on every app; it is not a usage count. */
    scope: ScopeEntry[];
    excluded: number;
    unmapped: { area: string; feature: string; uses: number }[];
    notObservable: number;
  };
  /** Partial and unsupported field behavior, listed by schema mapping id. */
  fieldGaps: FieldGap[];
  deluge: {
    units: number;
    statements: number;
    translated: number;
    shimmed: number;
    todo: number;
    todoLocations: DelugeLocation[];
  };
  blockers: Blocker[];
  determinism: DeterminismInfo;
  score: { readiness: number; band: 'ready' | 'needs-work' | 'blocked'; features: number; deluge: number };
  effort: { estimate: true; hours: number; weights: typeof EFFORT_WEIGHTS };
  catalyst: {
    tables: number;
    nosqlCollections: number;
    delugeUnits: number;
    functions: number;
    cronJobs: number;
    slatePages: number;
    cost: 'not estimated';
  };
}

const byText = (a: string, b: string) => compareEnUs(a, b);

interface DelugeUnit {
  label: string;
  span: RawDeluge;
  lineStarts: number[];
}

interface Ranged { start: number; end: number }

/** A sorted interval index; queries visit only intervals that may overlap. */
class IntervalIndex<T> {
  private readonly entries: { value: T; order: number; start: number; end: number; prefixEnd: number }[];

  constructor(values: readonly T[], range: (value: T) => Ranged) {
    let prefixEnd = Number.NEGATIVE_INFINITY;
    this.entries = values.map((value, order) => ({ value, order, ...range(value), prefixEnd: 0 }))
      .sort((a, b) => a.start - b.start || a.order - b.order)
      .map((entry) => {
        prefixEnd = Math.max(prefixEnd, entry.end);
        return { ...entry, prefixEnd };
      });
  }

  containing(offset: number): T[] {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid]!.start <= offset) lo = mid + 1;
      else hi = mid;
    }
    const out: { value: T; order: number }[] = [];
    for (let i = lo - 1; i >= 0 && this.entries[i]!.prefixEnd > offset; i--) {
      const entry = this.entries[i]!;
      if (offset < entry.end) out.push(entry);
    }
    out.sort((a, b) => a.order - b.order);
    return out.map((entry) => entry.value);
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid]! <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function delugeUnits(app: App): DelugeUnit[] {
  const out: DelugeUnit[] = [];
  for (const w of app.workflows) {
    const base = `workflow ${w.name}`;
    if (w.deluge?.text.trim()) out.push({ label: base, span: w.deluge, lineStarts: lineStarts(w.deluge.text) });
    let phase = 0;
    for (const t of w.blueprint?.transitions ?? []) {
      for (const p of t.phases) {
        phase++;
        for (const d of p.deluge) {
          if (!d.text.trim()) continue;
          out.push({ label: `${base} phase ${phase}`, span: d, lineStarts: lineStarts(d.text) });
        }
      }
    }
  }
  for (const fn of app.functions) {
    for (const d of fn.deluge) {
      if (!d.text.trim()) continue;
      out.push({ label: `function ${fn.name}`, span: d, lineStarts: lineStarts(d.text) });
    }
  }
  return out;
}

/**
 * A span inside a workflow or function script is that unit. The line is
 * counted inside the script. A report criteria or named filter is one
 * application-level hole.
 */
interface TodoIndexes {
  units: IntervalIndex<DelugeUnit>;
  reports: IntervalIndex<App['reports'][number]>;
  workflows: IntervalIndex<App['workflows'][number]>;
  functions: IntervalIndex<App['functions'][number]>;
}

function placeTodo(app: App, indexes: TodoIndexes, todo: TodoItem): { scope: 'app' | 'unit'; location: string } {
  const containingUnits = indexes.units.containing(todo.start);
  const best = containingUnits.reduce<DelugeUnit | undefined>((current, unit) => {
    const size = unit.span.span.end - unit.span.span.start;
    return !current || size < current.span.span.end - current.span.span.start ? unit : current;
  }, undefined);
  if (best) {
    return { scope: 'unit', location: `${best.label}:${lineAt(best.lineStarts, todo.start - best.span.span.start)}` };
  }
  for (const report of indexes.reports.containing(todo.start)) {
    const filter = report.filters.find((item) => todo.start >= item.span.start && todo.start < item.span.end);
    if (filter) return { scope: 'app', location: `report ${report.name} filter ${filter.label || filter.field || 'criteria'}` };
    return { scope: 'app', location: `report ${report.name}` };
  }
  for (const workflow of indexes.workflows.containing(todo.start)) {
    return { scope: 'unit', location: `workflow ${workflow.name}` };
  }
  for (const fn of indexes.functions.containing(todo.start)) {
    return { scope: 'unit', location: `function ${fn.name}` };
  }
  return { scope: 'app', location: 'app' };
}

function disambiguateLocations(located: readonly { scope: DelugeLocation['scope']; location: string; construct: string }[]): DelugeLocation[] {
  const groups = new Map<string, number>();
  for (const item of located) {
    const key = `${item.scope}|${item.location}|${item.construct}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return located.map((item) => {
    const key = `${item.scope}|${item.location}|${item.construct}`;
    let location = item.location;
    if ((groups.get(key) ?? 0) > 1) {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      location = `${item.location} #${n}`;
    }
    return { location, construct: item.construct, scope: item.scope };
  });
}

function locateTodos(app: App, units: readonly DelugeUnit[], todos: readonly TodoItem[]): DelugeLocation[] {
  const indexes: TodoIndexes = {
    units: new IntervalIndex(units, (unit) => unit.span.span),
    reports: new IntervalIndex(app.reports, (report) => report.span),
    workflows: new IntervalIndex(app.workflows, (workflow) => workflow.span),
    functions: new IntervalIndex(app.functions, (fn) => fn.span),
  };
  const located = dedupeTodos(todos).map((todo) => ({ ...placeTodo(app, indexes, todo), construct: todo.construct, start: todo.start, end: todo.end }));
  located.sort((a, b) => a.start - b.start || a.end - b.end || byText(a.construct, b.construct));
  const out = disambiguateLocations(located);
  out.sort((a, b) => byText(a.location, b.location) || byText(a.construct, b.construct) || byText(a.scope, b.scope));
  return out;
}

/** One generated UI stub. The location names the field, report, or page. */
function uiLocation(todo: UiTodo): string {
  if (todo.area === 'field') return `field ${todo.name}`;
  if (todo.area === 'report') return `report ${todo.name}`;
  return `page ${todo.name}`;
}

function locateUiTodos(todos: readonly UiTodo[]): DelugeLocation[] {
  return disambiguateLocations(todos.map((todo) => ({ scope: 'ui' as const, location: uiLocation(todo), construct: todo.reason })));
}

function featureUses(app: App): { used: FeatureUse[]; unmapped: { area: string; feature: string; uses: number }[]; excluded: number; notObservable: number } {
  const facts = appFacts(app);
  const byMatrixKey = new Map<string, number>();
  const unmapped: { area: string; feature: string; uses: number }[] = [];
  for (const row of FEATURES) {
    if (!row.count) continue;
    const uses = row.count(facts);
    if (!uses) continue;
    const key = FEATURE_ALIAS[`${row.area}|${row.feature}`] ?? `${row.area}|${row.feature}`;
    if (!FEATURE_MATRIX.some((m) => `${m.area}|${m.feature}` === key)) {
      unmapped.push({ area: row.area, feature: row.feature, uses });
      continue;
    }
    byMatrixKey.set(key, (byMatrixKey.get(key) ?? 0) + uses);
  }
  const used: FeatureUse[] = [];
  let excluded = 0;
  for (const m of FEATURE_MATRIX) {
    const uses = byMatrixKey.get(`${m.area}|${m.feature}`);
    if (!uses) continue;
    const verdict = VERDICT_OF_STATUS[m.status];
    if (!verdict) {
      excluded++;
      continue;
    }
    used.push({ id: m.id, area: m.area, feature: m.feature, status: m.status, verdict, uses });
  }
  const detected = new Set(FEATURES.filter((r) => r.count).map((r) => FEATURE_ALIAS[`${r.area}|${r.feature}`] ?? `${r.area}|${r.feature}`));
  const notObservable = FEATURE_MATRIX.filter((m) => !detected.has(`${m.area}|${m.feature}`)).length;
  unmapped.sort((a, b) => byText(`${a.area}|${a.feature}`, `${b.area}|${b.feature}`));
  return { used, unmapped, excluded, notObservable };
}

export function todoKindsOf(locations: readonly { construct: string }[]): TodoKind[] {
  const counts = new Map<string, number>();
  for (const item of locations) counts.set(item.construct, (counts.get(item.construct) ?? 0) + 1);
  return [...counts.entries()]
    .map(([construct, count]) => ({ construct, count }))
    .sort((a, b) => b.count - a.count || compareEnUs(a.construct, b.construct));
}

export function analyze(app: App, options?: { lock?: FillLock }): AnalyzeReport {
  const feat = featureUses(app);
  const counts: Record<Verdict, number> = { supported: 0, adapter: 0, 'needs-assessment': 0, gap: 0, blocker: 0 };
  for (const u of feat.used) counts[u.verdict]++;

  const units = delugeUnits(app);
  const whole = generate(app);
  // One translation of the app. Statement effort uses the statement todo
  // bucket. The listed count is every distinct residual hole, including each
  // generated UI stub.
  const statementTodo = whole.stats.todo;
  const uiBundle = buildUi(app);
  const ui = uiBundle.summary;
  const delugeResidual = dedupeTodos(whole.todos);
  const uiLocations = locateUiTodos(uiBundle.model.todos);
  const todoLocations = locateTodos(app, units, delugeResidual).concat(uiLocations);

  const blockers: Blocker[] = [];
  for (const u of feat.used) {
    if (u.verdict === 'blocker') blockers.push({ kind: 'feature', label: `${u.area} / ${u.feature}`, detail: `matrix status ${u.status}` });
  }
  for (const t of todoLocations) blockers.push({ kind: t.scope === 'ui' ? 'ui' : 'deluge', label: t.location, detail: t.construct, scope: t.scope });
  for (const item of widgetManualItems(app.widgets)) {
    blockers.push({ kind: 'feature', label: `widget ${item.name}`, detail: item.detail });
  }
  blockers.sort((a, b) => byText(a.kind, b.kind) || byText(a.label, b.label) || byText(a.detail, b.detail) || byText(a.scope ?? '', b.scope ?? ''));

  const featureScore = feat.used.length ? (feat.used.reduce((s, u) => s + WEIGHT[u.verdict], 0) / feat.used.length) * 100 : 100;
  const delugeScore = whole.stats.statements ? ((whole.stats.translated + SHIMMED_CREDIT * whole.stats.shimmed) / whole.stats.statements) * 100 : 100;
  const readiness = Math.round(0.5 * featureScore + 0.5 * delugeScore);
  const band: AnalyzeReport['score']['band'] = readiness >= 85 && blockers.length === 0 ? 'ready' : readiness >= 60 ? 'needs-work' : 'blocked';

  const schema = generateSchema(app);
  const cronJobs = app.workflows.filter((w) => w.container === 'schedule').length;
  const hours =
    feat.used.reduce((s, u) => s + EFFORT_WEIGHTS.hoursPerFeature[u.verdict], 0) +
    whole.stats.shimmed * EFFORT_WEIGHTS.hoursPerShimmedStatement +
    statementTodo * EFFORT_WEIGHTS.hoursPerTodoStatement +
    schema.summary.tables * EFFORT_WEIGHTS.hoursPerSchemaTable +
    ui.formsTodo * EFFORT_WEIGHTS.hoursPerTodoForm +
    ui.reportsTodo * EFFORT_WEIGHTS.hoursPerTodoReport +
    ui.pagesTodo * EFFORT_WEIGHTS.hoursPerTodoPage +
    cronJobs * EFFORT_WEIGHTS.hoursPerCronJob;

  // One list: every distinct residual hole, including holes with no script
  // (approver fields, field rules, action criteria, report criteria) and each
  // generated UI stub (scope ui; the location names the field, report, or page).
  // `deluge.todo`, this count, and the Deluge blockers are that list.
  const todoKinds = todoKindsOf([...delugeResidual, ...uiLocations]);
  const fillLockEntries = options?.lock ? reportLock(app, options.lock).matched.length : 0;
  const determinism = residualDeterminism(delugeResidual.length, uiLocations.length, fillLockEntries);

  return {
    schema: 'c2c-analyze/1',
    app: { name: app.name ?? null, shape: app.shape, dialect: app.dialect ?? 'ambiguous' },
    matrix: MATRIX_SNAPSHOT,
    features: {
      used: feat.used,
      counts,
      needsAssessment: feat.used.filter((u) => u.verdict === 'needs-assessment').map((u) => ({ id: u.id, area: u.area, feature: u.feature, uses: u.uses })),
      scope: ownerScope(),
      excluded: feat.excluded,
      unmapped: feat.unmapped,
      notObservable: feat.notObservable,
    },
    fieldGaps: fieldGapsOf(schema.fields),
    deluge: {
      units: units.length,
      statements: whole.stats.statements,
      translated: whole.stats.translated,
      shimmed: whole.stats.shimmed,
      todo: determinism.todoCount,
      todoLocations,
    },
    blockers,
    determinism: { deterministic: determinism.deterministic, todoCount: determinism.todoCount, fillLockEntries, todoKinds, uiTodoCount: determinism.uiTodoCount },
    score: { readiness, band, features: Math.round(featureScore), deluge: Math.round(delugeScore) },
    effort: { estimate: true, hours: Math.round(hours * 10) / 10, weights: EFFORT_WEIGHTS },
    catalyst: {
      tables: schema.summary.tables,
      nosqlCollections: schema.summary.nosqlCollections,
      delugeUnits: units.length,
      functions: 1,
      cronJobs,
      slatePages: ui.forms + ui.reports + ui.pages,
      cost: 'not estimated',
    },
  };
}

export function analyzeAsJson(r: AnalyzeReport): string {
  return `${JSON.stringify(r, null, 2)}\n`;
}

export function analyzeAsText(r: AnalyzeReport): string {
  const f = r.features.counts;
  return [
    `application: ${r.app.name ?? '(none)'}  shape: ${r.app.shape}  dialect: ${r.app.dialect}`,
    `matrix: ${r.matrix.matrix} snapshot ${r.matrix.snapshotDate}  sha256 ${r.matrix.sourceSha256.slice(0, 12)}${r.matrix.provisional ? '  (provisional)' : ''}`,
    `score: ${r.score.readiness}/100 ${r.score.band}  (features ${r.score.features}, deluge ${r.score.deluge})`,
    `features used: ${r.features.used.length}  supported ${f.supported}  adapter ${f.adapter}  needs-assessment ${f['needs-assessment']}  gap ${f.gap}  blocker ${f.blocker}  not-a-creator-feature ${r.features.excluded}`,
    ...r.features.scope.map((item) => `scope: ${item.feature} — ${item.label}`),
    `field behavior gaps: ${r.fieldGaps.reduce((total, gap) => total + gap.count, 0)} across ${r.fieldGaps.length} types`,
    ...r.fieldGaps.map((gap) => `  ${gap.matrixId}: ${gap.count} (${gap.fields.map((field) => `${field.form}.${field.field}`).join(', ')}) — ${gap.reason}`),
    `deluge: ${r.deluge.statements} statements  translated ${r.deluge.translated}  shimmed ${r.deluge.shimmed}  todo ${r.deluge.todo}  (${r.deluge.units} units)`,
    `deterministic: ${r.determinism.deterministic ? 'yes' : 'no'}  (todo items ${r.determinism.todoCount}, lock fills ${r.determinism.fillLockEntries}; UI TODO stubs ${r.determinism.uiTodoCount}, included in the todo items)`,
    `blockers: ${r.blockers.length}`,
    ...r.blockers.map((b) => `  ${b.kind}: ${b.label} (${b.detail})`),
    `effort (estimate, not a quote): ${r.effort.hours} h`,
    `catalyst (estimate): tables ${r.catalyst.tables}  nosql ${r.catalyst.nosqlCollections}  deluge units ${r.catalyst.delugeUnits}  functions ${r.catalyst.functions}  cron ${r.catalyst.cronJobs}  slate pages ${r.catalyst.slatePages}  cost ${r.catalyst.cost}`,
  ].join('\n');
}
