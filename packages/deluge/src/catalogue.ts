/**
 * Merge the hand-maintained Zoho docs list with the translator dispatch tables.
 * Status is never stored in the docs list: each entry is spot-translated.
 *
 *   supported — the builtin becomes native JS (no shim.todo, no shim call of its own)
 *   shimmed   — it maps to a named shim.* call or a client actions.push
 *   todo      — the translation emits shim.todo()
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareEnUs } from '../../core/src/order.js';
import {
  AGGREGATE_METHODS,
  DATE_METHODS,
  HANDLED_TASKS,
  MATH_FUNCTIONS,
  NATIVE_STRING_JS,
  ZOHO_ENV,
  recognisedBuiltinNames,
} from './dispatch.js';
import { translate, type TranslateResult } from './translate.js';

export type BuiltinStatus = 'supported' | 'shimmed' | 'todo';

export interface DocBuiltin {
  name: string;
  kind: 'function' | 'task' | 'integration' | 'variable' | 'constructor';
  category: string;
  receivers: string[];
  arity: number;
  form?: 'method' | 'free' | 'task' | 'variable';
  docUrl: string | null;
  snippet?: string;
  syntax?: string;
}

export interface CatalogueEntry {
  name: string;
  kind: DocBuiltin['kind'];
  category: string;
  receivers: string[];
  arity: number;
  docUrl: string | null;
  status: BuiltinStatus;
  mapsTo: string;
  snippet: string;
}

export interface Catalogue {
  generatedBy: string;
  docs: string;
  dispatch: string;
  counts: { supported: number; shimmed: number; todo: number; total: number };
  entries: CatalogueEntry[];
}

const NOISE_SHIMS = new Set(['shim.date.parse', 'shim.decimal.from']);

export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '../../..'), join(here, '../../../..')];
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json')) && existsSync(join(c, 'packages', 'deluge'))) return c;
  }
  throw new Error('repo root not found from ' + here);
}

export function docsPath(): string {
  return join(repoRoot(), 'packages/deluge/data/builtin-docs.json');
}

export function cataloguePath(): string {
  return join(repoRoot(), 'docs/deluge-builtins.json');
}

export function loadDocs(): DocBuiltin[] {
  const raw = JSON.parse(readFileSync(docsPath(), 'utf8')) as { entries: DocBuiltin[] };
  return raw.entries;
}

function flat(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function rank(shim: string): number {
  if (shim.startsWith('shim.datastore.rows')) return 80;
  if (shim.startsWith('shim.datastore.aggregate')) return 78;
  if (shim.startsWith('shim.datastore.column')) return 76;
  if (shim.startsWith('shim.datastore.insert')) return 74;
  if (shim.startsWith('shim.datastore.update')) return 74;
  if (shim.startsWith('shim.datastore.delete')) return 74;
  if (shim.startsWith('shim.datastore.setField')) return 60;
  if (shim.startsWith('shim.datastore.field')) return 55;
  if (shim.startsWith('shim.datastore.query')) return 40;
  if (shim.startsWith('shim.mail.') || shim.startsWith('shim.http.') || shim.startsWith('shim.thisapp.')) return 72;
  if (shim.startsWith('shim.zoho.task')) return 68;
  if (shim.startsWith('shim.convert.') || shim.startsWith('shim.string.') || shim.startsWith('shim.math.')) return 64;
  if (shim.startsWith('shim.date.')) return 64;
  if (
    shim === 'shim.isBlank'
    || shim === 'shim.isNull'
    || shim === 'shim.isEmpty'
    || shim === 'shim.isNumber'
    || shim.startsWith('shim.list')
    || shim.startsWith('shim.map(')
    || shim === 'shim.map'
  ) return 64;
  if (shim.startsWith('shim.input.') || shim.startsWith('shim.old.') || shim.startsWith('shim.record.')) return 50;
  if (shim.startsWith('shim.zoho.')) return 46;
  if (shim.startsWith('shim.decimal.')) return 20;
  return 10;
}

function nativeMapsTo(code: string, name: string): string {
  if (name === 'break' && code.includes('break')) return 'break';
  if (name === 'continue' && code.includes('continue')) return 'continue';
  if (name === 'return' && code.includes('return')) return 'return';
  if (name === 'try' && code.includes('try {')) return 'try';
  if (name === 'while' && code.includes('while (')) return 'while';
  if ((name === 'else' || name === 'else if') && code.includes('else')) return 'if/else';
  if (name === 'if' && code.includes('?')) return '?:';
  if (name === 'if' && code.includes('if (')) return 'if';
  if ((name === 'for each' || name === 'for each index') && code.includes('for (')) return 'for';
  if (name === 'List' || name === 'Collection') return '[]';
  if (name === 'Map') return '{}';
  const math = code.match(/Math\.[A-Za-z]+/);
  if (math && (Object.hasOwn(MATH_FUNCTIONS, name) || name === 'round')) return math[0];
  if (code.includes('Object.hasOwn')) return 'Object.hasOwn';
  if (code.includes('.push(')) return '.push';
  if (code.includes('.slice(')) return '.slice';
  if (code.includes('.includes(')) return '.includes';
  if (code.includes('.length')) return '.length';
  if (code.includes('?')) return '?:';
  if (code.includes('== null')) return '== null';
  const method = code.match(/\.([A-Za-z]+)\(/);
  if (method) return `.${method[1]}`;
  if (code.includes('[]')) return '[]';
  const line = code.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('//'));
  return (line ?? name).replace(/;$/, '').slice(0, 80);
}

/** Classify one spot-translation. `name` disambiguates the builtin from its arguments. */
export function classifyTranslation(result: TranslateResult, name: string): { status: BuiltinStatus; mapsTo: string } {
  // Drop comment lines (the `// Deluge:` provenance comments): classification
  // and the mapsTo heuristics describe the emitted code, not the source echo.
  const code = [result.server, result.client, result.prefetch]
    .join('\n')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  if (/shim\.todo\(/.test(code) || result.todos.length > 0) return { status: 'todo', mapsTo: 'shim.todo' };
  const shims = [...new Set([...code.matchAll(/shim\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)].map((m) => m[0]))]; // determinism-allow: regex matches in emitted-code order; useful.find takes the first hit, so source order is the contract
  const useful = shims.filter((s) => !NOISE_SHIMS.has(s));
  const named = useful.find((s) => flat(s).includes(flat(name)));
  if (named) return { status: 'shimmed', mapsTo: named };
  const uiMethod = code.match(/op: "ui", method: "([^"]+)"/);
  if (uiMethod && flat(uiMethod[1]!) === flat(name)) return { status: 'shimmed', mapsTo: `actions.ui.${uiMethod[1]}` };
  const actions = [...code.matchAll(/op: "([^"]+)"/g)].map((m) => m[1]!);
  const act = actions.find((a) => flat(a) === flat(name));
  if (act) return { status: 'shimmed', mapsTo: `actions.${act}` };
  if (useful.length) {
    const best = [...useful].sort((a, b) => rank(b) - rank(a) || compareEnUs(a, b))[0]!;
    return { status: 'shimmed', mapsTo: best };
  }
  if (actions.length) return { status: 'shimmed', mapsTo: `actions.${actions[0]}` };
  return { status: 'supported', mapsTo: nativeMapsTo(code, name) };
}

function receiverExpr(receivers: string[]): string {
  const r = receivers.find((x) => x !== 'none') ?? 'text';
  if (r === 'text') return '"abc"';
  if (r === 'list') return '{"a", "b"}';
  if (r === 'map') return '{"k": "v"}';
  if (r === 'collection') return 'Collection()';
  if (r === 'date-time' || r === 'time') return '"2020-01-01"';
  if (r === 'number') return '(1)';
  if (r === 'form') return 'Orders';
  if (r === 'file') return 'input.File_upload';
  if (r === 'xml' || r === 'json') return '"<a/>"';
  return '"abc"';
}

const TASK_SNIPPET: Record<string, string> = {
  if: 'if (1 == 1) { x = 1; }',
  'else if': 'if (1 == 0) { x = 0; } else if (1 == 1) { x = 1; }',
  else: 'if (1 == 0) { x = 0; } else { x = 1; }',
  'for each': 'for each item in {"a", "b"} { x = 1; }',
  'for each index': 'for each index i item in {"a", "b"} { x = i; }',
  'for each record': 'for each rec in Orders[Status == "Open"] { x = 1; }',
  while: 'while (1 == 0) { x = 1; }',
  break: 'for each item in {"a"} { break; }',
  continue: 'for each item in {"a"} { continue; }',
  return: 'return "ok";',
  try: 'try { x = 1; } catch (err) { x = 0; }',
  info: 'info "x";',
  alert: 'alert "x";',
  'cancel submit': 'cancel submit;',
  reload: 'reload;',
  openUrl: 'openUrl("https://example.test", "same window");',
  show: 'show input.Name;',
  hide: 'hide input.Name;',
  enable: 'enable input.Name;',
  disable: 'disable input.Name;',
  clear: 'clear input.Name;',
  sendmail: 'sendmail[from: "a@b.c" to: "c@d.e" subject: "s" message: "m"];',
  invokeurl: 'resp = invokeurl[url: "https://example.test" type: GET];',
  insert: 'row = insert into Orders[Name = "A"];',
  update: 'update Orders[ID == 1][Status = "Done"];',
  delete: 'delete from Orders[ID == 1];',
  input: 'x = input.Name;',
  old: 'x = old.Name;',
};

export function snippetFor(doc: DocBuiltin): string {
  if (doc.snippet) return doc.snippet;
  const args = Array.from({ length: Math.max(0, doc.arity) }, () => '"x"').join(', ');
  if (doc.kind === 'integration' || (doc.name.startsWith('zoho.') && doc.form !== 'variable')) {
    return `x = ${doc.name}(${args});`;
  }
  if (doc.form === 'variable' || (doc.kind === 'variable' && doc.form !== 'method' && doc.form !== 'free')) {
    if (doc.name === 'input' || doc.name === 'old') return TASK_SNIPPET[doc.name]!;
    return `x = ${doc.name};`;
  }
  const receivers = doc.receivers ?? ['none'];
  if (doc.form === 'method' || (receivers.some((r) => r !== 'none') && doc.form !== 'free' && doc.form !== 'task')) {
    return `x = ${receiverExpr(receivers)}.${doc.name}(${args});`;
  }
  if (doc.form === 'free') return `x = ${doc.name}(${args});`;
  if (doc.form === 'task' || doc.kind === 'task') return TASK_SNIPPET[doc.name] ?? `x = ${doc.name}();`;
  return `x = ${doc.name}(${args});`;
}

function synthetic(name: string): DocBuiltin {
  const flow = 'https://www.zoho.com/deluge/help/conditional-statements/condition.html';
  const fixed: Record<string, DocBuiltin> = {
    ifnull: { name, kind: 'function', category: 'flow', receivers: ['none'], arity: 2, form: 'free', docUrl: flow, snippet: 'x = ifnull("a", "b");' },
    isnull: { name, kind: 'function', category: 'logical', receivers: ['none'], arity: 1, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/functions/common/isnull.html', snippet: 'x = isnull("a");' },
    isblank: { name, kind: 'function', category: 'logical', receivers: ['none'], arity: 1, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/functions/common/isblank.html', snippet: 'x = isblank("a");' },
    pow: { name, kind: 'function', category: 'number', receivers: ['none'], arity: 2, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/functions/number/power.html', snippet: 'x = pow(2, 3);' },
    subString: { name, kind: 'function', category: 'text', receivers: ['text'], arity: 2, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/functions/string/substring.html', snippet: 'x = "abcd".subString(1, 2);' },
    avg: { name, kind: 'function', category: 'data-access', receivers: ['form'], arity: 1, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/data-access/aggregate-records/average.html', snippet: 'x = Orders.avg(Amount);' },
    thisapp: { name, kind: 'task', category: 'integration', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/creator-tasks.html', snippet: 'thisapp.util.ping();' },
    getAll: { name, kind: 'function', category: 'data-access', receivers: ['form'], arity: 0, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/fetch-records.html', snippet: 'x = Orders[Status == "Open"].Name.getAll();' },
    List: { name, kind: 'constructor', category: 'list', receivers: ['none'], arity: 0, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/list-manipulations/create-list.html', snippet: 'x = List();' },
    Collection: { name, kind: 'constructor', category: 'collection', receivers: ['none'], arity: 0, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/functions/collection.html', snippet: 'x = Collection();' },
    Map: { name, kind: 'constructor', category: 'map', receivers: ['none'], arity: 0, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/map-manipulations/create-map.html', snippet: 'x = Map();' },
    round: { name, kind: 'function', category: 'number', receivers: ['none'], arity: 1, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/functions/number/round.html', snippet: 'x = round(1);' },
    getUrl: { name, kind: 'task', category: 'notifications', receivers: ['none'], arity: 1, form: 'task', docUrl: null, snippet: 'x = getUrl("https://example.test");' },
    toJSONCollection: { name, kind: 'function', category: 'map', receivers: ['map'], arity: 0, form: 'method', docUrl: null, snippet: 'x = {"k": "v"}.toJSONCollection();' },
    'zoho.checkout.create': { name, kind: 'integration', category: 'integration', receivers: ['none'], arity: 0, form: 'free', docUrl: null, snippet: 'zoho.checkout.create();' },
  };
  if (Object.hasOwn(fixed, name)) return fixed[name]!;
  if (name.startsWith('zoho.')) {
    const key = name.slice('zoho.'.length);
    const envUrl = 'https://www.zoho.com/deluge/help/zoho-variables.html';
    if (Object.hasOwn(ZOHO_ENV, key)) {
      return { name, kind: 'variable', category: 'common', receivers: ['none'], arity: 0, form: 'variable', docUrl: envUrl, snippet: `x = ${name};` };
    }
    return { name, kind: 'integration', category: 'integration', receivers: ['none'], arity: 0, form: 'free', docUrl: null, snippet: `x = ${name}();` };
  }
  if (name === 'toDateTimeString') {
    // The documented forms take epoch milliseconds, not a date receiver.
    return {
      name, kind: 'function', category: 'date-time', receivers: ['number'], arity: 2, form: 'method',
      docUrl: 'https://www.zoho.com/deluge/help/functions/datetime/todatetimestring.html',
      snippet: 'x = (1693905560373).toDateTimeString("MMM dd, yy", "IST");',
    };
  }
  if (DATE_METHODS.has(name)) {
    const arity = name.startsWith('get') || name === 'toDate' || name === 'toTime' || name === 'toString' || name === 'unixEpoch' ? 0 : 1;
    const args = arity ? '1' : '';
    return {
      name, kind: 'function', category: 'date-time', receivers: ['date-time'], arity, form: 'method', docUrl: null,
      snippet: `x = "2020-01-01".${name}(${args});`,
    };
  }
  if (Object.hasOwn(NATIVE_STRING_JS, name) || name === 'replaceFirst' || name === 'getPrefix' || name === 'getSuffix' || name === 'length') {
    const arity = name === 'length' ? 0 : 1;
    const args = Array.from({ length: arity }, () => '"x"').join(', ');
    return { name, kind: 'function', category: 'text', receivers: ['text'], arity, form: 'method', docUrl: null, snippet: `x = "abc".${name}(${args});` };
  }
  if (Object.hasOwn(MATH_FUNCTIONS, name)) {
    const arity = name === 'abs' || name === 'sqrt' || name === 'log' || name === 'ceil' || name === 'floor' || name === 'exp' ? 1 : 2;
    const args = Array.from({ length: arity }, (_, i) => String(i + 1)).join(', ');
    return { name, kind: 'function', category: 'number', receivers: ['none'], arity, form: 'free', docUrl: null, snippet: `x = ${name}(${args});` };
  }
  if (AGGREGATE_METHODS.has(name)) {
    const arity = name === 'count' ? 0 : 1;
    return {
      name, kind: 'function', category: 'data-access', receivers: ['form'], arity, form: 'method', docUrl: null,
      snippet: arity ? `x = Orders.${name}(Amount);` : `x = Orders.${name}();`,
    };
  }
  if ((HANDLED_TASKS as readonly string[]).includes(name) && TASK_SNIPPET[name]) {
    return { name, kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: null, snippet: TASK_SNIPPET[name] };
  }
  return { name, kind: 'function', category: 'translator', receivers: ['none'], arity: 0, form: 'free', docUrl: null, snippet: `x = ${name}();` };
}

function toEntry(doc: DocBuiltin): CatalogueEntry {
  const snippet = snippetFor(doc);
  const got = classifyTranslation(translate(snippet), doc.name);
  return {
    name: doc.name,
    kind: doc.kind,
    category: doc.category,
    receivers: doc.receivers.length ? doc.receivers : ['none'],
    arity: doc.arity,
    docUrl: doc.docUrl,
    status: got.status,
    mapsTo: got.mapsTo,
    snippet,
  };
}

function entryKey(e: CatalogueEntry): string {
  return [e.name, e.category, e.kind, e.receivers.join('+'), String(e.arity), e.snippet].join('|');
}

export function buildCatalogue(docs: DocBuiltin[] = loadDocs()): Catalogue {
  const entries: CatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const entry = toEntry(doc);
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  const have = new Set(entries.map((e) => e.name));
  for (const name of recognisedBuiltinNames()) {
    const entry = toEntry(synthetic(name));
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    // A docs row for this name may be a different arity (round(n) vs round(n, scale)).
    // Keep the canonical snippet unless it is only the generic unknown-call fallback.
    const generic = entry.category === 'translator' && entry.snippet === `x = ${name}();`;
    if (have.has(name) && generic) continue;
    if (entries.some((e) => e.name === name && e.snippet === entry.snippet)) continue;
    seen.add(key);
    entries.push(entry);
    have.add(name);
  }
  // round() is native; round(n, scale) is shim.math.round. Both must be listed.
  if (!entries.some((e) => e.name === 'round' && e.arity >= 2)) {
    entries.push(toEntry({
      name: 'round', kind: 'function', category: 'number', receivers: ['none'], arity: 2, form: 'free',
      docUrl: 'https://www.zoho.com/deluge/help/functions/number/round.html', snippet: 'x = round(1, 2);',
    }));
  }
  if (!entries.some((e) => e.snippet === 'x = List:string();')) {
    entries.push(toEntry({
      name: 'List', kind: 'constructor', category: 'list', receivers: ['list'], arity: 1, form: 'free',
      docUrl: 'https://www.zoho.com/deluge/help/create-list-datatype.html', snippet: 'x = List:string();',
    }));
  }
  entries.sort((a, b) =>
    compareEnUs(a.category, b.category)
    || compareEnUs(a.name, b.name)
    || compareEnUs(a.receivers.join(','), b.receivers.join(','))
    || a.arity - b.arity
    || compareEnUs(a.docUrl ?? '', b.docUrl ?? '')
    || compareEnUs(a.snippet, b.snippet),
  );
  const counts = { supported: 0, shimmed: 0, todo: 0, total: entries.length };
  for (const e of entries) counts[e.status]++;
  return {
    generatedBy: 'packages/deluge/scripts/builtins-catalogue.ts',
    docs: 'packages/deluge/data/builtin-docs.json',
    dispatch: 'packages/deluge/src/dispatch.ts',
    counts,
    entries,
  };
}

export function writeCatalogue(): Catalogue {
  const cat = buildCatalogue();
  writeFileSync(cataloguePath(), JSON.stringify(cat, null, 2) + '\n');
  return cat;
}

/** Names in `recognised` that no catalogue entry covers. Used by the CI gate. */
export function missingFromCatalogue(recognised: readonly string[], entries: { name: string }[]): string[] {
  const have = new Set(entries.map((e) => e.name));
  return recognised.filter((n) => !have.has(n));
}
