/**
 * One-shot fetch of Zoho Deluge help pages into packages/deluge/data/builtin-docs.json.
 * Not used by tests. Re-run only when the official function/task index changes.
 * Network: https://www.zoho.com/deluge/help/ only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = 'https://www.zoho.com';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../data/builtin-docs.json');

/** Same contract as packages/core/src/order.ts. localeCompare would reshuffle this committed file under da/lt/et/cs. */
const compareEnUs = new Intl.Collator('en-US', {
  usage: 'sort',
  sensitivity: 'variant',
  ignorePunctuation: false,
  numeric: false,
  caseFirst: 'false',
}).compare;

/** [url, category, kind] */
const SEEDS = [
  ['/deluge/help/functions/text.html', 'text', 'function'],
  ['/deluge/help/functions/number.html', 'number', 'function'],
  ['/deluge/help/functions/date-time.html', 'date-time', 'function'],
  ['/deluge/help/functions/time.html', 'time', 'function'],
  ['/deluge/help/functions/list.html', 'list', 'function'],
  ['/deluge/help/functions/key-value.html', 'map', 'function'],
  ['/deluge/help/functions/collection.html', 'collection', 'function'],
  ['/deluge/help/functions/conversion.html', 'conversion', 'function'],
  ['/deluge/help/functions/logical.html', 'logical', 'function'],
  ['/deluge/help/functions/type-check.html', 'common', 'function'],
  ['/deluge/help/functions/utilities.html', 'common', 'function'],
  ['/deluge/help/functions/xml.html', 'xml', 'function'],
  ['/deluge/help/functions-returning-boolean.html', 'common', 'function'],
  ['/deluge/help/encryption-tasks.html', 'encryption', 'function'],
  ['/deluge/help/built-in-functions.html', 'common', 'function'],
  ['/deluge/help/data-access.html', 'data-access', 'task'],
  ['/deluge/help/aggregate-functions.html', 'data-access', 'task'],
  ['/deluge/help/client-functions.html', 'client', 'task'],
  ['/deluge/help/miscellaneous.html', 'miscellaneous', 'task'],
  ['/deluge/help/debug.html', 'debug', 'task'],
  ['/deluge/help/list-manipulations.html', 'list', 'task'],
  ['/deluge/help/map-manipulations.html', 'map', 'task'],
  ['/deluge/help/xml-manipulation.html', 'xml', 'task'],
  ['/deluge/help/file-attributes.html', 'file', 'task'],
  ['/deluge/help/file/get-file-name.html', 'file', 'function'],
  ['/deluge/help/subform-tasks.html', 'data-access', 'task'],
  ['/deluge/help/openurl.html', 'client', 'task'],
  ['/deluge/help/conditions.html', 'flow', 'task'],
  ['/deluge/help/conditional-statements/condition.html', 'flow', 'task'],
  ['/deluge/help/misc-statements/send-mail.html', 'notifications', 'task'],
  ['/deluge/help/webhook/invokeurl-api-task.html', 'notifications', 'task'],
  ['/deluge/help/notifications-using-deluge.html', 'notifications', 'task'],
  ['/deluge/help/zoho-variables.html', 'common', 'variable'],
  ['/deluge/help/integration-tasks.html', 'integration', 'integration'],
];

const MULTIWORD = new Set([
  'cancel submit',
  'for each',
  'for each index',
  'for each record',
  'else if',
  'conditional if',
  'add record',
  'send mail',
]);

const RECEIVER = {
  string: 'text',
  text: 'text',
  number: 'number',
  int: 'number',
  integer: 'number',
  decimal: 'number',
  bigint: 'number',
  long: 'number',
  date: 'date-time',
  datetime: 'date-time',
  dateTime: 'date-time',
  time: 'time',
  datetimevalue: 'date-time',
  datevalue: 'date-time',
  numericalexpression: 'number',
  numericexpression: 'number',
  numberexpression: 'number',
  stringexpression: 'text',
  textexpression: 'text',
  stringvalue: 'text',
  listvariable: 'list',
  mapvariable: 'map',
  collectionvariable: 'collection',
  timevalue: 'time',
  xmlstring: 'xml',
  jsonstring: 'json',
  list: 'list',
  map: 'map',
  keyvalue: 'map',
  keyValue: 'map',
  collection: 'collection',
  file: 'file',
  xml: 'xml',
  json: 'json',
  boolean: 'logical',
  bool: 'logical',
  expression: 'common',
  any: 'common',
};

const HAND = [
  { name: 'if', kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/conditional-statements/condition.html', snippet: 'if (1 == 1) { x = 1; }' },
  { name: 'else if', kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/conditional-statements/condition.html', snippet: 'if (1 == 0) { x = 0; } else if (1 == 1) { x = 1; }' },
  { name: 'else', kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/conditional-statements/condition.html', snippet: 'if (1 == 0) { x = 0; } else { x = 1; }' },
  { name: 'if', kind: 'function', category: 'flow', receivers: ['none'], arity: 3, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/conditional-statements/condition.html', snippet: 'x = if(1 == 1, "a", "b");' },
  { name: 'ifNull', kind: 'function', category: 'flow', receivers: ['none'], arity: 2, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/conditional-statements/condition.html', snippet: 'x = ifNull("a", "b");' },
  { name: 'for each', kind: 'task', category: 'flow', receivers: ['list'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/list-manipulations/for-each-element.html', snippet: 'for each item in {"a", "b"} { x = 1; }' },
  { name: 'for each index', kind: 'task', category: 'flow', receivers: ['list'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/list-manipulations/for-each-index.html', snippet: 'for each index i item in {"a", "b"} { x = i; }' },
  { name: 'for each record', kind: 'task', category: 'data-access', receivers: ['form'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/data-access/for-each-record.html', snippet: 'for each rec in Orders[Status == "Open"] { x = 1; }' },
  // No live Deluge help page documents `while` (loops.html and while-loop.html are 404; the help menu has no while task). Null is skipped by the docUrl check.
  { name: 'while', kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: null, snippet: 'while (1 == 0) { x = 1; }' },
  { name: 'break', kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/misc-statements/break.html', snippet: 'for each item in {"a"} { break; }' },
  { name: 'continue', kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/misc-statements/continue.html', snippet: 'for each item in {"a"} { continue; }' },
  { name: 'return', kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/misc-statements/return-statement.html', snippet: 'return "ok";' },
  { name: 'try', kind: 'task', category: 'flow', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/misc-statements/try-catch.html', snippet: 'try { x = 1; } catch (err) { x = 0; }' },
  { name: 'info', kind: 'task', category: 'debug', receivers: ['none'], arity: 1, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/debug/info.html', snippet: 'info "x";' },
  { name: 'alert', kind: 'task', category: 'client', receivers: ['none'], arity: 1, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/client-functions/alert.html', snippet: 'alert "x";' },
  { name: 'cancel submit', kind: 'task', category: 'client', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/misc-statements/cancel-submit.html', snippet: 'cancel submit;' },
  { name: 'reload', kind: 'task', category: 'client', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/client-functions/reload.html', snippet: 'reload;' },
  { name: 'openUrl', kind: 'task', category: 'client', receivers: ['none'], arity: 2, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/openurl.html', snippet: 'openUrl("https://example.test", "same window");' },
  { name: 'show', kind: 'task', category: 'client', receivers: ['none'], arity: 1, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/client-functions/hide-show.html', snippet: 'show input.Name;' },
  { name: 'hide', kind: 'task', category: 'client', receivers: ['none'], arity: 1, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/client-functions/hide-show.html', snippet: 'hide input.Name;' },
  { name: 'enable', kind: 'task', category: 'client', receivers: ['none'], arity: 1, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/client-functions/enable-disable.html', snippet: 'enable input.Name;' },
  { name: 'disable', kind: 'task', category: 'client', receivers: ['none'], arity: 1, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/client-functions/enable-disable.html', snippet: 'disable input.Name;' },
  { name: 'clear', kind: 'task', category: 'client', receivers: ['none'], arity: 1, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/client-functions/clear.html', snippet: 'clear input.Name;' },
  { name: 'sendmail', kind: 'task', category: 'notifications', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/misc-statements/send-mail.html', snippet: 'sendmail[from: "a@b.c" to: "c@d.e" subject: "s" message: "m"];' },
  { name: 'invokeurl', kind: 'task', category: 'notifications', receivers: ['none'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/webhook/invokeurl-api-task.html', snippet: 'resp = invokeurl[url: "https://example.test" type: GET];' },
  { name: 'toString', kind: 'function', category: 'time', receivers: ['date-time'], arity: 2, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/functions/common/tostring.html', snippet: 'x = "2020-01-01".toString("dd-MMM-yyyy", "Europe/Moscow");' },
  { name: 'toDateTimeString', kind: 'function', category: 'date-time', receivers: ['number'], arity: 2, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/functions/datetime/todatetimestring.html', snippet: 'x = (1693905560373).toDateTimeString("MMM dd, yy", "IST");' },
  { name: 'toDateTimeString', kind: 'function', category: 'date-time', receivers: ['none'], arity: 3, form: 'free', docUrl: 'https://www.zoho.com/deluge/help/functions/datetime/todatetimestring.html', snippet: 'x = toDateTimeString(1693905560373, "MMM dd, yy", "IST");' },
  { name: 'insert', kind: 'task', category: 'data-access', receivers: ['form'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/data-access/add-record.html', snippet: 'row = insert into Orders[Name = "A"];' },
  { name: 'update', kind: 'task', category: 'data-access', receivers: ['form'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/data-access/update-records.html', snippet: 'update Orders[ID == 1][Status = "Done"];' },
  { name: 'delete', kind: 'task', category: 'data-access', receivers: ['form'], arity: 0, form: 'task', docUrl: 'https://www.zoho.com/deluge/help/data-access/delete-records.html', snippet: 'delete from Orders[ID == 1];' },
  { name: 'input', kind: 'variable', category: 'data-access', receivers: ['form'], arity: 0, form: 'variable', docUrl: 'https://www.zoho.com/deluge/help/data-access/accessing-form-fields.html', snippet: 'x = input.Name;' },
  { name: 'old', kind: 'variable', category: 'data-access', receivers: ['form'], arity: 0, form: 'variable', docUrl: 'https://www.zoho.com/deluge/help/data-access/old.html', snippet: 'x = old.Name;' },
  { name: 'count', kind: 'function', category: 'data-access', receivers: ['form'], arity: 0, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/data-access/aggregate-records/count.html', snippet: 'x = Orders.count();' },
  { name: 'sum', kind: 'function', category: 'data-access', receivers: ['form'], arity: 1, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/data-access/aggregate-records/sum.html', snippet: 'x = Orders.sum(Amount);' },
  { name: 'average', kind: 'function', category: 'data-access', receivers: ['form'], arity: 1, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/data-access/aggregate-records/average.html', snippet: 'x = Orders.average(Amount);' },
  { name: 'min', kind: 'function', category: 'data-access', receivers: ['form'], arity: 1, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/data-access/aggregate-records/minimum.html', snippet: 'x = Orders.min(Amount);' },
  { name: 'max', kind: 'function', category: 'data-access', receivers: ['form'], arity: 1, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/data-access/aggregate-records/maximum.html', snippet: 'x = Orders.max(Amount);' },
  { name: 'median', kind: 'function', category: 'data-access', receivers: ['form'], arity: 1, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/data-access/aggregate-records/median.html', snippet: 'x = Orders.median(Amount);' },
  { name: 'distinct', kind: 'function', category: 'data-access', receivers: ['form'], arity: 1, form: 'method', docUrl: 'https://www.zoho.com/deluge/help/data-access/aggregate-records/distinct.html', snippet: 'x = Orders.distinct(Name);' },
];

function absUrl(href) {
  if (!href) return null;
  let u = href.trim();
  if (u.startsWith('//')) u = `https:${u}`;
  else if (u.startsWith('/')) u = ROOT + u;
  else if (u.startsWith('http://www.zoho.com')) u = 'https://www.zoho.com' + u.slice('http://www.zoho.com'.length);
  else if (u.startsWith('http://zoho.com')) u = 'https://www.zoho.com' + u.slice('http://zoho.com'.length);
  try {
    const url = new URL(u);
    if (url.hostname !== 'www.zoho.com') return null;
    if (!url.pathname.startsWith('/deluge/help/')) return null;
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function isIndex(url) {
  const path = new URL(url).pathname;
  // service indexes, including crm-integration-tasks-V8.html
  if (/tasks[^/]*\.html$/i.test(path)) return true;
  if (/\/deluge\/help\/functions\/[^/]+\.html$/i.test(path)) return true;
  if (/\/deluge\/help\/(built-in-functions|functions-returning-boolean|data-access|aggregate-functions|client-functions|miscellaneous|debug|list-manipulations|map-manipulations|xml-manipulation|file-attributes|subform-tasks|integration-tasks|conditions|loops)\.html$/i.test(path)) {
    return true;
  }
  return false;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|code|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

function linksOf(html) {
  const out = [];
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const u = absUrl(m[1]);
    if (u) out.push(u);
  }
  return out;
}

const BANNER = /^(deluge|help|zoho deluge|syntax|overview|example|note|description|response|parameters?|related links)$/i;

function pageTitle(html) {
  const titles = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((m) => htmlToText(m[1]).replace(/\s+/g, ' ').trim())
    .filter((t) => t && !BANNER.test(t));
  return titles[0] ?? '';
}

const STOP_NAMES = new Set([
  'and', 'or', 'if', 'for', 'where', 'variable', 'characters', 'returns', 'true', 'false', 'null', 'info',
  'the', 'function', 'task', 'syntax', 'example', 'note', 'when', 'this', 'that', 'with', 'from', 'into',
  'each', 'index', 'while', 'return', 'try', 'catch', 'else', 'not', 'is', 'in', 'overview', 'description',
  'parameter', 'parameters', 'data', 'type', 'string', 'number', 'list', 'map', 'collection', 'boolean',
  'text', 'date', 'time', 'key', 'value', 'response', 'request', 'optional', 'required', 'format',
]);

/** HTML between the Syntax heading and the next Example/Response heading. */
function syntaxRegion(html) {
  const re = /<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi;
  let m;
  let start = -1;
  let end = html.length;
  while ((m = re.exec(html))) {
    const label = htmlToText(m[0]).replace(/\s+/g, ' ').trim();
    if (start < 0 && /^syntax$/i.test(label)) {
      start = m.index + m[0].length;
      continue;
    }
    if (start >= 0 && /^(examples?|response|related|this task|scenario)\b/i.test(label)) {
      end = m.index;
      break;
    }
  }
  return start < 0 ? html : html.slice(start, end);
}

/** Formal signature lives in scriptNew / deluge-syntax, not the first "Syntax" word in the TOC. */
function signatureBlocks(html) {
  const chunks = [];
  const preRe = /<pre\b[^>]*\bdeluge-syntax\b[^>]*>([\s\S]*?)<\/pre>/gi;
  const divRe = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bscriptNew\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  for (const re of [preRe, divRe]) {
    let m;
    while ((m = re.exec(html))) chunks.push(m[1]);
  }
  const seen = new Set();
  const blocks = [];
  for (const chunk of chunks) {
    const text = normalizeSig(htmlToText(chunk));
    if (!text || text.length > 700 || seen.has(text)) continue;
    seen.add(text);
    blocks.push(text);
  }
  const formal = blocks.filter((b) => /<[^>\n]{1,80}>/.test(b));
  if (formal.length) return formal;
  return blocks.filter((b) =>
    /\(|^(?:hide|show|enable|disable|clear|alert|info|openUrl|reload|insert|update|delete|sendmail|invokeurl|return|break|continue)\b/i.test(b),
  ).slice(0, 6);
}

function normalizeSig(text) {
  return text
    .replace(/<\s+/g, '<')
    .replace(/\s+>/g, '>')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*\.\s*/g, '.')
    .replace(/\s*,\s*/g, ', ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** The CRM pages document a fake `zoho.crm.v8.task(...)` in a note. Never catalogue it. */
function placeholderZoho(name) {
  return /\.task$/i.test(name) || /\.v\d+\./i.test(name);
}

function keepFree(name, args, title) {
  if (STOP_NAMES.has(name) || STOP_NAMES.has(name.toLowerCase())) return false;
  if (BANNER.test(name)) return false;
  if (name.length < 2) return false;
  const titles = title.split('|').map((s) => s.replace(/\([^)]*\)/g, '').trim().toLowerCase());
  if (titles.includes(name.toLowerCase())) return true;
  if (args.includes('<') || args.includes('>')) return true;
  return false;
}

function cleanName(raw) {
  return raw.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\(\)/g, '').trim();
}

function acceptable(name) {
  if (MULTIWORD.has(name)) return true;
  if (/^zoho\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(name)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true;
  return false;
}

function splitArgs(args) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of args) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter((p) => p && p !== '...');
}

function arityOf(parts, blob) {
  const low = blob.toLowerCase();
  let optional = 0;
  for (const p of parts) {
    if (/\(optional\)/i.test(p)) {
      optional++;
      continue;
    }
    const token = (p.match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? '').toLowerCase();
    if (!token || token.length < 3) continue;
    let at = 0;
    let marked = false;
    while ((at = low.indexOf(token, at)) >= 0) {
      if (low.slice(at, at + 48).includes('(optional)')) {
        marked = true;
        break;
      }
      at += token.length;
    }
    if (marked) optional++;
  }
  return Math.max(0, parts.length - optional);
}

function receiverOf(word) {
  if (!word) return null;
  const key = word.replace(/[^A-Za-z]/g, '');
  return RECEIVER[key] ?? RECEIVER[key.toLowerCase()] ?? null;
}

const TASK_LINE = ['cancel submit', 'openUrl', 'sendmail', 'invokeurl', 'reload', 'alert', 'info', 'hide', 'show', 'enable', 'disable', 'clear', 'insert', 'update', 'delete', 'return', 'break', 'continue'];

const TYPED = new Set(['text', 'number', 'date-time', 'time', 'list', 'map', 'collection', 'xml', 'file', 'json']);

function entriesFromPage(url, category, kind, html) {
  const blocks = signatureBlocks(syntaxRegion(html));
  const title = pageTitle(html);
  const pageText = htmlToText(html);
  const found = [];
  const seen = new Set();

  const push = (entry) => {
    const name = cleanName(entry.name);
    if (!acceptable(name) || BANNER.test(name) || STOP_NAMES.has(name) || STOP_NAMES.has(name.toLowerCase())) return;
    if (placeholderZoho(name)) return;
    const key = `${name}|${entry.form}|${(entry.receivers ?? []).join(',')}|${entry.arity}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ ...entry, name });
  };

  const zohoIn = (syn) => [...syn.matchAll(/zoho\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+/g)]
    .map((m) => m[0])
    .filter((n) => n.split('.').length >= 3 && !placeholderZoho(n));
  const zohoPage = blocks.some((syn) => zohoIn(syn).length > 0);

  for (const syn of blocks) {
    for (const name of [...new Set(zohoIn(syn))]) {
      const re = new RegExp(`${name.replace(/\./g, '\\.')}\\(([^)]*)\\)`, 'i');
      const call = syn.match(re);
      const parts = call ? splitArgs(call[1]) : [];
      const at = pageText.toLowerCase().indexOf(name.toLowerCase());
      const blob = at >= 0 ? pageText.slice(at, at + 2200) : syn;
      push({
        name,
        kind: 'integration',
        category: name.startsWith('zoho.encryption.') ? 'encryption' : 'integration',
        receivers: ['none'],
        arity: call ? arityOf(parts, blob) : 0,
        form: 'free',
        docUrl: url,
        syntax: syn.slice(0, 400),
      });
    }
    if (zohoPage) continue;

    for (const m of syn.matchAll(/<([A-Za-z][A-Za-z0-9_]*)>\.([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)/g)) {
      const recv = receiverOf(m[1]);
      const receivers = recv ? [recv] : (TYPED.has(category) ? [category] : ['none']);
      const parts = splitArgs(m[3]);
      push({
        name: m[2],
        kind: kind === 'integration' ? 'function' : kind,
        category,
        receivers,
        arity: arityOf(parts, pageText),
        form: 'method',
        docUrl: url,
        syntax: syn.slice(0, 400),
      });
    }

    for (const m of syn.matchAll(/(?:^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)/g)) {
      if (m[1] === 'zoho') continue;
      if (!keepFree(m[1], m[2], title)) continue;
      push({
        name: m[1],
        kind: kind === 'integration' ? 'function' : kind,
        category,
        receivers: ['none'],
        arity: arityOf(splitArgs(m[2]), pageText),
        form: 'free',
        docUrl: url,
        syntax: syn.slice(0, 400),
      });
    }

    for (const m of syn.matchAll(/:ui\.([A-Za-z_][A-Za-z0-9_]*)\(([^)]*)\)/g)) {
      const parts = splitArgs(m[2]);
      const arity = arityOf(parts, pageText);
      const callArgs = Array.from({ length: arity }, () => '"x"').join(', ');
      push({
        name: m[1],
        kind: 'task',
        category: 'client',
        receivers: ['none'],
        arity,
        form: 'task',
        docUrl: url,
        snippet: `input.Name:ui.${m[1]}(${callArgs});`,
        syntax: syn.slice(0, 400),
      });
    }

    for (const m of syn.matchAll(/<([A-Za-z][A-Za-z0-9_]*)>\.([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g)) {
      const recv = receiverOf(m[1]);
      const receivers = recv ? [recv] : (TYPED.has(category) ? [category] : ['none']);
      push({
        name: m[2],
        kind: kind === 'integration' ? 'function' : kind,
        category,
        receivers,
        arity: 0,
        form: 'method',
        docUrl: url,
        syntax: syn.slice(0, 400),
      });
    }

    if (!/\(/.test(syn)) {
      for (const word of TASK_LINE) {
        const re = new RegExp(`^${word.replace(' ', '\\s+')}\\b`, 'i');
        if (!re.test(syn)) continue;
        const placeholders = syn.match(/<[^>]+>/g) ?? [];
        push({
          name: word,
          kind: 'task',
          category,
          receivers: ['none'],
          arity: placeholders.length,
          form: 'task',
          docUrl: url,
          syntax: syn.slice(0, 400),
        });
      }
    }
  }

  const tasks = new Map();
  const rest = [];
  for (const e of found) {
    if (e.form !== 'task') {
      rest.push(e);
      continue;
    }
    const prev = tasks.get(e.name);
    if (!prev || e.arity < prev.arity) tasks.set(e.name, e);
  }
  const kept = [...rest, ...tasks.values()];
  if (kept.length) return kept;

  if (!found.length) {
    for (const name of title.split('|').map((s) => cleanName(s)).filter((n) => acceptable(n) && !BANNER.test(n))) {
      push({
        name,
        kind,
        category,
        receivers: TYPED.has(category) ? [category] : ['none'],
        arity: 0,
        form: kind === 'task' || kind === 'variable' ? (kind === 'variable' ? 'variable' : 'task') : 'free',
        docUrl: url,
        syntax: '',
      });
    }
  }
  return found;
}

function ignoreLeaf(url) {
  const path = new URL(url).pathname.toLowerCase();
  return /connections\.html$|api-names\.html$|overview\.html$/.test(path);
}

function lowerFileUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/');
  const file = parts[parts.length - 1] ?? '';
  const lower = file.toLowerCase();
  if (!file || lower === file) return url;
  parts[parts.length - 1] = lower;
  u.pathname = parts.join('/');
  return u.toString();
}

async function fetchPage(url) {
  const headers = { 'user-agent': 'c2c-builtin-catalogue/0.1 (docs indexing)', accept: 'text/html' };
  let finalUrl = url;
  let res = await fetch(url, { headers, redirect: 'follow' });
  if (res.status === 404) {
    const lowered = lowerFileUrl(url);
    if (lowered !== url) {
      const retry = await fetch(lowered, { headers, redirect: 'follow' });
      if (retry.ok) {
        res = retry;
        finalUrl = lowered;
      }
    }
  }
  if (!res.ok) throw new Error(`${res.status}`);
  return { url: finalUrl, html: await res.text() };
}

const TOSTRING_PAGE = 'https://www.zoho.com/deluge/help/functions/common/tostring.html';
const TOTEXT_PAGE = 'https://www.zoho.com/deluge/help/functions/common/to-text.html';
const ZOHO_VARIABLES_PAGE = 'https://www.zoho.com/deluge/help/zoho-variables.html';
const INVOKEURL_PAGE = 'https://www.zoho.com/deluge/help/webhook/invokeurl-api-task.html';
/** Live pathname after Zoho's redirect. Stored URL must match that pathname exactly. */
const DOC_URL_CANON = {
  'https://www.zoho.com/deluge/help/functions/map/isempty.html': 'https://www.zoho.com/deluge/help/functions/text/is-empty.html',
  'https://www.zoho.com/deluge/help/functions/datetime/getYear.html': 'https://www.zoho.com/deluge/help/functions/datetime/getyear.html',
  'https://www.zoho.com/deluge/help/functions/map/putAll.html': 'https://www.zoho.com/deluge/help/functions/map/putall.html',
  'https://www.zoho.com/deluge/help/functions/string/equalsIgnoreCase.html': 'https://www.zoho.com/deluge/help/functions/string/equalsignorecase.html',
  'https://www.zoho.com/deluge/help/functions/string/getOccurenceCount.html': 'https://www.zoho.com/deluge/help/functions/string/getoccurencecount.html',
  'https://www.zoho.com/deluge/help/functions/string/getAlphaNumeric.html': 'https://www.zoho.com/deluge/help/functions/string/getalphanumeric.html',
  'https://www.zoho.com/deluge/help/functions/string/getAlpha.html': 'https://www.zoho.com/deluge/help/functions/string/getalpha.html',
  'https://www.zoho.com/deluge/help/functions/string/getSuffix.html': 'https://www.zoho.com/deluge/help/functions/string/getsuffix.html',
  'https://www.zoho.com/deluge/help/functions/string/removeAllAlpha.html': 'https://www.zoho.com/deluge/help/functions/string/removeallalpha.html',
};

/** Rewrite retired or cross-cited doc URLs before they are committed. */
function normalizeDocEntry(entry) {
  if (typeof entry.docUrl === 'string' && DOC_URL_CANON[entry.docUrl]) entry.docUrl = DOC_URL_CANON[entry.docUrl];
  const url = entry.docUrl;
  if (entry.name === 'while' && (url == null || url.endsWith('/loops.html') || url.endsWith('/while-loop.html'))) {
    entry.docUrl = null;
  } else if (url === 'https://www.zoho.com/deluge/help/web-data/invokeurl-task.html') {
    entry.docUrl = INVOKEURL_PAGE;
  } else if (url === 'https://www.zoho.com/deluge/help/system-variables.html' || url === 'https://www.zoho.com/deluge/help/functions/common/zoho-variables.html') {
    entry.docUrl = ZOHO_VARIABLES_PAGE;
  } else if (entry.name === 'toString' && url === TOTEXT_PAGE) {
    entry.docUrl = TOSTRING_PAGE;
  } else if (entry.name === 'toText' && url === TOSTRING_PAGE) {
    entry.docUrl = TOTEXT_PAGE;
  }
  return entry;
}

function distinctDocUrls(entries) {
  return [...new Set(entries.map((e) => e.docUrl).filter((url) => typeof url === 'string' && url.length > 0))];
}

/**
 * Every committed docUrl must be HTTP 200 at the path we store.
 * A redirect to a different pathname (system-variables.html → zoho-variables.html) fails
 * so the stored URL is the page that actually answered.
 */
async function assertDocUrlsLive(urls) {
  const failures = [];
  await pool(urls, 8, async (url) => {
    const headers = { 'user-agent': 'c2c-builtin-catalogue/0.1 (docs indexing)', accept: 'text/html' };
    try {
      const res = await fetch(url, { headers, redirect: 'follow' });
      const finalPath = new URL(res.url).pathname;
      const requestedPath = new URL(url).pathname;
      if (res.status !== 200 || finalPath !== requestedPath) {
        failures.push(`${url} status=${res.status} final=${finalPath}`);
      }
    } catch (err) {
      failures.push(`${url} ${err.message ?? err}`);
    }
  });
  if (failures.length) {
    throw new Error(`docUrl check failed (${failures.length}):\n${failures.join('\n')}`);
  }
}

async function pool(items, limit, fn) {
  const q = [...items];
  const workers = Array.from({ length: limit }, async () => {
    while (q.length) {
      const item = q.shift();
      if (!item) return;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

if (process.argv.includes('--verify-committed')) {
  const committed = JSON.parse(readFileSync(OUT, 'utf8'));
  const urls = distinctDocUrls(committed.entries ?? []);
  await assertDocUrlsLive(urls);
  process.stderr.write(`docUrls ok ${urls.length}\n`);
  process.exit(0);
}

if (process.argv.includes('--check')) {
  const samples = [
    ['/deluge/help/crm/create-record.html', 'integration', 'integration'],
    ['/deluge/help/functions/string/contains.html', 'text', 'function'],
    ['/deluge/help/functions/number/round.html', 'number', 'function'],
    ['/deluge/help/client-functions/hide-show.html', 'client', 'task'],
    ['/deluge/help/functions/common/isnull.html', 'logical', 'function'],
    ['/deluge/help/bookings/create-appointment.html', 'integration', 'integration'],
  ];
  for (const [path, category, kind] of samples) {
    const url = absUrl(ROOT + path);
    try {
      const page = await fetchPage(url);
      const html = page.html;
      const pageEntries = entriesFromPage(page.url, category, kind, html);
      process.stdout.write(`\n== ${path} blocks=${signatureBlocks(html).length} entries=${pageEntries.length}\n`);
      for (const e of pageEntries) process.stdout.write(`  ${e.form} ${e.name} recv=${e.receivers.join('+')} arity=${e.arity} | ${(e.syntax ?? '').slice(0, 140)}\n`);
    } catch (err) {
      process.stdout.write(`\n== ${path} FAIL ${err.message}\n`);
    }
  }
  process.exit(0);
}

const queue = SEEDS.map(([path, category, kind]) => ({ url: absUrl(ROOT + path), category, kind, depth: 0 })).filter((s) => s.url);
const seen = new Set();
const entries = [...HAND];
let fetched = 0;
let failed = 0;
const failedUrls = [];

while (queue.length) {
  const batch = [];
  while (queue.length && batch.length < 8) {
    const item = queue.shift();
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    batch.push(item);
  }
  if (!batch.length) break;
  await Promise.all(batch.map(async (item) => {
    try {
      const page = await fetchPage(item.url);
      const html = page.html;
      fetched++;
      if (isIndex(item.url) && item.depth < 3) {
        for (const href of linksOf(html)) {
          if (!seen.has(href) && !ignoreLeaf(href)) queue.push({ url: href, category: item.category, kind: item.kind, depth: item.depth + 1 });
        }
        return;
      }
      if ((item.depth === 0 && isIndex(item.url)) || ignoreLeaf(item.url)) return;
      if (item.category === 'file' && item.depth < 2) {
        for (const href of linksOf(html)) {
          if (!seen.has(href) && !ignoreLeaf(href) && href.includes('/deluge/help/file')) {
            queue.push({ url: href, category: 'file', kind: 'function', depth: item.depth + 1 });
          }
        }
      }
      const pageEntries = entriesFromPage(page.url, item.category, item.kind, html);
      entries.push(...pageEntries);
      if (fetched % 40 === 0) process.stderr.write(`fetched ${fetched} entries ${entries.length}\n`);
    } catch (err) {
      failed++;
      failedUrls.push(`${item.url} ${err.message ?? err}`);
    }
  }));
}

const dedup = new Map();
for (const raw of entries) {
  const e = normalizeDocEntry(raw);
  if (!acceptable(e.name) && !MULTIWORD.has(e.name)) continue;
  const key = [e.name, e.category, e.kind, (e.receivers ?? []).join('+'), e.arity, e.form ?? '', e.docUrl ?? '', e.snippet ?? ''].join('|');
  if (!dedup.has(key)) dedup.set(key, e);
}
const list = [...dedup.values()].sort((a, b) =>
  compareEnUs(a.category, b.category) || compareEnUs(a.name, b.name) || compareEnUs(a.docUrl ?? '', b.docUrl ?? '') || a.arity - b.arity,
);
for (const e of list) delete e.syntax;

const doc = {
  source: 'https://www.zoho.com/deluge/help/',
  note: 'Hand-maintained after a Zoho help scrape. Edit names, receivers, arity, docUrl, and snippet. Status is NOT stored here — packages/deluge/scripts/builtins-catalogue.ts derives it from the translator.',
  entries: list,
};
await assertDocUrlsLive(distinctDocUrls(list));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
if (failedUrls.length) process.stderr.write(failedUrls.map((u) => `fail ${u}`).join('\n') + '\n');
process.stderr.write(`done fetched=${fetched} failed=${failed} entries=${list.length} -> ${OUT}\n`);
