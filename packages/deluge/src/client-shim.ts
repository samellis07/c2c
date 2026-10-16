/**
 * The shim surface the browser runtime implements (`browserShim` in
 * packages/ui/src/client-runtime.js). Client code may only reference these:
 * any other `shim.<ns>` or `shim.<ns>.<method>` would reach the browser's
 * catch-all stub, which answers every call with a truthy proxy. The
 * translator keeps a statement whose client code needs anything else as a
 * counted `client-shim-unsupported` todo and emits no client code for it.
 */
/** Shim names the browser calls directly (`shim.each(...)`, `shim.list()`). */
export const CLIENT_SHIM_CALLABLE: ReadonlySet<string> = new Set(['each', 'get', 'ifnull', 'isBlank', 'isEmpty', 'isNull', 'isNumber', 'list', 'map', 'set', 'todo']);

/** Namespaces and the methods the browser implements on each. */
export const CLIENT_SHIM_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>([
  ['client', new Set(['call', 'element', 'prefetch', 'rows', 'touch'])],
  ['compare', new Set(['eq', 'ne'])],
  ['convert', new Set(['toLong', 'toNumber'])],
  [
    'date',
    new Set([
      'addDay',
      'addHour',
      'addMinutes',
      'addMonth',
      'addSeconds',
      'addWeek',
      'addYear',
      'days360',
      'daysBetween',
      'diffDays',
      'format',
      'getDay',
      'getDayOfWeek',
      'getDayOfYear',
      'getHour',
      'getMinutes',
      'getMonth',
      'getSeconds',
      'getYear',
      'monthsBetween',
      'parse',
      'rel',
      'subDay',
      'subHour',
      'subMinutes',
      'subMonth',
      'subSeconds',
      'subWeek',
      'subYear',
      'text',
      'toDate',
      'toTime',
      'yearsBetween',
    ]),
  ],
  ['decimal', new Set(['add', 'cmp', 'div', 'from', 'mul', 'sub'])],
  ['input', new Set(['get', 'root', 'set'])],
  [
    'list',
    new Set([
      'add',
      'addAll',
      'clear',
      'column',
      'contains',
      'containsKey',
      'containsValue',
      'deleteAll',
      'deleteItem',
      'deleteKey',
      'deleteKeys',
      'distinct',
      'duplicate',
      'get',
      'getKey',
      'getLastKey',
      'indexOf',
      'insert',
      'insertAll',
      'intersect',
      'keys',
      'lastIndexOf',
      'length',
      'notContains',
      'put',
      'putAll',
      'remove',
      'removeAll',
      'removeElement',
      'size',
      'sort',
      'sortKey',
      'subList',
      'update',
      'values',
    ]),
  ],
  ['old', new Set(['get'])],
  ['record', new Set(['bind', 'get', 'set', 'system'])],
  ['string', new Set(['getAlphaNumeric', 'removeAllAlpha'])],
  ['subform', new Set(['currentRow'])],
  ['zoho', new Set(['adminUser', 'adminUserId', 'appName', 'appUri', 'currentDate', 'currentTime', 'loginUser', 'loginUserId'])],
]);

const SHIM_REF = /\bshim\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;

/**
 * `shim.<ns>[.<method>]` references in emitted client code that the browser
 * runtime does not implement, sorted and de-duplicated. A bare namespace read
 * counts too: `shim.zoho.appUri` is a property the browser does not have.
 */
export function unsupportedClientShims(code: string): string[] {
  if (!code.includes('shim.')) return [];
  const out = new Set<string>();
  for (const m of code.matchAll(SHIM_REF)) {
    const ns = m[1]!;
    const method = m[2];
    if (method === undefined) {
      if (!CLIENT_SHIM_CALLABLE.has(ns) && !CLIENT_SHIM_METHODS.has(ns)) out.add(ns);
      continue;
    }
    if (!CLIENT_SHIM_METHODS.get(ns)?.has(method)) out.add(`${ns}.${method}`);
  }
  return [...out].sort();
}
