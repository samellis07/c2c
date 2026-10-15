/**
 * Gallery determinism status: residual TODO counts over a corpus of sample Creator apps (not included).
 *
 * One definition: the numbers come from the migration report
 * (`c2c migration-report`), so an app is deterministic here exactly when its
 * analyze report says so — zero TODO items and no fill-todos lock entries.
 *
 * Counts and public construct names only — never app names, paths, dates or
 * source text — so the rendered doc (docs/determinism-status.md) is safe to
 * commit and regenerates byte-identically. A construct whose name part is an
 * app identifier (a variable, field or user function, e.g. `task:<variable>`)
 * is bucketed as `<prefix>:(app identifier)`. A quoted user-chosen name
 * anywhere in the construct, including the prefix, is bucketed the same way.
 * Each non-deterministic app also
 * contributes one construct set: the sorted public names and that app's item
 * count, with no app name, so a reader can count apps cleared by fixing a
 * kind. Regenerate with:
 *
 *   C2C_FIXTURES_DIR=<fixtures> npm run determinism:status
 *
 * which reads the gallery from `--dir`, `C2C_FIXTURES_DIR/gallery`, or
 * `C2C_GALLERY_DIR`, in that order.
 *
 * `--sites <file>` additionally writes local-only per-app attribution — app
 * name, TODO kind, construct path with line, and a normalised signature — for
 * designers sizing patterns. The path must resolve outside the repo tree, so
 * private names can never be committed; the doc and summary are unchanged.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { compareEnUs } from '../../core/src/order.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { analyze } from '../../cli/src/analyze.js';
import {
  listReportApps,
  loadIr,
  lockFor,
  migrationReportForDir,
  type MigrationReport,
} from '../../cli/src/migration-report.js';

export interface StatusKind {
  construct: string;
  count: number;
}

/** One non-deterministic app, with no app name. */
export interface PerAppConstructSet {
  /** Public construct names on this app, sorted. */
  constructs: string[];
  /** Residual TODO items on this app. */
  items: number;
}

export interface DeterminismStatus {
  totalApps: number;
  deterministicApps: number;
  /** Residual TODO items across the gallery. */
  todoTotal: number;
  /** Full per-construct histogram (public names), count desc then construct asc. */
  kinds: StatusKind[];
  /** One entry per non-deterministic app. Sorted, name-free. */
  perAppConstructSets: PerAppConstructSet[];
  /** Deterministic apps that still have UI TODO stubs. A stub is a residual hole, so this stays zero. */
  deterministicWithUiTodos: { apps: number; uiTodos: number };
}

/** Gallery dir from explicit argv, C2C_FIXTURES_DIR/gallery, or C2C_GALLERY_DIR. */
export function resolveStatusDir(env: Record<string, string | undefined>, argvDir?: string): string | undefined {
  if (argvDir) return argvDir;
  if (env.C2C_FIXTURES_DIR) return join(env.C2C_FIXTURES_DIR, 'gallery');
  return env.C2C_GALLERY_DIR || undefined;
}

/**
 * Deluge statement words the translator reports as `task:<word>` that are
 * language keywords or documented legacy builtins rather than app identifiers.
 */
const KEYWORDS = new Set(['for', 'getUrl', 'if', 'input', 'postUrl', 'pushnotification', 'return', 'sort', 'while']);
const ATTACHMENT_KINDS = new Set(['file', 'template', 'view']);

let catalogue: Set<string> | undefined;

function catalogueNames(): Set<string> {
  if (!catalogue) {
    const doc = JSON.parse(readFileSync(join(repoRoot(), 'docs/deluge-builtins.json'), 'utf8')) as { entries: { name: string }[] };
    catalogue = new Set(doc.entries.map((entry) => entry.name.toLowerCase()));
  }
  return catalogue;
}

/**
 * `counts.todo` from the builtin catalogue (`docs/deluge-builtins.json` by
 * default). Reads the committed file, not a live count — deterministic, no
 * clock. `path` lets a test point at a fixture catalogue.
 */
export function builtinTodoCount(path: string = join(repoRoot(), 'docs/deluge-builtins.json')): number {
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { counts: { todo: number } };
  return doc.counts.todo;
}

/** A quoted user-chosen name. The quotes are part of the name, not of the kind. */
const QUOTED_NAME = /"[^"]*"/g;

/**
 * The construct name as it may appear in a committed doc. Translator kinds
 * (`criteria-dynamic`) and catalogue builtins / keywords pass through; any
 * other `prefix:name` becomes `prefix:(app identifier)`. A quoted name
 * anywhere in the construct, including the prefix, becomes `(app identifier)`
 * first, so constructs that differ only by that name share one bucket.
 */
export function publicConstruct(construct: string): string {
  const text = construct.replace(QUOTED_NAME, '(app identifier)');
  const at = text.indexOf(':');
  if (at < 0) return text;
  const prefix = text.slice(0, at);
  const name = text.slice(at + 1);
  if (prefix === 'sendmail-attachment') return ATTACHMENT_KINDS.has(name) ? text : `${prefix}:(other)`;
  if (KEYWORDS.has(name) || catalogueNames().has(name.toLowerCase())) return text;
  return `${prefix}:(app identifier)`;
}

const byKind = (a: StatusKind, b: StatusKind) => b.count - a.count || compareEnUs(a.construct, b.construct);

function compareConstructSets(a: PerAppConstructSet, b: PerAppConstructSet): number {
  const n = Math.min(a.constructs.length, b.constructs.length);
  for (let i = 0; i < n; i++) {
    const cmp = compareEnUs(a.constructs[i] ?? '', b.constructs[i] ?? '');
    if (cmp !== 0) return cmp;
  }
  if (a.constructs.length !== b.constructs.length) return a.constructs.length - b.constructs.length;
  return a.items - b.items;
}

/** Sorted public names and the item count. Private names that share a bucket collapse to one entry. */
function constructSetForApp(app: { todoKinds: { construct: string; count: number }[]; todoCount: number }): PerAppConstructSet {
  const names = new Set<string>();
  for (const kind of app.todoKinds) names.add(publicConstruct(kind.construct));
  return { constructs: [...names].sort(compareEnUs), items: app.todoCount };
}

export function statusFromReport(report: MigrationReport): DeterminismStatus {
  const kinds = new Map<string, number>();
  for (const kind of report.aggregate.todoKinds) {
    const name = publicConstruct(kind.construct);
    kinds.set(name, (kinds.get(name) ?? 0) + kind.count);
  }
  return {
    totalApps: report.aggregate.totalApps,
    deterministicApps: report.aggregate.deterministicApps,
    todoTotal: report.aggregate.todoTotal,
    kinds: [...kinds.entries()].map(([construct, count]) => ({ construct, count })).sort(byKind),
    perAppConstructSets: report.apps
      .filter((app) => !app.deterministic)
      .map(constructSetForApp)
      .sort(compareConstructSets),
    deterministicWithUiTodos: report.aggregate.deterministicWithUiTodos,
  };
}

/** Apps whose construct set is exactly one public name, counted by that name. */
export function soleKindUnblocks(sets: PerAppConstructSet[]): { construct: string; apps: number }[] {
  const counts = new Map<string, number>();
  for (const set of sets) {
    if (set.constructs.length !== 1) continue;
    const name = set.constructs[0];
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([construct, apps]) => ({ construct, apps }))
    .sort((a, b) => b.apps - a.apps || compareEnUs(a.construct, b.construct));
}

export function computeDeterminismStatus(dir: string): DeterminismStatus {
  return statusFromReport(migrationReportForDir(dir, 'gallery'));
}

/** One residual TODO hole attributed to a named app. Local-only: names are not anonymised. */
export interface SiteTodo {
  /** `unit` — inside a workflow or function script; `app` — application-level; `ui` — one generated UI stub. */
  scope: 'app' | 'unit' | 'ui';
  /**
   * Construct path, with the script line when the hole sits in a Deluge unit:
   * `workflow <name>:<line>`, `function <name>:<line>`, `report <name> [filter <name>]`,
   * `field <name>`, `page <name>`, or `app`.
   */
  location: string;
  /** Raw TODO kind, exactly as the translator reports it (may carry app identifiers). */
  construct: string;
  /** Normalised construct signature for clustering: `publicConstruct(construct)`. */
  signature: string;
}

/** Per-app attribution written by `--sites`: which app, and where each residual hole lives. */
export interface SiteAttributionApp {
  app: string;
  deterministic: boolean;
  fillLockEntries: number;
  todos: SiteTodo[];
}

export interface SiteAttribution {
  schema: 'c2c-determinism-sites/1';
  label: string;
  apps: SiteAttributionApp[];
}

/**
 * Per-app attribution for `--sites`. Runs the same `analyze` the migration
 * report runs, but keeps the located TODO list (`deluge.todoLocations`) instead
 * of aggregating it away. Output names apps and raw constructs — write it
 * outside the repo tree only.
 */
export function siteAttributionForDir(dir: string, label: string): SiteAttribution {
  const apps = listReportApps(dir).map((entry) => {
    const lock = lockFor(entry.target);
    const report = analyze(loadIr(entry.target), lock ? { lock } : undefined);
    const todos = report.deluge.todoLocations.map((todo) => ({
      scope: todo.scope,
      location: todo.location,
      construct: todo.construct,
      signature: publicConstruct(todo.construct),
    }));
    return {
      app: entry.name,
      deterministic: report.determinism.deterministic,
      fillLockEntries: report.determinism.fillLockEntries,
      todos,
    };
  });
  return { schema: 'c2c-determinism-sites/1', label, apps };
}

/**
 * Resolve a `--sites` output path and refuse anything inside the repo tree:
 * the attribution file names private apps and constructs, so it must never be
 * committable.
 */
function tryRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Canonical destination for a `--sites` path. The output file itself is
 * followed when it exists — a symlinked file must not smuggle an in-repo
 * target past the guard, including a dangling link — and otherwise the
 * nearest existing parent is resolved, so a symlinked parent directory
 * compares by target. The remainder is appended lexically.
 */
function canonicalSitesCandidate(abs: string): string {
  let cur = abs;
  for (let hops = 0; hops < 40; hops++) {
    const entry = lstatSync(cur, { throwIfNoEntry: false });
    if (!entry) break;
    if (!entry.isSymbolicLink()) break;
    cur = resolve(dirname(cur), readlinkSync(cur));
  }
  const direct = tryRealpath(cur);
  if (direct) return direct;
  const rest: string[] = [];
  let node = cur;
  for (;;) {
    const parent = dirname(node);
    if (parent === node) {
      const base = tryRealpath(node) ?? node;
      return rest.length ? join(base, ...rest.reverse()) : base;
    }
    rest.push(basename(node));
    node = parent;
    if (statSync(node, { throwIfNoEntry: false })) {
      const base = tryRealpath(node) ?? node;
      return join(base, ...rest.reverse());
    }
  }
}

/**
 * Every checkout the `--sites` output must avoid: the current root, all
 * worktrees of this repository (`git worktree list` covers the main
 * checkout), and the common dir's main worktree in case the list missed it.
 * A checkout that vanishes between calls is compared lexically.
 */
function sitesProtectedRoots(root: string): string[] {
  const roots = new Map<string, string>();
  const add = (candidate: string): void => {
    const real = tryRealpath(candidate) ?? resolve(candidate);
    if (!roots.has(real)) roots.set(real, candidate);
  };
  add(root);
  try {
    const out = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) add(line.slice('worktree '.length).trim());
    }
  } catch {
    // Not a git checkout, or git is unavailable: fall back to the root plus
    // the work-tree walk below.
  }
  try {
    let common = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!isAbsolute(common)) common = resolve(root, common);
    add(basename(common) === '.git' ? dirname(common) : common);
  } catch {
    // Ignore: the worktree list above is the primary source.
  }
  return [...roots.keys()];
}

/**
 * Whether the volume holding `dir` ignores filename case (opt-in probe: an
 * alias that differs only by case resolves to the same file). Exact-case
 * volumes compare exactly, so a same-spelling-different-case path elsewhere
 * stays a different path.
 */
function volumeIgnoresCase(dir: string): boolean {
  const base = statSync(dir, { throwIfNoEntry: false });
  if (!base?.isDirectory()) return false;
  for (const alias of [dir.toUpperCase(), dir.toLowerCase()]) {
    if (alias === dir) continue;
    const other = statSync(alias, { throwIfNoEntry: false });
    if (other && other.dev === base.dev && other.ino === base.ino) return true;
  }
  return false;
}

/** Nearest self-or-ancestor directory holding a `.git` entry: any git work tree. */
function enclosingGitWorkTree(start: string): string | undefined {
  let node = start;
  for (;;) {
    if (existsSync(join(node, '.git'))) return node;
    const parent = dirname(node);
    if (parent === node) return undefined;
    node = parent;
  }
}

export function resolveSitesPath(path: string, root: string = repoRoot()): string {
  const abs = resolve(path);
  const candidate = canonicalSitesCandidate(abs);
  const protectedRoots = sitesProtectedRoots(root);
  const ignoreCase =
    protectedRoots.some((protectedRoot) => volumeIgnoresCase(protectedRoot)) || volumeIgnoresCase(dirname(candidate));
  const fold = (value: string): string => (ignoreCase ? value.toLowerCase() : value);
  const folded = fold(candidate);
  const inside = (base: string): boolean => {
    const foldedBase = fold(base);
    return folded === foldedBase || folded.startsWith(foldedBase + sep);
  };
  const hit = protectedRoots.find((protectedRoot) => inside(protectedRoot));
  // Belt and braces: refuse any git work tree at all, not just this
  // repository's checkouts, so a nested or foreign repo is never committable.
  const workTree = hit ? undefined : enclosingGitWorkTree(candidate);
  if (hit ?? workTree) {
    throw new Error(
      `determinism:status: --sites path must be outside the repo tree: ${path} (resolves inside ${hit ?? workTree})`,
    );
  }
  return abs;
}

export function renderStatusDoc(status: DeterminismStatus, builtinCataloguePath?: string): string {
  const top = status.kinds.slice(0, 20);
  const todoCount = builtinTodoCount(builtinCataloguePath);
  const share = status.totalApps ? Math.round((status.deterministicApps / status.totalApps) * 1000) / 10 : 100;
  return [
    '# Determinism status',
    '',
    'Regenerable summary of a corpus of sample Creator apps (not included). Recompute with',
    '`C2C_FIXTURES_DIR=<fixtures> npm run determinism:status`; `npm test` fails when this file is',
    'stale and the local corpus is present. Counts and public construct names only — no app names,',
    'paths, or script text. A construct naming an app identifier, including a quoted name',
    'anywhere in the construct, is bucketed as `(app identifier)`.',
    'Each non-deterministic app adds one construct set: the sorted public names and that',
    "app's residual item count, with no app name.",
    '',
    'An app is deterministic when `c2c analyze` finds zero residual TODO items and no',
    '`c2c fill-todos` lock entries apply to it. Only deterministic apps count toward the',
    '95% / 100% migration targets.',
    '',
    'A residual TODO item is an untranslated Deluge hole or one generated UI stub',
    '(a field, report, page, or ZML item). Each UI stub is included in the residual,',
    'so an app with a stub is not deterministic.',
    `${status.deterministicWithUiTodos.apps} of the ${status.deterministicApps} deterministic apps still have UI TODO stubs ` +
      `(${status.deterministicWithUiTodos.uiTodos} in total).`,
    '',
    `The builtin catalogue lists ${todoCount} TODO entries`,
    '(`docs/deluge-builtins.json` `counts.todo`). That is not the corpus residual counted here: one',
    'TODO item per untranslated construct occurrence.',
    '',
    '| | |',
    '|---|---:|',
    `| corpus apps | ${status.totalApps} |`,
    `| deterministic apps | ${status.deterministicApps} (${share}%) |`,
    `| residual TODO items | ${status.todoTotal} |`,
    `| distinct TODO kinds | ${status.kinds.length} |`,
    `| deterministic apps with UI TODO stubs (included in the residual) | ${status.deterministicWithUiTodos.apps} (${status.deterministicWithUiTodos.uiTodos} stubs) |`,
    '',
    `## Top ${top.length} TODO kinds`,
    '',
    '| construct | count |',
    '|---|---:|',
    ...top.map((kind) => `| \`${kind.construct}\` | ${kind.count} |`),
    '',
    '## Sole-kind unblocks',
    '',
    'An app in this table has exactly one public construct left. Fixing that construct',
    'clears the app. The count is apps, not items.',
    '',
    '| construct | apps |',
    '|---|---:|',
    ...soleKindUnblocks(status.perAppConstructSets).map((row) => `| \`${row.construct}\` | ${row.apps} |`),
    '',
    '## Machine-readable',
    '',
    '```json',
    canonicalStatusJson(status),
    '```',
    '',
  ].join('\n');
}

/** The machine-readable block inside the doc. Counts and name-free construct sets. */
export function canonicalStatusJson(status: DeterminismStatus): string {
  return JSON.stringify(
    {
      deterministicApps: status.deterministicApps,
      deterministicWithUiTodos: status.deterministicWithUiTodos,
      kinds: status.kinds,
      perAppConstructSets: status.perAppConstructSets,
      todoTotal: status.todoTotal,
      totalApps: status.totalApps,
    },
    null,
    2,
  );
}

/** Parse the ```json block back out of a rendered doc. */
export function parseStatusDoc(text: string): DeterminismStatus {
  const match = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!match?.[1]) throw new Error('determinism-status: no ```json block found');
  const parsed = JSON.parse(match[1]) as Partial<DeterminismStatus>;
  const sets = parsed.perAppConstructSets;
  const setsOk =
    Array.isArray(sets) &&
    sets.every(
      (row) =>
        !!row &&
        Array.isArray(row.constructs) &&
        row.constructs.every((name) => typeof name === 'string') &&
        typeof row.items === 'number',
    );
  if (
    typeof parsed.totalApps !== 'number' ||
    typeof parsed.deterministicApps !== 'number' ||
    typeof parsed.todoTotal !== 'number' ||
    !Array.isArray(parsed.kinds) ||
    !setsOk ||
    typeof parsed.deterministicWithUiTodos?.apps !== 'number' ||
    typeof parsed.deterministicWithUiTodos.uiTodos !== 'number'
  ) {
    throw new Error('determinism-status: ```json block is not a status payload');
  }
  return {
    totalApps: parsed.totalApps,
    deterministicApps: parsed.deterministicApps,
    todoTotal: parsed.todoTotal,
    kinds: parsed.kinds,
    perAppConstructSets: sets.map((row) => ({ constructs: [...row.constructs], items: row.items })),
    deterministicWithUiTodos: { apps: parsed.deterministicWithUiTodos.apps, uiTodos: parsed.deterministicWithUiTodos.uiTodos },
  };
}

export function main(argv: string[]): number {
  const take = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.some((arg) => arg === '--help' || arg === '-h')) {
    process.stderr.write('usage: determinism:status [--dir <gallery-dir>] [--out <file>] [--sites <file>]\n');
    return 2;
  }
  let sitesPath: string | undefined;
  const sitesArg = take('--sites');
  if (sitesArg !== undefined) {
    try {
      sitesPath = resolveSitesPath(sitesArg);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      return 2;
    }
  }
  const dir = resolveStatusDir(process.env, take('--dir'));
  if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write('determinism:status: gallery not found; pass --dir or set C2C_FIXTURES_DIR or C2C_GALLERY_DIR\n');
    return 1;
  }
  const status = computeDeterminismStatus(dir);
  if (status.totalApps === 0) {
    process.stderr.write('determinism:status: no apps in the gallery directory\n');
    return 1;
  }
  const out = take('--out') ?? join(repoRoot(), 'docs/determinism-status.md');
  writeFileSync(out, renderStatusDoc(status));
  if (sitesPath) {
    writeFileSync(sitesPath, `${JSON.stringify(siteAttributionForDir(dir, 'gallery'), null, 2)}\n`);
    process.stderr.write(`determinism:status sites -> ${sitesPath}\n`);
  }
  process.stdout.write(
    `determinism:status apps=${status.totalApps} deterministic=${status.deterministicApps} todos=${status.todoTotal} kinds=${status.kinds.length} construct-sets=${status.perAppConstructSets.length} ui-todo-apps=${status.deterministicWithUiTodos.apps} ui-todos=${status.deterministicWithUiTodos.uiTodos}\n`,
  );
  return 0;
}

const invoked = process.argv[1]?.endsWith('/status.js') ?? false;
if (invoked) process.exitCode = main(process.argv.slice(2));
