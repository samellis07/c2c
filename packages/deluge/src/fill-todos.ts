/**
 * Opt-in host fills for migration TODOs.
 *
 * The plugin never calls a model and never stores a prompt. `emit` writes one
 * JSON task per remaining TODO. `accept` checks the fill and records it in
 * c2c.lock.json. `generate` re-checks every matching fill (hash, parse, AST
 * lint, size caps, per-construct shim allowlist) and splices it only when that passes.
 * A failure throws. A lock entry whose span, IR node, or translator version
 * no longer hashes to its key is reported and left unused.
 *
 * translate.ts is not modified by fills. Call shapes are
 * read back out of the generated text.
 *
 * Key preimage (canonical JSON, UTF-8, sha256 hex):
 *   { ir, note, sourceSpan, todo: { construct, coveredConstructs, ordinal }, translatorVersion }
 * Bump TRANSLATOR_VERSION when placeholder shape changes. Object keys are
 * ordered with compareEnUs, never localeCompare.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareEnUs } from '../../core/src/order.js';
import { parseFileOrProjectWithSidecars } from '../../core/src/parse.js';
import { LockedExportError } from '../../core/src/source.js';
import { transitionOwnerProperties } from './blueprint-rules.js';
import { isApprovalWorkflow, isBlueprintWorkflow, isPaymentWorkflow, isScheduleWorkflow, type App, type Form, type FunctionDef, type Property, type Workflow } from '../../core/src/ir.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { FILL_LIMITS, fillLimitRefusal, goldenProblems, lintFill } from './fill-check.js';
import {
  ACTION_CONDITION_GAP,
  actionGuardFor,
  approvalEvent,
  approvalEventGap,
  approvalScriptOptions,
  approverGap,
  emittedFieldRuleConditionFor,
  functionScriptOptions,
  generate,
  scheduleCriteriaGap,
  schedulePlansFor,
  serverScriptOptions,
  translateInApp,
  unmigratedReportCriteria,
  workflowFlowSpecs,
  workflowScriptOptions,
  type FlowSpec,
} from './generate.js';
import type { SchedulePlan } from './schedules.js';
import type { TodoItem, TranslateOptions } from './translate.js';

export const TRANSLATOR_VERSION = '1';

/** Re-export of the single fill cap table. Accept and replay call `fillLimitRefusal`. */
export { FILL_LIMITS, fillLimitRefusal };

const MIGRATION_NOTE = new Set(['blank-date-rel', 'for-each-null']);

const SHIM_UNSORTED = [
  'shim.todo',
  'shim.get',
  'shim.set',
  'shim.input.root',
  'shim.input.get',
  'shim.input.set',
  'shim.old.get',
  'shim.old.set',
  'shim.record.bind',
  'shim.record.get',
  'shim.record.set',
  'shim.list',
  'shim.map',
  'shim.each',
  'shim.datastore.query',
  'shim.datastore.rows',
  'shim.datastore.aggregate',
  'shim.datastore.column',
  'shim.datastore.field',
  'shim.datastore.insert',
  'shim.datastore.update',
  'shim.datastore.delete',
  'shim.datastore.setField',
  'shim.datastore.flush',
  'shim.mail.send',
  'shim.http.invokeurl',
  'shim.http.getUrl',
  'shim.zoho.currentDate',
  'shim.zoho.currentTime',
  'shim.zoho.loginUserId',
  'shim.zoho.loginUser',
  'shim.zoho.adminUserId',
  'shim.zoho.adminUser',
  'shim.zoho.appUri',
  'shim.zoho.ipAddress',
  'shim.zoho.appName',
  'shim.zoho.task',
  'shim.thisapp.call',
  'shim.date.parse',
  'shim.date.getYear',
  'shim.date.getMonth',
  'shim.date.getDay',
  'shim.date.getHour',
  'shim.date.getMinutes',
  'shim.date.getSeconds',
  'shim.date.addDay',
  'shim.date.addMonth',
  'shim.date.addYear',
  'shim.date.addWeek',
  'shim.date.addHour',
  'shim.date.addMinutes',
  'shim.date.addSeconds',
  'shim.date.toDate',
  'shim.date.toTime',
  'shim.date.format',
  'shim.date.text',
  'shim.date.diffDays',
  'shim.date.cmp',
  'shim.date.rel',
  'shim.decimal.from',
  'shim.decimal.add',
  'shim.decimal.sub',
  'shim.decimal.mul',
  'shim.decimal.div',
  'shim.decimal.cmp',
  'shim.math.round',
  'shim.string.replaceFirst',
  'shim.string.remove',
  'shim.isBlank',
  'shim.log.info',
  'shim.convert.toLong',
  'shim.convert.toNumber',
  'shim.convert.toDecimal',
  'shim.convert.toList',
  'shim.convert.toMap',
  'shim.convert.toJSONList',
  'shim.convert.toJSONCollection',
  'shim.client.touch',
  'shim.client.prefetch',
  'shim.client.rows',
];

export const SHIM_API: readonly string[] = [...SHIM_UNSORTED].sort((a, b) => compareEnUs(a, b));

/**
 * Reads and pure helpers. Unknown holes (`task:shareTo`, `task:if`) get this
 * set and nothing that writes, sends, or calls out. Side-effect holes add
 * exactly one capability on top (sendmail → mail.send, not delete as well).
 */
const SAFE_READS = [
  'shim.convert.toDecimal',
  'shim.convert.toJSONCollection',
  'shim.convert.toJSONList',
  'shim.convert.toList',
  'shim.convert.toLong',
  'shim.convert.toMap',
  'shim.convert.toNumber',
  'shim.decimal.add',
  'shim.decimal.cmp',
  'shim.decimal.div',
  'shim.decimal.from',
  'shim.decimal.mul',
  'shim.decimal.sub',
  'shim.each',
  'shim.input.get',
  'shim.input.root',
  'shim.isBlank',
  'shim.list',
  'shim.log.info',
  'shim.map',
  'shim.math.round',
  'shim.old.get',
  'shim.record.bind',
  'shim.record.get',
  'shim.string.remove',
  'shim.string.replaceFirst',
];

/** One Deluge side effect → the only extra shim that hole may call. */
const TASK_SIDE_EFFECT: Record<string, string> = {
  delete: 'shim.datastore.delete',
  flush: 'shim.datastore.flush',
  geturl: 'shim.http.getUrl',
  insert: 'shim.datastore.insert',
  invokeurl: 'shim.http.invokeurl',
  sendmail: 'shim.mail.send',
  setfield: 'shim.datastore.setField',
  update: 'shim.datastore.update',
};

/** method:/call: name → its shim, when that shim is not a side effect. */
const BUILTIN_SPECIFIC: Record<string, string> = {
  addday: 'shim.date.addDay',
  addhour: 'shim.date.addHour',
  addminutes: 'shim.date.addMinutes',
  addmonth: 'shim.date.addMonth',
  addseconds: 'shim.date.addSeconds',
  addweek: 'shim.date.addWeek',
  addyear: 'shim.date.addYear',
  adminuser: 'shim.zoho.adminUser',
  adminuserid: 'shim.zoho.adminUserId',
  aggregate: 'shim.datastore.aggregate',
  appname: 'shim.zoho.appName',
  appuri: 'shim.zoho.appUri',
  average: 'shim.datastore.aggregate',
  avg: 'shim.datastore.aggregate',
  cmp: 'shim.date.cmp',
  column: 'shim.datastore.column',
  count: 'shim.datastore.aggregate',
  currentdate: 'shim.zoho.currentDate',
  currenttime: 'shim.zoho.currentTime',
  diffdays: 'shim.date.diffDays',
  distinct: 'shim.datastore.aggregate',
  field: 'shim.datastore.field',
  format: 'shim.date.format',
  getday: 'shim.date.getDay',
  gethour: 'shim.date.getHour',
  getminutes: 'shim.date.getMinutes',
  getmonth: 'shim.date.getMonth',
  getseconds: 'shim.date.getSeconds',
  getyear: 'shim.date.getYear',
  info: 'shim.log.info',
  ipaddress: 'shim.zoho.ipAddress',
  isblank: 'shim.isBlank',
  loginuser: 'shim.zoho.loginUser',
  loginuserid: 'shim.zoho.loginUserId',
  max: 'shim.datastore.aggregate',
  median: 'shim.datastore.aggregate',
  min: 'shim.datastore.aggregate',
  parse: 'shim.date.parse',
  query: 'shim.datastore.query',
  rel: 'shim.date.rel',
  replacefirst: 'shim.string.replaceFirst',
  round: 'shim.math.round',
  rows: 'shim.datastore.rows',
  sum: 'shim.datastore.aggregate',
  Sum: 'shim.datastore.aggregate',
  Average: 'shim.datastore.aggregate',
  Count: 'shim.datastore.aggregate',
  Distinct: 'shim.datastore.aggregate',
  Maximum: 'shim.datastore.aggregate',
  Minimum: 'shim.datastore.aggregate',
  Median: 'shim.datastore.aggregate',
  text: 'shim.date.text',
  todate: 'shim.date.toDate',
  todecimal: 'shim.convert.toDecimal',
  tojsoncollection: 'shim.convert.toJSONCollection',
  tojsonlist: 'shim.convert.toJSONList',
  tolist: 'shim.convert.toList',
  tolong: 'shim.convert.toLong',
  tomap: 'shim.convert.toMap',
  tonumber: 'shim.convert.toNumber',
  totime: 'shim.date.toTime',
};

const DATASTORE_READS = [
  'shim.datastore.aggregate',
  'shim.datastore.column',
  'shim.datastore.field',
  'shim.datastore.query',
  'shim.datastore.rows',
];

function normConstructName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function addSafeReads(allow: Set<string>): void {
  for (const name of SAFE_READS) allow.add(name);
}

function addConstructAllow(construct: string, allow: Set<string>): void {
  const task = /^task:(.*)$/i.exec(construct);
  if (task) {
    addSafeReads(allow);
    const side = TASK_SIDE_EFFECT[normConstructName(task[1] ?? '')];
    if (side) allow.add(side);
    return;
  }
  const builtin = builtinOf(construct);
  if (!builtin) {
    addSafeReads(allow);
    return;
  }
  addSafeReads(allow);
  const key = normConstructName(builtin);
  const side = TASK_SIDE_EFFECT[key];
  if (side) {
    allow.add(side);
    return;
  }
  const specific = BUILTIN_SPECIFIC[key];
  if (!specific) return;
  allow.add(specific);
  if (DATASTORE_READS.includes(specific)) {
    for (const read of DATASTORE_READS) allow.add(read);
  }
}

/**
 * Shim calls this hole may use. Derived from the construct (and any construct
 * that collapsed into it), never from a list stored in the lock.
 * `method:` / `call:` get that builtin's shim plus the read set. A task side
 * effect gets that one capability plus the read set. Anything else (`task:shareTo`,
 * `task:if`) gets the read set only: no delete, update, insert, setField, flush,
 * mail, http, or thisapp.call.
 */
export function shimAllowlist(construct: string, covered: readonly string[] = []): readonly string[] {
  const allow = new Set<string>();
  addConstructAllow(construct, allow);
  for (const name of covered) addConstructAllow(name, allow);
  return [...allow].sort((a, b) => compareEnUs(a, b));
}

/** sha256 hex of the accepted fill text. Not part of the task id. */
export function fillHash(fill: string): string {
  return createHash('sha256').update(fill, 'utf8').digest('hex');
}

const FORBIDS = ['Date.now', 'Function', 'Math.random', 'child_process', 'eval', 'fetch', 'fs', 'net'].sort((a, b) =>
  compareEnUs(a, b),
);

export class FillTodoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FillTodoError';
  }
}

export interface SourceSpan {
  start: number;
  end: number;
  text: string;
}

export interface IrNode {
  kind: 'workflow' | 'function' | 'blueprint' | 'field-rule' | 'approver' | 'report';
  name: string;
  label: string | null;
  form: string | null;
  event: string | null;
  container: string | null;
  type: string | null;
  recordEvent: string | null;
  signature: string | null;
  fnKind: string | null;
  delugeIndex: number | null;
  transition: string | null;
  phase: string | null;
  ruleIndex: number | null;
  propertyKey: string | null;
  propertyValue: string | null;
  properties: { key: string; value: string }[];
  blockStart: number;
  blockEnd: number;
}

export interface AcceptanceTest {
  id: string;
  allow?: readonly string[];
  builtin?: string | null;
  cases?: readonly string[];
  forbids?: readonly string[];
  runtime?: string;
  syntax?: string;
}

export interface ExpectedSignature {
  async: true;
  bindings: ['ctx', 'shim'];
  form: 'expression' | 'statement' | 'note';
  replaces: string | null;
  returns: 'unknown';
}

export interface FillTask {
  id: string;
  translatorVersion: string;
  construct: string;
  ordinal: number;
  coveredConstructs: string[];
  role: 'expression' | 'statement' | 'note';
  note: string | null;
  sourceSpan: SourceSpan;
  ir: IrNode;
  placeholder: string | null;
  expectedSignature: ExpectedSignature;
  shimApi: readonly string[];
  acceptanceTests: AcceptanceTest[];
  /** Positions of this hole in the lock-free generate() output. Omitted from JSON. */
  sites: { fileIndex: number; start: number; end: number; text: string; index: number }[];
}

export interface LockEntry {
  id: string;
  translatorVersion: string;
  construct: string;
  ordinal: number;
  coveredConstructs: string[];
  note: string | null;
  sourceSpan: SourceSpan;
  ir: IrNode;
  role: 'expression' | 'statement';
  fill: string;
  /** sha256 hex of `fill`. Replay refuses to splice when this does not match. */
  fillHash: string;
}

export interface FillLock {
  version: 1;
  entries: Record<string, LockEntry>;
}

export interface StaleFill {
  id: string;
  reason: 'stale' | 'integrity' | 'note' | 'missing-site' | 'uncovered';
  detail: string;
}

interface KeyMaterial {
  translatorVersion: string;
  sourceSpan: SourceSpan;
  ir: IrNode;
  construct: string;
  ordinal: number;
  coveredConstructs: readonly string[];
  note: string | null;
}

export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FillTodoError('fill-todos: non-finite number in canonical JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => compareEnUs(a, b));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
  }
  throw new FillTodoError('fill-todos: value cannot be stored in canonical JSON');
}

export function fillKey(material: KeyMaterial): string {
  const preimage = canonicalJson({
    ir: material.ir,
    note: material.note,
    sourceSpan: material.sourceSpan,
    todo: {
      construct: material.construct,
      coveredConstructs: material.coveredConstructs,
      ordinal: material.ordinal,
    },
    translatorVersion: material.translatorVersion,
  });
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

export function builtinOf(construct: string): string | null {
  const method = /^method:(.+)$/.exec(construct);
  if (method?.[1]) return method[1];
  const call = /^call:(.+)$/.exec(construct);
  if (call?.[1]) return call[1];
  return null;
}

interface ExtractedCall {
  text: string;
  construct: string;
  role: 'expression' | 'statement';
  relStart: number | null;
  relEnd: number | null;
  start: number;
  end: number;
}

export function extractTodoCalls(source: string): ExtractedCall[] {
  const head = 'await shim.todo(';
  const out: ExtractedCall[] = [];
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(head, from);
    if (at < 0) break;
    if (insideLineComment(source, at)) {
      from = at + head.length;
      continue;
    }
    const open = at + head.length - 1;
    const close = matchingParen(source, open);
    if (close < 0) break;
    const args = source.slice(open + 1, close);
    const construct = firstStringArg(args);
    if (construct == null) {
      from = close + 1;
      continue;
    }
    const detail = detailSpan(args);
    let end = close + 1;
    const role = isStatementCall(source, at, end) ? 'statement' : 'expression';
    if (role === 'statement') {
      let cursor = end;
      while (cursor < source.length && (source[cursor] === ' ' || source[cursor] === '\t')) cursor++;
      if (source[cursor] === ';') end = cursor + 1;
    }
    out.push({
      text: source.slice(at, end),
      construct,
      role,
      relStart: detail?.start ?? null,
      relEnd: detail?.end ?? null,
      start: at,
      end,
    });
    from = end;
  }
  return out;
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '"' || ch === "'") {
      i = skipString(source, i);
    }
  }
  return -1;
}

function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i;
    i++;
  }
  return source.length;
}

/**
 * True when `at` sits inside a `//` line comment — generated files carry
 * `// Deluge:` provenance comments, and call-shaped text inside one is not a
 * call site. String and template literals earlier on the line are skipped so
 * a `//` inside one (a URL) does not mark real code as a comment.
 */
function insideLineComment(source: string, at: number): boolean {
  let i = source.lastIndexOf('\n', at - 1) + 1;
  while (i < at) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i) + 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') return true;
    i++;
  }
  return false;
}

function firstStringArg(args: string): string | null {
  let i = 0;
  while (i < args.length && /[\s,]/.test(args[i]!)) i++;
  if (/[A-Za-z_$]/.test(args[i] ?? '')) {
    while (i < args.length && /[\w$]/.test(args[i]!)) i++;
    while (i < args.length && /[\s,]/.test(args[i]!)) i++;
  }
  return readJsString(args, i)?.value ?? null;
}

function readJsString(source: string, start: number): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      const next = source[i + 1] ?? '';
      if (next === 'u' && /^[0-9a-fA-F]{4}/.test(source.slice(i + 2, i + 6))) {
        value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      value += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
    i++;
  }
  return null;
}

function detailSpan(args: string): { start: number; end: number } | null {
  const match = /\{\s*start:\s*(-?\d+)\s*,\s*end:\s*(-?\d+)\s*\}/.exec(args);
  if (!match?.[1] || !match[2]) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

function isStatementCall(source: string, start: number, end: number): boolean {
  let i = start - 1;
  for (;;) {
    while (i >= 0 && /\s/.test(source[i]!)) i--;
    // A `//` comment line (the `// Deluge:` provenance comments) is not a
    // token: keep walking back past the line it sits on.
    if (i >= 0 && insideLineComment(source, i)) {
      i = source.lastIndexOf('\n', i - 1);
      continue;
    }
    break;
  }
  const boundary = i < 0 || source[i] === ';' || source[i] === '{' || source[i] === '}';
  if (!boundary) return false;
  let j = end;
  while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;
  return source[j] === ';';
}

interface WalkCall {
  text: string;
  construct: string;
  role: 'expression' | 'statement';
  relStart: number | null;
  relEnd: number | null;
  fragment: string;
  bucket: 'server' | 'client' | 'prefetch' | 'field-rule';
  fileIndex: number;
  start: number;
  end: number;
  scanIndex: number;
}

interface Fragment {
  ir: IrNode;
  text: string;
  blockStart: number;
  server: WalkCall[];
  client: WalkCall[];
  prefetch: WalkCall[];
  todos: TodoItem[];
  serverText: string;
  clientText: string;
  prefetchText: string;
}

interface Draft {
  construct: string;
  coveredConstructs: string[];
  role: 'expression' | 'statement' | 'note';
  note: string | null;
  sourceSpan: SourceSpan;
  ir: IrNode;
  placeholder: string | null;
  calls: WalkCall[];
}

interface WalkState {
  flat: WalkCall[];
  drafts: Draft[];
  seq: number;
}

export function collectTasks(app: App): FillTask[] {
  return inspect(app).tasks;
}

function inspect(app: App): { tasks: FillTask[]; calls: number } {
  const generated = generate(app);
  const walked = walk(app);
  placeCalls(walked.flat, generated.files);
  const tasks = assignIds(walked.drafts);
  return { tasks, calls: walked.flat.length };
}

function placeCalls(flat: WalkCall[], files: readonly { source: string }[]): void {
  const scanned = scanTodoOccurrences(files);
  if (flat.length !== scanned.length) {
    throw new FillTodoError(`fill-todos: walk has ${flat.length} TODO calls, generator has ${scanned.length}`);
  }
  for (let i = 0; i < flat.length; i++) {
    const left = flat[i]!;
    const right = scanned[i]!;
    if (left.text !== right.text || left.construct !== right.construct || left.role !== right.role) {
      throw new FillTodoError(
        `fill-todos: TODO call ${i} mismatch walk ${left.construct}/${left.role} generator ${right.construct}/${right.role} (${flat.length} calls)`,
      );
    }
    left.scanIndex = i;
    left.fileIndex = right.fileIndex;
    left.start = right.start;
    left.end = right.end;
  }
}

interface TodoOccurrence {
  fileIndex: number;
  start: number;
  end: number;
  text: string;
  construct: string;
  role: 'expression' | 'statement';
}

function scanTodoOccurrences(files: readonly { source: string }[]): TodoOccurrence[] {
  const out: TodoOccurrence[] = [];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    for (const call of extractTodoCalls(files[fileIndex]!.source)) {
      out.push({
        fileIndex,
        start: call.start,
        end: call.end,
        text: call.text,
        construct: call.construct,
        role: call.role,
      });
    }
  }
  return out;
}

function assignIds(drafts: readonly Draft[]): FillTask[] {
  const seen: { key: string; n: number }[] = [];
  const tasks: FillTask[] = [];
  for (const draft of drafts) {
    const ordinalKey = canonicalJson({
      construct: draft.construct,
      coveredConstructs: draft.coveredConstructs,
      ir: draft.ir,
      note: draft.note,
      sourceSpan: draft.sourceSpan,
      translatorVersion: TRANSLATOR_VERSION,
    });
    const ordinal = nextOrdinal(seen, ordinalKey);
    const material: KeyMaterial = {
      translatorVersion: TRANSLATOR_VERSION,
      sourceSpan: draft.sourceSpan,
      ir: draft.ir,
      construct: draft.construct,
      ordinal,
      coveredConstructs: draft.coveredConstructs,
      note: draft.note,
    };
    const id = fillKey(material);
    const sites = draft.calls.map((call) => ({
      fileIndex: call.fileIndex,
      start: call.start,
      end: call.end,
      text: call.text,
      index: call.scanIndex,
    }));
    sites.sort((a, b) => a.index - b.index);
    tasks.push({
      id,
      translatorVersion: TRANSLATOR_VERSION,
      construct: draft.construct,
      ordinal,
      coveredConstructs: draft.coveredConstructs,
      role: draft.role,
      note: draft.note,
      sourceSpan: draft.sourceSpan,
      ir: draft.ir,
      placeholder: draft.placeholder,
      expectedSignature: {
        async: true,
        bindings: ['ctx', 'shim'],
        form: draft.role,
        replaces: draft.placeholder,
        returns: 'unknown',
      },
      shimApi: shimAllowlist(draft.construct, draft.coveredConstructs),
      acceptanceTests: acceptanceTests(draft.construct, draft.coveredConstructs, draft.role),
      sites,
    });
  }
  const ids: Record<string, true> = {};
  for (const task of tasks) {
    if (ids[task.id]) throw new FillTodoError(`fill-todos: duplicate key ${task.id}`);
    ids[task.id] = true;
  }
  return tasks;
}

function nextOrdinal(seen: { key: string; n: number }[], key: string): number {
  const found = seen.find((row) => row.key === key);
  if (!found) {
    seen.push({ key, n: 1 });
    return 0;
  }
  const ordinal = found.n;
  found.n++;
  return ordinal;
}

function acceptanceTests(construct: string, covered: readonly string[], role: string): AcceptanceTest[] {
  const builtin = builtinOf(construct);
  const tests: AcceptanceTest[] = [
    { id: 'codegen-lint', forbids: FORBIDS },
    { id: 'golden-vectors', builtin, cases: vectorCoverage(construct, covered) },
    { id: 'parse', syntax: role },
    { id: 'shim-api', allow: shimAllowlist(construct, covered) },
  ];
  tests.sort((a, b) => compareEnUs(a.id, b.id));
  return tests;
}

/**
 * Creator vector case ids covering a hole: the union over the construct and
 * every construct that collapsed into it. Empty means no vector covers this
 * hole, and acceptTodo rejects any fill for it.
 */
export function vectorCoverage(construct: string, covered: readonly string[] = []): string[] {
  const ids = new Set<string>();
  for (const name of [construct, ...covered]) {
    const builtin = builtinOf(name);
    if (!builtin) continue;
    for (const id of caseIdsFor(builtin)) ids.add(id);
  }
  return [...ids].sort((a, b) => compareEnUs(a, b));
}

/** First named builtin behind a hole, for the vector gate. Null when none is named. */
export function coverageBuiltin(construct: string, covered: readonly string[] = []): string | null {
  for (const name of [construct, ...covered]) {
    const builtin = builtinOf(name);
    if (builtin) return builtin;
  }
  return null;
}

let goldenCases: Record<string, string[]> | undefined;

function caseIdsFor(builtin: string): string[] {
  if (!goldenCases) {
    const doc = JSON.parse(readFileSync(join(repoRoot(), 'tests/golden/cases.json'), 'utf8')) as {
      cases: { id: string; builtin: string }[];
    };
    // Null prototype: a builtin named toString must not hit Object.prototype.toString.
    const acc: Record<string, string[]> = Object.create(null);
    for (const entry of doc.cases) {
      const list = acc[entry.builtin] ?? [];
      list.push(entry.id);
      acc[entry.builtin] = list;
    }
    for (const name of Object.keys(acc).sort((a, b) => compareEnUs(a, b))) acc[name]!.sort((a, b) => compareEnUs(a, b));
    goldenCases = acc;
  }
  return goldenCases[builtin] ?? [];
}

function walk(app: App): { flat: WalkCall[]; drafts: Draft[] } {
  const state: WalkState = { flat: [], drafts: [], seq: 0 };
  const specOf = workflowFlowSpecs(app);
  const schedulePlans = schedulePlansFor(app);
  const approvalGroups = new Map<string, Workflow[]>();
  for (const w of app.workflows) {
    if (!isApproval(w)) continue;
    const key = w.name || `approval:${w.form ?? ''}`;
    const group = approvalGroups.get(key) ?? [];
    group.push(w);
    approvalGroups.set(key, group);
  }
  for (const workflow of app.workflows) {
    if (isPayment(workflow)) continue;
    if (isBlueprint(workflow)) {
      const spec = specOf.get(workflow);
      if (spec) {
        // Mirrors emitBlueprint: a criteria todo on the workflow span, then
        // every transition phase's server script, then approver notes.
        if (spec.criteriaUnmigrated) pushGateNote(state, workflow);
        for (const transition of workflow.blueprint?.transitions ?? []) {
          for (const phase of transition.phases) {
            for (let index = 0; index < phase.deluge.length; index++) {
              const deluge = phase.deluge[index]!;
              const fragment = translateFragment(
                state,
                deluge.text,
                deluge.span.start,
                irNode({
                  kind: 'blueprint',
                  name: workflow.name,
                  label: workflow.label ?? null,
                  form: workflow.form ?? null,
                  event: workflow.event,
                  transition: transition.name,
                  phase: phase.phase,
                  delugeIndex: index,
                  properties: propList(transition.properties),
                  blockStart: deluge.span.start,
                  blockEnd: deluge.span.end,
                }),
                serverScriptOptions(app, workflow.form),
                app,
              );
              state.flat.push(...fragment.server);
              state.drafts.push(...draftsOf(serverOnly(fragment)));
            }
          }
        }
        for (const transition of workflow.blueprint?.transitions ?? []) {
          pushApprovers(state, app, workflow, transitionOwnerProperties(transition, app), transition.name, spec.form, true);
        }
      }
      if (workflow.deluge || workflow.fieldRules?.length) pushForm(state, app, workflow);
    } else if (isApproval(workflow)) {
      const key = workflow.name || `approval:${workflow.form ?? ''}`;
      const group = approvalGroups.get(key)!;
      // Same trigger as generate(): only the group's first member emits.
      if (group[0] === workflow) pushApprovalGroup(state, app, specOf, group);
    } else if (isSchedule(workflow)) {
      pushSchedule(state, app, workflow, schedulePlans.get(workflow));
    } else {
      pushForm(state, app, workflow);
    }
  }
  for (const fn of app.functions) pushFunction(state, app, fn);
  pushReportNotes(state, app);
  return { flat: state.flat, drafts: state.drafts };
}

/**
 * One deluge body inside an approval machine, in emitted order: `on start`
 * first, then levels ascending, approve before reject — the same order
 * emitApproval puts the translated scripts into the machine module.
 */
function pushApprovalGroup(state: WalkState, app: App, specOf: Map<Workflow, FlowSpec>, group: Workflow[]): void {
  const first = group[0]!;
  const spec = specOf.get(first);
  if (!spec) return; // emitApproval's early return: no spec, no machine output.
  if (spec.criteriaUnmigrated) pushGateNote(state, first);
  const form = app.forms.find((item) => item.name === spec.form);
  const starts: Workflow[] = [];
  const levels = new Map<number, { approve: Workflow[]; reject: Workflow[] }>();
  const levelApprovers = new Map<number, { workflow: Workflow; property: Property }[]>();
  for (const w of group) {
    if (/^on start\s*$/i.test(w.event)) {
      starts.push(w);
      continue;
    }
    const gap = approvalEventGap(w);
    if (gap) {
      pushNoteDraft(state, gap.construct, { start: gap.start, end: gap.end }, w.deluge?.text ?? w.event, workflowIr(w, w.span), 'approval');
      continue;
    }
    const parsed = approvalEvent(w.event)!;
    const bucket = levels.get(parsed.level) ?? { approve: [], reject: [] };
    bucket[parsed.action].push(w);
    levels.set(parsed.level, bucket);
    // resolveApprovers dedupes approver rows per level before resolving.
    const props = levelApprovers.get(parsed.level) ?? [];
    for (const p of w.approvers ?? []) {
      if (!props.some((item) => item.property.key === p.key && item.property.value === p.value)) {
        props.push({ workflow: w, property: p });
      }
    }
    levelApprovers.set(parsed.level, props);
  }
  for (const w of starts) pushApprovalScript(state, app, w, first);
  for (const level of [...levels.keys()].sort((a, b) => a - b)) {
    const entry = levels.get(level)!;
    for (const w of entry.approve) pushApprovalScript(state, app, w, first);
    for (const w of entry.reject) pushApprovalScript(state, app, w, first);
    const items = levelApprovers.get(level) ?? [];
    const properties = items.map((item) => item.property);
    for (const item of items) {
      pushApproverNote(state, item.workflow, properties, null, item.property, form);
    }
  }
}

/**
 * emitApproval gates every deluge in a group on the leader's action
 * criteria (`translate(deluge, first, ...)`), so `gate` is the group leader,
 * not the workflow that owns the script.
 */
function pushApprovalScript(state: WalkState, app: App, workflow: Workflow, gate: Workflow): void {
  if (!workflow.deluge) return;
  const fragment = translateFragment(state, workflow.deluge.text, workflow.deluge.span.start, workflowIr(workflow, workflow.deluge.span), approvalScriptOptions(), app);
  const { fragment: gated, suppressed } = gateFragment(state, app, gate, fragment, false);
  if (suppressed) pushGateNote(state, gate);
  state.flat.push(...gated.server);
  state.drafts.push(...draftsOf(serverOnly(gated)));
}

/**
 * A scheduled workflow: the generator counts schedulePlan gaps and an
 * untranslatable `form[Criteria]` as todos, emits the body as a server
 * script under the action gate, and substitutes the gap call when the link
 * criteria cannot run. Mirrored here in the same order.
 */
function pushSchedule(state: WalkState, app: App, workflow: Workflow, plan: SchedulePlan | undefined): void {
  if (plan?.gap && plan.gap !== 'workflow-action-condition') {
    pushNoteDraft(state, plan.gap, workflow.span, workflow.event, workflowIr(workflow, workflow.span), 'schedule');
  }
  const swept = plan?.kind === 'form' && !!plan.sweep;
  const fragment = workflow.deluge
    ? translateFragment(state, workflow.deluge.text, workflow.deluge.span.start, workflowIr(workflow, workflow.deluge.span), serverScriptOptions(app, workflow.form), app)
    : emptyFragment(workflowIr(workflow, workflow.span));
  const { fragment: gated, suppressed } = gateFragment(state, app, workflow, fragment, false);
  if (suppressed) pushGateNote(state, workflow);
  if (!swept && scheduleCriteriaGap(workflow)) {
    // scheduleBody replaces the whole body with the workflow-action-condition
    // gap call; whether it counts an extra todo depends on the body text, and
    // draftsOf already collapses a matching todo either way.
    const id = `f${state.seq++}`;
    const replaced = { ...gated, server: tagCalls(ACTION_CONDITION_GAP, id, 'server') };
    state.flat.push(...replaced.server);
    state.drafts.push(...draftsOf(serverOnly(replaced)));
    return;
  }
  state.flat.push(...gated.server);
  state.drafts.push(...draftsOf(serverOnly(gated)));
}

function pushForm(state: WalkState, app: App, workflow: Workflow): void {
  const fragment = workflow.deluge
    ? translateFragment(
        state,
        workflow.deluge.text,
        workflow.deluge.span.start,
        workflowIr(workflow, workflow.deluge.span),
        workflowScriptOptions(app, workflow),
        app,
      )
    : emptyFragment(workflowIr(workflow, workflow.span));
  const { fragment: gated, suppressed } = gateFragment(state, app, workflow, fragment, true);
  if (suppressed) pushGateNote(state, workflow);
  const rules = fieldRuleCalls(state, app, workflow);
  state.flat.push(...gated.server, ...gated.prefetch);
  for (const rule of rules) state.flat.push(rule);
  state.flat.push(...gated.client);
  state.drafts.push(...draftsOf(gated));
  state.drafts.push(...fieldRuleDrafts(app, workflow, rules));
}

function pushFunction(state: WalkState, app: App, fn: FunctionDef): void {
  let slot = 0;
  const fragments: Fragment[] = [];
  for (let index = 0; index < fn.deluge.length; index++) {
    const deluge = fn.deluge[index]!;
    const fragment = translateFragment(
      state,
      deluge.text,
      deluge.span.start,
      irNode({
        kind: 'function',
        name: fn.name,
        label: fn.label ?? null,
        form: fn.form ?? null,
        signature: fn.signature ?? null,
        fnKind: fn.kind,
        delugeIndex: index,
        properties: propList(fn.properties),
        blockStart: deluge.span.start,
        blockEnd: deluge.span.end,
      }),
      functionScriptOptions(app, fn, slot),
      app,
    );
    slot = fragmentNextSlot(fragment);
    fragments.push(fragment);
  }
  for (const fragment of fragments) state.flat.push(...fragment.server);
  for (const fragment of fragments) state.flat.push(...fragment.prefetch);
  for (const fragment of fragments) state.flat.push(...fragment.client);
  for (const fragment of fragments) state.drafts.push(...draftsOf(fragment));
}

/**
 * `report-criteria` notes for report and named-filter criteria the generator
 * counts but cannot emit — one per unmigrated criteria, in `.ds` order.
 */
function pushReportNotes(state: WalkState, app: App): void {
  for (const item of unmigratedReportCriteria(app)) {
    pushNoteDraft(
      state,
      'report-criteria',
      { start: item.start, end: item.end },
      item.criteria,
      irNode({
        kind: 'report',
        name: item.report.name,
        form: item.report.form ?? null,
        type: item.report.type,
        properties: propList(item.report.properties),
        blockStart: item.start,
        blockEnd: item.end,
      }),
      'report',
    );
  }
}

/** Slot counter is translate's, not stored on the fragment. Re-read it. */
function fragmentNextSlot(fragment: Fragment): number {
  void fragment;
  return lastSlot;
}

let lastSlot = 0;

function translateFragment(state: WalkState, text: string, blockStart: number, ir: IrNode, options: TranslateOptions, app: App): Fragment {
  const translated = translateInApp(app, text, options);
  lastSlot = translated.nextSlot;
  const id = `f${state.seq++}`;
  return {
    ir,
    text,
    blockStart,
    server: tagCalls(translated.server, id, 'server'),
    client: tagCalls(translated.client, id, 'client'),
    prefetch: tagCalls(translated.prefetch, id, 'prefetch'),
    todos: translated.todos,
    serverText: translated.server,
    clientText: translated.client,
    prefetchText: translated.prefetch,
  };
}

function emptyFragment(ir: IrNode): Fragment {
  return { ir, text: '', blockStart: ir.blockStart, server: [], client: [], prefetch: [], todos: [], serverText: '', clientText: '', prefetchText: '' };
}

/**
 * The `actions (criteria)` gate mirrored from generate's gateAction: a
 * condition that does not translate replaces each non-empty emitted bucket
 * with the `workflow-action-condition` gap call. `both` covers emitters that
 * also ship the client bucket (form handlers); approval and schedule paths
 * emit server only. `suppressed` is true when the gate still counts the todo
 * but no emitted bucket carried calls — the caller records a note task.
 */
function gateFragment(state: WalkState, app: App, workflow: Workflow, fragment: Fragment, both: boolean): { fragment: Fragment; suppressed: boolean } {
  if (!actionGuardFor(app, workflow).todo) return { fragment, suppressed: false };
  const id = `f${state.seq++}`;
  const gated = {
    ...fragment,
    server: fragment.serverText.trim() ? tagCalls(ACTION_CONDITION_GAP, id, 'server') : [],
    client: fragment.clientText.trim() ? tagCalls(ACTION_CONDITION_GAP, id, 'client') : [],
  };
  const suppressed = both
    ? !fragment.serverText.trim() && !fragment.clientText.trim()
    : !fragment.serverText.trim();
  return { fragment: gated, suppressed };
}

/**
 * A task with no shim.todo call: the generator counts the same hole as a
 * todos entry (a schedule-plan gap, an unresolvable approver, an unmigrated
 * report criteria, a gate todo on an empty body).
 */
function pushNoteDraft(state: WalkState, construct: string, span: { start: number; end: number }, text: string, ir: IrNode, note: string): void {
  state.drafts.push({
    construct,
    coveredConstructs: [],
    role: 'note',
    note,
    sourceSpan: { start: span.start, end: span.end, text },
    ir,
    placeholder: null,
    calls: [],
  });
}

/** The `workflow-action-condition` todo the generator counts on a workflow span. */
function pushGateNote(state: WalkState, workflow: Workflow): void {
  pushNoteDraft(state, 'workflow-action-condition', workflow.span, workflow.actionCondition ?? '', workflowIr(workflow, workflow.span), 'flow-criteria');
}

function serverOnly(fragment: Fragment): Fragment {
  return { ...fragment, client: [], prefetch: [] };
}

function tagCalls(source: string, fragment: string, bucket: WalkCall['bucket']): WalkCall[] {
  return extractTodoCalls(source).map((call) => ({
    text: call.text,
    construct: call.construct,
    role: call.role,
    relStart: call.relStart,
    relEnd: call.relEnd,
    fragment,
    bucket,
    fileIndex: -1,
    start: -1,
    end: -1,
    scanIndex: -1,
  }));
}

function fieldRuleCalls(state: WalkState, app: App, workflow: Workflow): WalkCall[] {
  const out: WalkCall[] = [];
  for (const rule of workflow.fieldRules ?? []) {
    if (!rule.condition) continue;
    const id = `f${state.seq++}`;
    out.push(...tagCalls(emittedFieldRuleConditionFor(app, workflow.form, rule.condition), id, 'field-rule'));
  }
  return out;
}

function fieldRuleDrafts(app: App, workflow: Workflow, calls: readonly WalkCall[]): Draft[] {
  const drafts: Draft[] = [];
  let cursor = 0;
  for (let index = 0; index < (workflow.fieldRules ?? []).length; index++) {
    const rule = workflow.fieldRules![index]!;
    if (!rule.condition) continue;
    const count = extractTodoCalls(emittedFieldRuleConditionFor(app, workflow.form, rule.condition)).length;
    const slice = calls.slice(cursor, cursor + count);
    cursor += count;
    for (const call of slice) {
      drafts.push({
        construct: call.construct,
        coveredConstructs: [],
        role: call.role,
        note: null,
        sourceSpan: { start: rule.span.start, end: rule.span.end, text: rule.condition },
        ir: irNode({
          kind: 'field-rule',
          name: workflow.name,
          label: workflow.label ?? null,
          form: workflow.form ?? null,
          event: workflow.event,
          ruleIndex: index,
          properties: rule.actions.map((action) => ({ key: action.action, value: action.fields.join(',') })),
          blockStart: rule.span.start,
          blockEnd: rule.span.end,
        }),
        placeholder: call.text,
        calls: [call],
      });
    }
  }
  return drafts;
}

function draftsOf(fragment: Fragment): Draft[] {
  const groups = pairBuckets(fragment.server, fragment.client);
  for (const call of fragment.prefetch) {
    const group = groups.find((item) => item[0]!.text === call.text && item.every((member) => member.bucket !== 'prefetch'));
    if (group) group.push(call);
    else groups.push([call]);
  }
  const used = fragment.todos.map(() => false);
  const matched: (TodoItem | undefined)[] = [];
  // shareWith[g] — this group's calls are extra sites of the hole matched
  // by an earlier group (an `else if` test shares its if's one todo).
  const shareWith: (number | null)[] = [];
  for (const group of groups) {
    const construct = group[0]!.construct;
    const idx = fragment.todos.findIndex((todo, index) => !used[index] && todo.construct === construct);
    if (idx >= 0) {
      used[idx] = true;
      matched.push(fragment.todos[idx]);
      shareWith.push(null);
      continue;
    }
    // The nearest preceding same-construct group already counted this hole.
    let share = -1;
    for (let g2 = matched.length - 1; g2 >= 0; g2--) {
      if (shareWith[g2] === null && matched[g2]?.construct === construct) {
        share = g2;
        break;
      }
    }
    if (share >= 0) {
      matched.push(matched[share]);
      shareWith.push(share);
    } else {
      matched.push(undefined);
      shareWith.push(null);
    }
  }
  const drafts: Draft[] = [];
  const draftOf: number[] = []; // group index -> draft index
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const share = shareWith[g];
    if (share !== null && share !== undefined) {
      drafts[draftOf[share]!]!.calls.push(...group);
      continue;
    }
    const todo = matched[g];
    const covered: string[] = [];
    if (todo) {
      for (let i = 0; i < fragment.todos.length; i++) {
        if (used[i]) continue;
        const other = fragment.todos[i]!;
        if (MIGRATION_NOTE.has(other.construct)) continue;
        if (other.start === todo.start && other.end === todo.end) {
          covered.push(other.construct);
          used[i] = true;
        }
      }
    }
    drafts.push({
      construct: group[0]!.construct,
      coveredConstructs: covered,
      role: group[0]!.role,
      note: null,
      sourceSpan: spanFor(group, todo, fragment.text, fragment.blockStart),
      ir: fragment.ir,
      placeholder: group[0]!.text,
      calls: group,
    });
    draftOf[g] = drafts.length - 1;
  }
  for (let i = 0; i < fragment.todos.length; i++) {
    if (used[i]) continue;
    const todo = fragment.todos[i]!;
    drafts.push({
      construct: todo.construct,
      coveredConstructs: [],
      role: 'note',
      note: MIGRATION_NOTE.has(todo.construct) ? 'migration-note' : 'collapsed',
      sourceSpan: {
        start: fragment.blockStart + todo.start,
        end: fragment.blockStart + todo.end,
        text: fragment.text.slice(todo.start, todo.end),
      },
      ir: fragment.ir,
      placeholder: null,
      calls: [],
    });
  }
  return drafts;
}

function pairBuckets(server: WalkCall[], client: WalkCall[]): WalkCall[][] {
  const groups: WalkCall[][] = [];
  let i = 0;
  let j = 0;
  while (i < server.length || j < client.length) {
    if (i < server.length && j < client.length && server[i]!.text === client[j]!.text) {
      groups.push([server[i]!, client[j]!]);
      i++;
      j++;
      continue;
    }
    if (i < server.length && !client.slice(j).some((call) => call.text === server[i]!.text)) {
      groups.push([server[i]!]);
      i++;
      continue;
    }
    if (j < client.length && !server.slice(i).some((call) => call.text === client[j]!.text)) {
      groups.push([client[j]!]);
      j++;
      continue;
    }
    if (i < server.length) {
      groups.push([server[i]!]);
      i++;
      continue;
    }
    groups.push([client[j]!]);
    j++;
  }
  return groups;
}

function spanFor(group: WalkCall[], todo: TodoItem | undefined, text: string, blockStart: number): SourceSpan {
  const call = group[0]!;
  if (call.relStart != null && call.relEnd != null) {
    return {
      start: blockStart + call.relStart,
      end: blockStart + call.relEnd,
      text: text.slice(call.relStart, call.relEnd),
    };
  }
  if (todo) {
    return {
      start: blockStart + todo.start,
      end: blockStart + todo.end,
      text: text.slice(todo.start, todo.end),
    };
  }
  return { start: blockStart, end: blockStart + text.length, text };
}

/**
 * Approver notes for one property list, matching resolveApprovers: only
 * properties that cannot resolve against `form` count.
 */
function pushApprovers(state: WalkState, app: App, workflow: Workflow, properties: Property[] | undefined, transition: string | null, formName: string | undefined, owner = false): void {
  const form = app.forms.find((item) => item.name === (formName ?? ''));
  for (const property of properties ?? []) {
    pushApproverNote(state, workflow, properties, transition, property, form, owner);
  }
}

function pushApproverNote(state: WalkState, workflow: Workflow, properties: Property[] | undefined, transition: string | null, property: Property, form: Form | undefined, owner = false): void {
  const construct = approverGap(property.key, property.value, form, owner);
  if (!construct) return;
  pushNoteDraft(
    state,
    construct,
    property.span,
    `${property.key}=${property.value}`,
    irNode({
      kind: 'approver',
      name: workflow.name,
      label: workflow.label ?? null,
      form: workflow.form ?? null,
      event: workflow.event,
      container: workflow.container ?? null,
      type: workflow.type ?? null,
      transition,
      propertyKey: property.key,
      propertyValue: property.value,
      properties: propList(properties),
      blockStart: property.span.start,
      blockEnd: property.span.end,
    }),
    'approver',
  );
}

function isPayment(workflow: Workflow): boolean {
  return isPaymentWorkflow(workflow);
}

function isSchedule(workflow: Workflow): boolean {
  return isScheduleWorkflow(workflow);
}

function isApproval(workflow: Workflow): boolean {
  return isApprovalWorkflow(workflow);
}

function isBlueprint(workflow: Workflow): boolean {
  return isBlueprintWorkflow(workflow);
}

function workflowIr(workflow: Workflow, block: { start: number; end: number }): IrNode {
  return irNode({
    kind: 'workflow',
    name: workflow.name,
    label: workflow.label ?? null,
    form: workflow.form ?? null,
    event: workflow.event,
    container: workflow.container ?? null,
    type: workflow.type ?? null,
    recordEvent: workflow.recordEvent ?? null,
    properties: propList(workflow.properties),
    blockStart: block.start,
    blockEnd: block.end,
  });
}

function propList(properties: Property[] | undefined): { key: string; value: string }[] {
  return (properties ?? []).map((property) => ({ key: property.key, value: property.value }));
}

function irNode(partial: Partial<IrNode> & Pick<IrNode, 'kind' | 'name'>): IrNode {
  return {
    kind: partial.kind,
    name: partial.name,
    label: partial.label ?? null,
    form: partial.form ?? null,
    event: partial.event ?? null,
    container: partial.container ?? null,
    type: partial.type ?? null,
    recordEvent: partial.recordEvent ?? null,
    signature: partial.signature ?? null,
    fnKind: partial.fnKind ?? null,
    delugeIndex: partial.delugeIndex ?? null,
    transition: partial.transition ?? null,
    phase: partial.phase ?? null,
    ruleIndex: partial.ruleIndex ?? null,
    propertyKey: partial.propertyKey ?? null,
    propertyValue: partial.propertyValue ?? null,
    properties: partial.properties ?? [],
    blockStart: partial.blockStart ?? 0,
    blockEnd: partial.blockEnd ?? 0,
  };
}

export function taskDocument(task: FillTask): Record<string, unknown> {
  return {
    acceptanceTests: task.acceptanceTests,
    construct: task.construct,
    coveredConstructs: task.coveredConstructs,
    expectedSignature: task.expectedSignature,
    id: task.id,
    ir: task.ir,
    note: task.note,
    ordinal: task.ordinal,
    placeholder: task.placeholder,
    role: task.role,
    shimApi: task.shimApi,
    sourceSpan: task.sourceSpan,
    translatorVersion: task.translatorVersion,
  };
}

export function emitTodoFiles(app: App, dir: string): FillTask[] {
  const tasks = [...collectTasks(app)].sort((a, b) => compareEnUs(a.id, b.id));
  mkdirSync(dir, { recursive: true });
  for (const task of tasks) writeFileSync(join(dir, `${task.id}.json`), `${canonicalJson(taskDocument(task))}\n`);
  return tasks;
}

export interface LockFileFs {
  openSync: (path: string, flags: number) => number;
  fstatSync: (fd: number) => { isFile(): boolean };
  readFileSync: (fd: number, encoding: 'utf8') => string;
  closeSync: (fd: number) => void;
}

/** Default reader: one `fs.openSync`, then fstat and read on that descriptor. */
const nodeLockFileFs: LockFileFs = {
  openSync,
  fstatSync,
  readFileSync: (fd, encoding) => readFileSync(fd, encoding),
  closeSync,
};

function errnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const LOCK_OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

/**
 * Open the lock once with O_NONBLOCK (a FIFO cannot block the open), then
 * fstat and read that descriptor. A path check before the read would race a
 * replacement. An open error whose code is in `absent`, or a descriptor that
 * is not a regular file, is an absent lock.
 */
function readLockFd(path: string, fsImpl: LockFileFs, absent: readonly string[]): FillLock | undefined {
  let fd: number;
  try {
    fd = fsImpl.openSync(path, LOCK_OPEN_FLAGS);
  } catch (err) {
    const code = errnoCode(err);
    if (code !== undefined && absent.includes(code)) return undefined;
    throw err;
  }
  try {
    if (!fsImpl.fstatSync(fd).isFile()) return undefined;
    let parsed: Partial<FillLock>;
    try {
      parsed = JSON.parse(fsImpl.readFileSync(fd, 'utf8')) as Partial<FillLock>;
    } catch {
      throw new FillTodoError('lock file is not valid JSON');
    }
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new FillTodoError('c2c.lock.json is not version 1');
    }
    return { version: 1, entries: parsed.entries };
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * The lock at `path`, read once. ENOENT, ENOTDIR (a path under a file) and
 * EISDIR, or a target that is not a regular file, is `undefined`: no lock.
 */
export function readLockIfPresent(path: string, fsImpl: LockFileFs = nodeLockFileFs): FillLock | undefined {
  return readLockFd(path, fsImpl, ['ENOENT', 'ENOTDIR', 'EISDIR']);
}

/**
 * The lock at `path`, or an empty lock when it is absent (ENOENT, EISDIR, or
 * not a regular file). ENOTDIR is still thrown.
 */
export function readLock(path: string, fsImpl: LockFileFs = nodeLockFileFs): FillLock {
  return readLockFd(path, fsImpl, ['ENOENT', 'EISDIR']) ?? { version: 1, entries: {} };
}

export function writeLock(path: string, lock: FillLock): void {
  writeFileSync(path, `${canonicalJson({ entries: lock.entries, version: 1 })}\n`);
}

export function normalizeFill(fill: string): string {
  if (fill.endsWith('\r\n')) return fill.slice(0, -2);
  if (fill.endsWith('\n')) return fill.slice(0, -1);
  return fill;
}

export async function acceptTodo(options: { app: App; taskId: string; fill: string; lockPath: string }): Promise<FillLock> {
  const fill = normalizeFill(options.fill);
  if (!fill.trim()) throw new FillTodoError(`task ${options.taskId} fill is empty`);
  const task = collectTasks(options.app).find((item) => item.id === options.taskId);
  if (!task) throw new FillTodoError(`unknown task ${options.taskId}`);
  if ((task.role !== 'expression' && task.role !== 'statement') || !task.placeholder) {
    throw new FillTodoError(`task ${options.taskId} is a ${task.note ?? 'note'} and has no placeholder to splice`);
  }
  const limited = fillLimitRefusal(fill);
  if (limited) throw new FillTodoError(limited);
  const allow = shimAllowlist(task.construct, task.coveredConstructs);
  const coverage = vectorCoverage(task.construct, task.coveredConstructs);
  const problems = [...lintFill(fill, task.role, allow), ...(await goldenProblems(coverageBuiltin(task.construct, task.coveredConstructs), coverage))];
  if (problems.length) throw new FillTodoError(problems.join('\n'));
  const uncovered = coverageRefusal(task);
  if (uncovered) throw new FillTodoError(uncovered);
  const entry: LockEntry = {
    construct: task.construct,
    coveredConstructs: task.coveredConstructs,
    fill,
    fillHash: fillHash(fill),
    id: task.id,
    ir: task.ir,
    note: task.note,
    ordinal: task.ordinal,
    role: task.role,
    sourceSpan: task.sourceSpan,
    translatorVersion: task.translatorVersion,
  };
  if (fillKey(entry) !== task.id) throw new FillTodoError(`task ${task.id} key did not round-trip`);
  const lock = readLock(options.lockPath);
  lock.entries[task.id] = entry;
  writeLock(options.lockPath, lock);
  return lock;
}

interface Replacement {
  index: number;
  fileIndex: number;
  start: number;
  end: number;
  placeholder: string;
  fill: string;
}

export function planFills(app: App, lock: FillLock): { stale: StaleFill[]; replacements: Replacement[] } {
  const { tasks } = inspect(app);
  const byId: Record<string, FillTask> = {};
  for (const task of tasks) byId[task.id] = task;
  const stale: StaleFill[] = [];
  const replacements: Replacement[] = [];
  for (const id of Object.keys(lock.entries).sort((a, b) => compareEnUs(a, b))) {
    const entry = lock.entries[id];
    if (!entry) continue;
    if (entry.id !== id || fillKey(entry) !== id) {
      stale.push({
        id,
        reason: 'integrity',
        detail: 'stored span, IR node, and translator version do not hash to this key',
      });
      continue;
    }
    const task = byId[id];
    if (!task) {
      stale.push({
        id,
        reason: 'stale',
        detail: 'span, IR node, or translator version changed, or the TODO is gone',
      });
      continue;
    }
    if (task.role === 'note' || !task.placeholder) {
      stale.push({ id, reason: 'note', detail: 'TODO has no generated placeholder; not applied' });
      continue;
    }
    if (!task.sites.length) {
      stale.push({ id, reason: 'missing-site', detail: 'placeholder was not found in generated output' });
      continue;
    }
    // The same vector gate as acceptTodo: a hand-written lock entry for a hole
    // no Creator vector covers is refused and the shim.todo stays.
    const uncovered = coverageRefusal(task);
    if (uncovered) {
      stale.push({ id, reason: 'uncovered', detail: uncovered });
      continue;
    }
    // Re-validate before splice. The task id does not cover the fill, and a
    // matching fillHash can be rewritten with the text, so the lint is the gate.
    assertReplayFill(entry, task);
    for (const site of task.sites) {
      replacements.push({
        index: site.index,
        fileIndex: site.fileIndex,
        start: site.start,
        end: site.end,
        placeholder: site.text,
        fill: entry.fill,
      });
    }
  }
  return { stale, replacements };
}

/** Why a fill for this hole is refused for lack of Creator vectors, or null when covered. Accept and replay share it. */
function coverageRefusal(task: FillTask): string | null {
  if (vectorCoverage(task.construct, task.coveredConstructs).length) return null;
  return (
    `task ${task.id} (${task.construct}) has no Creator vector coverage, so the fill is rejected: ` +
    `fill-todos accepts only constructs covered by tests/golden vectors`
  );
}

function assertReplayFill(entry: LockEntry, task: FillTask): void {
  if (typeof entry.fill !== 'string') {
    throw new FillTodoError(`fill-todos: lock entry ${task.id} fill is not text (refusing to splice)`);
  }
  if (entry.fillHash !== fillHash(entry.fill)) {
    throw new FillTodoError(
      `fill-todos: lock entry ${task.id} fill hash does not match the fill text (refusing to splice)`,
    );
  }
  if (task.role !== 'expression' && task.role !== 'statement') {
    throw new FillTodoError(`fill-todos: lock entry ${task.id} has no hole to splice`);
  }
  const limited = fillLimitRefusal(entry.fill);
  if (limited) throw new FillTodoError(limited);
  const problems = lintFill(entry.fill, task.role, shimAllowlist(task.construct, task.coveredConstructs));
  if (problems.length) {
    throw new FillTodoError(
      `fill-todos: lock entry ${task.id} failed static validation (refusing to splice)\n${problems.join('\n')}`,
    );
  }
}

export function reportLock(app: App, lock: FillLock): { stale: StaleFill[]; matched: string[] } {
  const plan = planFills(app, lock);
  const staleIds: Record<string, true> = {};
  for (const item of plan.stale) staleIds[item.id] = true;
  const matched = Object.keys(lock.entries)
    .filter((id) => !staleIds[id])
    .sort((a, b) => compareEnUs(a, b));
  return { stale: plan.stale, matched };
}

/** Splice matching fills. Callers that omit the lock never reach this. */
export function applyFillLock(app: App, files: { source: string }[], lock: FillLock): StaleFill[] {
  const plan = planFills(app, lock);
  const live = scanTodoOccurrences(files);
  for (const replacement of plan.replacements) {
    const occ = live[replacement.index];
    if (!occ || occ.text !== replacement.placeholder || occ.fileIndex !== replacement.fileIndex || occ.start !== replacement.start) {
      throw new FillTodoError('fill-todos: generated TODO list changed while applying the lock');
    }
  }
  const byFile: Replacement[][] = [];
  for (const replacement of plan.replacements) {
    const list = byFile[replacement.fileIndex] ?? [];
    list.push(replacement);
    byFile[replacement.fileIndex] = list;
  }
  for (let fileIndex = 0; fileIndex < byFile.length; fileIndex++) {
    const list = byFile[fileIndex];
    if (!list?.length) continue;
    list.sort((a, b) => b.start - a.start);
    let source = files[fileIndex]!.source;
    let previous = source.length;
    for (const replacement of list) {
      if (replacement.end > previous || source.slice(replacement.start, replacement.end) !== replacement.placeholder) {
        throw new FillTodoError('fill-todos: overlapping or moved TODO replacement');
      }
      source = `${source.slice(0, replacement.start)}${replacement.fill}${source.slice(replacement.end)}`;
      previous = replacement.start;
    }
    files[fileIndex]!.source = source;
  }
  return plan.stale;
}

export function loadApp(target: string): App {
  try {
    return parseFileOrProjectWithSidecars(target).ir;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new FillTodoError(`c2c: no such file or directory: ${target}`);
    throw err;
  }
}

export async function fillTodosMain(args: string[]): Promise<number> {
  const consumed = new Set<number>();
  const take = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    consumed.add(index);
    if (args[index + 1] !== undefined) consumed.add(index + 1);
    return args[index + 1];
  };
  const emitDir = take('--emit');
  const lockFlag = take('--lock');
  let taskId: string | undefined;
  let fillFile: string | undefined;
  const acceptAt = args.indexOf('--accept');
  if (acceptAt >= 0) {
    taskId = args[acceptAt + 1];
    fillFile = args[acceptAt + 2];
    consumed.add(acceptAt);
    if (taskId !== undefined) consumed.add(acceptAt + 1);
    if (fillFile !== undefined) consumed.add(acceptAt + 2);
  }
  const reportAt = args.indexOf('--report');
  const report = reportAt >= 0;
  if (report) consumed.add(reportAt);
  const positionals = args.filter((_arg, index) => !consumed.has(index));
  if (positionals.some((arg) => arg.startsWith('--')) || (emitDir !== undefined && acceptAt >= 0) || (report && (emitDir !== undefined || acceptAt >= 0))) {
    writeUsage();
    return 2;
  }
  const target = positionals[0];
  if (!target || positionals.length !== 1) {
    writeUsage();
    return 2;
  }
  try {
    const app = loadApp(target);
    if (emitDir !== undefined) {
      if (!emitDir) {
        writeUsage();
        return 2;
      }
      const tasks = emitTodoFiles(app, emitDir);
      process.stdout.write(`fill-todos emit ${tasks.length} ${emitDir}\n`);
      return 0;
    }
    if (acceptAt >= 0) {
      if (!taskId || !fillFile) {
        writeUsage();
        return 2;
      }
      const lockPath = lockFlag || 'c2c.lock.json';
      await acceptTodo({ app, taskId, fill: readFileSync(fillFile, 'utf8'), lockPath });
      process.stdout.write(`accepted ${taskId} ${lockPath}\n`);
      return 0;
    }
    if (report) {
      if (!lockFlag) {
        process.stderr.write('c2c: fill-todos --report requires --lock\n');
        return 2;
      }
      const result = reportLock(app, readLock(lockFlag));
      for (const id of result.matched) process.stdout.write(`ok ${id}\n`);
      for (const item of result.stale) process.stdout.write(`stale ${item.id} ${item.reason}\n`);
      return result.stale.length ? 1 : 0;
    }
  } catch (err) {
    // A locked Marketplace export is refused, never planned: exit 2.
    if (err instanceof LockedExportError) {
      process.stderr.write(`c2c: ${err.message}\n`);
      return 2;
    }
    const message = err instanceof Error ? err.message : 'fill-todos failed';
    process.stderr.write(`c2c: ${message}\n`);
    return 1;
  }
  writeUsage();
  return 2;
}

function writeUsage(): void {
  process.stderr.write(
    'usage: c2c fill-todos <file|dir> --emit <dir>\n' +
      '       c2c fill-todos <file|dir> --accept <task-id> <fill-file> [--lock c2c.lock.json]\n' +
      '       c2c fill-todos <file|dir> --lock <c2c.lock.json> --report\n',
  );
}
