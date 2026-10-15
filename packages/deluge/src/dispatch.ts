/**
 * Dispatch tables for Deluge built-ins the translator actually recognises.
 *
 * translate.ts consults these tables. Adding a built-in means adding it here;
 * the catalogue test fails until docs/deluge-builtins.json lists the new name.
 * Status (supported / shimmed / todo) is not declared here — the catalogue
 * derives it by translating a snippet.
 *
 * Name → implementation tables are null-prototype. Look them up with
 * `dispatchGet` (`Object.hasOwn`). A normal object would resolve
 * `toString`, `valueOf`, `constructor`, `hasOwnProperty`, and `__proto__`
 * through `Object.prototype` and emit `[native code]`.
 */
import { compareEnUs } from '../../core/src/order.js';

/** Copy `entries` onto an object with no prototype. */
function ownTable<T extends Record<string, string>>(entries: T): T {
  const table = Object.create(null) as T;
  for (const key of Object.keys(entries)) table[key as keyof T] = entries[key as keyof T]; // determinism-allow: copies a source-order literal into a null-prototype table; key order never reaches output
  return table;
}

/** Own-property lookup. Prototype names are never an implementation. */
export function dispatchGet<T>(table: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

const PREFERRED: Record<string, string> = ownTable({
  removeall: 'removeAll',
  removeelement: 'removeElement',
  getall: 'getAll',
  addall: 'addAll',
  leftpad: 'leftPad',
  substring: 'subString',
  replaceall: 'replaceAll',
  indexof: 'indexOf',
  lastindexof: 'lastIndexOf',
  tolowercase: 'toLowerCase',
  touppercase: 'toUpperCase',
  upper: 'toUpperCase',
  year: 'getYear',
  workday: 'addBusinessDay',
  weekday: 'getDayOfWeek',
  removeallalpha: 'removeAllAlpha',
  isascii: 'isAscii',
  removeallalphanumeric: 'removeAllAlphaNumeric',
  hextotext: 'hexToText',
  htmldecode: 'htmlDecode',
  htmlencode: 'htmlEncode',
  toxml: 'toXml',
  toxmllist: 'toXmlList',
  executexpath: 'executeXpath',
  isdate: 'isDate',
  getprefix: 'getPrefix',
  getsuffix: 'getSuffix',
  startswith: 'startsWith',
  startswithignorecase: 'startsWithIgnoreCase',
  texttohex: 'textToHex',
  containkey: 'containKey',
  containsvalue: 'containsValue',
  deletekey: 'deleteKey',
  deletekeys: 'deleteKeys',
  getkey: 'getKey',
  getlastkey: 'getLastKey',
  containskey: 'containKey',
  tolist: 'toList',
  tolong: 'toLong',
  tonumber: 'toNumber',
  todecimal: 'toDecimal',
  asin: 'asin',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  acos: 'acos',
  acosh: 'acosh',
  asinh: 'asinh',
  atan: 'atan',
  atan2: 'atan2',
  atanh: 'atanh',
  cosh: 'cosh',
  log10: 'log10',
  sinh: 'sinh',
  tanh: 'tanh',
  sqrt: 'sqrt',
  tomap: 'toMap',
  tojsonlist: 'toJSONList',
  tojsoncollection: 'toJSONCollection',
  geturl: 'getUrl',
  isempty: 'isEmpty',
  isnumber: 'isNumber',
  iseven: 'isEven',
  isodd: 'isOdd',
  isfile: 'isFile',
  containvalue: 'containValue',
  notcontains: 'notContains',
  deleteall: 'deleteAll',
  sortkey: 'sortKey',
  delete: 'delete',
  duplicate: 'duplicate',

  istext: 'isText',
  rightpad: 'rightPad',
  getdayofweek: 'getDayOfWeek',
  tostartofweek: 'toStartOfWeek',
  addbusinessday: 'addBusinessDay',
  days360: 'days360',
  replacefirst: 'replaceFirst',
  ifnull: 'ifnull',
  getjson: 'getJson',
  equalsignorecase: 'equalsIgnoreCase',
  containsignorecase: 'containsIgnoreCase',
  insertall: 'insertAll',
  putall: 'putAll',
  // The corpus calls the list constructor lowercase (call:list); Deluge is
  // case-insensitive, so `list()` is `List()`.
  list: 'List',
  removefirstoccurence: 'removeFirstOccurence',
  removelastoccurence: 'removeLastOccurence',
  getalpha: 'getAlpha',
  getalphanumeric: 'getAlphaNumeric',
  subtext: 'subText',
  encodeurl: 'encodeUrl',
  sublist: 'subList',
  toliststring: 'toListString',
  eomonth: 'eomonth',
  tostartofmonth: 'toStartOfMonth',
  daysbetween: 'daysBetween',
  day: 'getDay',
  monthsbetween: 'monthsBetween',
  yearsbetween: 'yearsBetween',
  totalmonths: 'totalMonths',
  totalyears: 'totalYears',
  unixepoch: 'unixEpoch',
  todatetimestring: 'toDateTimeString',
  getdayofyear: 'getDayOfYear',
  getweekofyear: 'getWeekOfYear',
  selectall: 'selectAll',
  deselectall: 'deselectAll',
  getfilename: 'getFileName',
  getfilesize: 'getFileSize',
  getfiletype: 'getFileType',
  getfilecontent: 'getFileContent',
  setfilename: 'setFileName',
  setfiletype: 'setFileType',
  setcharset: 'setCharSet',
  setfilepassword: 'setFilePassword',
  actualname: 'actualname',
  content: 'content',
});

/** Deluge names are case-insensitive. Unknown names are returned unchanged. */
export function canonicalBuiltin(name: string): string {
  const key = name.toLowerCase();
  return Object.hasOwn(PREFERRED, key) ? PREFERRED[key]! : name;
}

/**
 * Free-call argument counts for a name the help page documents as both a
 * function and a method, with the method receiver as the function's first
 * argument. The key is the canonical name in lower case. The value lists
 * those free-call counts (`method arguments + 1`), comma-separated.
 * One help page is one function: a second page for the same name (list
 * `contains` and text `contains`) is not a second implementation. The
 * method translation already chooses by the receiver's runtime type.
 */
export const CROSS_FORM_FREE_ARITIES: Record<string, string> = ownTable({
  abs: '1',
  acos: '1',
  acosh: '1',
  addbusinessday: '2',
  addday: '2',
  addhour: '2',
  addminutes: '2',
  addmonth: '2',
  addseconds: '2',
  addweek: '2',
  addyear: '2',
  asin: '1',
  asinh: '1',
  atan: '1',
  atanh: '1',
  average: '1',
  ceil: '1',
  concat: '2',
  contains: '2',
  containsignorecase: '2',
  cos: '1',
  cosh: '1',
  days360: '2',
  daysbetween: '2',
  edate: '2',
  endswith: '2',
  endswithignorecase: '2',
  eomonth: '2',
  equalsignorecase: '2',
  exp: '1',
  find: '2',
  floor: '1',
  frac: '1',
  getalpha: '1',
  getalphanumeric: '1',
  getday: '1',
  getdayofweek: '1',
  gethour: '1',
  getminutes: '1',
  getmonth: '1',
  getoccurencecount: '2',
  getprefix: '2',
  getprefixignorecase: '2',
  getseconds: '1',
  getsuffix: '2',
  getweekofyear: '1',
  getyear: '1',
  hextotext: '1',
  hour: '1',
  hoursbetween: '2',
  htmldecode: '1',
  htmlencode: '1',
  indexof: '2',
  isascii: '1',
  isblank: '1',
  isdate: '1',
  iseven: '1',
  isfile: '1',
  isnull: '1',
  isnumber: '1',
  isodd: '1',
  largest: '1',
  lastindexof: '2',
  leftpad: '2',
  len: '1',
  length: '1',
  log: '1',
  log10: '1',
  lower: '1',
  ltrim: '1',
  matches: '2',
  max: '2',
  median: '1',
  mid: '2',
  min: '2',
  minute: '1',
  month: '1',
  monthsbetween: '2',
  nextweekday: '2',
  power: '2',
  previousweekday: '2',
  remove: '2',
  removeallalpha: '1',
  removeallalphanumeric: '1',
  removefirstoccurence: '2',
  removelastoccurence: '2',
  repeat: '2',
  replaceall: '4',
  replaceallignorecase: '4',
  replacefirst: '4',
  replacefirstignorecase: '4',
  reverse: '1',
  rightpad: '2',
  rtrim: '1',
  second: '1',
  sin: '1',
  sinh: '1',
  smallest: '1',
  sqrt: '1',
  startswith: '2',
  startswithignorecase: '2',
  subbusinessday: '2',
  subday: '2',
  subhour: '2',
  subminutes: '2',
  submonth: '2',
  subseconds: '2',
  substring: '2',
  subtext: '2',
  subweek: '2',
  subyear: '2',
  tan: '1',
  tanh: '1',
  texttohex: '1',
  todate: '1',
  todatetimestring: '3',
  todecimal: '1',
  tohex: '1',
  tolong: '1',
  tolowercase: '1',
  tonumber: '1',
  tostartofmonth: '1',
  tostartofweek: '1',
  tostring: '1',
  totalmonths: '2',
  totalyears: '2',
  totext: '1',
  touppercase: '1',
  towords: '2',
  trim: '1',
  yearsbetween: '2',
});

/** True when `name(argc arguments)` is the function form of a documented method. */
export function crossFormFree(name: string, argc: number): boolean {
  const raw = dispatchGet(CROSS_FORM_FREE_ARITIES, canonicalBuiltin(name).toLowerCase());
  if (!raw) return false;
  return raw.split(',').includes(String(argc));
}

/** Date methods emitted as shim.date.<name>. `toString` is special-cased in translate.ts. */
export const DATE_METHODS = new Set([
  'getYear', 'getMonth', 'getDay', 'getHour', 'getMinutes', 'getSeconds', 'addDay', 'addMonth', 'addYear',
  'addHour', 'addMinutes', 'addSeconds', 'addWeek', 'toDate', 'toTime', 'toString',
  'addBusinessDay', 'getDayOfWeek', 'toStartOfWeek', 'days360',
  'subDay', 'subMonth', 'subYear', 'subWeek', 'subHour', 'subMinutes', 'subSeconds',
  'toStartOfMonth', 'eomonth', 'getDayOfYear', 'getWeekOfYear', 'daysBetween', 'monthsBetween', 'yearsBetween',
  'hour', 'minute', 'second', 'month', 'hoursBetween', 'nextWeekDay', 'previousWeekDay',
  'toDateTimeString', 'totalMonths', 'totalYears', 'unixEpoch',
  'edate', 'subBusinessDay',
]);

/** Text, number, and collection methods the long-tail shims implement (method or free). */
export const LONGTAIL_METHODS = new Set([
  'removeAllAlpha', 'leftPad', 'rightPad', 'isEmpty', 'isNumber', 'isText', 'isDate', 'sort', 'intersect', 'remove',
  'sin', 'cos', 'tan', 'asin',
  'removeAll', 'removeElement', 'clear', 'insert', 'insertAll', 'putAll', 'lastIndexOf', 'largest', 'smallest', 'keys', 'values', 'update',
  'getJson', 'equalsIgnoreCase', 'containsIgnoreCase',
  ...['removeFirstOccurence', 'removeLastOccurence', 'getAlpha', 'getAlphaNumeric', 'subText', 'matches', 'encodeUrl', 'left', 'right', 'mid', 'ltrim', 'rtrim', 'repeat', 'reverse'],
  'find', 'subList', 'containsValue', 'deleteKey', 'deleteKeys', 'getKey', 'getLastKey', 'frac',
  'isEven', 'isOdd', 'isFile', 'containValue', 'notContains', 'deleteAll', 'sortKey', 'delete', 'duplicate',
  'getFieldNames', 'getFieldValue',

]);

/**
 * Text functions emitted as `shim.string.<name>(text, ...args)`. Each has a
 * method form (`s.getAlpha()`) and a free form (`getAlpha(s)`).
 */
export const TEXT_FUNCTIONS = new Set(['len', 'length', 'lower', 'toLowerCase', 'toUpperCase', 'trim', 'removeFirstOccurence', 'removeLastOccurence', 'getAlpha', 'getAlphaNumeric', 'subText', 'matches', 'encodeUrl', 'left', 'right', 'mid', 'ltrim', 'rtrim', 'repeat', 'reverse', 'startsWithIgnoreCase', 'textToHex', 'getSuffix', 'isAscii', 'removeAllAlphaNumeric', 'hexToText', 'htmlDecode', 'htmlEncode']);

/**
 * XML builtins emitted as `shim.xml.<name>(...)`. Deluge names are
 * case-insensitive; `canonicalBuiltin` maps them here.
 * https://www.zoho.com/deluge/help/functions/xml/toxml.html
 * https://www.zoho.com/deluge/help/functions/xml/toxmllist.html
 * https://www.zoho.com/deluge/help/xml-manipulation/executexpath.html
 */
export const XML_FUNCTIONS = new Set(['executeXpath', 'toXml', 'toXmlList']);

/** `getUrl(url)`: the legacy GET task, sent through the invokeurl shim. */
export const GET_URL = 'getUrl';

/**
 * Choice-field client tasks (`Field.select(v)`, `Field.deselect(v)`,
 * `Field.selectAll()`, `Field.deselectAll()`), lowercased. Emitted as a client
 * `ui` action, like `Field:ui.add(...)`.
 * https://www.zoho.com/deluge/help/client-functions/select-deselect.html
 */
export const CHOICE_TASKS: Record<string, string> = ownTable({
  select: 'select',
  deselect: 'deselect',
  selectall: 'selectAll',
  deselectall: 'deselectAll',
});

/** Collection/form aggregate methods → shim.datastore.aggregate. `average` is passed as `avg`. */
export const AGGREGATE_METHODS = new Set(['count', 'sum', 'avg', 'average', 'min', 'max', 'minimum', 'maximum', 'median', 'distinct']);

export function aggregateFn(method: string): string {
  if (method === 'average') return 'avg';
  if (method === 'maximum') return 'max';
  if (method === 'minimum') return 'min';
  return method;
}

/** zoho.<key> with no further call, or a date method on that value. */
export const ZOHO_ENV: Record<string, string> = ownTable({
  currentdate: 'currentDate',
  currenttime: 'currentTime',
  loginuserid: 'loginUserId',
  loginuser: 'loginUser',
  adminuserid: 'adminUserId',
  adminuser: 'adminUser',
  appuri: 'appUri',
  ipaddress: 'ipAddress',
  appname: 'appName',
});

/** zoho.* paths matching this are shim.todo(ctx, "payments"), never a gateway call. */
export const ZOHO_PAYMENT = /payment|checkout/i;

/** Representative payment path. Spot-translation must stay a TODO. */
export const ZOHO_PAYMENT_EXAMPLES = ['zoho.checkout.create'] as const;

/** Free functions translated to a JS call with the same arguments. */
export const MATH_FUNCTIONS: Record<string, string> = ownTable({
  abs: 'Math.abs',
  power: 'Math.pow',
  pow: 'Math.pow',
  log: 'Math.log',
  ceil: 'Math.ceil',
  floor: 'Math.floor',
  min: 'Math.min',
  max: 'Math.max',
  exp: 'Math.exp',
});

/**
 * Math builtins routed through `shim.math` rather than a bare `Math.*` call:
 * a domain edge (negative sqrt, |x| > 1 for acos, x <= 0 for log10) is null,
 * and an argument a double cannot carry exactly is refused.
 * `atan2` takes two arguments and has no method form in the docs list.
 */
export const MATH_SHIM_FUNCTIONS = new Set(['acos', 'acosh', 'asinh', 'atan', 'atan2', 'atanh', 'cosh', 'log10', 'sinh', 'tanh', 'sqrt']);

/** `x.acos()` and `(1).sqrt()`: the single-argument shim.math names as number methods. */
export const MATH_SHIM_METHODS = new Set(['acos', 'acosh', 'asinh', 'atan', 'atanh', 'cosh', 'log10', 'sinh', 'tanh', 'sqrt']);

/** Deluge string method → JS method. Applied only when the receiver is not a list, map, or query. */
export const NATIVE_STRING_JS: Record<string, string> = ownTable({
  toLowerCase: 'toLowerCase',
  toUpperCase: 'toUpperCase',
  trim: 'trim',
  contains: 'includes',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  substring: 'substring',
  subString: 'substring',
  replaceAll: 'replaceAll',
  indexOf: 'indexOf',
  lastIndexOf: 'lastIndexOf',
  split: 'split',
  concat: 'concat',
});

/** Lowercased conversion method → shim.convert.<name>. */
export const CONVERSION_BY_LOWER: Record<string, string> = ownTable({
  tolong: 'toLong',
  tonumber: 'toNumber',
  todecimal: 'toDecimal',
  tolist: 'toList',
  tomap: 'toMap',
  toliststring: 'toListString',
  tojsonlist: 'toJSONList',
  tojsoncollection: 'toJSONCollection',
});

export const CONSTRUCTORS = new Set(['List', 'Collection', 'Map']);

export const LENGTH_METHODS = new Set(['length', 'size']);

/** Recognised only when the receiver expression is a list. */
export const LIST_METHODS = new Set(['add', 'addAll', 'contains', 'get']);

/** Recognised only when the receiver expression is a map. */
export const MAP_METHODS = new Set(['get', 'put', 'containKey', 'containsKey']);

/**
 * File methods. The column holds a Stratus object key (or `{ key }` before
 * write). Only the name is on that value. The rest stay generation-time
 * manual items: the key has no byte length, bytes, or content type, and
 * nothing here encrypts a PDF or ZIP or encodes a charset onto an HTTP body.
 */
export const FILE_METHODS = new Set([
  'getFileName',
  'getFileSize',
  'getFileType',
  'getFileContent',
  'content',
  'actualname',
  'setFileName',
  'setFileType',
  'setCharSet',
  'setFilePassword',
]);

/**
 * File methods with no equivalent on the stored key. Emitted as `file:<name>`.
 * Zoho documents getFileContent/getFileSize/getFileType for invokeUrl FILE
 * values, while Creator upload fields use the separate `content` attribute.
 * Creator file fields here are Stratus keys: bytes, byte length and MIME type
 * are not present in the key or retained by the invokeUrl response adapter.
 * Keep these as counted manual steps until a byte/metadata-aware file value is
 * available; guessing from a filename would not implement the documented API.
 */
export const FILE_MANUAL = new Set([
  'getFileSize',
  'getFileType',
  'getFileContent',
  'content',
  'setFileName',
  'setFileType',
  'setCharSet',
  'setFilePassword',
]);

export const REPLACE_FIRST = 'replaceFirst';
export const GET_PREFIX = 'getPrefix';
export const GET_SUFFIX = 'getSuffix';
export const GET_ALL = 'getAll';

export const ROUND_FUNCTION = 'round';
export const IFNULL_FUNCTION = 'ifnull';
/** The deprecated HTTP GET task (superseded by invokeurl): shim.http.getUrl. */
export const GET_URL_FUNCTION = 'getUrl';
export const NULL_FUNCTIONS = new Set(['isNull', 'isnull']);
export const BLANK_FUNCTIONS = new Set(['isBlank', 'isblank']);

/** Namespaces routed to a single shim rather than a per-method table. */
export const NAMESPACES = ['thisapp'] as const;

/**
 * Statement tasks the translator handles (not the generic unknown → todo path).
 * Flow-control names are native JS. Client names are actions.push. Data and
 * notification names are shim.datastore / shim.mail / shim.http.
 */
export const HANDLED_TASKS = [
  'if',
  'else if',
  'else',
  'for each',
  'for each index',
  'for each record',
  'while',
  'break',
  'continue',
  'return',
  'try',
  'info',
  'alert',
  'cancel submit',
  'reload',
  'openUrl',
  'show',
  'hide',
  'enable',
  'disable',
  'clear',
  'insert',
  'update',
  'delete',
  'sendmail',
  'invokeurl',
  'input',
  'old',
  'Sum',
  'Average',
  'Count',
  'Distinct',
  'Maximum',
  'Minimum',
  'Median',
] as const;

export function recognisedBuiltinNames(): string[] {
  const names = new Set<string>();
  for (const n of DATE_METHODS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of TEXT_FUNCTIONS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of XML_FUNCTIONS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of LONGTAIL_METHODS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of AGGREGATE_METHODS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const key of Object.keys(ZOHO_ENV)) names.add(`zoho.${key}`); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of ZOHO_PAYMENT_EXAMPLES) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of Object.keys(MATH_FUNCTIONS)) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of MATH_SHIM_FUNCTIONS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of Object.keys(NATIVE_STRING_JS)) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of Object.values(CONVERSION_BY_LOWER)) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of CONSTRUCTORS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of LENGTH_METHODS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of LIST_METHODS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of MAP_METHODS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of FILE_METHODS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  names.add(REPLACE_FIRST);
  names.add(GET_PREFIX);
  names.add(GET_SUFFIX);
  names.add(GET_ALL);
  for (const n of Object.values(CHOICE_TASKS)) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  names.add(ROUND_FUNCTION);
  names.add(IFNULL_FUNCTION);
  names.add(GET_URL_FUNCTION);
  for (const n of NULL_FUNCTIONS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of BLANK_FUNCTIONS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of NAMESPACES) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  for (const n of HANDLED_TASKS) names.add(n); // determinism-allow: collects into a Set returned as a sorted array by recognisedBuiltinNames
  return [...names].sort((a, b) => compareEnUs(a, b));
}
