/**
 * Deluge AST → ES2022.
 *
 * Each statement is counted once:
 * - **todo** if it is unknown or contains an untranslated construct
 * - else **shimmed** if it uses the shim (records, mail, invokeurl, zoho, thisapp, input, dates, decimals, client tasks)
 * - else **translated** (control flow, operators, strings, collections)
 *
 * Client tasks (alert, cancel submit, openUrl, info, reload, show/hide/enable/disable/clear, field:ui.*)
 * are emitted only into the client body. Datastore, mail, invokeurl, zoho.* tasks and thisapp.*
 * are emitted only into the server body. Input reads/writes and pure assignments are emitted
 * into both so each module can run on its own.
 *
 * A client action guarded by a server read is not a TODO. The read is lifted into `prefetch`
 * (one slot per expression) and the client evaluates the condition against that snapshot.
 * See CLIENT-SPLIT.md.
 */

import { decimalAuditSink } from './audit.js';
import type { Expr, Param, Stmt } from './ast.js';
import {
  AGGREGATE_METHODS,
  BLANK_FUNCTIONS,
  CHOICE_TASKS,
  CONSTRUCTORS,
  CONVERSION_BY_LOWER,
  DATE_METHODS,
  GET_ALL,
  GET_PREFIX,
  FILE_MANUAL,
  FILE_METHODS,
  GET_SUFFIX,
  GET_URL_FUNCTION,
  IFNULL_FUNCTION,
  MATH_FUNCTIONS,
  MATH_SHIM_FUNCTIONS,
  MATH_SHIM_METHODS,
  NATIVE_STRING_JS,
  NULL_FUNCTIONS,
  REPLACE_FIRST,
  ROUND_FUNCTION,
  TEXT_FUNCTIONS,
  ZOHO_ENV,
  ZOHO_PAYMENT,
  aggregateFn,
  canonicalBuiltin,
  crossFormFree,
  dispatchGet,
} from './dispatch.js';
import { connectionArgIndex, resolveConnectionArgument, walk, type DeclaredConnection } from './connections.js';
import { parse, parseExpression } from './parser.js';
import { lex } from './lexer.js';
import type { Criteria } from '../../shims/src/criteria.js';
import type { SchemaPlan } from '../../schema/src/generator.js';
import { plainRecordStages } from '../../schema/src/limits.js';

export interface TranslateStats {
  statements: number;
  translated: number;
  shimmed: number;
  todo: number;
}

export interface TodoItem {
  construct: string;
  start: number;
  end: number;
  /**
   * `follows-comment-line` — the statement sits directly under a `//`
   * comment-only line, which is also where a wrapped comment tail lands.
   * Adjacency alone never changes the verdict; the note flags it for review.
   */
  note?: string;
}

export interface TranslateResult {
  server: string;
  client: string;
  /** Server statements that fill `slots` for the client. Empty when the client needs no server read. */
  prefetch: string;
  /** True when the prefetch body has a per-element slot the client POSTs a loop element for. */
  usesElement?: boolean;
  /** Next free slot index. Pass as `slotStart` when translating another span into the same handler. */
  nextSlot: number;
  stats: TranslateStats;
  todos: TodoItem[];
}

export interface TranslateOptions {
  /** Names that are the current row (`rec` in a "for each record" function). */
  rowNames?: string[];
  /**
   * Field link names of the current row's form. In a "for each record"
   * function a bare field name (`thisapp.Vote.vote(ID)`) is a read of that
   * row, emitted as `shim.record.get(<row>, "<field>")` on the first name in
   * `rowNames`. Locals still win. A `type = functions` action with
   * `execution type = for each record` runs once per selected record of its
   * `form`, and its body names that record's fields bare (gallery shape:
   * `form = Raise_an_Idea`, `thisapp.Vote.vote(ID);`). `ID` is the record ID.
   */
  rowFields?: string[];
  /**
   * A form link name that names the row binding `row`: a function with
   * `execution type = for each record` names its current record, and one with
   * `collection of records` its selected records, by the form
   * (`thisapp.CustomAction.approveVisa(Add_Visa_Details)`). Locals still win.
   */
  rowAlias?: { name: string; row: string };
  /**
   * The script runs in an approval process. `approver.<x>` (gallery shape:
   * `sendmail ( to : approver.submitter )`) has no definition in the Deluge
   * docs, so it is an explicit todo (`approval-approver`), not a free name.
   */
  approval?: boolean;
  /** First slot index, so concatenated spans do not reuse `c0`. */
  slotStart?: number;
  /**
   * Form field link names. An unbound name in this set is `input.<field>`,
   * which is how a workflow `actions (Status == "Overdue")` criteria is written.
   * Locals still win. Pass this only for the criteria, not the action body.
   */
  inputFields?: string[];
  /**
   * Link names of decimal, percent, and currency fields. A read of one of
   * these names is an exact decimal. Arithmetic, unary minus, and relational
   * comparisons then go through `shim.decimal`, not JS numbers.
   */
  decimalFields?: string[];
  /**
   * Link names of lookup fields. A bare read is the stored reference object,
   * so `Field == literal` compares the id/label through `shim.compare`, not
   * object identity.
   */
  lookupFields?: string[];
  /**
   * Local variable names that start out holding a decimal value (e.g. function parameters).
   */
  decimalVars?: string[];
  /**
   * Whether the enclosing event may carry an `alert`. Live-tested on Creator:
   * `alert` runs in on load, on validate, on change / on user input, and on
   * click (custom action / button) actions, and is rejected by the importer in
   * a form-workflow on success. Everywhere else (schedules, approvals,
   * blueprint phases, record events, standalone functions) is unverified: the
   * alert is still not emitted, but the diagnostic says 'unverified' rather
   * than 'disallowed'. Defaults to 'allowed' so direct `translate` calls keep
   * body-level semantics.
   */
  alertEvent?: AlertEventClass;
  /**
   * Deluge names the generated prefetch module binds without a replayed
   * assignment: a custom function's parameters (`var [params] = ctx.args`) and
   * `row` in a subform row event (`shim.subform.currentRow`). A prefetch slot
   * that reads any other unbound local — a loop variable or a name assigned
   * inside a branch — cannot be computed there, so it becomes a todo instead
   * of a free identifier.
   */
  prefetchBound?: string[];
  /**
   * Form link names of the app. A bare form name is the form's full
   * collection (`for each r in Form`, `Form.count()`), not a variable.
   * Locals and `inputFields` still win.
   */
  formNames?: string[];
  /**
   * Schema plan for this app. When a full-row read would exceed a ZCQL cap,
   * the emitted query carries `zcql` stages. Omitted on a direct translate()
   * call, which stays byte-identical.
   */
  schema?: SchemaPlan;
  /** Map of form link name to its declared field link names. */
  formFields?: Record<string, string[]>;
  /**
   * Declared connections. A connection argument that equals one connection's
   * display name, and not its link name, is emitted as the link name.
   * Omitted on a direct translate() call, which stays byte-identical.
   */
  connections?: DeclaredConnection[];
  /** Names of user-defined functions in the app. */
  functions?: string[];
  /**
   * Dotted `thisapp` callees the generator proved read-only from their emitted
   * server bodies. A client condition may call these through the generated
   * `/functions/<name>/call` endpoint; every other app-function call stays a
   * `client-condition-uses-server` todo.
   */
  clientCallFunctions?: readonly string[];
}

export type AlertEventClass = 'allowed' | 'disallowed' | 'unverified';

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new',
  'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'await', 'let', 'enum', 'of', 'static', 'implements', 'package', 'private', 'protected',
  'public', 'interface', 'arguments', 'eval',
  // Names the generator emits into the same scope as the translated body:
  // function/handler params (`ctx`), destructured module locals
  // (`shim`, `slots`, `actions`, `prefetched`), the custom-function wrapper
  // locals (`record`, `principal`, `runtime`), and the generated row bindings
  // (`rec`, `recs`, `row`). A Deluge name equal to any of these would redeclare
  // the emitted binding — a SyntaxError — or capture it. All are renamed `d_*`.
  'ctx', 'shim', 'slots', 'actions', 'prefetched', 'record', 'principal', 'runtime',
  'rec', 'recs', 'row',
]);

const AGG = AGGREGATE_METHODS;

interface Fx {
  code: string;
  serverOnly: boolean;
  /** True when the client can evaluate `code` from values it already has (including a prefetched row). */
  clientReady: boolean;
  shim: boolean;
  todo: boolean;
  constructs: string[];
  /**
   * Non-blocking diagnostics: constructs emitted into `todos` without marking
   * the statement todo. fill-todos reports them as `note` tasks — an explicit,
   * documented unsupported diagnostic, not a silent drop.
   */
  notes: string[];
  /** Local names this expression reads. */
  reads: string[];
  /**
   * Read names that had no local binding when the expression was translated —
   * unbound, bound only later, or bound only in a non-dominating arm. A name
   * the prefetch module binds (`prefetchBound`: function params, the subform
   * `row`) is bound. A binding carrying one is never safe to replay: its
   * recorded value is not the value this expression saw.
   */
  unboundReads: string[];
  query: boolean;
  list: boolean;
  map: boolean;
  /** A record value (fetched row, or the `Form.Subform()` row constructor). */
  row: boolean;
  date: boolean;
  decimal: boolean;
  /** Text: a string literal, or a `+` that concatenates one. */
  text: boolean;
  /** A read whose value may be a lookup `{id,label}` reference object. */
  lookup: boolean;
  simpleLookup?: SimpleKeyLookup;
  /** App-function calls are never safe to replay from a client prefetch slot. */
  appFunction: boolean;
  /**
   * The expression writes or calls out — an insert/update/delete, mail, an
   * integration task, or a same-app function. A binding holding one can never
   * be replayed into the prefetch: the prefetch would run the effect a second
   * time.
   */
  sideEffect: boolean;
  /** A criteria expression carrying `range from … to …` (a page window). */
  ranged: boolean;
  /**
   * A query whose `range from`/`range to` the client can evaluate and send as
   * request parameters: `code` is the same query call with the bounds read
   * from `ctx.rangeFrom`/`ctx.rangeTo`, so the prefetch endpoint can serve the
   * read later, once the client's accumulated scalars are known.
   */
  clientRange?: { from: Fx; to: Fx; code: string };
  /**
   * Server reads inside this expression whose criteria are a conjunction with
   * one `Key == row.Field` leaf: each can be answered for every prefetched row
   * by one batched `IN` query instead of a per-row call.
   */
  rowReads?: RowRead[];
}

interface SimpleKeyLookup {
  form: string;
  keyField: string;
  rowName: string;
  rowKeyField: string;
  targetField: string;
}

/** A server read keyed by one prefetched row, answered by one batched map query. */
interface RowRead {
  kind: 'field' | 'rows' | 'aggregate';
  /** Exact emitted call inside the expression code; the batched value replaces it. */
  call: string;
  form: string;
  /** Equality field on the read's form. */
  keyField: string;
  rowName: string;
  /** Field on the loop row the key equality reads. `''` when the row is the key itself. */
  rowKeyField: string;
  /** The loop element is the key directly (a non-record `for each` element). */
  rowScalar?: boolean;
  targetField?: string;
  fn?: string;
  /** Emitted aggregate field argument (`undefined`, a link name literal, or expression code). */
  field?: string;
  /** Emitted criteria object for the conjuncts that do not read the row. */
  extra?: string;
  /**
   * Emitted criteria for conjuncts that DO read a row: extra keyed leaves and
   * other row-dependent tests. The batched read fetches candidates by `keyField`
   * and `extra`, and generated code post-filters each row's candidates through
   * `shim.datastore.matches` with this criteria — no second query.
   */
  rowRest?: string;
  /** Names `rowRest` reads (the row itself, or locals bound inside the map loop). */
  rowDeps?: string[];
  /** Emitted JS a missing key reads as: field null, rows `[]`, count 0, other aggregate null. */
  noMatch: string;
}

interface Binding {
  code: string;
  reads: string[];
  /** Names read before any local binding existed — never safe to replay. */
  unboundReads: string[];
  /** The bound expression called an app function: it must not be replayed by the prefetch. */
  appFunction: boolean;
  /** The bound expression is an untranslated/dynamic call: it must not be replayed by the prefetch. */
  todo: boolean;
  /**
   * The bound expression writes or calls out. Optional only so a caller can
   * omit it; a missing flag is not a side effect.
   */
  sideEffect?: boolean;
  /**
   * The binding each entry in `reads` resolved to when this assignment ran —
   * the value the replay must reproduce, which is not always the name's latest
   * binding (`n = 1; limit = n; n = n + 9` records `limit`'s read of `n` as the
   * first assignment). A self-read records the binding this assignment
   * replaced. A read with no binding records `undefined`: the name resolves
   * against `prefetchBound`, or the local is unbound.
   */
  deps: Map<string, Binding | undefined>;
  /** Creation order within the translation; the replay emits in this order. */
  seq: number;
  /**
   * The control-flow frame the assignment ran under: 0 is the handler's top
   * level; each if/else arm, loop body, try/catch arm and function body opens
   * a fresh frame. A binding replays only while its frame is still open — an
   * arm or loop-body assignment does not dominate a later point of use. A
   * binding created before a loop also does not dominate a read inside that
   * loop when the body assigns the same name: the value changes across
   * iterations, so one replay would be a single iteration.
   */
  flow: number;
  /** The value is already bound in the prefetch module (a param): nothing to emit. */
  bound?: boolean;
  /** Emit the replayed value under this name instead of the dep key (a previous `var name`). */
  emitAs?: string;
  rowReads?: RowRead[];
}

/** One `for each` whose elements the client already iterates. */
interface LoopFrame {
  name: string;
  /** Collection expression evaluated on the server. */
  source: string;
  /** Slot or row-map lookup, once the client can iterate the same rows. */
  clientSource: string | null;
  /** The collection as the client resolver sees it (`rows(...)` for a query). */
  iter: Fx;
  /** Elements are scalars, not records: the map key is the element itself. */
  scalar?: boolean;
  /** Bindings `source` reads, emitted ahead of the map loop. */
  deps?: string[];
  /** The collection is a non-read or reads one: `source` must never reach the prefetch. */
  refused?: boolean;
  closed: boolean;
  depth: number;
}

/** Extra server read for each prefetched row, keyed by row ID. */
interface RowMap {
  slot: string;
  /** Rows the value reads, outermost first once sorted by depth. */
  frames: LoopFrame[];
  /** Assignments that mention those rows, emitted inside the loop. */
  bindings: string[];
  value: string;
  simpleLookup?: SimpleKeyLookup;
  /** Row-keyed reads inside `value` or `bindings` that can share one batched query each. */
  rowReads: RowRead[];
}

interface Scope {
  local: Set<string>;
  query: Set<string>;
  list: Set<string>;
  map: Set<string>;
  date: Set<string>;
  /** Locals whose current value is an exact decimal. */
  decimal: Set<string>;
  /** Form link names stored as exact decimals. */
  decimalFields: Set<string>;
  row: Set<string>;
  serverOnly: Set<string>;
  /** Loop elements whose snapshot is in scope on the client. */
  clientData: Set<string>;
  /**
   * Loop elements that are non-record server data the client iterates from a
   * snapshot (a `getAll` column, a server function result). A client
   * condition that reads one plus other server data is evaluated with one
   * server round trip per element through the prefetch endpoint.
   */
  elementVars: Set<string>;
  /** Server-side collection source each element variable is iterated from. */
  elementCollections: Map<string, string>;
  /** Per-element slots emitted into `prefetch` (client round trips). */
  elementSlots: number;
  declaredServer: Set<string>;
  declaredClient: Set<string>;
  /** Form fields that a bare name reads via `input`. */
  inputFields: Set<string>;
  /** Lookup fields: a bare read is the stored `{id,label}` reference object. */
  lookupFields: Set<string>;
  /** Fields that a bare name reads from the current row `rowField.row`. */
  rowFields: { row: string; names: Set<string> } | null;
  rowAlias: { name: string; row: string } | null;
  approval: boolean;
  bindings: Map<string, Binding>;
  /** Monotonic ids shared with nested function scopes: binding seq and flow frames. */
  clock: { seq: number; flow: number };
  /** Open control-flow frames; index 0 is the handler top level. */
  flowStack: number[];
  /**
   * Enclosing `for each` / `while` bodies, innermost last. A name in
   * `assigned` is written somewhere in that body, so a binding created before
   * the body (`flow` less than `frame`) is not a single value for a read inside it.
   */
  loops: { frame: number; assigned: Set<string> }[];
  /** The binding object already replayed into the prefetch function per name. */
  emitted: Map<string, Binding>;
  /** Names bound in the prefetch module without a replayed assignment (params, `row`). */
  prefetchBound: Set<string>;
  /** The app's form link names; a bare one is the form's collection. */
  formNames: Set<string>;
  formFields: Map<string, Set<string>>;
  functions: Set<string>;
  /** Dotted `thisapp` names allowed to become `shim.client.call` in a client condition. */
  clientCallFunctions: Set<string>;
  prefetch: string[];
  /** Server loops currently being translated, outermost first. */
  rowFrames: LoopFrame[];
  /** Every server loop in this translation, including ones already closed. */
  knownLoops: LoopFrame[];
  /** Unique id source for previous-binding dep keys (shared across fn scopes). */
  depSeq: { next: number };
  /** Row maps whose loops are emitted once the collections they walk exist. */
  pendingMaps: RowMap[];
  /** Deferred slot reads: `if (ctx.rangeSlot === "cN") { … }` blocks. */
  deferred: string[];
  loopDepth: number;
  slot: number;
  alertEvent: AlertEventClass;
  /** Raw source, for comment-tail lookup. */
  src: string;
  /**
   * Line-start offsets that directly follow a `//` comment-only line. The .ds
   * export can wrap a long `//` comment so its tail lands on the next physical
   * line without a `//` prefix, but an ordinary comment above a live `alert`
   * has the same shape — adjacency is only a `follows-comment-line` note on
   * the diagnostic, never a reason to soften the verdict.
   */
  commentTails: Set<number>;
  /** App schema, when the caller is generating a whole app. Absent for a direct translate(). */
  schema?: SchemaPlan;
  /** Declared connections for rewriting a display-name argument to its link name. */
  connections: DeclaredConnection[];
  /** Live `expr()` depth. Past {@link EXPR_STACK_LIMIT} the walk returns a todo. */
  exprDepth: number;
}

interface Out {
  server: string;
  client: string;
}

const EMPTY: Fx = {
  code: 'undefined',
  serverOnly: false,
  clientReady: true,
  shim: false,
  todo: false,
  constructs: [],
  notes: [],
  reads: [],
  unboundReads: [],
  query: false,
  list: false,
  map: false,
  row: false,
  date: false,
  decimal: false,
  text: false,
  lookup: false,
  appFunction: false,
  sideEffect: false,
  ranged: false,
};

function fx(partial: Partial<Fx> & { code: string }): Fx {
  const serverOnly = partial.serverOnly ?? false;
  return {
    ...EMPTY,
    ...partial,
    serverOnly,
    clientReady: partial.clientReady ?? !serverOnly,
    constructs: partial.constructs ?? [],
    notes: partial.notes ?? [],
    reads: partial.reads ?? [],
    unboundReads: partial.unboundReads ?? [],
  };
}

function mergeFx(code: string, parts: Fx[], flags: Partial<Fx> = {}): Fx {
  const serverOnly = parts.some((p) => p.serverOnly) || !!flags.serverOnly;
  const reads = [...new Set([...parts.flatMap((p) => p.reads), ...(flags.reads ?? [])])];
  const unboundReads = [...new Set([...parts.flatMap((p) => p.unboundReads), ...(flags.unboundReads ?? [])])];
  return fx({
    code,
    serverOnly,
    clientReady: flags.clientReady ?? (!flags.serverOnly && parts.every((p) => p.clientReady)),
    shim: parts.some((p) => p.shim) || !!flags.shim,
    todo: parts.some((p) => p.todo) || !!flags.todo,
    constructs: [...parts.flatMap((p) => p.constructs), ...(flags.constructs ?? [])],
    notes: [...parts.flatMap((p) => p.notes), ...(flags.notes ?? [])],
    reads,
    unboundReads,
    query: !!flags.query,
    list: !!flags.list,
    map: !!flags.map,
    row: parts.some((p) => p.row) || !!flags.row,
    date: !!flags.date,
    decimal: !!flags.decimal,
    text: !!flags.text,
    lookup: !!flags.lookup,
    simpleLookup: flags.simpleLookup,
    appFunction: parts.some((p) => p.appFunction) || !!flags.appFunction,
    sideEffect: parts.some((p) => p.sideEffect) || !!flags.sideEffect,
    ranged: parts.some((p) => p.ranged) || !!flags.ranged,
    rowReads: [...parts.flatMap((p) => p.rowReads ?? []), ...(flags.rowReads ?? [])],
  });
}

function clientExpr(value: Fx, scope: Scope, todoConstruct = 'client-condition-uses-server', allowClientCall = false): { code: string; todo: boolean; shim: boolean } {
  // A read-only app function is an event-time server call, not a prefetch
  // replay. Every `thisapp` call in the expression must resolve to a callee
  // the generator classified read-only; one writer keeps the counted todo.
  // The gate applies only where a condition decides the client actions: a
  // `ui.add`/`openUrl` argument is not the measured condition path.
  if (allowClientCall && value.appFunction && !value.todo && todoConstruct === 'client-condition-uses-server') {
    // The call's arguments run client-side, so every name the expression
    // reads must be bound there: a client-bound loop variable or a local
    // whose current binding emitted a client assignment. A server-bound
    // local (`n = Form[…]…; if(thisapp.F(n))`) has no client value — keep
    // the todo path instead of emitting a free identifier.
    const clientBound =
      value.unboundReads.length === 0 &&
      value.reads.every((name) => scope.clientData.has(name) || (scope.local.has(name) && !scope.serverOnly.has(name)));
    if (clientBound) {
      const call = clientCallCode(value.code, scope);
      if (call !== null) return { code: call, todo: false, shim: true };
    }
  }
  // App-function and untranslated/dynamic calls must not be replayed by the
  // client prefetch; their bodies may have side effects. A bare call to a
  // declared function is not server-only, so the refusal precedes the
  // server-only check — the placeholder is what keeps the construct counted.
  if (value.appFunction || value.todo) {
    return { code: `await shim.todo(ctx, ${JSON.stringify(todoConstruct)})`, todo: true, shim: true };
  }
  if (!value.serverOnly || value.clientReady) return { code: value.code, todo: false, shim: false };
  // A non-record loop element is client data the client can send back:
  // the prefetch endpoint evaluates the server part for that one element.
  // A same-app function call never runs this way. Two elements, or a record
  // element, cannot be one round trip. A name read before any binding exists
  // has no value the prefetch module could evaluate.
  const elements = new Set<string>();
  let blocked = false;
  const walk = (name: string, stack: Set<string>): void => {
    if (stack.has(name)) return;
    if (scope.elementVars.has(name)) {
      elements.add(name);
      return;
    }
    if (scope.clientData.has(name)) {
      blocked = true;
      return;
    }
    const binding = scope.bindings.get(name);
    if (!binding) return;
    stack.add(name);
    for (const d of binding.reads) walk(d, stack);
    stack.delete(name);
  };
  for (const r of value.reads) walk(r, new Set());
  if (
    todoConstruct === 'client-condition-uses-server' &&
    !blocked &&
    elements.size === 1 &&
    !value.unboundReads.length
  ) {
    const slot = elementSlot(value, elements.values().next().value!, scope);
    if (slot !== null) return { code: slot, todo: false, shim: true };
  }
  // The expression reads the current prefetched row and another server value.
  // One scalar slot cannot see the row. A map keyed by row ID can: the prefetch
  // evaluates the read for each row already fetched for that loop.
  // A refused or ambiguous element read is a counted todo. It is not a row map:
  // a non-record element has no row ID. A record loop variable is client data
  // (so the walk above sets `blocked`) and still uses the row map.
  if (elements.size > 0) {
    return { code: `await shim.todo(ctx, ${JSON.stringify(todoConstruct)})`, todo: true, shim: true };
  }
  const closure = rowClosure(value, scope);
  if (!value.todo && closure.rows.length && closure.ok) {
    const mapped = queueRowMap(value, closure.rows, scope);
    if (mapped) return { code: mapped, todo: false, shim: true };
  }
  if (closure.rows.length || value.reads.some((r) => scope.clientData.has(r)) || blocked) {
    return { code: `await shim.todo(ctx, ${JSON.stringify(todoConstruct)})`, todo: true, shim: true };
  }
  const slot = slotExpr(value, scope);
  if (slot === null) {
    return { code: `await shim.todo(ctx, ${JSON.stringify(todoConstruct)})`, todo: true, shim: true };
  }
  return { code: slot, todo: false, shim: true };
}

/**
 * Names in `value` that are the current prefetched row, following bindings.
 * `ok` is false when a local in that closure has no prefetch value (a loop
 * variable that is not a prefetched row, or a name assigned where no binding
 * was recorded).
 */
function rowClosure(value: Fx, scope: Scope): { rows: string[]; ok: boolean } {
  const rows: string[] = [];
  const seen = new Set<string>();
  let ok = true;
  const walk = (name: string, stack: Set<string>): void => {
    if (!ok || stack.has(name) || seen.has(name)) {
      if (stack.has(name)) ok = false;
      return;
    }
    seen.add(name);
    if (scope.clientData.has(name)) {
      rows.push(name);
      return;
    }
    const binding = scope.bindings.get(name);
    if (binding) {
      stack.add(name);
      for (const dep of binding.reads) walk(dep, stack);
      stack.delete(name);
      return;
    }
    if (scope.prefetchBound.has(name)) return;
    if (scope.local.has(name) || scope.serverOnly.has(name) || scope.query.has(name) || scope.row.has(name)) ok = false;
  };
  for (const name of value.reads) walk(name, new Set());
  if (!ok || !rows.length) return { rows, ok };
  const rowSet = new Set(rows);
  for (const name of seen) {
    if (!rowBindingOk(name, scope, rowSet, new Set())) ok = false;
  }
  return { rows, ok };
}

/**
 * True when `name` can be computed inside a loop that binds `rows`.
 * Walks the binding recorded at the assignment (`deps`), not a later rebind.
 * The row itself is client data and is allowed; any other client value is not.
 * Does not call the scalar `bindingOk`: that one treats every client-data
 * read as a failure, which is right for a scalar slot and wrong for a row map.
 */
function rowBindingOk(name: string, scope: Scope, rows: Set<string>, stack: Set<string>): boolean {
  if (rows.has(name)) return true;
  if (stack.has(name) || scope.clientData.has(name)) return false;
  const binding = scope.bindings.get(name);
  if (!binding) return scope.prefetchBound.has(name) || !scope.local.has(name);
  return rowVersionOk(name, binding, scope, rows, new Set());
}

function rowVersionOk(name: string, binding: Binding, scope: Scope, rows: Set<string>, seen: Set<Binding>): boolean {
  if (binding.appFunction || binding.todo || binding.sideEffect || binding.unboundReads.length) return false;
  if (!flowOk(binding, scope)) return false;
  for (const loop of scope.loops) {
    if (loop.assigned.has(name) && binding.flow < loop.frame) return false;
  }
  if (seen.has(binding)) return true;
  seen.add(binding);
  return binding.reads.every((dep) => {
    if (rows.has(dep)) return true;
    if (scope.clientData.has(dep)) return false;
    const recorded = binding.deps.get(dep);
    if (dep === name) return recorded ? rowVersionOk(dep, recorded, scope, rows, seen) : scope.prefetchBound.has(name);
    if (recorded) return rowVersionOk(dep, recorded, scope, rows, seen);
    return scope.prefetchBound.has(dep);
  });
}

function dependsOnRow(name: string, scope: Scope, rows: Set<string>, stack: Set<string>): boolean {
  if (rows.has(name)) return true;
  if (stack.has(name)) return false;
  const binding = scope.bindings.get(name);
  if (!binding) return false;
  return bindingDepends(binding, scope, rows, new Set());
}

/** Row dependence through the bindings the assignment recorded. */
function bindingDepends(binding: Binding, scope: Scope, rows: Set<string>, seen: Set<Binding>): boolean {
  if (seen.has(binding)) return false;
  seen.add(binding);
  return binding.reads.some((dep) => {
    if (rows.has(dep)) return true;
    const recorded = binding.deps.get(dep);
    return recorded ? bindingDepends(recorded, scope, rows, seen) : false;
  });
}

/** Replay bindings that do not read the loop row. Row-dependent ones are emitted inside the map loop. */
function emitPlainBindings(names: readonly string[], scope: Scope, rows: Set<string>, stack: Set<string>): boolean {
  for (const name of names) {
    if (stack.has(name) || rows.has(name)) continue;
    const binding = scope.bindings.get(name);
    if (!binding) continue;
    if (bindingDepends(binding, scope, rows, new Set())) {
      stack.add(name);
      for (const dep of binding.reads) {
        const recorded = binding.deps.get(dep);
        if (recorded && bindingDepends(recorded, scope, rows, new Set())) continue;
        if (!emitPlainBindings([dep], scope, rows, stack)) return false;
      }
      stack.delete(name);
      continue;
    }
    if (!replayNow(name, scope)) return false;
  }
  return true;
}

/**
 * Calls the row-map prefetch must not replay. These write, send, or leave the
 * app. Reads (`datastore.lookupMap` / `rowsMap` / `aggregateMap`, `zoho.loginUser`,
 * `list.get` / `size`) stay. A loop *collection* is judged by the same list
 * through `collectionReplayRefused`, including its transitive read chain.
 */
const NON_READ_REPLAY =
  /\bshim\.(?:mail\.send|http\.(?:getUrl|postUrl|invokeurl)|datastore\.(?:insert|update|delete|setField|flush)|zoho\.task|thisapp\.call|list\.(?:add|addAll|put|putAll|clear|insert|insertAll|remove|removeAll|removeElement|deleteItem|deleteAll|deleteKey|deleteKeys|update))\s*\(/;

function nonReadReplay(code: string): boolean {
  return NON_READ_REPLAY.test(code);
}

/** An app function, an untranslated call, or a non-read must not be replayed into a row map. */
function bindingReplayRefused(binding: Binding): boolean {
  return binding.appFunction || binding.todo || !!binding.sideEffect || nonReadReplay(binding.code);
}

/**
 * A name read before it had any value resolves to whatever the program bound
 * LATER when the read is replayed in the prefetch — a different value than
 * the program saw (and possibly a non-read the prefetch must not run). A
 * binding that carries such a read refuses instead of pulling the later
 * binding forward. A name still unbound at the end keeps the old behaviour:
 * it is a contextual operand or a free name the walk already handles.
 */
function useBeforeDef(binding: Binding, scope: Scope): boolean {
  return (binding.unboundReads ?? []).some((name) => scope.bindings.has(name));
}

/** The same use-before-definition check on an unassigned expression. */
function valueUseBeforeDef(value: Fx, scope: Scope): boolean {
  return value.unboundReads.some((name) => scope.bindings.has(name));
}

/**
 * Walk `names` through bindings. `rows` are the loop elements and are not
 * bindings. When `nonRead` is false (a loop collection's own dependencies),
 * only an app function or a todo is refused, so an `invokeurl` collection
 * snapshot stays.
 */
function closureReplayRefused(names: readonly string[], scope: Scope, rows: Set<string>, nonRead: boolean): boolean {
  const seen = new Set<string>();
  const walk = (name: string): boolean => {
    if (rows.has(name) || seen.has(name)) return false;
    seen.add(name);
    const binding = scope.bindings.get(name);
    if (!binding) return false;
    if (binding.appFunction || binding.todo || (nonRead && nonReadReplay(binding.code)) || useBeforeDef(binding, scope)) return true;
    return binding.reads.some((dep) => walk(dep));
  };
  return names.some((name) => walk(name));
}

/**
 * A `for each` collection is refused when the same rule as the row-map
 * condition path fails anywhere on its transitive read chain: an app
 * function, an untranslated call, or a non-read (`invokeurl`, `sendmail`,
 * `getUrl`, `insert`, a `zoho` task, `thisapp`, a list mutator). The loop
 * collection itself is screened too — `for each r in invokeurl[...]` names no
 * binding. A read name with no binding is unknown (a free name, or a local
 * assigned only later), and unknown refuses: a later `b = sendmail[...]`
 * would otherwise be invisible to the walk.
 */
function collectionReplayRefused(col: Fx, scope: Scope): boolean {
  if (col.appFunction || col.todo || nonReadReplay(col.code)) return true;
  const seen = new Set<string>();
  const walk = (name: string): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    const binding = scope.bindings.get(name);
    if (!binding) {
      return !(scope.clientData.has(name) || scope.row.has(name) || scope.prefetchBound.has(name));
    }
    if (binding.appFunction || binding.todo || nonReadReplay(binding.code) || useBeforeDef(binding, scope)) return true;
    return binding.reads.some((dep) => walk(dep));
  };
  return col.reads.some((name) => walk(name));
}

/** Bindings emitted inside the map loop plus every batched read they and the value carry. */
function loopBindings(value: Fx, scope: Scope, rows: Set<string>): { lines: string[]; reads: RowRead[]; refused: boolean } {
  const lines: string[] = [];
  const reads: RowRead[] = [];
  const seenCalls = new Set<string>();
  const emitted = new Set<string>();
  let refused = false;
  const pushReads = (rs: readonly RowRead[] | undefined): void => {
    for (const r of rs ?? []) {
      if (seenCalls.has(r.call)) continue;
      seenCalls.add(r.call);
      reads.push(r);
    }
  };
  const walk = (name: string): void => {
    if (rows.has(name)) return;
    const binding = scope.bindings.get(name);
    if (!binding || !dependsOnRow(name, scope, rows, new Set())) return;
    if (
      binding.appFunction ||
      binding.todo ||
      binding.sideEffect ||
      binding.unboundReads.length ||
      bindingReplayRefused(binding) ||
      useBeforeDef(binding, scope)
    ) {
      refused = true;
      return;
    }
    if (emitted.has(name)) return;
    emitted.add(name);
    for (const dep of binding.reads) walk(dep);
    pushReads(binding.rowReads);
    lines.push(`var ${jsIdent(binding.emitAs ?? name)} = ${binding.code};`);
  };
  pushReads(value.rowReads);
  for (const name of value.reads) walk(name);
  return { lines, reads, refused };
}

/**
 * Client read of a row map. A missing key is null: `Form[criteria].Field` is
 * null when no record matches (`shim.datastore.field`), and `for each` over
 * null runs zero times (`shim.each`).
 */
/** The map key a loop element contributes: row ID for records, its own value for scalars. */
function mapKeyExpr(frame: LoopFrame): string {
  const rowVar = jsIdent(frame.name);
  return frame.scalar ? `String(${rowVar})` : `shim.record.get(${rowVar}, "ID")`;
}

function mapRead(slot: string, frames: readonly LoopFrame[]): string {
  const ordered = [...frames].sort((a, b) => a.depth - b.depth);
  let expr = `slots[${JSON.stringify(slot)}]`;
  ordered.forEach((frame, i) => {
    const key = mapKeyExpr(frame);
    const missing = i === ordered.length - 1 ? 'null' : '{}';
    expr = `(${expr}[${key}] ?? ${missing})`;
  });
  return expr;
}

function queueRowMap(value: Fx, rows: readonly string[], scope: Scope): string | null {
  // A name read has to carry the binding's app-function and todo flags, and
  // this emitter refuses them: a loop row plus a local bound to thisapp.call
  // must not replay the call inside the map.
  const refused = (name: string, stack: Set<string>): boolean => {
    if (stack.has(name) || rows.includes(name)) return false;
    const binding = scope.bindings.get(name);
    if (!binding) return false;
    if (binding.appFunction || binding.todo || binding.sideEffect || binding.unboundReads.length) return true;
    stack.add(name);
    const yes = binding.reads.some((dep) => {
      const recorded = binding.deps.get(dep);
      if (recorded && (recorded.appFunction || recorded.todo || recorded.sideEffect || recorded.unboundReads.length)) return true;
      return refused(dep, stack);
    });
    stack.delete(name);
    return yes;
  };
  if (value.appFunction || value.todo || value.sideEffect || value.unboundReads.length || value.reads.some((name) => refused(name, new Set()))) return null;
  const rowSet = new Set(rows);
  const frames: LoopFrame[] = [];
  for (const frame of scope.rowFrames) {
    if (!rowSet.has(frame.name)) continue;
    const at = frames.findIndex((f) => f.name === frame.name);
    if (at >= 0) frames.splice(at, 1);
    frames.push(frame);
  }
  if (frames.length !== rowSet.size) return null;
  // A refused collection, a non-read, or a name bound only later never
  // reaches the prefetch. A frame the client cannot iterate leaves the
  // row name unbound, so the map stays a counted todo.
  if (frames.some((frame) => frame.refused)) return null;
  if (nonReadReplay(value.code) || valueUseBeforeDef(value, scope)) return null;
  if (closureReplayRefused(value.reads, scope, rowSet, true)) return null;
  const guardRows = new Set([...rowSet, ...scope.clientData, ...scope.row].sort());
  if (closureReplayRefused(frames.flatMap((frame) => frame.deps ?? []), scope, guardRows, false)) return null;
  for (const frame of frames) if (!clientIterates(frame, scope, new Set())) return null;
  if (!emitPlainBindings(value.reads, scope, rowSet, new Set())) return null;
  if (!emitPlainBindings(frames.flatMap((frame) => frame.deps ?? []), scope, guardRows, new Set())) return null;
  const slot = `c${scope.slot++}`;
  const loop = loopBindings(value, scope, rowSet);
  if (loop.refused) return null;
  if (frames.some((frame) => frame.scalar)) {
    // Scalar elements key a map by their own value — only the batched
    // `Field == element` read is safe. Anything else (a member-keyed read, or
    // a value the per-row path would replay) risks object elements collapsing
    // onto one `String()` key, so it stays a todo.
    const ok =
      frames.length === 1 &&
      loop.reads.length > 0 &&
      loop.reads.every((r) => r.rowName === frames[0]!.name && r.rowScalar === true);
    if (!ok) return null;
  }
  const bindings = loop.lines;
  const simple =
    frames.length === 1 && bindings.length === 0 && value.simpleLookup && value.simpleLookup.rowName === frames[0]!.name
      ? value.simpleLookup
      : undefined;
  scope.pendingMaps.push({ slot, frames, bindings, value: value.code, simpleLookup: simple, rowReads: loop.reads });
  return mapRead(slot, frames);
}

function slotIds(code: string): string[] {
  const ids: string[] = [];
  const re = /slots\["(c\d+)"\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code))) ids.push(match[1]!);
  return ids;
}

function identIn(code: string, ident: string): boolean {
  return new RegExp(`\\b${ident.replace(/[$*+?.()|[\]{}\\]/g, '\\$&')}\\b`).test(code);
}

/**
 * True when the client emits a real loop over this frame, binding its row
 * variable: the collection resolves to a slot, a row map, or data the client
 * already has. A collection that degrades to a todo leaves the row name
 * unbound on the client, so a row map over it cannot be emitted there.
 *
 * The collection expression was resolved before this frame's name was bound,
 * and the client loop is resolved after that name is removed. Judge
 * `frame.iter` the same way: with this frame's own name absent, unless an
 * outer frame already bound that name (the collection read that outer row).
 * Dependency rows match one open frame per name — the innermost frame that
 * was already open — the same way a row map keeps a single frame per name.
 */
function clientIterates(frame: LoopFrame, scope: Scope, stack: Set<LoopFrame>): boolean {
  if (stack.has(frame)) return false;
  const value = frame.iter;
  if (value.appFunction || value.todo) return false;
  if (!value.serverOnly || value.clientReady) return true;
  const shadowed = scope.rowFrames.some((other) => other !== frame && other.name === frame.name && other.depth < frame.depth);
  const hideOwnName = !shadowed && scope.clientData.has(frame.name);
  if (hideOwnName) scope.clientData.delete(frame.name);
  // The collection was evaluated before the body, so a read of this frame's
  // name is the pre-loop binding, not the loop variable. Dominance would
  // otherwise refuse it: the body assigns that name.
  const hiddenAssigned: { assigned: Set<string> }[] = [];
  if (hideOwnName) {
    for (const loop of scope.loops) {
      if (!loop.assigned.has(frame.name)) continue;
      loop.assigned.delete(frame.name);
      hiddenAssigned.push(loop);
    }
  }
  try {
    const closure = rowClosure(value, scope);
    if (closure.rows.length) {
      if (value.todo || !closure.ok) return false;
      const rowSet = new Set(closure.rows);
      // One frame per row name. A later loop that reuses the name is not the
      // row this collection read; keep the innermost frame already open.
      const matched = new Map<string, LoopFrame>();
      for (const other of scope.rowFrames) {
        if (other.depth >= frame.depth) continue;
        if (!rowSet.has(other.name)) continue;
        matched.set(other.name, other);
      }
      if (matched.size !== rowSet.size) return false;
      stack.add(frame);
      const ok = [...matched.values()].sort((a, b) => a.depth - b.depth).every((other) => clientIterates(other, scope, stack));
      stack.delete(frame);
      return ok;
    }
    return value.reads.every((name) => prefetchable(name, scope, new Set()));
  } finally {
    if (hideOwnName) scope.clientData.add(frame.name);
    for (const loop of hiddenAssigned) loop.assigned.add(frame.name);
  }
}

/**
 * The server collection expression, when every name it reads resolves in the
 * prefetch module: a replayable binding, a name it binds, or a row an
 * enclosing emitted loop binds. Otherwise `null`: emitting it would leave a
 * free identifier.
 */
function sourceIfBound(frame: LoopFrame, scope: Scope): string | null {
  for (const name of frame.iter.reads) {
    if (!scope.clientData.has(name) && !prefetchable(name, scope, new Set())) return null;
  }
  return frame.source || null;
}

function iterationSource(frame: LoopFrame, pending: Set<string>, force: boolean, scope: Scope): string | null {
  if (frame.refused) return null;
  if (!frame.closed && !force) return null;
  const preferred = frame.clientSource;
  if (preferred && !slotIds(preferred).some((id) => pending.has(id))) return preferred;
  const bound = sourceIfBound(frame, scope);
  if (!force) return preferred ? null : bound;
  return bound ?? preferred;
}

/** Loops to open so every row the map reads, and every row those collections read, is bound. */
function planRowMap(map: RowMap, scope: Scope, force: boolean): { frames: LoopFrame[]; sources: string[] } | null {
  const pending = new Set(scope.pendingMaps.map((item) => item.slot));
  const chosen = new Map<LoopFrame, string>();
  const frames: LoopFrame[] = [...map.frames];
  const have = new Set(map.frames);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const src = iterationSource(frame, pending, force, scope);
    if (src === null) return null;
    chosen.set(frame, src);
    for (const other of scope.knownLoops) {
      if (have.has(other) || other.depth >= frame.depth) continue;
      if (!identIn(src, jsIdent(other.name))) continue;
      have.add(other);
      frames.push(other);
    }
    // A collection bound to a row-dependent local (`for each x in
    // trackedLogsForDay`) reads that row through the binding, not the source
    // text: pull the rows its dependencies walk into the plan.
    for (const dep of frame.deps ?? []) {
      for (const other of scope.knownLoops) {
        if (have.has(other) || other.depth >= frame.depth) continue;
        if (!dependsOnRow(dep, scope, new Set([other.name]), new Set())) continue;
        have.add(other);
        frames.push(other);
      }
    }
  }
  frames.sort((a, b) => a.depth - b.depth);
  return { frames, sources: frames.map((frame) => chosen.get(frame)!) };
}

function emitPlanned(map: RowMap, planned: { frames: LoopFrame[]; sources: string[] }, scope: Scope): void {
  // A false return from the batched writer falls through to the per-row loop,
  // which would replay the same calls. Refuse both writers.
  if (nonReadReplay(`${map.bindings.join('\n')}\n${map.value}`)) return;
  if (map.simpleLookup && planned.frames.length === 1 && map.bindings.length === 0) {
    emitBatchedLookup(map, planned, scope);
    return;
  }
  if (
    planned.frames.length === 1 &&
    map.rowReads.length > 0 &&
    map.rowReads.every(
      (r) =>
        r.rowName === planned.frames[0]!.name &&
        // A scalar-keyed read only matches a scalar element loop (and vice versa).
        (r.rowScalar ?? false) === !!planned.frames[0]!.scalar &&
        // A post-filter may only read the loop row itself or a local the map
        // loop binds; anything else falls back to the per-row path.
        (r.rowDeps ?? []).every((dep) => dep === planned.frames[0]!.name || scope.bindings.has(dep) || scope.prefetchBound.has(dep)),
    )
  ) {
    if (emitBatchedReads(map, planned, scope)) return;
  }
  const keys = [...map.frames].sort((a, b) => a.depth - b.depth);
  // A binding emitted inside the map loop binds at the level of the deepest
  // frame row it reads, so a later frame's collection source sees it bound.
  const levelOf = (line: string): number => {
    const name = /^var ([\w$]+) = /.exec(line)?.[1];
    if (name) {
      for (let i = planned.frames.length - 1; i >= 0; i--) {
        if (dependsOnRow(name, scope, new Set([planned.frames[i]!.name]), new Set())) return i;
      }
    }
    return 0;
  };
  const byLevel = new Map<number, string[]>();
  for (const line of map.bindings) {
    const level = levelOf(line);
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level)!.push(line);
  }
  const lines: string[] = [`slots[${JSON.stringify(map.slot)}] = {};`];
  planned.frames.forEach((frame, i) => {
    const pad = '  '.repeat(i);
    // An inlined server collection reads locals the prefetch module must bind
    // before the loop that uses them.
    if (planned.sources[i] === frame.source) for (const name of frame.iter.reads) replayNow(name, scope);
    lines.push(`${pad}for (var ${jsIdent(frame.name)} of shim.each(ctx, ${planned.sources[i]})) {`);
    for (const line of byLevel.get(i) ?? []) lines.push(`${'  '.repeat(i + 1)}${line}`);
  });
  const inner = '  '.repeat(planned.frames.length);
  let target = `slots[${JSON.stringify(map.slot)}]`;
  keys.forEach((frame, i) => {
    const key = mapKeyExpr(frame);
    if (i < keys.length - 1) {
      lines.push(`${inner}if (${target}[${key}] == null) ${target}[${key}] = {};`);
      target = `${target}[${key}]`;
    } else {
      lines.push(`${inner}${target}[${key}] = ${map.value};`);
    }
  });
  for (let i = planned.frames.length - 1; i >= 0; i--) lines.push(`${'  '.repeat(i)}}`);
  scope.prefetch.push(lines.join('\n'));
}

function emitBatchedLookup(map: RowMap, planned: { frames: LoopFrame[]; sources: string[] }, scope: Scope): void {
  const simple = map.simpleLookup!;
  const frame = planned.frames[0]!;
  const rowVar = jsIdent(frame.name);
  const source = planned.sources[0]!;
  if (source === frame.source) for (const name of frame.iter.reads) replayNow(name, scope);
  const slotKey = JSON.stringify(map.slot);
  const lines: string[] = [
    `slots[${slotKey}] = {};`,
    `var rows_${map.slot} = shim.each(ctx, ${source});`,
    `var keys_${map.slot} = [];`,
    `for (var ${rowVar} of rows_${map.slot}) {`,
    `  keys_${map.slot}.push(shim.record.get(${rowVar}, ${JSON.stringify(simple.rowKeyField)}));`,
    `}`,
    `var res_${map.slot} = await shim.datastore.lookupMap(ctx, ${JSON.stringify(simple.form)}, ${JSON.stringify(simple.keyField)}, ${JSON.stringify(simple.targetField)}, keys_${map.slot});`,
    `for (var ${rowVar} of rows_${map.slot}) {`,
    `  var rowId_${map.slot} = shim.record.get(${rowVar}, "ID");`,
    `  var k_${map.slot} = shim.record.get(${rowVar}, ${JSON.stringify(simple.rowKeyField)});`,
    `  var norm_${map.slot} = k_${map.slot} != null && typeof k_${map.slot} === "object" && "id" in k_${map.slot} ? k_${map.slot}.id : k_${map.slot};`,
    `  slots[${slotKey}][rowId_${map.slot}] = norm_${map.slot} != null && res_${map.slot}.has(String(norm_${map.slot})) ? res_${map.slot}.get(String(norm_${map.slot})) : null;`,
    `}`,
  ];
  scope.prefetch.push(lines.join('\n'));
}

/**
 * One batched `IN` query per row-keyed read in the map's value or loop
 * bindings. Inside the loop the per-row call is replaced by that read's map
 * entry; a missing key reads as the empty result (`null`, `[]`, or 0), the
 * same result the per-row call returned when no record matched.
 *
 * A read that carries `rowRest` (a second keyed leaf or another row-dependent
 * conjunct) is fetched as candidate rows by `rowsMap` and post-filtered per
 * row through `shim.datastore.matches` — still one query. A binding that IS a
 * keyed fetch (`var existingLog = shim.datastore.query(...)`) rebinds to the
 * row's filtered rows; later `datastore.rows/aggregate/field/column` calls on
 * that local are rewritten to the equivalent in-memory ops on the bound rows.
 */
function emitBatchedReads(map: RowMap, planned: { frames: LoopFrame[]; sources: string[] }, scope: Scope): boolean {
  const frame = planned.frames[0]!;
  const rowVar = jsIdent(frame.name);
  const source = planned.sources[0]!;
  const slotKey = JSON.stringify(map.slot);

  // Which reads actually fire: a `Form[crit]` literal read embedded inside a
  // longer call (e.g. an aggregate wrapper) never matches once the longer call
  // is replaced first.
  const calls = [...new Set(map.rowReads.map((r) => r.call))].sort((a, b) => b.length - a.length);
  const probe = `${map.bindings.join('\n')}\n${map.value}`;
  if (nonReadReplay(probe)) return false;
  const fired = new Set<string>();
  let probeRest = probe;
  for (const call of calls) {
    if (probeRest.includes(call)) {
      fired.add(call);
      probeRest = probeRest.split(call).join('');
    }
  }
  const used = map.rowReads.filter((r) => fired.has(r.call));
  if (!used.length) return false;

  // The key expression each read indexes by: a field of the row, or the row
  // itself for scalar elements.
  const keyExpr = (r: RowRead): string =>
    r.rowScalar ? rowVar : `shim.record.get(${rowVar}, ${JSON.stringify(r.rowKeyField)})`;
  const keyExprs: string[] = [];
  for (const r of used) {
    const k = keyExpr(r);
    if (!keyExprs.includes(k)) keyExprs.push(k);
  }
  const keysVar = (r: RowRead) => `keys_${map.slot}_${keyExprs.indexOf(keyExpr(r))}`;
  const normVar = (r: RowRead) => `norm_${map.slot}_${keyExprs.indexOf(keyExpr(r))}`;

  const resVar = new Map<string, string>();
  const replacements: [string, string][] = [];
  const lines: string[] = [
    `slots[${slotKey}] = {};`,
    `var rows_${map.slot} = shim.each(ctx, ${source});`,
    ...keyExprs.map((_k, j) => `var keys_${map.slot}_${j} = [];`),
    `for (var ${rowVar} of rows_${map.slot}) {`,
    ...keyExprs.map((k, j) => `  keys_${map.slot}_${j}.push(${k});`),
    `}`,
  ];
  let resIndex = 0;
  for (const r of used) {
    if (!fired.has(r.call) || resVar.has(r.call)) continue;
    const res = `res_${map.slot}_${resIndex++}`;
    resVar.set(r.call, res);
    const keys = keysVar(r);
    const n = normVar(r);
    const extra = r.extra ? `, ${r.extra}` : '';
    const cands = `(${n} != null ? ${res}.get(String(${n})) ?? [] : [])`;
    if (r.rowRest) {
      // Candidates by the keyed leaf (+ static conjuncts), filtered per row.
      lines.push(`var ${res} = await shim.datastore.rowsMap(ctx, ${JSON.stringify(r.form)}, ${JSON.stringify(r.keyField)}, ${keys}${extra});`);
      const filter = `${cands}.filter((cand) => shim.datastore.matches(ctx, cand, ${r.rowRest}))`;
      if (r.kind === 'field') {
        replacements.push([
          r.call,
          `(() => { const hit = ${filter}.find(() => true); return hit ? shim.record.get(hit, ${JSON.stringify(r.targetField)}) : null; })()`,
        ]);
      } else if (r.kind === 'aggregate') {
        replacements.push([
          r.call,
          `shim.list.aggregate(${filter}, ${JSON.stringify(r.fn)}, ${r.field ?? 'undefined'})`,
        ]);
      } else {
        replacements.push([r.call, `(${filter})`]);
      }
      continue;
    }
    if (r.kind === 'field') {
      lines.push(
        `var ${res} = await shim.datastore.lookupMap(ctx, ${JSON.stringify(r.form)}, ${JSON.stringify(r.keyField)}, ${JSON.stringify(r.targetField)}, ${keys}${extra});`,
      );
    } else if (r.kind === 'rows') {
      lines.push(`var ${res} = await shim.datastore.rowsMap(ctx, ${JSON.stringify(r.form)}, ${JSON.stringify(r.keyField)}, ${keys}${extra});`);
    } else {
      lines.push(
        `var ${res} = await shim.datastore.aggregateMap(ctx, ${JSON.stringify(r.form)}, ${JSON.stringify(r.keyField)}, ${keys}, ${JSON.stringify(r.fn)}, ${r.field ?? 'undefined'}${extra});`,
      );
    }
    replacements.push([r.call, `(${n} != null && ${res}.has(String(${n})) ? ${res}.get(String(${n})) : ${r.noMatch})`]);
  }
  replacements.sort((a, b) => b[0].length - a[0].length);

  // Locals rebound to the row's fetched rows: `var N = <keyed fetch>` becomes
  // `var N = <rows array>`, and datastore calls on N become in-memory ops.
  const arrayNames = new Set<string>();
  for (const line of map.bindings) {
    const m = /^var ([\w$]+) = (.*);$/.exec(line);
    if (m && used.some((r) => r.kind === 'rows' && r.call === m[2])) arrayNames.add(m[1]!);
  }
  const rewrite = (code: string): string => {
    for (const [call, expr] of replacements) code = code.split(call).join(expr);
    for (const name of arrayNames) {
      const esc = name.replace(/[$*+?.()|[\]{}\\]/g, '\\$&');
      const str = `("(?:[^"\\\\]|\\\\.)*")`;
      code = code.replace(new RegExp(`await shim\\.datastore\\.rows\\(ctx, ${esc}\\)`, 'g'), `(${name})`);
      code = code.replace(
        new RegExp(`await shim\\.datastore\\.aggregate\\(ctx, ${esc}, ${str}, (${str}|undefined)\\)`, 'g'),
        `shim.list.aggregate(${name}, $1, $2)`,
      );
      code = code.replace(new RegExp(`await shim\\.datastore\\.field\\(ctx, ${esc}, ${str}\\)`, 'g'), `shim.record.get(${name}, $1)`);
      code = code.replace(new RegExp(`await shim\\.datastore\\.column\\(ctx, ${esc}, ${str}\\)`, 'g'), `shim.list.column(${name}, $1)`);
    }
    return code;
  };
  lines.push(`for (var ${rowVar} of rows_${map.slot}) {`);
  for (const k of keyExprs) {
    const j = keyExprs.indexOf(k);
    lines.push(`  var k_${map.slot}_${j} = ${k};`);
    lines.push(
      `  var norm_${map.slot}_${j} = k_${map.slot}_${j} != null && typeof k_${map.slot}_${j} === "object" && "id" in k_${map.slot}_${j} ? k_${map.slot}_${j}.id : k_${map.slot}_${j};`,
    );
  }
  for (const line of map.bindings) lines.push(`  ${rewrite(line)}`);
  lines.push(`  slots[${slotKey}][${mapKeyExpr(frame)}] = ${rewrite(map.value)};`);
  lines.push(`}`);
  scope.prefetch.push(lines.join('\n'));
  return true;
}

function emitReadyMaps(scope: Scope, useForce: boolean): boolean {
  let emitted = false;
  for (let i = 0; i < scope.pendingMaps.length; ) {
    const map = scope.pendingMaps[i]!;
    const planned = planRowMap(map, scope, useForce);
    if (!planned) {
      i++;
      continue;
    }
    scope.pendingMaps.splice(i, 1);
    emitPlanned(map, planned, scope);
    emitted = true;
  }
  return emitted;
}

function flushMaps(scope: Scope, force: boolean): void {
  let guard = 0;
  while (scope.pendingMaps.length && emitReadyMaps(scope, false) && guard++ < 20) {
    // A map emitted above can unblock one that was queued earlier.
  }
  if (!force) return;
  guard = 0;
  while (scope.pendingMaps.length && emitReadyMaps(scope, true) && guard++ < 20) {
    // The collection slot is still pending: walk the server collection expression.
  }
  for (const map of scope.pendingMaps) scope.prefetch.push(`slots[${JSON.stringify(map.slot)}] = {};`);
  scope.pendingMaps.length = 0;
}

/**
 * The slot's expression runs in the prefetch module, so every local it reads
 * must be resolvable there: a replayable assignment binding, or a name the
 * module binds (`prefetchBound`: function params, the subform `row`). A loop
 * variable or a name with no binding has no prefetch value — `null`, and the
 * caller degrades the slot to a todo.
 */
function slotExpr(value: Fx, scope: Scope): string | null {
  // An expression that writes, calls out, or reads a name bound only
  // later stays a todo: the prefetch would run the effect or the later value.
  if (value.sideEffect || value.appFunction || value.todo || value.unboundReads.length || nonReadReplay(value.code) || valueUseBeforeDef(value, scope)) return null;
  for (const name of value.reads) if (!prefetchable(name, scope, new Set())) return null;
  const mark = scope.prefetch.length;
  const emittedMark = new Map(scope.emitted);
  const ordered: { name: string; binding: Binding }[] = [];
  const seen = new Set<Binding>();
  for (const name of value.reads) {
    if (!emitBinding(name, scope, new Set(), ordered, seen)) {
      scope.prefetch.length = mark;
      scope.emitted = emittedMark;
      return null;
    }
  }
  // Emit the whole closure in assignment order, not depth-first per read:
  // every binding's reads resolve to the version its assignment recorded, so
  // a `var` line runs only after each name it reads holds that version, and a
  // later version of one name (`n = 1; a = n; n = n + 9` needs both `n`s for
  // one slot) emits after its dependents instead of being overwritten by a
  // re-emitted earlier one.
  ordered.sort((a, b) => a.binding.seq - b.binding.seq);
  for (const item of ordered) {
    // A param placeholder records the previous value and emits nothing.
    // A previous-value rewrite emits under the real name, never the dep key.
    if (item.binding.bound) continue;
    if (scope.emitted.get(item.name) === item.binding) continue;
    scope.emitted.set(item.name, item.binding);
    scope.prefetch.push(`var ${jsIdent(item.binding.emitAs ?? item.name)} = ${item.binding.code};`);
  }
  const id = `c${scope.slot++}`;
  scope.prefetch.push(`slots[${JSON.stringify(id)}] = ${value.code};`);
  return `slots[${JSON.stringify(id)}]`;
}

function prefetchable(name: string, scope: Scope, stack: Set<string>): boolean {
  if (stack.has(name) || scope.clientData.has(name)) return false;
  const binding = scope.bindings.get(name);
  if (!binding) return scope.prefetchBound.has(name);
  if (binding.appFunction || binding.todo || binding.unboundReads.length) return false;
  return bindingOk(name, binding, scope, stack);
}

/**
 * Runs `f` under a fresh control-flow frame: an if/else arm, a loop body, a
 * try/catch arm, or a function body. Assignments inside are marked with the
 * frame so a binding that may not have run — or may have run many times — is
 * never replayed at a point of use it does not dominate.
 */
function underFlow<T>(scope: Scope, f: () => T): T {
  scope.flowStack.push(scope.clock.flow++);
  try {
    return f();
  } finally {
    scope.flowStack.pop();
  }
}

/** A binding replays only while the frame it was assigned in is still open. */
function flowOk(binding: Binding, scope: Scope): boolean {
  return scope.flowStack.includes(binding.flow);
}

/**
 * A binding is the value in force at this point when it is read-only, its
 * frame is still open, and no enclosing loop writes the same name after the
 * binding was created. That write makes the read loop-carried: one prefetch
 * assignment would repeat a single iteration.
 */
function dominates(name: string, binding: Binding, scope: Scope): boolean {
  if (binding.sideEffect || binding.appFunction || binding.todo || binding.unboundReads.length || nonReadReplay(binding.code) || !flowOk(binding, scope)) return false;
  for (const loop of scope.loops) {
    if (loop.assigned.has(name) && binding.flow < loop.frame) return false;
  }
  return true;
}

/** Bindings and open frames at a test or collection, before its arms or body. */
function snapBindings(scope: Scope): { bindings: Map<string, Binding>; flowStack: number[] } {
  return { bindings: new Map(scope.bindings), flowStack: scope.flowStack.slice() };
}

function withBindings<T>(
  scope: Scope,
  snap: { bindings: Map<string, Binding>; flowStack: number[] },
  f: () => T,
): T {
  const bindings = scope.bindings;
  const flowStack = scope.flowStack;
  scope.bindings = snap.bindings;
  scope.flowStack = snap.flowStack;
  try {
    return f();
  } finally {
    scope.bindings = bindings;
    scope.flowStack = flowStack;
  }
}

/** Sets an assignment updates. Sibling arms must not see each other's updates. */
const ARM_CLASSES = ['local', 'query', 'list', 'map', 'date', 'decimal', 'row', 'serverOnly', 'clientData'] as const;
type ArmClass = (typeof ARM_CLASSES)[number];
type ArmClasses = Record<ArmClass, Set<string>>;

function copyClasses(scope: Scope): ArmClasses {
  return {
    local: new Set(scope.local),
    query: new Set(scope.query),
    list: new Set(scope.list),
    map: new Set(scope.map),
    date: new Set(scope.date),
    decimal: new Set(scope.decimal),
    row: new Set(scope.row),
    serverOnly: new Set(scope.serverOnly),
    clientData: new Set(scope.clientData),
  };
}

function restoreClasses(scope: Scope, saved: ArmClasses): void {
  for (const key of ARM_CLASSES) {
    const set = scope[key];
    set.clear();
    for (const name of saved[key]) set.add(name);
  }
}

/** The sets `classes` gives `name`, as one slot per class. */
function classSignature(classes: ArmClasses, name: string): boolean[] {
  return ARM_CLASSES.map((key) => classes[key].has(name));
}

/**
 * Names a statement assigns. Nested loop variables count: they are written on
 * every iteration of the enclosing body. A nested function's assignments run
 * only when it is called, so they are not loop-body writes.
 */
function assignedNames(stmt: Stmt): Set<string> {
  const into = new Set<string>();
  const visit = (s: Stmt): void => {
    switch (s.kind) {
      case 'block':
        for (const child of s.body) visit(child);
        break;
      case 'if':
        collectListMutations(s.test, into);
        visit(s.then);
        for (const arm of s.elifs) {
          collectListMutations(arm.test, into);
          visit(arm.body);
        }
        if (s.else) visit(s.else);
        break;
      case 'forEach':
        into.add(s.name);
        if (s.index) into.add(s.index);
        visit(s.body);
        break;
      case 'while':
        visit(s.body);
        break;
      case 'try':
        visit(s.body);
        if (s.catchBody) visit(s.catchBody);
        break;
      case 'assign':
        if (s.target.kind === 'name') into.add(s.target.name);
        collectListMutations(s.value, into);
        break;
      case 'unknown': {
        const lhs = /^([A-Za-z_$][\w$]*)\s*=(?![>=])/.exec(s.text.trimStart())?.[1];
        if (lhs) into.add(lhs);
        break;
      }
      case 'fn':
      case 'return':
      case 'break':
      case 'continue':
      case 'info':
      case 'alert':
      case 'cancelSubmit':
      case 'cancelDelete':
      case 'successMessage':
      case 'reload':
      case 'openUrl':
      case 'ui':
      case 'deleteFrom':
      case 'update':
        break;
      case 'expr':
        collectListMutations(s.expr, into);
        break;
      default: {
        const never: never = s;
        void never;
      }
    }
  };
  visit(stmt);
  return into;
}

/**
 * A server-only statement dropped from the client side leaves any local
 * collection it mutates holding the earlier (often empty) client value. The
 * name reads server-bound from here, so a later client call or condition does
 * not send the partial value. A client rebind clears the taint like any other
 * server-only binding.
 */
function taintServerMutated(e: Expr, scope: Scope): void {
  const mutated = new Set<string>();
  collectListMutations(e, mutated);
  for (const name of mutated) if (scope.local.has(name)) scope.serverOnly.add(name);
}

/** List methods that write the receiver. A later read is not the earlier value. */
const LIST_MUTATORS = new Set([
  'add',
  'addall',
  'put',
  'putall',
  'clear',
  'insert',
  'insertall',
  'remove',
  'removeall',
  'removeelement',
  'delete',
  'deleteitem',
  'deleteall',
  'deletekey',
  'deletekeys',
  'update',
]);

function collectListMutations(e: Expr, into: Set<string>): void {
  walk(e, (n) => {
    if (n.kind !== 'call') return;
    const callee = n.callee;
    if (typeof callee !== 'object' || callee === null) return;
    const member = callee as { kind?: unknown; property?: unknown; object?: Expr };
    if (member.kind !== 'member' || typeof member.property !== 'string' || !member.object) return;
    if (!LIST_MUTATORS.has(member.property.toLowerCase())) return;
    const root = rootName(member.object);
    if (root) into.add(root);
  });
}

/** A `getAll` column is one posted element. A bound scalar list stays on the row map. */
function collectionIsGetAll(e: Expr): boolean {
  const cur = unparen(e);
  return cur.kind === 'call' && cur.callee.kind === 'member' && cur.callee.property === GET_ALL;
}

/**
 * Runs `f` as a `for each` or `while` body. `assigned` is every name that
 * body writes, including the loop variable. A binding of one of those names
 * created before this frame does not dominate a slot resolved inside `f`.
 */
function underLoop<T>(scope: Scope, assigned: Set<string>, f: () => T): T {
  const frame = scope.clock.flow;
  scope.loops.push({ frame, assigned });
  try {
    return underFlow(scope, f);
  } finally {
    scope.loops.pop();
  }
}

/**
 * A binding replays in the prefetch only when its code is read-only and every
 * local it reads resolves there too, at the binding the assignment recorded
 * (`deps`), not the name's latest binding. A self-read (`n = n + 1`, a range
 * end computed from an arithmetic scalar) resolves against the binding the
 * assignment replaced, so `n = 0; n = n + 1` replays as two statements; a
 * self-read with no earlier binding resolves against the names the module
 * already binds (`prefetchBound`), else the local is unbound and the caller
 * stays a todo. A binding that writes or calls out (`sideEffect`), or that
 * does not dominate this point, is never replayed — the prefetch would run
 * the effect a second time, or repeat one iteration of a loop-carried name.
 */
function bindingOk(name: string, binding: Binding, scope: Scope, stack: Set<string>): boolean {
  if (!dominates(name, binding, scope)) return false;
  stack.add(name);
  const ok = binding.reads.every((dep) => {
    const depBinding = binding.deps.get(dep);
    if (dep === name) {
      // A self-read resolves to the binding this assignment replaced.
      return depBinding ? bindingOk(dep, depBinding, scope, stack) : scope.prefetchBound.has(name);
    }
    if (scope.clientData.has(dep) || stack.has(dep)) return false;
    return depBinding ? bindingOk(dep, depBinding, scope, stack) : scope.prefetchBound.has(dep);
  });
  stack.delete(name);
  return ok;
}

/**
 * Shim calls a per-element prefetch guard may replay: reads and pure helpers
 * only, as an allowlist. Datastore writes (`insert`/`update`/`delete`/
 * `setField`/`flush`), record/input writes, `mail.send`, `http.*`,
 * `thisapp.*`, `zoho.task`, `todo`, and anything unlisted are absent, so a
 * condition whose replay would invoke one stays a counted
 * `client-condition-uses-server` todo and no `shim.client.element` is emitted.
 */
const ELEMENT_SHIM_ALLOW: ReadonlyMap<string, ReadonlySet<string> | true> = new Map<string, ReadonlySet<string> | true>([
  ['compare', true],
  ['convert', true],
  ['date', true],
  ['decimal', true],
  ['list', true],
  ['math', true],
  ['name', true],
  ['number', true],
  ['string', true],
  ['datastore', new Set(['aggregate', 'column', 'field', 'query', 'rows'])],
  ['input', new Set(['get', 'root'])],
  ['old', new Set(['get'])],
  ['record', new Set(['get', 'system'])],
  ['subform', new Set(['currentRow'])],
  ['zoho', new Set(['adminUser', 'adminUserId', 'appName', 'appUri', 'currentDate', 'currentTime', 'ipAddress', 'loginUser', 'loginUserId'])],
]);
const ELEMENT_SHIM_ALLOW_SINGLE = new Set(['each', 'ifnull', 'isBlank', 'isEmpty', 'isFile', 'isNull', 'isNumber', 'isText', 'list', 'map', 'startsWith']);
const SHIM_CALL = /\bshim\.([A-Za-z]+)(?:\.([A-Za-z]+))?\s*\(/g;

/** Every `shim.*(` call site in emitted code is an allowlisted read or pure helper. */
function elementSafe(code: string): boolean {
  for (const m of code.matchAll(SHIM_CALL)) {
    const fn = m[2];
    if (fn === undefined) {
      if (!ELEMENT_SHIM_ALLOW_SINGLE.has(m[1]!)) return false;
      continue;
    }
    const allow = ELEMENT_SHIM_ALLOW.get(m[1]!);
    if (allow !== true && !allow?.has(fn)) return false;
  }
  return true;
}

const THISAPP_CALL_PATH = /(\bshim\.thisapp\.call\s*\(\s*ctx\s*,\s*)(\[[^\]]*\])/g;

/**
 * The static `thisapp` targets in emitted code. `null` means the emitted call
 * shape was not the translator's literal registry path, so the caller must not
 * reason about it as a declared-function call.
 */
export function emittedThisappCalls(code: string): string[][] | null {
  const calls: string[][] = [];
  for (const match of code.matchAll(THISAPP_CALL_PATH)) {
    try {
      const parsed = JSON.parse(match[2]!) as unknown;
      if (!Array.isArray(parsed) || !parsed.length || parsed.some((part) => typeof part !== 'string')) return null;
      calls.push(parsed as string[]);
    } catch {
      return null;
    }
  }
  return calls;
}

/**
 * The elementSafe() call-site scan, extended for `thisapp.call`: every other
 * shim call must be in the same read/pure allowlist, while a same-app call is
 * allowed only when `isReadOnly` accepts its static target. This is the scan
 * the generator's transitive read-only classifier uses on emitted function
 * bodies.
 */
export function emittedReadOnly(code: string, isReadOnly: (path: readonly string[]) => boolean): boolean {
  const calls = emittedThisappCalls(code);
  if (calls === null || calls.some((path) => !isReadOnly(path))) return false;
  for (const m of code.matchAll(SHIM_CALL)) {
    const fn = m[2];
    if (m[1] === 'thisapp' && fn === 'call') continue;
    if (fn === undefined) {
      if (!ELEMENT_SHIM_ALLOW_SINGLE.has(m[1]!)) return false;
      continue;
    }
    const allow = ELEMENT_SHIM_ALLOW.get(m[1]!);
    if (allow !== true && !allow?.has(fn)) return false;
  }
  return true;
}

const CLIENT_CALL_SHIM_ALLOW: ReadonlyMap<string, ReadonlySet<string> | true> = (() => {
  const allow = new Map(ELEMENT_SHIM_ALLOW);
  allow.delete('datastore');
  allow.set('client', new Set(['call']));
  return allow;
})();

/** The emitted expression after `thisapp` calls are rewritten to client calls, or null when unsafe. */
function clientCallCode(code: string, scope: Scope): string | null {
  const calls = emittedThisappCalls(code);
  if (!calls?.length) return null;
  if (calls.some((path) => !scope.clientCallFunctions.has(path.join('.').toLowerCase()))) return null;
  const rewritten = code.replace(THISAPP_CALL_PATH, (_match, prefix: string, pathJson: string) => {
    const path = JSON.parse(pathJson) as string[];
    return `${prefix}${JSON.stringify(path.join('.'))}`;
  }).replace(/\bshim\.thisapp\.call\s*\(/g, 'shim.client.call(');
  for (const m of rewritten.matchAll(SHIM_CALL)) {
    const fn = m[2];
    if (fn === undefined) {
      if (!ELEMENT_SHIM_ALLOW_SINGLE.has(m[1]!)) return null;
      continue;
    }
    const allow = CLIENT_CALL_SHIM_ALLOW.get(m[1]!);
    if (allow !== true && !allow?.has(fn)) return null;
  }
  return rewritten;
}

/**
 * Per-element slot: the client POSTs the loop element to the prefetch
 * endpoint, which binds `ctx.element` and evaluates the expression's server
 * part for that element. The emission is one guarded block — `var` for the
 * element plus any binding that reaches it — so the one-shot prefetch skips
 * it entirely. Bindings that do not reach the element are ordinary top-level
 * prefetch lines (`emitBinding`).
 *
 * The guard refuses a posted value that is not a scalar member of the
 * iterated collection (or is past the element cap), and a slot that
 * evaluates to a dry-run placeholder is reported as `{ ok: false }` — never
 * truthy to the client.
 *
 * `null` when a read resolves to no value in the prefetch module — a record
 * element, another loop's element, or an unbound local — or when the
 * expression or a replayed binding is not read-only. The caller degrades
 * the slot to a todo.
 */
function elementSlot(value: Fx, element: string, scope: Scope): string | null {
  if (value.sideEffect || value.appFunction || value.todo || value.unboundReads.length) return null;
  const collection = scope.elementCollections.get(element);
  if (collection === undefined) return null;
  const pending: string[] = [];
  const guardedNames = new Set<string>();
  const reaches = (name: string, stack: Set<string>): boolean => {
    if (name === element) return true;
    if (stack.has(name) || scope.clientData.has(name)) return false;
    const binding = scope.bindings.get(name);
    if (!binding) return false;
    stack.add(name);
    const out = binding.reads.some((d) => reaches(d, stack));
    stack.delete(name);
    return out;
  };
  const dep = (name: string, stack: Set<string>): boolean => {
    if (name === element) return true;
    if (scope.clientData.has(name) || stack.has(name)) return false;
    const binding = scope.bindings.get(name);
    if (!binding) return scope.emitted.has(name) || guardedNames.has(name) || scope.prefetchBound.has(name);
    // Screen the binding this assignment recorded, not a later rebind of the
    // same name: a copy of a non-read call stays a non-read after the name is
    // overwritten. A same-app call, an untranslated call, a write, or a read
    // from before any binding existed is never replayed. Ready means this
    // binding object, not an older one stored under the same name. The read
    // chain is still walked when the binding was already emitted.
    const recordedUnsafe = binding.reads.some((d) => {
      const recorded = binding.deps.get(d);
      return !!recorded && (recorded.appFunction || recorded.todo || !!recorded.sideEffect || recorded.unboundReads.length > 0 || !elementSafe(recorded.code));
    });
    if (
      recordedUnsafe ||
      binding.appFunction ||
      binding.todo ||
      binding.sideEffect ||
      binding.unboundReads.length ||
      !elementSafe(binding.code) ||
      !dominates(name, binding, scope)
    ) return false;
    const ready = scope.emitted.get(name) === binding || guardedNames.has(name);
    stack.add(name);
    const ok = binding.reads.every((d) => dep(d, stack));
    stack.delete(name);
    if (!ok) return false;
    if (ready) return true;
    if (binding.reads.some((d) => reaches(d, new Set()))) {
      pending.push(`var ${jsIdent(name)} = ${binding.code};`);
      guardedNames.add(name);
    } else if (!replayNow(name, scope)) {
      return false;
    }
    return true;
  };
  for (const name of value.reads) if (!dep(name, new Set())) return null;
  if (!elementSafe(value.code)) return null;
  const id = `c${scope.slot++}`;
  scope.elementSlots += 1;
  scope.prefetch.push(
    `if (ctx.element !== undefined && ctx.element.name === ${JSON.stringify(element)}) {\n` +
      `  var __elements = ${collection};\n` +
      `  var __index = Array.isArray(__elements) ? __elements.findIndex((v) => typeof v === typeof ctx.element.value && shim.compare.eq(v, ctx.element.value)) : -1;\n` +
      `  if (__index < 0 || __index >= LIMITS.clientElementRoundTrips) throw new Error("element value is not in the iterated collection or is past the element cap");\n` +
      `  var ${jsIdent(element)} = __elements[__index];\n` +
      (pending.length ? `${pending.map((line) => `  ${line}`).join('\n')}\n` : '') +
      `  slots[${JSON.stringify(id)}] = ${value.code};\n` +
      `  if (slots[${JSON.stringify(id)}] !== null && typeof slots[${JSON.stringify(id)}] === "object" && (slots[${JSON.stringify(id)}].dryRun === true || slots[${JSON.stringify(id)}].performed === false)) slots[${JSON.stringify(id)}] = { ok: false };\n` +
      `}`,
  );
  return `(await shim.client.element(ctx, ${JSON.stringify(element)}, ${jsIdent(element)}, ${JSON.stringify(id)}))`;
}

/** True when a binding or anything it depends on is a non-read or an untranslated call. */
function bindingTodo(name: string, scope: Scope, stack: Set<string>): boolean {
  if (stack.has(name)) return false;
  const binding = scope.bindings.get(name);
  if (!binding) return false;
  if (binding.todo || binding.appFunction || binding.sideEffect || binding.unboundReads.length) return true;
  stack.add(name);
  const bad = binding.code.includes('op: "todo"') || binding.reads.some((dep) => {
    const recorded = binding.deps.get(dep);
    if (recorded && (recorded.todo || recorded.appFunction || recorded.sideEffect || recorded.unboundReads.length)) return true;
    return bindingTodo(dep, scope, stack);
  });
  stack.delete(name);
  return bad;
}

function emitBinding(
  name: string,
  scope: Scope,
  stack: Set<string>,
  out: { name: string; binding: Binding }[],
  seen: Set<Binding>,
): boolean {
  if (scope.clientData.has(name) || stack.has(name)) return false;
  const binding = scope.bindings.get(name);
  if (!binding) return scope.prefetchBound.has(name);
  return collectChain(name, binding, scope, stack, out, seen);
}

/**
 * Collects `binding` for `name` and the binding each read was recorded
 * against (`deps`) into `out`, so a copied local replays the value the
 * assignment saw (`n = 1; limit = n; n = n + 9` collects `n = 1` and
 * `limit = n` when `limit` is read, not `n`'s latest binding). A self-read
 * collects the replaced binding, so a self-assigning scalar replays as its
 * prior binding followed by the self-assign (`var n = 0; var n = n + 1;`).
 * The caller emits the collected set once, sorted by `seq`.
 */
function collectChain(
  name: string,
  binding: Binding,
  scope: Scope,
  stack: Set<string>,
  out: { name: string; binding: Binding }[],
  seen: Set<Binding>,
): boolean {
  if (!dominates(name, binding, scope)) return false;
  if (seen.has(binding)) return true;
  seen.add(binding);
  stack.add(name);
  for (const dep of binding.reads) {
    const depBinding = binding.deps.get(dep);
    const fail = dep !== name && stack.has(dep);
    if (fail || (depBinding ? !collectChain(dep, depBinding, scope, stack, out, seen) : !scope.prefetchBound.has(dep))) {
      stack.delete(name);
      return false;
    }
  }
  stack.delete(name);
  out.push({ name, binding });
  return true;
}


/** Emit `name`'s recorded binding chain into the prefetch module, in assignment order. */
function replayNow(name: string, scope: Scope): boolean {
  const ordered: { name: string; binding: Binding }[] = [];
  const seen = new Set<Binding>();
  if (!emitBinding(name, scope, new Set(), ordered, seen)) return false;
  ordered.sort((a, b) => a.binding.seq - b.binding.seq);
  for (const item of ordered) {
    // A param placeholder records the previous value and emits nothing.
    // A previous-value rewrite emits under the real name, never the dep key.
    if (item.binding.bound) continue;
    if (scope.emitted.get(item.name) === item.binding) continue;
    scope.emitted.set(item.name, item.binding);
    scope.prefetch.push(`var ${jsIdent(item.binding.emitAs ?? item.name)} = ${item.binding.code};`);
  }
  return true;
}

export function jsIdent(name: string): string {
  let n = name;
  if (RESERVED.has(n)) n = `d_${n}`;
  if (!/^[$A-Za-z_][$\w]*$/.test(n)) n = `d_${n.replace(/[^$A-Za-z0-9_]/g, '_') || 'name'}`;
  return n;
}

function indent(body: string, pad = '  '): string {
  if (!body.trim()) return '';
  return body
    .split('\n')
    .map((line) => (line.trim() ? pad + line : line))
    .join('\n');
}

function bucketOf(flags: { todo: boolean; shim: boolean }): 'translated' | 'shimmed' | 'todo' {
  if (flags.todo) return 'todo';
  if (flags.shim) return 'shimmed';
  return 'translated';
}

export function translate(src: string, options: TranslateOptions = {}): TranslateResult {
  const script = parse(src);
  const scope: Scope = {
    local: new Set(),
    query: new Set(),
    list: new Set(),
    map: new Set(),
    date: new Set(),
    decimal: new Set(options.decimalVars ?? []),
    decimalFields: new Set(options.decimalFields ?? []),
    row: new Set(options.rowNames ?? []),
    serverOnly: new Set(),
    clientData: new Set(),
    declaredServer: new Set(),
    declaredClient: new Set(),
    inputFields: new Set(options.inputFields ?? []),
    lookupFields: new Set(options.lookupFields ?? []),
    rowFields: options.rowFields?.length && options.rowNames?.length
      ? { row: options.rowNames[0]!, names: new Set(options.rowFields) }
      : null,
    rowAlias: options.rowAlias && options.rowNames?.includes(options.rowAlias.row) ? options.rowAlias : null,
    approval: options.approval ?? false,
    bindings: new Map(),
    elementVars: new Set(),
    elementCollections: new Map(),
    elementSlots: 0,
    clock: { seq: 0, flow: 1 },
    flowStack: [0],
    loops: [],
    emitted: new Map(),
    prefetchBound: new Set(options.prefetchBound ?? []),
    formNames: new Set(options.formNames ?? []),
    functions: new Set((options.functions ?? []).map((n) => n.toLowerCase())),
    clientCallFunctions: new Set((options.clientCallFunctions ?? []).map((n) => n.toLowerCase())),
    formFields: new Map(Object.entries(options.formFields ?? {}).sort().map(([k, v]) => [k, new Set(v)])),
    prefetch: [],
    rowFrames: [],
    knownLoops: [],
    depSeq: { next: 0 },
    pendingMaps: [],
    deferred: [],
    loopDepth: 0,
    slot: options.slotStart ?? 0,
    alertEvent: options.alertEvent ?? 'allowed',
    src,
    commentTails: commentTails(src),
    schema: options.schema,
    connections: options.connections ?? [],
    exprDepth: 0,
  };
  for (const n of scope.row) scope.local.add(n);
  const stats: TranslateStats = { statements: 0, translated: 0, shimmed: 0, todo: 0 };
  const todos: TodoItem[] = [];
  const out = stmts(script.body, scope, stats, todos);
  flushMaps(scope, true);
  const eager = scope.prefetch.join('\n');
  // A client range request asks for one deferred slot; the eager reads are
  // skipped so the endpoint computes only what the caller asked for.
  const prefetch = scope.deferred.length
    ? `if (ctx.rangeSlot) {\n${scope.deferred.join('\n')}\n}${eager.trim() ? ` else {\n${eager}\n}` : ''}`
    : eager;
  return { server: out.server, client: out.client, prefetch, usesElement: scope.elementSlots > 0, nextSlot: scope.slot, stats, todos };
}

/** Line-start offsets of lines that directly follow a `//` comment-only line. */
function commentTails(src: string): Set<number> {
  const tails = new Set<number>();
  let start = 0;
  let prevComment = false;
  while (start <= src.length) {
    const nl = src.indexOf('\n', start);
    const end = nl < 0 ? src.length : nl;
    const line = src.slice(start, end).trim();
    if (prevComment && line) tails.add(start);
    prevComment = line.startsWith('//');
    if (nl < 0) break;
    start = end + 1;
  }
  return tails;
}

function lineStart(src: string, offset: number): number {
  return src.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function account(
  stats: TranslateStats,
  todos: TodoItem[],
  flags: { todo: boolean; shim: boolean; constructs: string[]; note?: string; notes?: readonly string[] },
  span: { start: number; end: number },
): void {
  stats.statements++;
  const b = bucketOf(flags);
  stats[b]++;
  for (const note of flags.notes ?? []) todos.push({ construct: note, start: span.start, end: span.end });
  if (b !== 'todo') return;
  const names = flags.constructs ?? [];
  const listed = names.length ? names : ['unknown'];
  for (const construct of listed) todos.push({ construct, start: span.start, end: span.end, note: flags.note });
}

/**
 * The statement's Deluge source as a single-line comment on its emitted code.
 * String and date literals are masked and Deluge comments (which live in the
 * gaps between tokens) are dropped, so the comment never carries a literal
 * value or comment text into the generated file. Whitespace collapses to
 * single spaces, so the comment is always one line even for a multi-line
 * statement, and it truncates past 80 code points so an astral character
 * is never split into a lone surrogate.
 */
function delugeComment(s: Stmt, src: string): string {
  const slice = src.substring(s.span.start, s.span.end);
  const tokens = lex(slice);
  let out = '';
  let last = 0;
  for (const t of tokens) {
    // Inter-token gaps are whitespace and comments only; drop comment text.
    out += slice
      .substring(last, t.start)
      .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
      .replace(/\/\/[^\r\n]*/g, ' ');
    if (t.kind === 'string' || t.kind === 'date') {
      const q = t.text[0] ?? '"';
      out += `${q}***${q}`;
    } else {
      out += slice.substring(t.start, t.end);
    }
    last = t.end;
  }
  out = out.replace(/\s+/g, ' ').trim();
  const points = Array.from(out);
  if (points.length > 80) out = `${points.slice(0, 77).join('')}...`;
  return out ? `// Deluge: ${out}` : '';
}

function stmts(list: Stmt[], scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  const server: string[] = [];
  const client: string[] = [];
  let alertText: string | null = null;
  for (const s of list) {
    if (s.kind === 'alert') alertText = s.value.kind === 'string' ? s.value.value : null;
    const o =
      s.kind === 'cancelDelete'
        ? cancelDeleteOut(s, alertText, stats, todos)
        : s.kind === 'cancelSubmit'
          ? cancelSubmitOut(s, alertText, stats, todos)
          : statement(s, scope, stats, todos);
    if (s.kind !== 'block') {
      const comment = delugeComment(s, scope.src);
      if (comment) {
        if (o.server.trim()) o.server = `${comment}\n${o.server}`;
        if (o.client.trim()) o.client = `${comment}\n${o.client}`;
      }
    }
    if (o.server.trim()) server.push(o.server);
    if (o.client.trim()) client.push(o.client);
  }
  return { server: server.join('\n'), client: client.join('\n') };
}

function statement(s: Stmt, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  switch (s.kind) {
    case 'block':
      return stmts(s.body, scope, stats, todos);
    case 'if':
      return ifStmt(s, scope, stats, todos);
    case 'forEach':
      return forStmt(s, scope, stats, todos);
    case 'while':
      return whileStmt(s, scope, stats, todos);
    case 'try':
      return tryStmt(s, scope, stats, todos);
    case 'return':
      return returnStmt(s, scope, stats, todos);
    case 'break':
    case 'continue':
      account(stats, todos, { todo: false, shim: false, constructs: [] }, s.span);
      return { server: `${s.kind};`, client: `${s.kind};` };
    case 'info':
      return clientPush('info', expr(s.value, scope), s.span, scope, stats, todos);
    case 'alert': {
      // Live-tested on Creator: `alert` runs in on load, on validate, on
      // change / on user input, and on click (custom action / button) actions;
      // a form-workflow on success rejects it at import. Any other event is
      // unverified, not proven disallowed.
      // https://www.zoho.com/deluge/help/misc-tasks/alert-task.html
      if (scope.alertEvent === 'allowed') {
        return clientPush('alert', expr(s.value, scope), s.span, scope, stats, todos);
      }
      const note = scope.commentTails.has(lineStart(scope.src, s.span.start)) ? 'follows-comment-line' : undefined;
      const construct =
        scope.alertEvent === 'disallowed' ? 'alert-outside-allowed-event' : 'alert-in-unverified-event';
      account(stats, todos, { todo: true, shim: true, constructs: [construct], note }, s.span);
      return { server: '', client: '' };
    }
    case 'cancelSubmit':
      return cancelSubmitOut(s, null, stats, todos);
    case 'cancelDelete':
      return cancelDeleteOut(s, null, stats, todos);
    case 'successMessage':
      return clientPush('successMessage', expr(s.value, scope), s.span, scope, stats, todos);
    case 'reload':
      account(stats, todos, { todo: false, shim: true, constructs: [] }, s.span);
      return { server: '', client: 'actions.push({ op: "reload" });' };
    case 'openUrl': {
      const args = s.args.map((a) => expr(a, scope));
      // A server read in the URL (`openUrl base + Form[criteria].ID`) is a prefetch slot, like a client condition.
      const clientArgs = args.map((a) => clientExpr(a, scope));
      const constructs = [...args.flatMap((a) => a.constructs), ...(clientArgs.some((c) => c.todo) ? ['client-condition-uses-server'] : [])];
      account(stats, todos, { todo: args.some((a) => a.todo) || clientArgs.some((c) => c.todo), shim: true, constructs }, s.span);
      return { server: '', client: `actions.push({ op: "openUrl", args: [${clientArgs.map((a) => a.code).join(', ')}] });` };
    }
    case 'ui': {
      const targets = s.targets.map((t) => targetLit(t, scope));
      account(stats, todos, { todo: targets.some((t) => t.todo), shim: true, constructs: targets.flatMap((t) => t.constructs) }, s.span);
      return {
        server: '',
        client: `actions.push({ op: ${JSON.stringify(s.action)}, targets: [${targets.map((t) => t.code).join(', ')}] });`,
      };
    }
    case 'deleteFrom':
      return deleteStmt(s.target, s.span, scope, stats, todos);
    case 'update':
      return updateStmt(s, scope, stats, todos);
    case 'assign':
      return assignStmt(s, scope, stats, todos);
    case 'expr':
      return exprStmt(s.expr, s.span, scope, stats, todos);
    case 'fn':
      return fnStmt(s, scope, stats, todos);
    case 'unknown': {
      // A bare `approver.<x>` statement flagged no-effect keeps the curated
      // approval construct (see `memberExpr`), not a generic `task:` name.
      const approverRead =
        s.reason === 'no-effect' && !!scope.approval && !scope.local.has('approver') && /^approver\.[A-Za-z_][\w.]*$/.test(s.text.trim());
      const construct = approverRead ? 'approval-approver' : taskConstruct(s.text, s.reason);
      account(stats, todos, { todo: true, shim: true, constructs: [construct] }, s.span);
      const call = approverRead
        ? `await shim.todo(ctx, ${JSON.stringify(construct)});`
        : `await shim.todo(ctx, ${JSON.stringify(construct)}, { start: ${s.span.start}, end: ${s.span.end} });`;
      // A statement that did not parse is still `name = <expr>` more often
      // than not: bind `name` to the todo value so later reads resolve on both
      // sides instead of leaking a free identifier.
      const lhs = /^([A-Za-z_$][\w$]*)\s*=(?![>=])/.exec(s.text.trimStart())?.[1];
      if (lhs) {
        scope.local.add(lhs);
        scope.bindings.set(lhs, {
          code: `await shim.todo(ctx, ${JSON.stringify(construct)})`,
          reads: [],
          unboundReads: [],
          appFunction: false,
          todo: true,
          sideEffect: true,
          deps: new Map(),
          seq: scope.clock.seq++,
          flow: scope.flowStack[scope.flowStack.length - 1]!,
        });
        const line = `var ${jsIdent(lhs)} = ${call}`;
        return { server: line, client: line };
      }
      return { server: call, client: '' };
    }
    default: {
      const never: never = s;
      return never;
    }
  }
}

function taskConstruct(text: string, reason: string): string {
  const word = /[A-Za-z_][A-Za-z0-9_]*/.exec(text)?.[0] ?? reason;
  return `task:${word}`.slice(0, 80);
}

/**
 * `cancel delete` refuses the delete on the server. A literal `alert "..."` earlier in the
 * same block replaces Creator's default alert text.
 */
function cancelDeleteOut(s: Extract<Stmt, { kind: 'cancelDelete' }>, alertText: string | null, stats: TranslateStats, todos: TodoItem[]): Out {
  account(stats, todos, { todo: false, shim: true, constructs: [] }, s.span);
  return { server: `await shim.validate.cancelDelete(ctx, ${JSON.stringify(alertText)});`, client: '' };
}

/**
 * The client stops the submit; the server refuses it too, so a direct POST cannot skip on validate.
 */
function cancelSubmitOut(s: Extract<Stmt, { kind: 'cancelSubmit' }>, alertText: string | null, stats: TranslateStats, todos: TodoItem[]): Out {
  account(stats, todos, { todo: false, shim: true, constructs: [] }, s.span);
  return { server: `await shim.validate.cancelSubmit(ctx, ${JSON.stringify(alertText)});`, client: 'actions.push({ op: "cancelSubmit" });' };
}

function clientPush(op: string, value: Fx, span: { start: number; end: number }, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  // A server read in the message (`info Form[criteria].Field`) is a prefetch slot, like a client condition.
  const message = clientExpr(value, scope);
  const constructs = message.todo ? [...value.constructs, 'client-condition-uses-server'] : value.constructs;
  account(stats, todos, { todo: value.todo || message.todo, shim: true, constructs }, span);
  return { server: '', client: `actions.push({ op: ${JSON.stringify(op)}, message: ${message.code} });` };
}

function ifStmt(s: Extract<Stmt, { kind: 'if' }>, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  // Tests are translated, and later slotted, against the bindings in force
  // before any arm. An assignment inside the then-arm must not become the
  // value an else-if test replays. Each arm is translated from those same
  // bindings: the then-arm has not run when the else-if or else arm is
  // evaluated, so a read there still sees the value from before the if.
  const test = expr(s.test, scope);
  const elifTests = s.elifs.map((e) => expr(e.test, scope));
  const atTest = snapBindings(scope);
  const atClass = copyClasses(scope);
  const afterClass = copyClasses(scope);
  const bodies: Stmt[] = [s.then, ...s.elifs.map((e) => e.body)];
  if (s.else) bodies.push(s.else);
  const assigned = new Set<string>();
  for (const body of bodies) for (const name of assignedNames(body)) assigned.add(name);
  const translated: Out[] = [];
  const perArm: { assigns: Set<string>; classes: ArmClasses }[] = [];
  for (const body of bodies) {
    restoreClasses(scope, atClass);
    for (const name of assigned) {
      const prior = atTest.bindings.get(name);
      if (prior) scope.bindings.set(name, prior);
      else scope.bindings.delete(name);
    }
    translated.push(underFlow(scope, () => statement(body, scope, stats, todos)));
    perArm.push({ assigns: assignedNames(body), classes: copyClasses(scope) });
  }
  // A name is client-ready after the if only when every arm — and the
  // fall-through path when there is no else — leaves it client-ready with the
  // same kind. An arm that does not assign the name contributes the sets from
  // before the if. When any path binds a value the client cannot reproduce (a
  // side effect, a query, a refused todo) or the paths disagree on the value's
  // shape (a list against a scalar, a row against a number), the name is not
  // client-ready: a later read reaches the tombstone binding and degrades to
  // a counted todo instead of silently evaluating the last arm's kind. A
  // decimal refinement is a union, so one exact-decimal path keeps arithmetic
  // on shim.decimal. A date refinement stays when every path that binds the
  // name leaves a date; a path that never bound the name does not remove it.
  restoreClasses(scope, atClass);
  const serverOnlyIx = ARM_CLASSES.indexOf('serverOnly');
  const clientDataIx = ARM_CLASSES.indexOf('clientData');
  const shapeIx = (['query', 'list', 'map', 'row'] as const).map((k) => ARM_CLASSES.indexOf(k));
  for (const name of assigned) {
    const sigs = perArm.map((arm) => classSignature(arm.assigns.has(name) ? arm.classes : atClass, name));
    if (!s.else) sigs.push(classSignature(atClass, name));
    const clientReady = sigs.every((sig) => !sig[serverOnlyIx] || sig[clientDataIx]);
    const sameShape = sigs.every((sig) => shapeIx.every((i) => sig[i] === sigs[0]![i]));
    // A path with no binding (an else-less fall-through, or an arm that does
    // not assign the name) is neutral for `date`. A path that assigns another
    // value drops it, so a later toString uses String on the non-date path.
    // `decimal` stays a union: shim.decimal accepts a plain number.
    const bound = sigs.filter((sig) => sig.some(Boolean));
    for (let i = 0; i < ARM_CLASSES.length; i++) {
      const key = ARM_CLASSES[i]!;
      const survives = key === 'date' ? bound.length > 0 && bound.every((sig) => sig[i]) : sigs.some((sig) => sig[i]);
      if (survives) afterClass[key].add(name);
      else afterClass[key].delete(name);
    }
    if (!(clientReady && sameShape)) {
      afterClass.serverOnly.add(name);
      afterClass.clientData.delete(name);
    }
  }
  restoreClasses(scope, afterClass);
  const then = translated[0]!;
  const elifBodies = translated.slice(1, 1 + s.elifs.length);
  const els = s.else ? translated[translated.length - 1] : undefined;
  // An arm may have replaced the name. The value from before the if does not
  // dominate a use after the if, whether or not the last arm assigned it.
  for (const name of assigned) {
    scope.bindings.set(name, {
      code: 'undefined',
      reads: [],
      unboundReads: [],
      appFunction: false,
      todo: false,
      sideEffect: true,
      deps: new Map(),
      seq: scope.clock.seq++,
      flow: -1,
    });
  }
  const serverBits = [then.server, ...elifBodies.map((b) => b.server), els?.server ?? ''].some((x) => x.trim());
  const clientBits = [then.client, ...elifBodies.map((b) => b.client), els?.client ?? ''].some((x) => x.trim());
  const condTodo = test.todo || elifTests.some((t) => t.todo);
  const condShim = test.shim || elifTests.some((t) => t.shim);
  const constructs = [...test.constructs, ...elifTests.flatMap((t) => t.constructs)];
  const clientTests = clientBits
    ? withBindings(scope, atTest, () => [clientExpr(test, scope, 'client-condition-uses-server', true), ...elifTests.map((t) => clientExpr(t, scope, 'client-condition-uses-server', true))])
    : [];
  const clientCondTodo = clientTests.some((c) => c.todo);
  if (clientCondTodo) constructs.push('client-condition-uses-server');
  account(stats, todos, { todo: condTodo || clientCondTodo, shim: condShim || clientTests.some((c) => c.shim), constructs }, s.span);
  let server = '';
  if (serverBits) {
    server = `if (${test.code}) {\n${indent(then.server)}\n}`;
    for (let i = 0; i < elifTests.length; i++) server += ` else if (${elifTests[i]!.code}) {\n${indent(elifBodies[i]!.server)}\n}`;
    if (els) server += ` else {\n${indent(els.server)}\n}`;
  }
  let client = '';
  if (clientBits) {
    const head = clientTests[0]!.code;
    client = `if (${head}) {\n${indent(then.client)}\n}`;
    for (let i = 0; i < elifTests.length; i++) {
      const c = clientTests[i + 1]!.code;
      client += ` else if (${c}) {\n${indent(elifBodies[i]!.client)}\n}`;
    }
    if (els) client += ` else {\n${indent(els.client)}\n}`;
  }
  return { server, client };
}

function forStmt(s: Extract<Stmt, { kind: 'forEach' }>, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  const col = expr(s.collection, scope);
  // The collection is evaluated once, before the body. Slot it against these
  // bindings even though the body is translated first and may reassign them.
  const atCollection = snapBindings(scope);
  scope.local.add(s.name);
  scope.query.delete(s.name);
  scope.list.delete(s.name);
  scope.decimal.delete(s.name);
  scope.serverOnly.delete(s.name);
  // A row-scope collection — a bound `recs`, a form-typed function parameter,
  // or the row alias (`Form` naming `recs`) — also iterates records: `v.Field`
  // reads and writes go through shim.record like a fetched collection does.
  const rowSource =
    s.collection.kind === 'name' &&
    (scope.row.has(s.collection.name) || rowAliasOf(s.collection.name, scope) !== null);
  const elementIsRow = !s.iteratesIndex && (col.query || isSubform(s.collection, scope) || rowSource);
  if (elementIsRow) scope.row.add(s.name);
  else scope.row.delete(s.name);
  if (col.serverOnly) scope.serverOnly.add(s.name);
  const hadClientData = scope.clientData.has(s.name);
  const collectionSource = col.query ? `await shim.datastore.rows(ctx, ${col.code})` : col.code;
  // A non-read or an app function on the collection must never run in
  // the prefetch, and the client loop degrades to the counted todo.
  const colRefused = collectionReplayRefused(col, scope);
  const iterSource = collectionSource;
  const collectionIter = col.query
    ? mergeFx(collectionSource, [col], { shim: true, serverOnly: true, rowReads: rowsRowRead(s.collection, collectionSource, scope) })
    : col;
  let frame: LoopFrame | null = null;
  if (col.serverOnly) {
    scope.clientData.add(s.name);
    frame = {
      name: s.name,
      source: collectionSource,
      clientSource: null,
      iter: collectionIter,
      scalar: elementIsRow ? undefined : true,
      deps: col.reads,
      refused: colRefused,
      closed: false,
      depth: scope.loopDepth++,
    };
    scope.rowFrames.push(frame);
    scope.knownLoops.push(frame);
  } else if (!s.iteratesIndex && prefetchLoopSource(col, elementIsRow, s.collection, scope)) {
    // A client-iterated collection the prefetch can replay as-is: a subform or
    // `input` row list, or a scalar list bound ahead of the loop.
    scope.clientData.add(s.name);
    frame = {
      name: s.name,
      source: col.code,
      clientSource: null,
      iter: col,
      scalar: elementIsRow ? undefined : true,
      deps: col.reads,
      refused: colRefused,
      closed: false,
      depth: scope.loopDepth++,
    };
    scope.rowFrames.push(frame);
    scope.knownLoops.push(frame);
  }
  // A non-record server element (a getAll column) that the client iterates
  // from a snapshot can be sent back to the prefetch endpoint: a condition
  // reading it plus other server data is one server round trip per element.
  // Record elements stay on the row path. A collection that itself reads a
  // snapshot-scoped name cannot be a client loop.
  const elementRoundTrip =
    col.serverOnly &&
    !col.appFunction &&
    !col.todo &&
    !colRefused &&
    collectionIsGetAll(s.collection) &&
    !elementIsRow &&
    !s.iteratesIndex &&
    !collectionIter.reads.some((r) => scope.clientData.has(r)) &&
    collectionIter.reads.every((r) => prefetchable(r, scope, new Set()));
  if (elementRoundTrip) {
    scope.elementVars.add(s.name);
    scope.elementCollections.set(s.name, iterSource);
  }
  const assigned = assignedNames(s.body);
  assigned.add(s.name);
  if (s.index) assigned.add(s.index);
  const body = underLoop(scope, assigned, () => statement(s.body, scope, stats, todos));
  scope.elementVars.delete(s.name);
  scope.elementCollections.delete(s.name);
  if (!hadClientData) scope.clientData.delete(s.name);
  const constructs = [...col.constructs];
  // A query becomes `rows()`, which is an array (empty → zero iterations).
  // Null also iterates zero times (`foreach.null`); `shim.each` does that.
  let clientTodo = false;
  let clientIter = '';
  let rangeSlot: { slot: string; from: string; to: string } | null = null;
  if (body.client.trim() && (col.serverOnly || col.todo || col.appFunction || colRefused)) {
    // A refused collection is the counted client-loop todo: no slot, no map,
    // and no replayed call — clientExpr must not even see it.
    const resolved = colRefused
      ? { code: `await shim.todo(ctx, "client-loop-uses-server")`, todo: true, shim: true }
      : withBindings(scope, atCollection, () => clientExpr(collectionIter, scope, 'client-loop-uses-server'));
    if (frame && !resolved.todo) frame.clientSource = resolved.code;
    if (resolved.todo) {
      // A range bound that reads only client-resolvable scalars (a
      // client-accumulated counter like `11 - proplength`) is evaluated by the
      // client and sent as a request parameter to the deferred slot read
      // instead of making the whole loop a counted todo.
      rangeSlot = withBindings(scope, atCollection, () => rangeSlotFor(col, scope));
      if (!rangeSlot) {
        clientTodo = true;
        constructs.push('client-loop-uses-server');
        clientIter = resolved.code;
      }
    } else {
      clientIter = resolved.code;
    }
  }
  if (frame) {
    frame.closed = true;
    flushMaps(scope, false);
    scope.rowFrames.pop();
  }
  account(stats, todos, { todo: col.todo || clientTodo, shim: col.shim || col.query || !!clientIter, constructs }, s.span);
  const name = jsIdent(s.name);
  const iter = iterSource;
  // collection.html — iterations equal the number of values, so an empty
  // array runs zero times. `foreach.null` is also zero iterations. Do not emit `?? []`.
  // `var`, not `const`: the body may assign or redeclare the loop variable,
  // and after the loop it holds the last element
  // (deluge-docs/pages/list-manipulations__for-each-element.html).
  const headFor = (source: string) =>
    s.iteratesIndex
      ? `for (var ${name} of shim.each(ctx, ${source}).keys())`
      : s.index
        ? `for (var [${jsIdent(s.index)}, ${name}] of shim.each(ctx, ${source}).entries())`
        : `for (var ${name} of shim.each(ctx, ${source}))`;
  const head = headFor(iter);
  // Field writes on a fetched row are record.set. Deluge persists them
  // (fetch example 4: https://www.zoho.com/deluge/help/fetch-records/fetch-collection-records.html
  // and https://www.zoho.com/deluge/help/data-access/update-records.html).
  // Queue during the loop and flush once when it leaves, including break, return, and throw.
  // record.set is the only call that queues a pending field write, so a loop
  // whose body never calls it gets no flush wrapper at all: an unconditional
  // flush would put a write-capable shim call in code that only reads.
  const queuesFieldWrite = /\bshim\.record\.set\(/.test(body.server);
  const serverLoop = body.server.trim()
    ? (col.query || rowSource) && queuesFieldWrite
      ? `try {\n${indent(`${head} {\n${indent(body.server)}\n}`)}\n} finally {\n${indent('await shim.datastore.flush(ctx);')}\n}`
      : `${head} {\n${indent(body.server)}\n}`
    : '';
  const clientPart = (): string => {
    if (!body.client.trim()) return '';
    if (rangeSlot) {
      const v = `range_${rangeSlot.slot}`;
      return (
        `var ${v} = await shim.client.rows(ctx, ${JSON.stringify(rangeSlot.slot)}, ${rangeSlot.from}, ${rangeSlot.to});\n` +
        `if (!${v} || !${v}.ok) {\n` +
        `  actions.push({ op: "info", message: (${v} && ${v}.message) || "Server read failed; client action blocked." });\n` +
        `  return actions;\n` +
        `}\n` +
        `${headFor(`${v}.rows`)} {\n${indent(body.client)}\n}`
      );
    }
    if (clientTodo) return `if (${clientIter}) {\n${indent(body.client)}\n}`;
    if (clientIter) {
      const note = col.ranged
        ? '// snapshot: a ranged query is the page the range names; a loop body that moves the page window reads no later page\n'
        : '';
      return `${note}${headFor(clientIter)} {\n${indent(body.client)}\n}`;
    }
    return `${head} {\n${indent(body.client)}\n}`;
  };
  return {
    server: serverLoop,
    client: clientPart(),
  };
}

/**
 * A query collection whose `range` bounds are evaluable on the client: every
 * name the bounds read is a client-resolvable scalar, and every other name the
 * query reads replays in the prefetch module (constants, `input.*`, and
 * input-derived locals bound as parameters). Returns the deferred slot when
 * the endpoint can serve the read on request, else `null` and the loop stays
 * a counted todo.
 */
function rangeSlotFor(col: Fx, scope: Scope): { slot: string; from: string; to: string } | null {
  const range = col.clientRange;
  if (!range || !col.query || col.todo) return null;
  if (range.from.todo || range.to.todo || range.from.serverOnly || range.to.serverOnly) return null;
  const rangeReads = new Set([...range.from.reads, ...range.to.reads]);
  for (const name of rangeReads) {
    if (!clientBound(name, scope)) return null;
    const binding = scope.bindings.get(name);
    // A pure local an earlier client loop wrote is a number the client posts.
    // An if/else tombstone (flow -1, side effect) is also a live client value
    // when the client stream declared the name: the client posts whichever
    // value the arms left, so no arm is guessed and nothing is replayed. The
    // deferred read still refuses bounds that are not safe integers, so a name
    // the client never actually set degrades to a blocked read, not bad rows.
    // Any other non-read binding stays refused.
    if (binding?.flow === -1 && (scope.declaredClient.has(name) || scope.prefetchBound.has(name))) continue;
    if (binding && (binding.sideEffect || binding.appFunction || binding.todo || binding.unboundReads.length > 0 || binding.flow < 0)) return null;
  }
  const serverReads: string[] = [];
  for (const name of col.reads) if (!rangeReads.has(name)) serverReads.push(name);
  for (const name of serverReads) {
    if (!prefetchable(name, scope, new Set())) return null;
    // A binding that already degraded (a nested getAll whose inner criteria is
    // dynamic) would emit a `{"op":"todo"}` read into the deferred branch.
    if (bindingTodo(name, scope, new Set())) return null;
  }
  // The bindings the deferred branch replays are independent of the eager
  // slot emissions: each branch binds its own names inside its guard.
  const savedPrefetch = scope.prefetch;
  const savedEmitted = scope.emitted;
  scope.prefetch = [];
  scope.emitted = new Map();
  let binds: string[] = [];
  let replayed = true;
  try {
    for (const name of serverReads) {
      if (!replayNow(name, scope)) replayed = false;
    }
    binds = scope.prefetch;
  } finally {
    scope.prefetch = savedPrefetch;
    scope.emitted = savedEmitted;
  }
  if (!replayed) return null;
  const slot = `c${scope.slot++}`;
  scope.deferred.push(
    [
      `if (ctx.rangeSlot === ${JSON.stringify(slot)}) {`,
      ...binds.map((line) => `  ${line}`),
      `  slots[${JSON.stringify(slot)}] = ctx.rangeEmpty ? [] : await shim.datastore.rows(ctx, ${range.code});`,
      `}`,
    ].join('\n'),
  );
  return { slot, from: range.from.code, to: range.to.code };
}

/**
 * A name the client evaluates in place: a plain local or parameter that is not
 * a server value, a fetched row, a query, or a loop element. `input`/`old`
 * read the record the client already holds.
 */
function clientBound(name: string, scope: Scope): boolean {
  if (name === 'input' || name === 'old') return true;
  if (scope.serverOnly.has(name) || scope.clientData.has(name) || scope.query.has(name) || scope.row.has(name)) return false;
  return scope.local.has(name) || scope.prefetchBound.has(name);
}

function isSubform(e: Expr, scope: Scope): boolean {
  if (e.kind !== 'member') return false;
  const root = rootName(e);
  return root === 'input' || root === 'old' || root === 'row' || (root !== null && scope.row.has(root));
}

/**
 * Can the collection's emitted code be replayed inside the prefetch? Row
 * sources (`input`, `old`, `row`, another row variable) and locals replayable
 * ahead of the loop qualify; a scalar list qualifies only when it is a bound
 * name, so the prefetch can emit that binding first.
 */
function prefetchLoopSource(col: Fx, elementIsRow: boolean, collection: Expr, scope: Scope): boolean {
  const bound = (n: string) => scope.clientData.has(n) || scope.row.has(n) || prefetchable(n, scope, new Set());
  if (!col.reads.every(bound)) return false;
  return elementIsRow || collection.kind === 'name';
}

function whileStmt(s: Extract<Stmt, { kind: 'while' }>, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  const test = expr(s.test, scope);
  // The test is read again every iteration, so it is slotted after the body
  // against the live bindings: a name the body assigns does not dominate it.
  // Reads inside the body of those names are refused by `underLoop`.
  const body = underLoop(scope, assignedNames(s.body), () => statement(s.body, scope, stats, todos));
  const constructs = [...test.constructs];
  const needsSnapshot = !!(body.client.trim() && test.serverOnly && !test.clientReady);
  const snap = needsSnapshot ? clientExpr(test, scope, 'client-condition-uses-server', true) : undefined;
  if (snap?.todo) constructs.push('client-condition-uses-server');
  account(stats, todos, { todo: test.todo || !!snap?.todo, shim: test.shim || !!snap, constructs }, s.span);
  const server = body.server.trim() || test.serverOnly ? `while (${test.code}) {\n${indent(body.server)}\n}` : '';
  let client = '';
  if (body.client.trim() && snap) {
    // A frozen while (true) would not terminate: the client cannot re-query, so the body runs once.
    client = snap.todo
      ? `if (${snap.code}) {\n${indent(body.client)}\n}`
      : `// snapshot: server while-test is evaluated once (the client cannot re-query)\nif (${snap.code}) {\n${indent(body.client)}\n}`;
  } else if (body.client.trim()) {
    client = `while (${test.code}) {\n${indent(body.client)}\n}`;
  }
  return { server: body.server.trim() ? server : '', client };
}

function tryStmt(s: Extract<Stmt, { kind: 'try' }>, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  const body = underFlow(scope, () => statement(s.body, scope, stats, todos));
  const catchBody = s.catchBody ? underFlow(scope, () => statement(s.catchBody!, scope, stats, todos)) : undefined;
  account(stats, todos, { todo: false, shim: false, constructs: [] }, s.span);
  const name = jsIdent(s.catchName ?? 'err');
  const wrap = (inner: string, alt: string) => {
    if (!inner.trim() && !(alt && alt.trim())) return '';
    // A refused element round trip throws through a user catch: its discard
    // of the run's queued client actions must not be swallowed.
    return `try {\n${indent(inner)}\n} catch (${name}) {\n  if (${name} && ${name}.c2cElementBlocked === true) throw ${name};\n${indent(alt)}\n}`;
  };
  return { server: wrap(body.server, catchBody?.server ?? ''), client: wrap(body.client, catchBody?.client ?? '') };
}

function returnStmt(s: Extract<Stmt, { kind: 'return' }>, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  if (!s.value) {
    account(stats, todos, { todo: false, shim: false, constructs: [] }, s.span);
    return { server: 'return;', client: 'return;' };
  }
  const v = expr(s.value, scope);
  account(stats, todos, v, s.span);
  const line = `return ${v.code};`;
  if (v.serverOnly) return { server: line, client: '' };
  return { server: line, client: line };
}

function deleteStmt(target: Expr, span: { start: number; end: number }, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  const q = asQuery(target, scope);
  account(stats, todos, { todo: q.todo, shim: true, constructs: q.constructs }, span);
  const line = `await shim.datastore.delete(ctx, ${JSON.stringify(q.form)}, ${q.criteria});`;
  return { server: line, client: '' };
}

function updateStmt(s: Extract<Stmt, { kind: 'update' }>, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  const q = asQuery(s.target, scope);
  const fields = fieldsObj(s.entries, scope);
  const constructs = [...q.constructs, ...fields.constructs];
  account(stats, todos, { todo: q.todo || fields.todo, shim: true, constructs }, s.span);
  const line = `await shim.datastore.update(ctx, ${JSON.stringify(q.form)}, ${q.criteria}, ${fields.code});`;
  return { server: line, client: '' };
}

/** True when `e` textually reads `name`, including a name still unbound at this point. */
function exprReadsName(e: Expr, name: string): boolean {
  let found = false;
  walk(e, (n) => {
    if (n.kind === 'name' && n.name === name) found = true;
  });
  return found;
}

function assignStmt(s: Extract<Stmt, { kind: 'assign' }>, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  const value = expr(s.value, scope);
  const selfRef = s.target.kind === 'name' && (s.op !== '=' || exprReadsName(s.value, s.target.name));
  if (s.op !== '=' && s.target.kind === 'name') {
    const cur = expr(s.target, scope);
    const combined = applyOp(s.op.slice(0, -1), cur, value);
    auditArithmetic(s.op.slice(0, -1), s.target, s.value, combined, scope);
    return assignTo(s.target, combined, s.span, scope, stats, todos, s.declType, selfRef);
  }
  return assignTo(s.target, value, s.span, scope, stats, todos, s.declType, selfRef);
}

/**
 * Path segments a write may never contain: they reach the object's shared
 * prototype instead of an own key. A path holding one is refused outright —
 * the same counted hole as any other unhandled write — and the runtime set
 * refuses them too, so a computed segment cannot sneak one in.
 */
const UNSAFE_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function unsafePathRefusal(span: { start: number; end: number }, stats: TranslateStats, todos: TodoItem[]): Out {
  account(stats, todos, { todo: true, shim: true, constructs: ['unsafe-path-key'] }, span);
  const line = `await shim.todo(ctx, "unsafe-path-key");`;
  return { server: line, client: '' };
}

/**
 * An assignment target's member/index chain down to its root name. Member
 * steps and string-literal index steps are static segments; any other index
 * expression is a computed segment.
 */
function assignPath(e: Expr): { root: string; segments: Array<{ key?: string; index?: Expr }> } | null {
  const segments: Array<{ key?: string; index?: Expr }> = [];
  let cur: Expr = e;
  for (;;) {
    if (cur.kind === 'member') {
      segments.unshift({ key: cur.property });
      cur = cur.object;
    } else if (cur.kind === 'index') {
      segments.unshift(cur.index.kind === 'string' ? { key: cur.index.value } : { index: cur.index });
      cur = cur.object;
    } else break;
  }
  if (cur.kind === 'name') return { root: cur.name, segments };
  return null;
}

function assignTo(target: Expr, value: Fx, span: { start: number; end: number }, scope: Scope, stats: TranslateStats, todos: TodoItem[], declType?: string, selfRef = false): Out {
  void declType;
  if (target.kind === 'name') {
    const name = target.name;
    let reads = value.reads;
    // Rewriting the dep is only for a bound expression that is itself a server
    // read: a self-referential accumulator or any other shape keeps the cycle,
    // so a value the prefetch must not evaluate is never replayed.
    const serverRead = value.serverOnly && !value.appFunction && !value.todo && !nonReadReplay(value.code);
    if (reads.includes(name) && serverRead) {
      // A right-hand read of the name being assigned reads the PREVIOUS value
      // — an earlier binding or a prefetch-module param — not the new binding.
      // Rewriting the dep to the previous binding keeps the walk acyclic; a
      // name with no previous value stays a self-read and refuses as a cycle.
      const prior = scope.bindings.get(name);
      if (prior || scope.prefetchBound.has(name)) {
        const key = ` ${name}#${scope.depSeq.next++}`;
        scope.bindings.set(
          key,
          prior
            ? { ...prior, emitAs: name }
            : {
                code: '',
                reads: [],
                appFunction: false,
                todo: false,
                sideEffect: false,
                unboundReads: [],
                deps: new Map(),
                seq: scope.clock.seq++,
                flow: scope.flowStack[scope.flowStack.length - 1]!,
                bound: true,
              },
        );
        reads = reads.map((r) => (r === name ? key : r));
      }
    }
    scope.local.add(name);
    scope.query.delete(name);
    scope.list.delete(name);
    scope.map.delete(name);
    scope.date.delete(name);
    scope.decimal.delete(name);
    scope.row.delete(name);
    scope.serverOnly.delete(name);
    if (value.query) scope.query.add(name);
    if (value.list) scope.list.add(name);
    if (value.map) scope.map.add(name);
    if (value.row) scope.row.add(name);
    if (value.date) scope.date.add(name);
    if (value.decimal) scope.decimal.add(name);
    if (value.serverOnly) scope.serverOnly.add(name);
    // `reads` already names the previous binding when this assignment is a
    // server read of its own name. An arithmetic self-assign keeps the cycle.
    // Unbound names stay on the read list so a later walk can see them.
    const recordedReads = [...reads];
    if (selfRef && !recordedReads.includes(name) && !recordedReads.some((r) => r.startsWith(`\0${name}#`))) recordedReads.push(name);
    for (const u of value.unboundReads) if (!recordedReads.includes(u)) recordedReads.push(u);
    const deps = new Map<string, Binding | undefined>();
    for (const r of recordedReads) deps.set(r, scope.bindings.get(r));
    scope.bindings.set(name, {
      code: value.code,
      reads: recordedReads,
      unboundReads: value.unboundReads,
      appFunction: value.appFunction,
      todo: value.todo,
      sideEffect: value.sideEffect,
      rowReads: value.rowReads,
      deps,
      seq: scope.clock.seq++,
      flow: scope.flowStack[scope.flowStack.length - 1]!,
    });
    account(stats, todos, value.query || value.serverOnly ? { ...value, shim: true } : value, span);
    const where: Array<'server' | 'client'> = value.serverOnly ? ['server'] : ['server', 'client'];
    return declare(name, value.code, where, scope);
  }
  const path = aliasedPath(target, scope);
  if (path && (path.root === 'input' || path.root === 'row')) {
    if (path.path.some((k) => UNSAFE_PATH_KEYS.has(k))) return unsafePathRefusal(span, stats, todos);
    const api = path.root === 'input' ? 'input' : 'record';
    const base = path.root === 'input' ? '' : `${jsIdent(path.root)}, `;
    const code = `shim.${api}.set(ctx, ${base}${JSON.stringify(path.path)}, ${value.code})`.replace('set(ctx, ,', 'set(ctx,');
    const fixed = path.root === 'input'
      ? `shim.input.set(ctx, ${JSON.stringify(path.path)}, ${value.code});`
      : `shim.record.set(${jsIdent(path.root)}, ${JSON.stringify(path.path)}, ${value.code});`;
    void code;
    account(stats, todos, { todo: value.todo, shim: true, constructs: value.constructs }, span);
    return { server: fixed, client: value.serverOnly ? '' : fixed };
  }
  if (path && scope.query.has(path.root)) {
    if (path.path.some((k) => UNSAFE_PATH_KEYS.has(k))) return unsafePathRefusal(span, stats, todos);
    account(stats, todos, { todo: value.todo, shim: true, constructs: value.constructs }, span);
    const line = `await shim.datastore.setField(ctx, ${jsIdent(path.root)}, ${JSON.stringify(path.path.join('.'))}, ${value.code});`;
    return { server: line, client: '' };
  }
  if (path && scope.row.has(path.root)) {
    if (path.path.some((k) => UNSAFE_PATH_KEYS.has(k))) return unsafePathRefusal(span, stats, todos);
    account(stats, todos, { todo: value.todo, shim: true, constructs: value.constructs }, span);
    const line = `shim.record.set(${jsIdent(path.root)}, ${JSON.stringify(path.path)}, ${value.code});`;
    // The row itself is a server value: the client cannot write to it even when the value is client-side.
    return { server: line, client: value.serverOnly || scope.serverOnly.has(path.root) ? '' : line };
  }
  if (path && !scope.local.has(path.root)) {
    // A bare field member write is the same field write `input.X.Y` emits:
    // the folded read is a call result, which cannot take an assignment.
    const rowFields = scope.rowFields;
    if (rowFields?.names.has(path.root) && scope.row.has(rowFields.row)) {
      if ([path.root, ...path.path].some((k) => UNSAFE_PATH_KEYS.has(k))) return unsafePathRefusal(span, stats, todos);
      account(stats, todos, { todo: value.todo, shim: true, constructs: value.constructs }, span);
      const line = `shim.record.set(${jsIdent(rowFields.row)}, ${JSON.stringify([path.root, ...path.path])}, ${value.code});`;
      return { server: line, client: value.serverOnly || scope.serverOnly.has(rowFields.row) ? '' : line };
    }
    if (scope.inputFields.has(path.root)) {
      if ([path.root, ...path.path].some((k) => UNSAFE_PATH_KEYS.has(k))) return unsafePathRefusal(span, stats, todos);
      account(stats, todos, { todo: value.todo, shim: true, constructs: value.constructs }, span);
      const line = `shim.input.set(ctx, ${JSON.stringify([path.root, ...path.path])}, ${value.code});`;
      return { server: line, client: value.serverOnly ? '' : line };
    }
  }
  const indexed = assignPath(target);
  if (indexed && indexed.segments.some((seg) => seg.key !== undefined && UNSAFE_PATH_KEYS.has(seg.key))) {
    return unsafePathRefusal(span, stats, todos);
  }
  if (indexed && (indexed.root === 'input' || indexed.root === 'old') && indexed.segments.length) {
    // An index path on `input` or `old` is the same record write a member
    // path emits; routing it through the shim keeps a computed segment under
    // the runtime key guard instead of indexing the record object raw.
    const segFxs = indexed.segments.map((seg) => (seg.key !== undefined ? fx({ code: JSON.stringify(seg.key) }) : expr(seg.index!, scope)));
    account(stats, todos, mergeFx('', [...segFxs, value]), span);
    const api = indexed.root === 'input' ? 'shim.input.set' : 'shim.old.set';
    const line = `${api}(ctx, [${segFxs.map((seg) => seg.code).join(', ')}], ${value.code});`;
    const serverOnly = value.serverOnly || segFxs.some((seg) => seg.serverOnly);
    return { server: line, client: serverOnly ? '' : line };
  }
  if (target.kind === 'index' || target.kind === 'member') {
    // A computed key (and a member step that resolved to a local holding a
    // prototype) goes through the guarded setter: it refuses the unsafe
    // segment names and never writes onto a shared prototype object, so
    // `m[k][f] = v` with `k` = "__proto__" from request input is inert.
    const obj = expr(target.object, scope);
    const key = target.kind === 'index' ? expr(target.index, scope) : fx({ code: JSON.stringify(target.property) });
    account(stats, todos, mergeFx('', [obj, key, value]), span);
    const line = `shim.set(${obj.code}, ${key.code}, ${value.code});`;
    if (value.serverOnly || obj.serverOnly || key.serverOnly) {
      // A member write dropped client-side leaves the local collection's client
      // value stale — the same taint a dropped mutating call applies.
      const root = rootName(target.object);
      if (root && scope.local.has(root)) scope.serverOnly.add(root);
      return { server: line, client: '' };
    }
    return { server: line, client: line };
  }
  const left = expr(target, scope);
  account(stats, todos, mergeFx('', [left, value]), span);
  const line = `${left.code} = ${value.code};`;
  if (value.serverOnly || left.serverOnly) {
    // A member write dropped client-side leaves the local collection's client
    // value stale — the same taint a dropped mutating call applies.
    const root = path?.root ?? null;
    if (root && scope.local.has(root)) scope.serverOnly.add(root);
    return { server: line, client: '' };
  }
  return { server: line, client: line };
}

function declare(name: string, code: string, where: Array<'server' | 'client'>, scope: Scope): Out {
  const out: Out = { server: '', client: '' };
  const id = jsIdent(name);
  for (const side of where) {
    const set = side === 'server' ? scope.declaredServer : scope.declaredClient;
    const kw = set.has(name) ? '' : 'var ';
    set.add(name);
    out[side] = `${kw}${id} = ${code};`;
  }
  return out;
}

/** Methods that mutate a collection value in place, canonical name in lower case. */
const COLLECTION_MUTATORS = new Set([
  'add',
  'addall',
  'insert',
  'put',
  'putall',
  'remove',
  'removeall',
  'retainall',
  'clear',
  'sort',
  'deletekey',
  'deletekeys',
]);

function exprStmt(e: Expr, span: { start: number; end: number }, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  if (e.kind === 'colonCall') return colonStmt(e, span, scope, stats, todos);
  const choice = choiceTask(e, scope);
  if (choice) {
    const values = e.kind === 'call' ? e.args.map((a) => expr(a, scope)) : [];
    const clientArgs = values.map((v) => clientExpr(v, scope));
    const constructs = values.flatMap((v) => v.constructs);
    if (clientArgs.some((c) => c.todo)) constructs.push('client-condition-uses-server');
    account(stats, todos, { todo: clientArgs.some((c) => c.todo), shim: true, constructs }, span);
    return {
      server: '',
      client: `actions.push({ op: "ui", method: ${JSON.stringify(choice.method)}, target: ${JSON.stringify(choice.target)}, args: [${clientArgs.map((a) => a.code).join(', ')}] });`,
    };
  }
  const mutate = inputMutation(e);
  if (mutate) {
    const values = mutate.method === 'insert' && e.kind === 'call' ? e.args.map((a) => expr(a, scope)) : [];
    const clientArgs = values.map((v) => clientExpr(v, scope));
    const constructs = values.flatMap((v) => v.constructs);
    if (clientArgs.some((c) => c.todo)) constructs.push('client-condition-uses-server');
    account(stats, todos, { todo: values.some((v) => v.todo) || clientArgs.some((c) => c.todo), shim: true, constructs }, span);
    const path = JSON.stringify(mutate.path);
    const server =
      mutate.method === 'clear'
        ? `shim.list.clear(shim.input.get(ctx, ${mutate.path.map((p) => JSON.stringify(p)).join(', ')}));`
        : `shim.input.insert(ctx, ${path}, ${values[0]?.code ?? 'null'});`;
    const client =
      mutate.method === 'clear'
        ? `actions.push({ op: "clear", targets: [${JSON.stringify(mutate.path.join('.'))}] });`
        : `actions.push({ op: "subform", method: "insert", target: ${path}, args: [${clientArgs.map((a) => a.code).join(', ')}] });`;
    return { server, client };
  }
  const v = expr(e, scope);
  account(stats, todos, v, span);
  // A mutating call on a local collection whose argument is server-fed puts
  // the real value on the server only. Mark the receiver server-bound and
  // drop its recorded binding (the binding holds only the pre-mutation
  // value): a later client read must become a counted manual item, not a
  // silent read of the client's stale empty collection. A later client
  // rebind clears the mark through the usual assignment path.
  if (v.serverOnly && e.kind === 'call' && e.callee.kind === 'member') {
    const receiver = memberPath(e.callee.object);
    if (
      receiver !== null &&
      COLLECTION_MUTATORS.has(canonicalBuiltin(e.callee.property).toLowerCase()) &&
      scope.local.has(receiver.root) &&
      !scope.query.has(receiver.root)
    ) {
      scope.serverOnly.add(receiver.root);
      scope.bindings.delete(receiver.root);
    }
  }
  const line = v.code.trim().endsWith(';') ? v.code : `${v.code};`;
  if (v.serverOnly) {
    taintServerMutated(e, scope);
    return { server: line, client: '' };
  }
  // client tasks are statements, not expr. A pure expr goes to both.
  return { server: line, client: line };
}

/**
 * `input.<subform>.clear()` empties the rows of an inline subform, and
 * `input.<subform>.insert(rows)` appends them (functions of the `input`
 * record, not the list value — a collection argument adds one row per
 * element). The client applies them to the grid: clear drops the body rows
 * and insert renders them.
 */
function inputMutation(e: Expr): { method: 'clear' | 'insert'; path: string[] } | null {
  if (e.kind !== 'call' || e.callee.kind !== 'member') return null;
  const method = canonicalBuiltin(e.callee.property);
  if (method !== 'clear' && method !== 'insert') return null;
  const path = memberPath(e.callee.object);
  if (!path || path.root !== 'input' || !path.path.length) return null;
  if (method === 'insert' && e.args.length !== 1) return null;
  return { method, path: path.path };
}

/**
 * `Field.select(v)`, `Field.deselect(v)`, `Field.selectAll()`,
 * `Field.deselectAll()` on a form field (a bare field name or `input.Field`),
 * not on a local variable. The target is the field path, as for `Field:ui.add`.
 */
function choiceTask(e: Expr, scope: Scope): { method: string; target: string[] } | null {
  if (e.kind !== 'call' || e.callee.kind !== 'member') return null;
  const method = dispatchGet(CHOICE_TASKS, e.callee.property.toLowerCase());
  if (!method) return null;
  const obj = e.callee.object;
  if (obj.kind === 'name') {
    if (scope.local.has(obj.name) || scope.row.has(obj.name)) return null;
    if (obj.name === 'input' || obj.name === 'zoho' || obj.name === 'thisapp') return null;
    return { method, target: [obj.name] };
  }
  const path = memberPath(obj);
  if (path && path.root === 'input' && path.path.length) return { method, target: path.path };
  return null;
}

function colonStmt(e: Extract<Expr, { kind: 'colonCall' }>, span: { start: number; end: number }, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  const args = e.args.map((a) => expr(a, scope));
  const obj = memberPath(e.object);
  const target = obj ? JSON.stringify(obj.root === 'input' || obj.root === 'row' ? obj.path : [obj.root, ...obj.path]) : expr(e.object, scope).code;
  const method = e.path.join('.');
  const ui = e.path[0] === 'ui';
  // A server read in a `:ui` argument (`row.Items:ui.add(fetched_list)`) is a prefetch slot, like a client condition.
  const clientArgs = ui ? args.map((a) => clientExpr(a, scope)) : [];
  const constructs = args.flatMap((a) => a.constructs);
  if (!ui) constructs.push(`colon:${method}`);
  if (clientArgs.some((c) => c.todo)) constructs.push('client-condition-uses-server');
  account(stats, todos, { todo: !ui || args.some((a) => a.todo) || clientArgs.some((c) => c.todo), shim: true, constructs }, span);
  if (!ui) {
    const line = `await shim.todo(ctx, ${JSON.stringify(`colon:${method}`)}, { start: ${span.start}, end: ${span.end} });`;
    return { server: line, client: '' };
  }
  return {
    server: '',
    client: `actions.push({ op: "ui", method: ${JSON.stringify(e.path.slice(1).join('.') || method)}, target: ${typeof target === 'string' && target.startsWith('[') ? target : `[${target}]`}, args: [${clientArgs.map((a) => a.code).join(', ')}] });`,
  };
}

function fnStmt(s: Extract<Stmt, { kind: 'fn' }>, scope: Scope, stats: TranslateStats, todos: TodoItem[]): Out {
  // An `alert` inside a function body is always unverified: callers are not
  // analysed, so it is never credited to or blamed on the enclosing event.
  const fnScope = { ...scope, local: new Set(scope.local), alertEvent: 'unverified' as AlertEventClass };
  for (const p of s.params) fnScope.local.add(p.name);
  const body = underFlow(fnScope, () => statement(s.body, fnScope, stats, todos));
  account(stats, todos, { todo: false, shim: false, constructs: [] }, s.span);
  const params = s.params.map((p) => jsIdent(p.name)).join(', ');
  const wrap = (inner: string) => `async function ${jsIdent(s.name)}(ctx, ${params}) {\n${indent(inner)}\n}`;
  return { server: wrap(body.server), client: body.client.trim() ? wrap(body.client) : '' };
}

function fieldsObj(entries: Param[], scope: Scope): Fx {
  const parts = entries.map((en) => {
    const v = expr(en.value, scope);
    return { key: en.key, v };
  });
  
  // Dedupe keys, keeping the last one
  const dedupedParts = [];
  const seen = new Set();
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!seen.has(parts[i].key)) {
      seen.add(parts[i].key);
      dedupedParts.unshift(parts[i]);
    }
  }

  const code = `{ ${dedupedParts.map((p) => `${JSON.stringify(p.key)}: ${p.v.code}`).join(', ')} }`;
  return mergeFx(code, parts.map((p) => p.v));
}

interface QueryBits {
  form: string;
  criteria: string;
  todo: boolean;
  constructs: string[];
}

function asQuery(target: Expr, scope: Scope): QueryBits {
  if (target.kind === 'criteria') {
    const form = staticName(target.object) ?? '';
    const c = criteria(target.criteria, scope);
    const constructs = [...c.constructs];
    if (!form) constructs.push('form-dynamic');
    let extra = '';
    if (target.sort) extra += '';
    return {
      form,
      criteria: c.code,
      todo: c.todo || !form,
      constructs,
    };
  }
  if (target.kind === 'name') {
    return { form: target.name, criteria: '{ op: "true" }', todo: false, constructs: [] };
  }
  return { form: '', criteria: '{ op: "todo", construct: "criteria-dynamic" }', todo: true, constructs: ['criteria-dynamic'] };
}

const COMPARE = new Set(['==', '!=', '<', '>', '<=', '>=', 'in', 'not in']);

/**
 * Report criteria (`show all rows from Form [ ... ]`) as a data filter.
 * A relative date is a marker (`{ __rel }`). The report function binds it in
 * the application time zone when the report is read. Unresolved text stays
 * `todo` so the read is denied rather than unfiltered.
 */
export function reportCriteria(src: string): Criteria {
  return criteriaValue(parseExpression(src, true));
}

function criteriaValue(e: Expr): Criteria {
  if (e.kind === 'paren') return criteriaValue(e.expr);
  if (e.kind === 'name' && e.name === 'true') return { op: 'true' };
  if (e.kind === 'binary' && (e.op === '&&' || e.op === 'and' || e.op === '||' || e.op === 'or')) {
    const op = e.op === '||' || e.op === 'or' ? 'or' : 'and';
    return { op, args: [criteriaValue(e.left), criteriaValue(e.right)] };
  }
  if (e.kind === 'binary' && (e.op === 'is' || e.op === 'is not')) {
    const rel = relativeRef(e.right);
    if (rel) {
      const field = literalField(e.left);
      // `is now` is not a day and not a period. `is this week` is the period window, not IS NULL.
      if (!field || rel.role === 'instant') return { op: 'todo', construct: 'criteria-dynamic' };
      return relativeMembership(e.op, field, rel.role === 'day' ? { spec: rel.spec, role: 'day' } : { spec: rel.spec, role: 'period' });
    }
    const field = literalField(e.left);
    if (!field) return { op: 'todo', construct: 'criteria-dynamic' };
    return { op: e.op === 'is' ? 'isNull' : 'notNull', field };
  }
  if (e.kind === 'unary' && (e.op === '!' || e.op === 'not')) {
    return { op: 'not', arg: criteriaValue(e.expr) };
  }
  if (e.kind === 'binary' && e.op === 'not in') {
    const field = literalField(e.left);
    const value = literalValue(e.right);
    if (!field || value === undefined) return { op: 'todo', construct: 'criteria-dynamic' };
    const inner = compareCriteria('in', field, value);
    if (inner.op === 'todo') return inner;
    return { op: 'not', arg: inner };
  }
  if (e.kind === 'binary') {
    const field = literalField(e.left);
    const op = e.op === '=' ? '==' : e.op;
    const rel = relativeRef(e.right);
    if (field && rel && COMPARE.has(op)) return relativeCompare(op, field, rel);
    const value = literalValue(e.right);
    if (!field || value === undefined || !COMPARE.has(op)) return { op: 'todo', construct: 'criteria-dynamic' };
    return compareCriteria(op, field, value);
  }
  if (e.kind === 'call' && e.callee.kind === 'member') {
    const field = literalField(e.callee.object);
    const arg = e.args[0] ? literalValue(e.args[0]) : undefined;
    if (!field || arg === undefined) return { op: 'todo', construct: 'criteria-dynamic' };
    return compareCriteria(e.callee.property, field, arg);
  }
  // A bare field name is Creator shorthand for `field == true`. A dotted
  // member path is not: no Creator vector covers a member bare term, so it
  // stays a coverage gap.
  const bare = e.kind === 'name' ? literalField(e) : null;
  if (bare) return { op: '==', field: bare, value: true };
  return { op: 'todo', construct: 'criteria-dynamic' };
}

/**
 * `today` / `zoho.currentdate` are a calendar day under `==` / `is` and midnight under `<` `>`.
 * `now` / `zoho.currenttime` are the current instant. `in this month` is a period.
 * A period under `<` or `==` stays untranslated: the read must not guess a window.
 */
function relativeCompare(op: string, field: string, rel: { spec: string; role: 'day' | 'instant' | 'period' }): Criteria {
  if (rel.role === 'period') {
    if (op !== 'in') return { op: 'todo', construct: 'criteria-dynamic' };
    return { op: 'in', field, value: { __rel: rel.spec } };
  }
  if (rel.role === 'instant') {
    if (op === 'in') return { op: 'todo', construct: 'criteria-dynamic' };
    return compareCriteria(op, field, { __rel: 'now' });
  }
  if (op === '==' || op === '!=') return compareCriteria(op, field, { __rel: rel.spec, day: true });
  if (op === 'in') return { op: 'in', field, value: { __rel: rel.spec, day: true } };
  if (op === '<' || op === '>' || op === '<=' || op === '>=') return compareCriteria(op, field, { __rel: rel.spec });
  return { op: 'todo', construct: 'criteria-dynamic' };
}

/**
 * `is today` is that calendar day. `is this week` / `is this month` is the same
 * half-open period as `in this week`. The read binds `{ __rel }` in the application time zone.
 */
function relativeMembership(op: 'is' | 'is not', field: string, rel: { spec: string; role: 'day' | 'period' }): Criteria {
  if (rel.role === 'day') return compareCriteria(op === 'is' ? '==' : '!=', field, { __rel: rel.spec, day: true });
  if (op === 'is') return { op: 'in', field, value: { __rel: rel.spec } };
  return { op: '!=', field, value: { __rel: rel.spec } };
}

function compareCriteria(op: string, field: string, value: unknown): Criteria {
  switch (op) {
    case '==':
    case '!=':
    case '<':
    case '>':
    case '<=':
    case '>=':
    case 'in':
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      return { op, field, value };
    case 'not in':
      return { op: 'not', arg: { op: 'in', field, value } };
    default:
      return { op: 'todo', construct: 'criteria-dynamic' };
  }
}

function literalField(e: Expr): string | null {
  const props: string[] = [];
  let cur: Expr = e;
  while (cur.kind === 'member') {
    props.push(cur.property);
    cur = cur.object;
  }
  if (cur.kind !== 'name') return null;
  if (cur.name === 'true' || cur.name === 'false' || cur.name === 'null') return null;
  if (cur.name === 'input' || cur.name === 'old' || cur.name === 'zoho' || cur.name === 'thisapp' || cur.name === 'row') return null;
  return [cur.name, ...props.reverse()].join('.');
}

function unsafeInteger(text: string): boolean {
  return /^\d+$/.test(text) && !Number.isSafeInteger(Number(text));
}

function literalValue(e: Expr): unknown | undefined {
  if (e.kind === 'string') return e.value;
  // An integer past 2^53 (a 19-digit Creator id) stays its digits; Number() would round it.
  if (e.kind === 'number') return /[.]|[eE]/.test(e.text) ? e.text : unsafeInteger(e.text) ? e.text : Number(e.text);
  if (e.kind === 'name') {
    if (e.name === 'true') return true;
    if (e.name === 'false') return false;
    if (e.name === 'null') return null;
    return undefined;
  }
  if (e.kind === 'member') {
    const path = memberPath(e);
    const head = path?.path[0]?.toLowerCase();
    if (path?.root === 'zoho' && path.path.length === 1 && head === 'loginuser') return { __bind: 'loginUser' };
    if (path?.root === 'zoho' && path.path.length === 1 && head === 'loginuserid') return { __bind: 'loginUserId' };
  }
  if (e.kind === 'list') {
    const items: unknown[] = [];
    for (const el of e.elements) {
      const value = literalValue(el);
      if (value === undefined) return undefined;
      items.push(value);
    }
    return items;
  }
  return undefined;
}

function criteria(e: Expr, scope: Scope): Fx {
  if (e.kind === 'paren') return criteria(e.expr, scope);
  if (e.kind === 'name' && e.name === 'true') return fx({ code: '{ op: "true" }' });
  if (e.kind === 'binary' && (e.op === '&&' || e.op === 'and' || e.op === '||' || e.op === 'or')) {
    const l = criteria(e.left, scope);
    const r = criteria(e.right, scope);
    const op = e.op === '||' || e.op === 'or' ? 'or' : 'and';
    return mergeFx(`{ op: ${JSON.stringify(op)}, args: [${l.code}, ${r.code}] }`, [l, r]);
  }
  if (e.kind === 'binary' && (e.op === 'is' || e.op === 'is not')) {
    const rel = relativeRef(e.right);
    // `is today` and `is this week` are markers. The query binds them. `is now` stays IS NULL.
    if (rel && rel.role !== 'instant') {
      const field = fieldPath(e.left, scope);
      if (!field) return fx({ code: '{ op: "todo", construct: "criteria-dynamic" }', todo: true, constructs: ['criteria-dynamic'] });
      return fx({ code: JSON.stringify(relativeMembership(e.op, field, rel.role === 'day' ? { spec: rel.spec, role: 'day' } : { spec: rel.spec, role: 'period' })) });
    }
    const field = fieldPath(e.left, scope);
    if (!field) return fx({ code: '{ op: "todo", construct: "criteria-dynamic" }', todo: true, constructs: ['criteria-dynamic'] });
    const op = e.op === 'is' ? 'isNull' : 'notNull';
    return fx({ code: `{ op: ${JSON.stringify(op)}, field: ${JSON.stringify(field)} }` });
  }
  if (e.kind === 'binary' && e.op === 'not in') {
    // `Field not in list` — the negated membership test, not a dynamic leaf.
    const field = fieldPath(e.left, scope);
    const right = expr(e.right, scope);
    if (!field) return mergeFx('{ op: "todo", construct: "criteria-dynamic" }', [right], { todo: true, constructs: ['criteria-dynamic'] });
    return mergeFx(`{ op: "not", arg: { op: "in", field: ${JSON.stringify(field)}, value: ${right.code} } }`, [right]);
  }
  if (e.kind === 'binary') {
    const field = fieldPath(e.left, scope);
    const right = expr(e.right, scope);
    if (!field) return mergeFx('{ op: "todo", construct: "criteria-dynamic" }', [right], { todo: true, constructs: ['criteria-dynamic'] });
    const op = e.op === '=' ? '==' : e.op;
    return mergeFx(`{ op: ${JSON.stringify(op)}, field: ${JSON.stringify(field)}, value: ${right.code} }`, [right]);
  }
  if (e.kind === 'call' && e.callee.kind === 'member') {
    const field = fieldPath(e.callee.object, scope);
    const method = e.callee.property;
    const arg = e.args[0] ? expr(e.args[0], scope) : undefined;
    if (field && arg) {
      return mergeFx(`{ op: ${JSON.stringify(method)}, field: ${JSON.stringify(field)}, value: ${arg.code} }`, [arg]);
    }
  }
  if (e.kind === 'unary' && (e.op === '!' || e.op === 'not')) {
    const inner = criteria(e.expr, scope);
    return mergeFx(`{ op: "not", arg: ${inner.code} }`, [inner]);
  }
  // A bare field name in criteria is Creator shorthand for `field == true`.
  // A dotted member path is not: no Creator vector covers a member bare term,
  // so it stays a criteria-dynamic coverage gap.
  if (e.kind === 'name') {
    const field = fieldPath(e, scope);
    if (field) return fx({ code: `{ op: "==", field: ${JSON.stringify(field)}, value: true }` });
  }
  return fx({ code: '{ op: "todo", construct: "criteria-dynamic" }', todo: true, constructs: ['criteria-dynamic'] });
}

function fieldPath(e: Expr, scope: Scope): string | null {
  const props: string[] = [];
  let cur: Expr = e;
  while (cur.kind === 'member') {
    props.push(cur.property);
    cur = cur.object;
  }
  if (cur.kind !== 'name') return null;
  if (scope.local.has(cur.name) || cur.name === 'true' || cur.name === 'false' || cur.name === 'null') return null;
  if (cur.name === 'input' || cur.name === 'old' || cur.name === 'zoho' || cur.name === 'thisapp' || cur.name === 'row') return null;
  return [cur.name, ...props.reverse()].join('.');
}

function staticName(e: Expr): string | null {
  const props: string[] = [];
  let cur: Expr = e;
  while (cur.kind === 'member') {
    props.push(cur.property);
    cur = cur.object;
  }
  if (cur.kind !== 'name') return null;
  return [cur.name, ...props.reverse()].join('.');
}


function tryApplyDuration(baseCode: string, durCode: string, ctxArg = 'ctx'): string | null {
  const m = /^shim\.date\.parse\((["'])([^"']+)\1, ctx\)$/.exec(durCode);
  if (!m) return null;
  const str = m[2];
  if (!/^(-?\d+[WDHMS])(:-?\d+[WDHMS])*$/.test(str)) return null;
  const parts = str.split(':');
  let w = 0, d = 0, h = 0, min = 0, s = 0;
  for (const part of parts) {
    const val = parseInt(part.slice(0, -1), 10);
    const unit = part.slice(-1);
    if (unit === 'W') w += val;
    else if (unit === 'D') d += val;
    else if (unit === 'H') h += val;
    else if (unit === 'M') min += val;
    else if (unit === 'S') s += val;
  }
  let res = baseCode;
  const days = w * 7 + d;
  if (days !== 0) res = `shim.date.addDay(${res}, ${days}, ${ctxArg})`;
  if (h !== 0) res = `shim.date.addHour(${res}, ${h}, ${ctxArg})`;
  if (min !== 0) res = `shim.date.addMinutes(${res}, ${min}, ${ctxArg})`;
  if (s !== 0) res = `shim.date.addSeconds(${res}, ${s}, ${ctxArg})`;
  if (days === 0 && h === 0 && min === 0 && s === 0) {
    res = `shim.date.addDay(${res}, 0, ${ctxArg})`;
  }
  return res;
}

/**
 * `expr()` is recursive. Real scripts stay far under this (the parser's own
 * cap is 200). Left-associative `+` chains and `.get()` chains are folded in
 * loops, so they do not consume a frame per operand. Anything still deeper
 * becomes a todo instead of throwing RangeError.
 */
const EXPR_STACK_LIMIT = 400;

function tooDeepExpr(): Fx {
  return fx({
    code: 'await shim.todo(ctx, "too-deeply-nested")',
    todo: true,
    shim: true,
    constructs: ['too-deeply-nested'],
  });
}

function expr(e: Expr, scope: Scope): Fx {
  const depth = scope.exprDepth + 1;
  if (depth > EXPR_STACK_LIMIT) return tooDeepExpr();
  scope.exprDepth = depth;
  try {
    return exprBody(e, scope);
  } finally {
    scope.exprDepth = depth - 1;
  }
}

function exprBody(e: Expr, scope: Scope): Fx {
  switch (e.kind) {
    case 'number':
      if (/[.]|[eE]/.test(e.text)) return fx({ code: `shim.decimal.from(${JSON.stringify(e.text)})`, shim: true, decimal: true });
      // A Deluge NUMBER is a 64-bit long. Past 2^53 a JS number literal rounds, so emit a bigint.
      return fx({ code: unsafeInteger(e.text) ? `${e.text}n` : e.text });
    case 'string':
      return fx({ code: JSON.stringify(e.value), text: true });
    case 'date':
      return fx({ code: `shim.date.parse(${JSON.stringify(e.value)}, ctx)`, shim: true, date: true });
    case 'name':
      return nameExpr(e.name, scope);
    case 'list': {
      const els = e.elements.map((x) => expr(x, scope));
      return mergeFx(`[${els.map((x) => x.code).join(', ')}]`, els, { list: true });
    }
    case 'map': {
      const parts = e.entries.map((en) => ({ k: expr(en.key, scope), v: expr(en.value, scope) }));
      return mergeFx(`{ ${parts.map((p) => `[${p.k.code}]: ${p.v.code}`).join(', ')} }`, parts.flatMap((p) => [p.k, p.v]), { map: true });
    }
    case 'unary': {
      const inner = expr(e.expr, scope);
      const op = e.op === 'not' ? '!' : e.op;
      if (op === '-' && inner.decimal) {
        return mergeFx(`shim.decimal.sub("0", ${inner.code})`, [inner], { shim: true, decimal: true });
      }
      if (op === '+' && inner.decimal) return mergeFx(inner.code, [inner], { decimal: true });
      const raw = mergeFx(`(${op}${inner.code})`, [inner]);
      if (op === '-') auditArithmetic(op, e.expr, undefined, raw, scope);
      return raw;
    }
    case 'binary':
      return binaryExpr(e, scope);
    case 'paren':
      return expr(e.expr, scope);
    case 'ifExpr': {
      const t = expr(e.test, scope);
      const a = expr(e.then, scope);
      const b = e.else ? expr(e.else, scope) : fx({ code: 'null' });
      return mergeFx(`(${t.code} ? ${a.code} : ${b.code})`, [t, a, b], { decimal: a.decimal || b.decimal });
    }
    case 'member':
      return memberExpr(e, scope);
    case 'call':
      return callExpr(e, scope);
    case 'index': {
      // `Form[Flag]` / `Form[!Flag]` on a form name is a criteria: a bare
      // field name is Creator shorthand for `Flag == true`. The parser cannot
      // tell it from an index without knowing the form names. A bare name
      // only folds when it is a declared field of the form — a local or an
      // undeclared name keeps real index semantics.
      if (
        e.object.kind === 'name' &&
        scope.formNames.has(e.object.name) &&
        !scope.local.has(e.object.name) &&
        (e.index.kind !== 'name' ||
          (fieldPath(e.index, scope) && scope.formFields.get(e.object.name)?.has(e.index.name)))
      ) {
        return criteriaExpr({ kind: 'criteria', object: e.object, criteria: e.index, span: e.span }, scope);
      }
      // `input["f"]` / `old["f"]` with a string-literal key read like the
      // member form: the record getter walks own keys under the same key
      // guard, keeps the `input.ID` rule, and stays the shape criteria
      // compilation recognises. Any other key expression stays a guarded
      // generic index read — the record root is still visible in the emitted
      // code, so a criteria compiler cannot enumerate the field and fails
      // closed exactly like a computed key did before.
      if (e.object.kind === 'name' && (e.object.name === 'input' || e.object.name === 'old') && e.index.kind === 'string') {
        const api = e.object.name === 'input' ? 'shim.input.get' : 'shim.old.get';
        return fx({
          code: `${api}(ctx, ${JSON.stringify(e.index.value)})`,
          shim: true,
          decimal: decimalLeaf([e.index.value], scope),
          lookup: e.object.name === 'input' && scope.lookupFields.has(e.index.value),
        });
      }
      const o = expr(e.object, scope);
      const i = expr(e.index, scope);
      // A TODO is not a collection. Indexing it throws at runtime.
      if (o.todo) return untranslatedMethod('index', o, [i]);
      // Every index read is own-only through the shim: a computed `__proto__`,
      // `constructor`, or `prototype` key must never hand back the shared
      // prototype (or a function) for a later write.
      return mergeFx(`shim.get(${o.code}, ${i.code})`, [o, i], { shim: true });
    }
    case 'criteria':
      return criteriaExpr(e, scope);
    case 'insert': {
      const fields = fieldsObj(e.entries, scope);
      const form = staticName(e.form) ?? '';
      const constructs = [...fields.constructs];
      if (!form) constructs.push('form-dynamic');
      return mergeFx(`await shim.datastore.insert(ctx, ${JSON.stringify(form)}, ${fields.code})`, [fields], {
        shim: true,
        serverOnly: true,
        sideEffect: true,
        todo: fields.todo || !form,
        constructs,
      });
    }
    case 'sendmail':
      return mailOrHttp('mail', 'send', e.entries, scope);
    case 'pushnotification': {
      // The Creator push-notification task targets the mobile app's
      // Notifications tab (deluge-docs/pages/deluge/help/pushnotify-using-deluge.html);
      // no Catalyst-side equivalent exists, so it stays a named manual item.
      return fx({
        code: `await shim.todo(ctx, "pushnotification")`,
        todo: true,
        shim: true,
        constructs: ['pushnotification'],
      });
    }
    case 'mailAttachments':
      return mailAttachmentsFx(e, scope);
    case 'invokeurl':
      return mailOrHttp('http', 'invokeurl', e.entries, scope);
    case 'colonCall': {
      // expression-position colon call is reported; statements are handled in colonStmt
      return fx({
        code: `await shim.todo(ctx, ${JSON.stringify('colon:' + e.path.join('.'))})`,
        todo: true,
        shim: true,
        constructs: [`colon:${e.path.join('.')}`],
      });
    }
    case 'relative':
      // A criteria bracket compiles the phrase itself. A free expression does not.
      return fx({
        code: `await shim.todo(ctx, "criteria-dynamic")`,
        todo: true,
        shim: true,
        constructs: ['criteria-dynamic'],
      });
    case 'unknown':
      return fx({
        code: `await shim.todo(ctx, ${JSON.stringify(taskConstruct(e.text, e.reason))})`,
        todo: true,
        shim: true,
        constructs: [taskConstruct(e.text, e.reason)],
      });
    default: {
      const never: never = e;
      return never;
    }
  }
}

/**
 * A name read carries the binding's app-function flag so a later prefetch
 * refuses the call. It does not carry `todo`: an untranslated binding is still
 * a local, and a method on it keeps its own translation. A loop variable does
 * not carry a binding from before the loop.
 */
function carriedFlags(name: string, scope: Scope): { appFunction: boolean } {
  if (scope.clientData.has(name) || scope.elementVars.has(name)) return { appFunction: false };
  const binding = scope.bindings.get(name);
  return { appFunction: !!binding?.appFunction };
}

function nameExpr(name: string, scope: Scope): Fx {
  return applyBindingFlags(name, scope, readName(name, scope));
}

/**
 * A local inherits an app-function binding, so a name bound to `thisapp` is
 * refused like the call. `todo` stays on the binding: copying it onto the name
 * would turn a later method (`toString`) or a server-only loop into a second
 * nameless todo. The row-map walk reads `binding.todo` itself. A declared
 * function still assigns its counted placeholder on the client.
 */
function applyBindingFlags(name: string, scope: Scope, value: Fx): Fx {
  const binding = scope.bindings.get(name);
  if (!binding?.appFunction) return value;
  return fx({
    ...value,
    appFunction: true,
    clientReady: value.clientReady,
  });
}

function readName(name: string, scope: Scope): Fx {
  if (name === 'true' || name === 'false' || name === 'null') return fx({ code: name });
  if (name === 'input') return fx({ code: 'shim.input.root(ctx)', shim: true });
  if (name === 'old') return fx({ code: 'ctx.old', shim: true });
  const reads = localReads(name, scope);
  const onClient = scope.clientData.has(name);
  const carried = carriedFlags(name, scope);
  if (scope.serverOnly.has(name) && scope.query.has(name)) {
    return fx({ code: jsIdent(name), query: true, serverOnly: true, shim: true, reads, clientReady: onClient, ...carried });
  }
  if (scope.query.has(name)) return fx({ code: jsIdent(name), query: true, serverOnly: true, shim: true, reads, clientReady: onClient, ...carried });
  if (scope.list.has(name)) return fx({ code: jsIdent(name), list: true, reads, serverOnly: scope.serverOnly.has(name), clientReady: onClient || !scope.serverOnly.has(name), ...carried });
  if (scope.map.has(name)) return fx({ code: jsIdent(name), map: true, reads, serverOnly: scope.serverOnly.has(name), clientReady: onClient || !scope.serverOnly.has(name), ...carried });
  if (scope.date.has(name)) return fx({ code: jsIdent(name), date: true, reads, serverOnly: scope.serverOnly.has(name), clientReady: onClient || !scope.serverOnly.has(name), ...carried });
  if (scope.decimal.has(name)) return fx({ code: jsIdent(name), decimal: true, reads, serverOnly: scope.serverOnly.has(name), clientReady: onClient || !scope.serverOnly.has(name), ...carried });
  if (scope.row.has(name)) return fx({ code: jsIdent(name), shim: true, reads, serverOnly: scope.serverOnly.has(name), clientReady: onClient || !scope.serverOnly.has(name), ...carried });
  if (scope.serverOnly.has(name)) return fx({ code: jsIdent(name), serverOnly: true, shim: true, reads, clientReady: onClient, ...carried });
  const alias = rowAliasOf(name, scope);
  if (alias) return nameExpr(alias, scope);
  if (!scope.local.has(name) && scope.rowFields?.names.has(name) && scope.row.has(scope.rowFields.row)) {
    const row = scope.rowFields.row;
    const serverOnly = scope.serverOnly.has(row);
    return fx({
      code: `shim.record.get(${jsIdent(row)}, ${JSON.stringify(name)})`,
      shim: true,
      serverOnly,
      reads: [row],
      clientReady: scope.clientData.has(row) || !serverOnly,
    });
  }
  if (!scope.local.has(name) && scope.inputFields.has(name)) {
    return fx({
      code: `shim.input.get(ctx, ${JSON.stringify(name)})`,
      shim: true,
      decimal: scope.decimalFields.has(name),
      lookup: scope.lookupFields.has(name),
    });
  }
  if (!scope.local.has(name) && name === 'REMOVE_ALL') {
    // The `:ui.deselect(REMOVE_ALL)` constant: every choice comes off.
    return fx({ code: '"REMOVE_ALL"' });
  }
  if (!scope.local.has(name) && name.toLowerCase() === 'today') {
    // Deluge `today` is the current date with the time at 00:00:00 in the
    // app time zone: deluge-docs/pages/functions__datetime__today.html,
    // https://www.zoho.com/deluge/help/functions/datetime/today.html.
    // That is `zoho.currentdate`; a local named `today` still wins.
    return fx({ code: 'shim.zoho.currentDate(ctx)', shim: true, date: true });
  }
  if (!scope.local.has(name) && (name.toLowerCase() === 'yesterday' || name.toLowerCase() === 'tomorrow')) {
    // Same day arithmetic as `today +/- 1`: a date with the time at 00:00:00
    // in the app time zone. A local named `yesterday`/`tomorrow` still wins.
    const shift = name.toLowerCase() === 'yesterday' ? -1 : 1;
    return fx({ code: `shim.date.addDay(shim.zoho.currentDate(ctx), ${shift}, ctx)`, shim: true, date: true });
  }
  if (!scope.local.has(name)) {
    const system = systemField(name);
    if (system) {
      return fx({
        code: `shim.record.system(ctx.record, ${JSON.stringify(system.name)})`,
        shim: true,
        date: system.date,
      });
    }
  }
  if (!scope.local.has(name) && scope.formNames.has(name)) {
    // A bare form link name is the form's full collection:
    // `for each r in Form` and `Form.count()` iterate every record.
    return fx({
      code: `shim.datastore.query(ctx, ${JSON.stringify(name)}, { op: "true" })`,
      shim: true,
      serverOnly: true,
      query: true,
    });
  }
  // A name with no local binding — bound later, bound only inside a branch,
  // or never bound at all — is still read. It is server-only, so the client
  // does not emit a dangling identifier, and it is marked unbound so a binding
  // that records it is never replayed. A `prefetchBound` name (a function
  // parameter, the subform `row`) is bound in the prefetch module.
  if (reads.length === 0 && !scope.prefetchBound.has(name) && name !== 'row') {
    return fx({ code: jsIdent(name), serverOnly: true, shim: true, reads: [name], unboundReads: [name] });
  }
  return fx({ code: jsIdent(name), reads, ...carriedFlags(name, scope) });
}

/** Creator system columns. Not form fields, so a bare name is not `input.<field>`. */
const SYSTEM_FIELDS: { name: string; date: boolean }[] = [
  { name: 'Added_User', date: false },
  { name: 'Modified_User', date: false },
  { name: 'Added_Time', date: true },
  { name: 'Modified_Time', date: true },
];

function systemField(name: string): { name: string; date: boolean } | null {
  const lower = name.toLowerCase();
  return SYSTEM_FIELDS.find((item) => item.name.toLowerCase() === lower) ?? null;
}

const RELATIVE_DAY = new Set(['today', 'tomorrow', 'yesterday']);

function relativeDay(e: Expr): string | null {
  if (e.kind === 'name' && RELATIVE_DAY.has(e.name.toLowerCase())) return e.name.toLowerCase();
  return null;
}

/** Right-hand side of a report comparison. `null` means a static literal (or something else). */
function relativeRef(e: Expr): { spec: string; role: 'day' | 'instant' | 'period' } | null {
  if (e.kind === 'relative') return { spec: e.spec, role: 'period' };
  if (e.kind === 'name') {
    const folded = e.name.toLowerCase();
    if (RELATIVE_DAY.has(folded)) return { spec: folded, role: 'day' };
    if (folded === 'now') return { spec: 'now', role: 'instant' };
  }
  if (e.kind === 'member') {
    const path = memberPath(e);
    const head = path?.path[0]?.toLowerCase();
    if (path?.root.toLowerCase() === 'zoho' && path.path.length === 1 && head === 'currentdate') return { spec: 'today', role: 'day' };
    if (path?.root.toLowerCase() === 'zoho' && path.path.length === 1 && head === 'currenttime') return { spec: 'now', role: 'instant' };
  }
  return null;
}

function binaryExpr(e: Extract<Expr, { kind: 'binary' }>, scope: Scope): Fx {
  // Left-associative chains (`a + a + …`) are a left spine. Walk it in a loop
  // so a 10k-term sum does not recurse once per operand.
  const spine: Array<Extract<Expr, { kind: 'binary' }>> = [];
  let cur: Expr = e;
  while (cur.kind === 'binary') {
    spine.push(cur);
    cur = cur.left;
  }
  let left = expr(cur, scope);
  for (let i = spine.length - 1; i >= 0; i--) {
    const node = spine[i]!;
    const day = node.op === 'is' || node.op === 'is not' ? relativeDay(node.right) : null;
    if (day) {
      const call = `shim.date.isDay(${left.code}, ${JSON.stringify(day)}, ctx)`;
      left = mergeFx(node.op === 'is not' ? `(!${call})` : call, [left], { shim: true });
      continue;
    }
    const right = expr(node.right, scope);
    const out = binary(node.op, left, right);
    auditArithmetic(node.op, node.left, node.right, out, scope);
    left = out;
  }
  return left;
}

/** Arithmetic ops; `+` on text is concatenation, not arithmetic. */
const ARITHMETIC = new Set(['+', '-', '*', '/']);

function hasText(e: Expr): boolean {
  const stack: Expr[] = [e];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.kind === 'string') return true;
    if (n.kind === 'paren') stack.push(n.expr);
    else if (n.kind === 'binary' && n.op === '+') {
      stack.push(n.left);
      stack.push(n.right);
    }
  }
  return false;
}

/** True when `e` reads a decimal, currency, or percent field or a decimal local. Audit only. */
function mentionsDecimal(e: Expr, scope: Scope): boolean {
  const stack: Expr[] = [e];
  while (stack.length > 0) {
    const n = stack.pop()!;
    switch (n.kind) {
      case 'number':
        if (/[.]|[eE]/.test(n.text)) return true;
        break;
      case 'name':
        if (scope.local.has(n.name) ? scope.decimal.has(n.name) : scope.decimalFields.has(n.name) || scope.decimal.has(n.name)) return true;
        break;
      case 'member':
        if (scope.decimalFields.has(n.property)) return true;
        break;
      case 'call':
        if (n.callee.kind === 'member' && n.callee.property === 'get' && n.args[0]?.kind === 'string') {
          if (scope.decimalFields.has(n.args[0].value)) return true;
        } else if (n.callee.kind === 'name' && n.callee.name === 'toDecimal') {
          return true;
        } else if (n.callee.kind === 'name' && n.callee.name === IFNULL_FUNCTION) {
          for (const a of n.args) stack.push(a);
        }
        break;
      case 'paren':
        stack.push(n.expr);
        break;
      case 'unary':
        stack.push(n.expr);
        break;
      case 'binary':
        if (ARITHMETIC.has(n.op)) {
          stack.push(n.left);
          stack.push(n.right);
        }
        break;
      case 'ifExpr':
        stack.push(n.then);
        if (n.else) stack.push(n.else);
        break;
      default:
        break;
    }
  }
  return false;
}

/** Records a raw JS arithmetic op on a decimal operand (see audit.ts). No effect on output. */
function auditArithmetic(op: string, left: Expr, right: Expr | undefined, out: Fx, scope: Scope): void {
  const sink = decimalAuditSink();
  if (!sink || !ARITHMETIC.has(op) || out.code.startsWith('shim.')) return;
  if (op === '+' && (hasText(left) || (right && hasText(right)))) return;
  if (!mentionsDecimal(left, scope) && !(right && mentionsDecimal(right, scope))) return;
  sink.arithmetic.push({ op, code: out.code });
}

/**
 * Every name a bare identifier reads — including one not bound yet. `a = b`
 * before `b` is assigned still records `b`, so a later `b = sendmail[...]` is
 * visible to the read-chain walks instead of slipping through as an empty
 * read list.
 */
function localReads(name: string, scope: Scope): string[] {
  if (
    scope.local.has(name) ||
    scope.serverOnly.has(name) ||
    scope.query.has(name) ||
    scope.list.has(name) ||
    scope.map.has(name) ||
    scope.row.has(name) ||
    scope.date.has(name) ||
    scope.decimal.has(name)
  ) {
    return [name];
  }
  return [];
}

function decimalLeaf(path: readonly string[], scope: Scope): boolean {
  const leaf = path[path.length - 1];
  return !!leaf && scope.decimalFields.has(leaf);
}

function memberPath(e: Expr): { root: string; path: string[] } | null {
  const path: string[] = [];
  let cur: Expr = e;
  while (cur.kind === 'member') {
    path.unshift(cur.property);
    cur = cur.object;
  }
  if (cur.kind === 'name') return { root: cur.name, path };
  return null;
}

function rootName(e: Expr): string | null {
  let cur: Expr = e;
  for (;;) {
    if (cur.kind === 'name') return cur.name;
    if (cur.kind === 'member') cur = cur.object;
    else if (cur.kind === 'call') cur = cur.callee;
    else if (cur.kind === 'criteria') cur = cur.object;
    else return null;
  }
}

/** The row binding a form link name stands for, when it is not shadowed by a local. */
function rowAliasOf(name: string, scope: Scope): string | null {
  const alias = scope.rowAlias;
  if (!alias || alias.name !== name || scope.local.has(name) || !scope.row.has(alias.row)) return null;
  return alias.row;
}

/** memberPath with a row alias (a collection function's form name) resolved to its row binding. */
function aliasedPath(e: Expr, scope: Scope): { root: string; path: string[] } | null {
  const path = memberPath(e);
  const row = path ? rowAliasOf(path.root, scope) : null;
  return path && row ? { ...path, root: row } : path;
}

function rowMember(e: Expr, scope: Scope): { rowName: string; field: string } | null {
  while (e.kind === 'paren') e = e.expr;
  if (e.kind === 'member' && e.object.kind === 'name') {
    const rowName = rowAliasOf(e.object.name, scope) ?? e.object.name;
    if (scope.row.has(rowName) || scope.clientData.has(rowName)) {
      return { rowName, field: e.property };
    }
  }
  return null;
}

/**
 * The `Key == row.Field` (or `Key == <scalar loop element>`) equality leaf of a
 * criteria conjunction, plus the emitted criteria for the remaining conjuncts.
 * `extra` is the static conjuncts folded into the batched query; `rowRest` is
 * the row-dependent ones (a second keyed leaf included) applied per row by
 * `shim.datastore.matches`. Null when there is no keyed leaf, a remaining
 * conjunct is dynamic, or the query sorts or ranges.
 */
function splitRowCriteria(
  e: Expr,
  scope: Scope,
): { keyField: string; rowName: string; rowKeyField: string; rowScalar?: boolean; extra?: string; rowRest?: string; rowDeps?: string[] } | null {
  const leaves: Expr[] = [];
  const flat = (x: Expr): void => {
    let c = x;
    while (c.kind === 'paren') c = c.expr;
    if (c.kind === 'binary' && (c.op === '&&' || c.op === 'and')) {
      flat(c.left);
      flat(c.right);
      return;
    }
    leaves.push(c);
  };
  flat(e);
  let keyed: { keyField: string; rowName: string; rowKeyField: string; rowScalar?: boolean } | null = null;
  const staticParts: string[] = [];
  const rowParts: string[] = [];
  const rowDeps = new Set<string>();
  for (const leaf of leaves) {
    const hit = rowKeyLeaf(leaf, scope);
    if (hit && !keyed) {
      keyed = hit;
      continue;
    }
    const c = criteria(leaf, scope);
    if (c.todo) return null;
    if (c.reads.some((n) => scope.clientData.has(n) || scope.row.has(n))) {
      rowParts.push(c.code);
      for (const n of c.reads) rowDeps.add(n);
    } else {
      staticParts.push(c.code);
    }
  }
  if (!keyed) return null;
  const extra =
    staticParts.length === 1 ? staticParts[0]! : staticParts.length ? `{ op: "and", args: [${staticParts.join(', ')}] }` : undefined;
  const rowRest =
    rowParts.length === 1 ? rowParts[0]! : rowParts.length ? `{ op: "and", args: [${rowParts.join(', ')}] }` : undefined;
  return { ...keyed, extra, rowRest, rowDeps: rowDeps.size ? [...rowDeps].sort() : undefined };
}

function rowKeyLeaf(e: Expr, scope: Scope): { keyField: string; rowName: string; rowKeyField: string; rowScalar?: boolean } | null {
  if (e.kind !== 'binary' || (e.op !== '==' && e.op !== '=')) return null;
  const leftRow = rowMember(e.left, scope);
  const rightRow = rowMember(e.right, scope);
  if (leftRow && !rightRow) {
    let r = e.right;
    while (r.kind === 'paren') r = r.expr;
    const kf = fieldPath(r, scope);
    if (kf && !kf.includes('.')) return { keyField: kf, rowName: leftRow.rowName, rowKeyField: leftRow.field };
  } else if (rightRow && !leftRow) {
    let l = e.left;
    while (l.kind === 'paren') l = l.expr;
    const kf = fieldPath(l, scope);
    if (kf && !kf.includes('.')) return { keyField: kf, rowName: rightRow.rowName, rowKeyField: rightRow.field };
  }
  // `Field == <scalar loop element>`: `for each eachDate in weekDates` keys a
  // fetch by the element itself (`Log_Date = eachDate`).
  if (!leftRow && !rightRow) {
    const scalar = (x: Expr): string | null => {
      let n = x;
      while (n.kind === 'paren') n = n.expr;
      return n.kind === 'name' && scope.clientData.has(n.name) ? n.name : null;
    };
    const rightScalar = scalar(e.right);
    const leftScalar = scalar(e.left);
    if (rightScalar && !leftScalar) {
      const kf = fieldPath(e.left, scope);
      if (kf && !kf.includes('.')) return { keyField: kf, rowName: rightScalar, rowKeyField: '', rowScalar: true };
    } else if (leftScalar && !rightScalar) {
      const kf = fieldPath(e.right, scope);
      if (kf && !kf.includes('.')) return { keyField: kf, rowName: leftScalar, rowKeyField: '', rowScalar: true };
    }
  }
  return null;
}

/** The batched read for `Form[Key == row.F && ...].Target`, when the criteria is row-keyed. */
function fieldRowRead(objExpr: Expr, targetField: string, call: string, scope: Scope): RowRead[] {
  if (objExpr.kind !== 'criteria' || objExpr.sort || objExpr.range) return [];
  const form = staticName(objExpr.object);
  const keyed = form ? splitRowCriteria(objExpr.criteria, scope) : null;
  if (!form || !keyed) return [];
  return [
    {
      kind: 'field',
      call,
      form,
      keyField: keyed.keyField,
      rowName: keyed.rowName,
      rowKeyField: keyed.rowKeyField,
      rowScalar: keyed.rowScalar,
      targetField,
      extra: keyed.extra,
      rowRest: keyed.rowRest,
      rowDeps: keyed.rowDeps,
      noMatch: 'null',
    },
  ];
}

/** The batched read for `for each x in Form[Key == row.F && ...]`, when the criteria is row-keyed. */
function rowsRowRead(collection: Expr, call: string, scope: Scope): RowRead[] {
  if (collection.kind !== 'criteria' || collection.sort || collection.range) return [];
  const form = staticName(collection.object);
  const keyed = form ? splitRowCriteria(collection.criteria, scope) : null;
  if (!form || !keyed) return [];
  return [
    {
      kind: 'rows',
      call,
      form,
      keyField: keyed.keyField,
      rowName: keyed.rowName,
      rowKeyField: keyed.rowKeyField,
      rowScalar: keyed.rowScalar,
      extra: keyed.extra,
      rowRest: keyed.rowRest,
      rowDeps: keyed.rowDeps,
      noMatch: '[]',
    },
  ];
}

/** The batched read for `Form[Key == row.F && ...].fn(field)`, when the criteria is row-keyed. */
function aggregateRowRead(objAst: Expr, fn: string, field: string, call: string, scope: Scope): RowRead[] {
  if (objAst.kind !== 'criteria' || objAst.sort || objAst.range) return [];
  const form = staticName(objAst.object);
  const keyed = form ? splitRowCriteria(objAst.criteria, scope) : null;
  if (!form || !keyed) return [];
  const noMatch = fn === 'count' ? '0' : fn === 'distinct' ? '[]' : 'null';
  return [
    {
      kind: 'aggregate',
      call,
      form,
      keyField: keyed.keyField,
      rowName: keyed.rowName,
      rowKeyField: keyed.rowKeyField,
      fn,
      field,
      rowScalar: keyed.rowScalar,
      extra: keyed.extra,
      rowRest: keyed.rowRest,
      rowDeps: keyed.rowDeps,
      noMatch,
    },
  ];
}

function simpleKeyLookup(objExpr: Expr, targetField: string, scope: Scope): SimpleKeyLookup | undefined {
  if (objExpr.kind !== 'criteria') return undefined;
  if (objExpr.sort || objExpr.range) return undefined;
  const form = staticName(objExpr.object);
  if (!form) return undefined;
  let c: Expr = objExpr.criteria;
  while (c.kind === 'paren') c = c.expr;
  if (c.kind !== 'binary' || (c.op !== '==' && c.op !== '=')) return undefined;

  const leftRow = rowMember(c.left, scope);
  const rightRow = rowMember(c.right, scope);

  if (leftRow && !rightRow) {
    let r = c.right;
    while (r.kind === 'paren') r = r.expr;
    const kf = fieldPath(r, scope);
    if (kf && !kf.includes('.')) {
      return {
        form,
        keyField: kf,
        rowName: leftRow.rowName,
        rowKeyField: leftRow.field,
        targetField,
      };
    }
  } else if (rightRow && !leftRow) {
    let l = c.left;
    while (l.kind === 'paren') l = l.expr;
    const kf = fieldPath(l, scope);
    if (kf && !kf.includes('.')) {
      return {
        form,
        keyField: kf,
        rowName: rightRow.rowName,
        rowKeyField: rightRow.field,
        targetField,
      };
    }
  }

  return undefined;
}

function memberExpr(e: Extract<Expr, { kind: 'member' }>, scope: Scope): Fx {
  const path = aliasedPath(e, scope);
  if (path && path.root === 'approver' && scope.approval && !scope.local.has('approver')) {
    if (path.path.length === 1 && path.path[0]?.toLowerCase() === 'submitter') {
      return fx({ code: '(ctx.approver?.submitter ?? null)', constructs: [] });
    }
    return fx({ code: 'await shim.todo(ctx, "approval-approver")', todo: true, shim: true, constructs: ['approval-approver'] });
  }
  if (path && path.root === 'zoho') return zohoMember(path.path, scope);
  if (path && (path.root === 'input' || path.root === 'old')) {
    const api = path.root === 'input' ? 'shim.input.get(ctx' : 'shim.old.get(ctx';
    return fx({
      code: `${api}, ${path.path.map((p) => JSON.stringify(p)).join(', ')})`,
      shim: true,
      decimal: decimalLeaf(path.path, scope),
      lookup: path.root === 'input' && path.path.length === 1 && scope.lookupFields.has(path.path[0]!),
    });
  }
  if (path && path.path.length && !scope.local.has(path.root)) {
    // `Field.Sub` on the current row of a for-each-record function. record.get
    // walks the path, so a null lookup reads undefined instead of throwing on `.Sub`.
    // A row field wins over an input field of the same name, matching a bare name.
    const rowFields = scope.rowFields;
    if (rowFields?.names.has(path.root) && scope.row.has(rowFields.row)) {
      const serverOnly = scope.serverOnly.has(rowFields.row);
      return fx({
        code: `shim.record.get(${jsIdent(rowFields.row)}, ${[path.root, ...path.path].map((p) => JSON.stringify(p)).join(', ')})`,
        shim: true,
        decimal: decimalLeaf(path.path, scope),
        serverOnly,
        reads: [rowFields.row],
        clientReady: scope.clientData.has(rowFields.row) || !serverOnly,
      });
    }
  }
  if (path && path.path.length && !scope.local.has(path.root) && scope.inputFields.has(path.root)) {
    // `Field.Sub` — a navigational read on a record field (lookup id, subform
    // column): input.get walks the path so a null lookup reads undefined
    // rather than throwing on `.Sub`.
    return fx({
      code: `shim.input.get(ctx, ${[path.root, ...path.path].map((p) => JSON.stringify(p)).join(', ')})`,
      shim: true,
      decimal: decimalLeaf(path.path, scope),
    });
  }
  if (path && scope.row.has(path.root)) {
    const onClient = scope.clientData.has(path.root);
    const serverOnly = scope.serverOnly.has(path.root);
    return fx({
      code: `shim.record.get(${jsIdent(path.root)}, ${path.path.map((p) => JSON.stringify(p)).join(', ')})`,
      shim: true,
      decimal: decimalLeaf(path.path, scope),
      serverOnly,
      reads: [path.root],
      clientReady: onClient || !serverOnly,
    });
  }
  if (path && scope.query.has(path.root)) {
    return fx({
      code: `await shim.datastore.field(ctx, ${jsIdent(path.root)}, ${JSON.stringify(path.path.join('.'))})`,
      shim: true,
      decimal: decimalLeaf(path.path, scope),
      serverOnly: true,
      reads: [path.root],
      clientReady: false,
    });
  }
  if (path && scope.map.has(path.root)) {
    const onClient = scope.clientData.has(path.root);
    const serverOnly = scope.serverOnly.has(path.root);
    // Member reads on a map are index reads: they go through the same
    // own-only accessor so `m.__proto__` / `m.constructor` cannot hand a
    // script the shared prototype for a later write.
    const code = path.path.reduce((acc, p) => `shim.get(${acc}, ${JSON.stringify(p)})`, jsIdent(path.root));
    return fx({
      code,
      map: true,
      shim: true,
      reads: [path.root],
      serverOnly,
      clientReady: onClient || !serverOnly,
    });
  }
  const obj = expr(e.object, scope);
  if (obj.todo) return untranslatedMethod(`member:${e.property}`, obj, []);
  if (obj.query) {
    // `Form[criteria].Field` is the field of the first matching record, or
    // null when nothing matches. A multi-valued field (checkbox, multi-select,
    // multi lookup) is that one record's list, not a column across records;
    // `.getAll()` is the column. https://www.zoho.com/deluge/help/fetch-records/fetch-field-values.html
    // (deluge-docs/examples/fetch_records_fetch_field_values-2.deluge).
    const simple = simpleKeyLookup(e.object, e.property, scope);
    const call = `await shim.datastore.field(ctx, ${obj.code}, ${JSON.stringify(e.property)})`;
    return mergeFx(call, [obj], {
      shim: true,
      serverOnly: true,
      clientReady: false,
      simpleLookup: simple,
      rowReads: fieldRowRead(e.object, e.property, call, scope),
    });
  }
  // Any other member read is an index read on a runtime object: own-only
  // through the shim, so `x.__proto__` on a call result or lookup cannot hand
  // a script the shared prototype either.
  return mergeFx(`shim.get(${obj.code}, ${JSON.stringify(e.property)})`, [obj], {
    shim: true,
    decimal: path ? decimalLeaf(path.path, scope) : false,
  });
}

function zohoMember(path: string[], _scope: Scope): Fx {
  const head = path[0]?.toLowerCase() ?? '';
  const env = dispatchGet(ZOHO_ENV, head);
  if (env && path.length === 1) {
    const date = head === 'currentdate' || head === 'currenttime';
    return fx({ code: `shim.zoho.${env}(ctx)`, shim: true, date });
  }
  if (env) {
    // zoho.currentdate.something without a call — leave as todo method chain
    return fx({
      code: `await shim.todo(ctx, ${JSON.stringify('zoho.' + path.join('.'))})`,
      shim: true,
      todo: true,
      constructs: [`zoho.${path.join('.')}`],
    });
  }
  return fx({
    code: `await shim.zoho.task(ctx, ${JSON.stringify(path)}, [])`,
    shim: true,
    serverOnly: true,
    sideEffect: true,
    todo: ZOHO_PAYMENT.test(path.join('.')),
    constructs: ZOHO_PAYMENT.test(path.join('.')) ? ['payments'] : [],
  });
}

/**
 * `.get().get()…` is a left spine of calls. Fold it in a loop. Argument
 * expressions are still evaluated outer-first, matching the recursive walk.
 * A single `.get()` stays on the ordinary path.
 */
function flattenGetChain(e: Expr): { base: Expr; steps: Expr[][] } | null {
  const steps: Expr[][] = [];
  let cur: Expr = e;
  while (cur.kind === 'call' && cur.callee.kind === 'member' && canonicalBuiltin(cur.callee.property) === 'get') {
    steps.push(cur.args);
    cur = cur.callee.object;
  }
  if (steps.length < 2) return null;
  return { base: cur, steps };
}

function translateGetChain(base: Expr, steps: Expr[][], scope: Scope): Fx {
  const evaluated = steps.map((args) => args.map((a) => expr(a, scope)));
  let recv = expr(base, scope);
  for (let i = steps.length - 1; i >= 0; i--) {
    const args = evaluated[i]!;
    recv = recv.todo ? untranslatedMethod('get', recv, args) : directMethod('get', recv, args)!;
  }
  return recv;
}

function callExpr(e: Extract<Expr, { kind: 'call' }>, scope: Scope, cross = false): Fx {
  const flat = flattenGetChain(e);
  if (flat) return translateGetChain(flat.base, flat.steps, scope);
  if (e.callee.kind === 'name') return namedCall(e, scope, cross);
  if (e.callee.kind !== 'member') {
    const c = expr(e.callee, scope);
    const args = e.args.map((a) => expr(a, scope));
    return mergeFx(`await ${c.code}(${args.map((a) => a.code).join(', ')})`, [c, ...args], { shim: true, serverOnly: true, todo: true, constructs: ['call-dynamic'] });
  }
  const method = canonicalBuiltin(e.callee.property);
  const mark = scope.prefetch.length;
  const slot = scope.slot;
  const emittedMark = new Map(scope.emitted);
  const args = e.args.map((a) => expr(a, scope));
  const zoho = zohoCall(e, args, scope);
  if (zoho) return zoho;
  const app = thisappCall(e, args);
  if (app) return app;
  // `(F[crit].Field).getAll()` wraps the member chain in a paren; the column
  // fetch is the same with or without the parens.
  const getAllTarget = method === GET_ALL ? unparen(e.callee.object) : null;
  if (getAllTarget && getAllTarget.kind === 'member') {
    const base = unparen(getAllTarget.object);
    const q = expr(getAllTarget.object, scope);
    if (q.query || base.kind === 'criteria' || base.kind === 'name') {
      const queryCode = q.query ? q.code : criteriaExpr(asCriteria(base), scope).code;
      return mergeFx(`await shim.datastore.column(ctx, ${queryCode}, ${JSON.stringify(getAllTarget.property)})`, [q, ...args], {
        shim: true,
        serverOnly: true,
        list: true,
      });
    }
    if (!e.args.length) {
      // `input.Subform.Field.getAll()` / `rec.Subform.Field.getAll()`: the field
      // of every row already in memory, not a Data Store read.
      const rows = expr(getAllTarget.object, scope);
      if (!rows.query && !rows.todo) {
        return mergeFx(`shim.list.column(${rows.code}, ${JSON.stringify(getAllTarget.property)})`, [rows], { shim: true, list: true });
      }
    }
  }
  if (AGG.has(method)) {
    const obj = e.callee.object;
    const q = obj.kind === 'criteria' ? criteriaExpr(obj, scope) : expr(obj, scope);
    // `FormAlias.count()` inside a collection function counts the selected
    // records, not the whole table: the bare form name is the row binding.
    const aliasRoot = obj.kind === 'name' ? rowAliasOf(obj.name, scope) : null;
    if (aliasRoot && method === 'count') {
      const id = jsIdent(aliasRoot);
      return mergeFx(`(${id} ? (Array.isArray(${id}) ? ${id}.length : 1) : 0)`, [q], { shim: true });
    }
    // A row binding (a form-typed parameter, or the current record) may be the
    // fetch the caller passed or the rows that fetch already holds. Count those
    // rows. Do not build another query.
    // https://www.zoho.com/deluge/help/data-access/aggregate-records/count.html
    if (obj.kind === 'name' && method === 'count' && scope.row.has(obj.name)) {
      const id = jsIdent(obj.name);
      return mergeFx(
        `((${id} && ${id}.__query) ? await shim.datastore.aggregate(ctx, ${id}, "count", undefined) : (${id} ? (Array.isArray(${id}) ? ${id}.length : 1) : 0))`,
        [q],
        { shim: true },
      );
    }
    if (q.query || (obj.kind === 'name' && !scope.local.has(obj.name) && !scope.list.has(obj.name))) {
      const queryCode = q.query
        ? q.code
        : queryInvoke(obj.kind === 'name' ? obj.name : '', '{ op: "true" }', scope, []);
      const fn = aggregateFn(method);
      // distinct(Status) and sum(Amount) pass the field link name. A bare name
      // is not a JS variable; a local is, and stays an expression.
      const fieldArg = e.args[0];
      const fieldName = fieldArg ? fieldPath(fieldArg, scope) : null;
      const field = fieldName ? JSON.stringify(fieldName) : fieldArg ? args[0]!.code : 'undefined';
      const call = `await shim.datastore.aggregate(ctx, ${queryCode}, ${JSON.stringify(fn)}, ${field})`;
      // A bare field-name argument is emitted as a link-name literal, so its
      // expression effects are not part of the call: merging them would record
      // the field name as a read and refuse a read-only collection.
      return mergeFx(call, fieldName ? [q] : [q, ...args], {
        shim: true,
        serverOnly: true,
        // sum/avg/min/max/median of a decimal, percent or currency column is an
        // exact decimal, so later arithmetic stays on shim.decimal.
        decimal: fn !== 'count' && fn !== 'distinct' && !!fieldName && scope.decimalFields.has(fieldName),
        list: fn === 'distinct',
        rowReads: aggregateRowRead(obj, fn, field, call, scope),
      });
    }
    // `.count()` on a record-typed local (a function parameter holding one
    // record or a record collection) is the record cardinality: a single
    // record counts as 1, a collection counts its rows, null counts as 0
    // (record count: https://www.zoho.com/deluge/help/data-access/aggregate-records/count.html).
    if (
      method === 'count' &&
      !e.args.length &&
      obj.kind === 'name' &&
      scope.local.has(obj.name) &&
      !scope.list.has(obj.name) &&
      !scope.map.has(obj.name) &&
      !scope.date.has(obj.name) &&
      !scope.decimal.has(obj.name) &&
      !q.query &&
      !q.todo &&
      !q.list &&
      !q.map &&
      !q.date &&
      !q.decimal
    ) {
      const id = jsIdent(obj.name);
      return mergeFx(`(${id} ? (Array.isArray(${id}) ? ${id}.length : 1) : 0)`, [q], { shim: true });
    }
    // Rows or values already in memory (`input.Subform.sum(Amount)`,
    // `numbers.average()`). `min`/`max` with an argument are the two-number
    // functions (functions/number/min.html, max.html) and `distinct` is the
    // list function, so they are not here.
    const fieldArg = e.args[0];
    const fieldName = fieldArg && fieldArg.kind === 'name' ? fieldPath(fieldArg, scope) : null;
    // In-memory lists only, same as the free-call form: a string or other
    // non-list stays an untranslated call. A member expression (`m.k.sum()`)
    // aggregates the member value, so it counts as a possible list.
    if (!q.query && !q.todo && (q.list || obj.kind === 'member') && method !== 'min' && method !== 'max' && method !== 'distinct' && e.args.length <= 1 && (!fieldArg || fieldName)) {
      const fn = aggregateFn(method);
      const exact = !!fieldName && scope.decimalFields.has(fieldName);
      const extra = fieldName ? `, ${JSON.stringify(fieldName)}${exact ? ', true' : ''}` : '';
      return mergeFx(`shim.list.aggregate(${q.code}, ${JSON.stringify(fn)}${extra})`, [q], { shim: true, decimal: exact && fn !== 'count' });
    }
  }
  if (DATE_METHODS.has(method) && method !== 'toString') {
    const recv = expr(e.callee.object, scope);
    if (recv.todo) return untranslatedMethod(method, recv, args);
    const dateResult = returnsDate(method);
    const argSrc = args.map((a) => a.code).join(', ');
    const code = `shim.date.${method}(${recv.code}${argSrc ? `, ${argSrc}` : ''}, ctx)`;
    return mergeFx(code, [recv, ...args], { shim: true, date: dateResult });
  }
  if (method === 'toString') {
    const recv = expr(e.callee.object, scope);
    if (recv.todo) return untranslatedMethod(method, recv, args);
    if (args.length >= 1) return mergeFx(`shim.date.format(${recv.code}, ${args[0]!.code}, ctx)`, [recv, args[0]!], { shim: true });
    if (recv.date) return mergeFx(`shim.date.text(${recv.code}, ctx)`, [recv], { shim: true });
    return mergeFx(`String(${recv.code})`, [recv]);
  }
  const recv = expr(e.callee.object, scope);
  // Before the todo-receiver return, so a hole such as `notARealFn().toXml()`
  // still calls the XML shim instead of a second `method:toXml` hole.
  if (method === 'toXml' || method === 'toXmlList' || method === 'executeXpath') return xmlCall(method, recv, args);
  if (recv.todo) return untranslatedMethod(method, recv, args);
  const direct = directMethod(method, recv, args);
  if (direct) return direct;
  const converted = conversionCall(method, recv, args);
  if (converted) return converted;
  // `Form.Subform()` is the subform row constructor: a new empty row bound to
  // `Form.Subform`. It is client-capable even though the bare form name
  // resolves to the form's server collection.
  if (e.callee.object.kind === 'name' && !e.args.length && !scope.local.has(e.callee.object.name) && scope.formNames.has(e.callee.object.name)) {
    return fx({
      code: `shim.record.bind(ctx, {}, ${JSON.stringify(`${e.callee.object.name}.${e.callee.property}`)})`,
      shim: true,
      row: true,
    });
  }
  // A number method such as `(1).ceil()` is the function `ceil(1)`. A list,
  // map, or query receiver keeps its own method (aggregate, contains, remove):
  // those already returned above, or they stay a hole when this name is not
  // that function.
  if (!cross && !recv.list && !recv.map && !recv.query && crossFormFree(method, e.args.length + 1)) {
    scope.prefetch.length = mark;
    scope.slot = slot;
    scope.emitted = new Map(emittedMark);
    const via = callAsFunction(e, method, scope);
    if (!via.todo) return via;
    scope.prefetch.length = mark;
    scope.slot = slot;
    scope.emitted = new Map(emittedMark);
    const recv2 = expr(e.callee.object, scope);
    const args2 = e.args.map((a) => expr(a, scope));
    return mergeFx(`await shim.todo(ctx, ${JSON.stringify('method:' + method)})`, [recv2, ...args2], {
      shim: true,
      todo: true,
      constructs: [`method:${method}`],
    });
  }
  return mergeFx(`await shim.todo(ctx, ${JSON.stringify('method:' + method)})`, [recv, ...args], {
    shim: true,
    todo: true,
    constructs: [`method:${method}`],
  });
}

function unparen(e: Expr): Expr {
  while (e.kind === 'paren') e = e.expr;
  return e;
}

function asCriteria(e: Expr): Extract<Expr, { kind: 'criteria' }> {
  if (e.kind === 'criteria') return e;
  const span = e.span;
  return { kind: 'criteria', object: e, criteria: { kind: 'name', name: 'true', span }, span };
}

function zohoCall(e: Extract<Expr, { kind: 'call' }>, args: Fx[], scope: Scope): Fx | null {
  if (rootName(e) !== 'zoho' || e.callee.kind !== 'member') return null;
  const path = callPath(e);
  if (!path.length) return null;
  const head = path[0]!.toLowerCase();
  const env = dispatchGet(ZOHO_ENV, head);
  // `zoho.currenttime.toLong()`: a method on the variable's value, translated
  // like a method on any other value. Never an integration task.
  if (env && path.length === 2 && !DATE_METHODS.has(canonicalBuiltin(path[1]!))) return null;
  if (env && (path.length === 1 || DATE_METHODS.has(canonicalBuiltin(path[path.length - 1]!)))) {
    const date = head === 'currentdate' || head === 'currenttime';
    let base = fx({ code: `shim.zoho.${env}(ctx)`, shim: true, date });
    const methods = path.slice(1);
    if (!methods.length) return base;
    const method = canonicalBuiltin(methods[methods.length - 1]!);
    if (method === 'toString' && args.length >= 1) {
      return mergeFx(`shim.date.format(${base.code}, ${args[0]!.code}, ctx)`, [base, ...args], { shim: true });
    }
    if (method === 'toString') return mergeFx(`shim.date.text(${base.code}, ctx)`, [base, ...args], { shim: true });
    if (DATE_METHODS.has(method) && method !== 'toString') {
      const dateResult = returnsDate(method);
      const argSrc = args.map((a) => a.code).join(', ');
      return mergeFx(`shim.date.${method}(${base.code}${argSrc ? `, ${argSrc}` : ''}, ctx)`, [base, ...args], { shim: true, date: dateResult });
    }
    return base;
  }
  const pay = ZOHO_PAYMENT.test(path.join('.'));
  if (pay) {
    return mergeFx(`await shim.todo(ctx, "payments")`, args, { shim: true, todo: true, serverOnly: true, constructs: ['payments'] });
  }
  const taskArgs = connectionArgs(e, path, args, scope);
  return mergeFx(`await shim.zoho.task(ctx, ${JSON.stringify(path)}, [${taskArgs.map((a) => a.code).join(', ')}])`, taskArgs, {
    shim: true,
    serverOnly: true,
    sideEffect: true,
  });
}

/** A string literal, including one wrapped in parentheses. */
function stringLiteral(e: Expr): string | null {
  let current = e;
  while (current.kind === 'paren') current = current.expr;
  return current.kind === 'string' ? current.value : null;
}

/** Replace a unique display-name connection argument with its link name. */
function connectionArgs(e: Extract<Expr, { kind: 'call' }>, path: string[], args: Fx[], scope: Scope): Fx[] {
  if (!scope.connections.length) return args;
  const index = connectionArgIndex(path, e.args.length);
  if (index == null) return args;
  const literal = stringLiteral(e.args[index]!);
  if (literal == null) return args;
  const resolved = resolveConnectionArgument(literal, scope.connections);
  if (resolved.kind !== 'display') return args;
  const next = args.slice();
  const current = next[index];
  if (!current) return args;
  next[index] = { ...current, code: JSON.stringify(resolved.link) };
  return next;
}

function thisappCall(e: Extract<Expr, { kind: 'call' }>, args: Fx[]): Fx | null {
  if (rootName(e) !== 'thisapp') return null;
  const path = callPath(e);
  return mergeFx(`await shim.thisapp.call(ctx, ${JSON.stringify(path)}, [${args.map((a) => a.code).join(', ')}])`, args, {
    shim: true,
    serverOnly: true,
    appFunction: true,
    sideEffect: true,
  });
}

/** Properties from `zoho.books.getRecords` → [books, getRecords], ignoring the root name. */
function callPath(e: Extract<Expr, { kind: 'call' }>): string[] {
  const path: string[] = [];
  let cur: Expr = e.callee;
  while (cur.kind === 'member') {
    path.unshift(cur.property);
    cur = cur.object;
  }
  return path;
}

function namedCall(e: Extract<Expr, { kind: 'call' }>, scope: Scope, cross = false): Fx {
  const raw = e.callee.kind === 'name' ? e.callee.name : '';
  const name = raw === 'List' || raw === 'Collection' || raw === 'Map' ? raw : canonicalBuiltin(raw);
  const mark = scope.prefetch.length;
  const slot = scope.slot;
  const emittedMark = new Map(scope.emitted);
  const args = e.args.map((a) => expr(a, scope));
  if (name === 'executeXpath' || name === 'toXml' || name === 'toXmlList') return xmlCall(name, null, args);

  const typeArg = e.typeArgs?.[0];
  if (name === 'List' || name === 'Collection') {
    if (!CONSTRUCTORS.has(name)) return mergeFx(`await shim.todo(ctx, ${JSON.stringify('call:' + name)})`, args, { shim: true, todo: true, constructs: [`call:${name}`] });
    if (!typeArg) return mergeFx('[]', args, { list: true });
    return mergeFx(`shim.list(${JSON.stringify(typeArg)})`, args, { shim: true, list: true });
  }
  if (name === 'Map') {
    if (!CONSTRUCTORS.has('Map')) return mergeFx(`await shim.todo(ctx, ${JSON.stringify('call:' + name)})`, args, { shim: true, todo: true, constructs: [`call:${name}`] });
    if (!typeArg) return mergeFx('{}', args, { map: true });
    return mergeFx(`shim.map(${JSON.stringify(typeArg)})`, args, { shim: true, map: true });
  }
  if (name === 'abs') return mergeFx(`shim.math.abs(${args[0]?.code ?? 'undefined'})`, args, { shim: true });
  if (name === 'exp') return mergeFx(`shim.math.exp(${args[0]?.code ?? 'undefined'})`, args, { shim: true });
  if (name === 'frac') return mergeFx(`shim.math.frac(${args[0]?.code ?? 'undefined'})`, args, { shim: true });
  if (name === 'log') return mergeFx(`shim.math.log(${args[0]?.code ?? 'undefined'})`, args, { shim: true });
  if (MATH_SHIM_FUNCTIONS.has(name)) {
    // `atan2(y, x)` has two mandatory parameters
    // (https://www.zoho.com/deluge/help/functions/number/atan2.html); any
    // other count is the counted call:atan2 todo, never a value.
    if (name === 'atan2' && args.length !== 2) {
      return mergeFx(`await shim.todo(ctx, "call:atan2")`, args, { shim: true, todo: true, constructs: ['call:atan2'] });
    }
    return mergeFx(`shim.math.${name}(${args.map((a) => a.code).join(', ')})`, args, { shim: true });
  }
  const math = dispatchGet(MATH_FUNCTIONS, name);
  if (math && name !== ROUND_FUNCTION && name !== 'sqrt' && name !== 'frac' && name !== 'abs' && name !== 'exp' && name !== 'log' && !MATH_SHIM_FUNCTIONS.has(name)) {
    return mergeFx(`${math}(${args.map((a) => a.code).join(', ')})`, args);
  }
  if (name === ROUND_FUNCTION) {
    const n = args[0]?.code ?? 'undefined';
    const places = args[1]?.code ?? '0';
    return mergeFx(`shim.math.round(${n}, ${places})`, args, { shim: true });
  }
  if (name === IFNULL_FUNCTION && args.length >= 2) return mergeFx(`shim.ifnull(${args[0]!.code}, ${args[1]!.code})`, args, { shim: true, decimal: args[0]!.decimal || args[1]!.decimal });
  if (name === 'isEmpty') return mergeFx(`shim.isEmpty(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'isDate') return mergeFx(`shim.date.isDate(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'isNumber') return mergeFx(`shim.isNumber(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'isText') return mergeFx(`shim.isText(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'isFile') return mergeFx(`shim.isFile(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'isEven') return mergeFx(`shim.math.isEven(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'isOdd') return mergeFx(`shim.math.isOdd(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'leftPad') return mergeFx(`shim.string.leftPad(${args.map((a) => a.code).join(', ')})`, args, { shim: true });
  if (name === 'rightPad') return mergeFx(`shim.string.rightPad(${args.map((a) => a.code).join(', ')})`, args, { shim: true });
  if (name === 'removeAllAlpha') return mergeFx(`shim.string.removeAllAlpha(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'toDecimal') return mergeFx(`shim.convert.toDecimal(${args[0]?.code ?? 'null'})`, args, { shim: true, decimal: true });
  if (name === 'sin' || name === 'cos' || name === 'tan' || name === 'asin') {
    return mergeFx(`shim.number.${name}(${args[0]?.code ?? 'null'})`, args, { shim: true, decimal: true });
  }
  if (DATE_METHODS.has(name) && name !== 'toString' && args[0]) {
    const rest = args.slice(1).map((a) => a.code).join(', ');
    return mergeFx(`shim.date.${name}(${args[0].code}${rest ? `, ${rest}` : ''}, ctx)`, args, { shim: true, date: returnsDate(name) });
  }
  if (name === 'getFieldNames') return mergeFx('shim.record.getFieldNames(ctx.record)', args, { shim: true, list: true });
  if (name === 'getFieldValue') return mergeFx(`shim.record.getFieldValue(ctx.record, ${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'getJson') return mergeFx(`shim.list.getJson(${args[0]?.code ?? 'null'}, ${args[1]?.code ?? 'null'})`, args, { shim: true });
  // A list argument has no documented text form for reverse (see the method
  // arm in directMethod), so the free call stays an untranslated call too.
  if (name === 'reverse' && args[0]?.list) {
    return mergeFx(`await shim.todo(ctx, "call:reverse")`, args, { shim: true, todo: true, constructs: ['call:reverse'] });
  }
  if (TEXT_FUNCTIONS.has(name) && args.length) return mergeFx(`shim.string.${name}(${args.map((a) => a.code).join(', ')})`, args, { shim: true });
  if (name === 'find' && args.length >= 2) return mergeFx(`shim.list.indexOf(${args.map((a) => a.code).join(', ')})`, args, { shim: true });
  if (name === 'indexOf') return mergeFx(`shim.list.indexOf(${args.map((a) => a.code).join(', ')})`, args, { shim: true });
  if (name === 'trim') return mergeFx(`shim.string.trim(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'startsWith') return mergeFx(`shim.string.startsWith(${args[0]?.code ?? 'null'}, ${args[1]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'startsWithIgnoreCase') return mergeFx(`shim.string.startsWithIgnoreCase(${args[0]?.code ?? 'null'}, ${args[1]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'textToHex') return mergeFx(`shim.string.textToHex(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === GET_SUFFIX) return mergeFx(`shim.string.getSuffix(${args[0]?.code ?? 'null'}, ${args[1]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'lastIndexOf') return mergeFx(`shim.list.lastIndexOf(${args.map((a) => a.code).join(', ')})`, args, { shim: true });
  if (name === 'largest') return mergeFx(`shim.number.largest(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'smallest') return mergeFx(`shim.number.smallest(${args[0]?.code ?? 'null'})`, args, { shim: true });
  // The deprecated GET task: the same outbound transport and host allowlist as
  // invokeurl. `false` as the last argument is the non-simple (response map) form.
  if (name === GET_URL_FUNCTION) {
    const tail = e.args[e.args.length - 1];
    const nonSimple = tail?.kind === 'name' && tail.name === 'false';
    return mergeFx(`await shim.http.getUrl(ctx${args.length ? `, ${args.map((a) => a.code).join(', ')}` : ''})`, args, {
      shim: true,
      serverOnly: true,
      map: nonSimple,
      // The same outbound transport and host allowlist as invokeurl: replaying
      // the call in the prefetch would run the request a second time.
      sideEffect: true,
    });
  }
  if (name === 'equalsIgnoreCase') return mergeFx(`shim.string.equalsIgnoreCase(${args[0]?.code ?? 'null'}, ${args[1]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'containsIgnoreCase') return mergeFx(`shim.string.containsIgnoreCase(${args[0]?.code ?? 'null'}, ${args[1]?.code ?? 'null'})`, args, { shim: true });
  if (name === 'put') return mergeFx(`shim.list.put(${args.map((a) => a.code).join(', ')})`, args, { shim: true, map: args[0]?.map });
  // Deluge names are case-insensitive, and the data-access page documents both
  // spellings (`Sum(Form.Field)` and `Form.sum(Field)`). A local list or a list
  // expression is already in memory, so it uses the same aggregate as `list.sum()`.
  const aggregateCall = name.toLowerCase();
  if (
    !scope.functions.has(aggregateCall) &&
    e.args.length <= 1 &&
    (aggregateCall === 'sum' || aggregateCall === 'average' || aggregateCall === 'count' || aggregateCall === 'distinct' ||
    aggregateCall === 'maximum' || aggregateCall === 'minimum' || aggregateCall === 'median')
  ) {
    const fn = aggregateFn(aggregateCall);
    const argAst = e.args[0];
    if (argAst) {
      let fieldName: string | null = null;
      let objAst = argAst;
      if (argAst.kind === 'member') {
        objAst = argAst.object;
        fieldName = argAst.property;
      }
      const q = objAst.kind === 'criteria' ? criteriaExpr(objAst, scope) : expr(objAst, scope);
      if (q.query || (objAst.kind === 'name' && !scope.local.has(objAst.name) && !scope.list.has(objAst.name))) {
        const rootName = objAst.kind === 'criteria' ? (objAst.object.kind === 'name' ? objAst.object.name : '') : (objAst.kind === 'name' ? objAst.name : '');
        const queryCode = q.query
          ? q.code
          : queryInvoke(rootName, '{ op: "true" }', scope, []);
        const fieldCode = fieldName ? JSON.stringify(fieldName) : 'undefined';
        const call = `await shim.datastore.aggregate(ctx, ${queryCode}, ${JSON.stringify(fn)}, ${fieldCode})`;
        return mergeFx(call, [q], {
          shim: true,
          serverOnly: true,
          decimal: fn !== 'count' && fn !== 'distinct' && !!fieldName && scope.decimalFields.has(fieldName),
          list: fn === 'distinct',
          rowReads: aggregateRowRead(objAst, fn, fieldCode, call, scope),
        });
      }
      // In-memory lists only. A string or other non-list stays an untranslated call
      // (`sum("x")` is not `shim.list.aggregate`). A map member is not a list of rows:
      // `sum(m.k)` aggregates the member expression, same as `m.k.sum()`.
      if (!q.query && !q.todo && q.list) {
        const exact = !!fieldName && scope.decimalFields.has(fieldName);
        const extra = fieldName ? `, ${JSON.stringify(fieldName)}${exact ? ', true' : ''}` : '';
        return mergeFx(`shim.list.aggregate(${q.code}, ${JSON.stringify(fn)}${extra})`, [q], {
          shim: true,
          decimal: exact && fn !== 'count',
          list: fn === 'distinct',
        });
      }
      if (!q.query && !q.todo && fieldName) {
        const fullQ = expr(argAst, scope);
        if (!fullQ.query && !fullQ.todo) {
          return mergeFx(`shim.list.aggregate(${fullQ.code}, ${JSON.stringify(fn)})`, [fullQ], {
            shim: true,
            decimal: fullQ.decimal && fn !== 'count',
            list: fn === 'distinct',
          });
        }
      }
    }
  }

  if (NULL_FUNCTIONS.has(name)) return mergeFx(`shim.isNull(${args[0]?.code ?? 'null'})`, args, { shim: true });
  if (BLANK_FUNCTIONS.has(name)) return mergeFx(`shim.isBlank(${args[0]?.code ?? 'null'})`, args, { shim: true });
  // `contains(text, part)` is `text.contains(part)`, including a list receiver:
  // the method translation picks list or text from the value.
  if (!cross && args.length > 0 && crossFormFree(name, args.length)) {
    scope.prefetch.length = mark;
    scope.slot = slot;
    scope.emitted = new Map(emittedMark);
    const via = callAsMethod(e, name, scope);
    if (!via.todo) return via;
    scope.prefetch.length = mark;
    scope.slot = slot;
    scope.emitted = new Map(emittedMark);
    const again = e.args.map((a) => expr(a, scope));
    return mergeFx(`await shim.todo(ctx, ${JSON.stringify('call:' + name)})`, again, { shim: true, todo: true, constructs: [`call:${name}`] });
  }
  return mergeFx(`await shim.todo(ctx, ${JSON.stringify('call:' + name)})`, args, { shim: true, todo: true, constructs: [`call:${name}`] });
}

/** `f(recv, ...args)` translated as the method `recv.f(...args)`. */
function callAsMethod(e: Extract<Expr, { kind: 'call' }>, name: string, scope: Scope): Fx {
  const recv = e.args[0];
  if (!recv) {
    return mergeFx(`await shim.todo(ctx, ${JSON.stringify('call:' + name)})`, [], { shim: true, todo: true, constructs: [`call:${name}`] });
  }
  return callExpr({
    kind: 'call',
    callee: { kind: 'member', object: recv, property: name, span: recv.span },
    args: e.args.slice(1),
    span: e.span,
  }, scope, true);
}

/** `recv.f(...args)` translated as the function `f(recv, ...args)`. */
function callAsFunction(e: Extract<Expr, { kind: 'call' }>, name: string, scope: Scope): Fx {
  if (e.callee.kind !== 'member') {
    return mergeFx(`await shim.todo(ctx, ${JSON.stringify('method:' + name)})`, [], { shim: true, todo: true, constructs: [`method:${name}`] });
  }
  return namedCall({
    kind: 'call',
    callee: { kind: 'name', name, span: e.callee.span },
    args: [e.callee.object, ...e.args],
    span: e.span,
  }, scope, true);
}

/**
 * An untranslated expression is not a value. Calling `.length`, `.get`, or
 * any other method on `shim.todo()` throws (the placeholder is `undefined`).
 * Emit the todo itself — a no-op that returns undefined — and record
 * `method:<name>` so migration-report.json lists it.
 * Deluge `.size()` counts a real collection
 * (https://www.zoho.com/deluge/help/functions/common/size.html). A TODO is not one.
 */
/** toXml, toXmlList, and executeXpath. `toXmlList` returns a list. */
function xmlCall(name: 'toXml' | 'toXmlList' | 'executeXpath', recv: Fx | null, args: Fx[]): Fx {
  const parts = recv ? [recv, ...args] : args;
  return mergeFx(`shim.xml.${name}(${parts.map((part) => part.code).join(', ')})`, parts, {
    shim: true,
    list: name === 'toXmlList',
  });
}

function untranslatedMethod(method: string, recv: Fx, args: Fx[]): Fx {
  return mergeFx(`await shim.todo(ctx, ${JSON.stringify('method:' + method)})`, [recv, ...args], {
    shim: true,
    todo: true,
    constructs: [`method:${method}`],
  });
}

function conversionCall(method: string, recv: Fx, args: Fx[]): Fx | null {
  if (recv.query || recv.todo) return null;
  const fn = dispatchGet(CONVERSION_BY_LOWER, method.toLowerCase()) ?? '';
  if (!fn) return null;
  if (fn === 'toList') {
    const sep = args[0];
    const rest = args.slice(sep ? 1 : 0);
    const code = sep
      ? `shim.convert.toList(${recv.code}, ctx, ${sep.code}${rest.map((a) => `, ${a.code}`).join('')})`
      : `shim.convert.toList(${recv.code}, ctx)`;
    return mergeFx(code, [recv, ...args], { shim: true, list: true });
  }
  const extra = args.map((a) => `, ${a.code}`).join('');
  const flags: Partial<Fx> = { shim: true };
  if (fn === 'toDecimal') flags.decimal = true;
  if (fn === 'toMap' || fn === 'toJSONCollection') flags.map = true;
  if (fn === 'toListString' || fn === 'toJSONList') flags.list = true;
  return mergeFx(`shim.convert.${fn}(${recv.code}, ctx${extra})`, [recv, ...args], flags);
}

function returnsDate(method: string): boolean {
  return method.startsWith('add') || method.startsWith('sub') || method.startsWith('toStart') || method === 'edate' || method === 'toDate' || method === 'toTime' || method === 'nextWeekDay' || method === 'previousWeekDay';
}

function directMethod(method: string, recv: Fx, args: Fx[]): Fx | null {
  const a = args.map((x) => x.code);
  const argList = a.join(', ');
  const call = (code: string, flags?: Partial<Fx>) => mergeFx(code, [recv, ...args], { shim: true, ...flags });
  const textish = !recv.list && !recv.map && !recv.query;

  if (method === 'getFieldNames') return call(`shim.record.getFieldNames(${recv.code})`, { list: true });
  if (method === 'getFieldValue') return call(`shim.record.getFieldValue(${recv.code}, ${a[0] ?? 'null'})`);

  // The stored file value is a Stratus object key (or `{ key }` before write),
  // not the bytes, the byte length, or a content type. Name reads use that
  // key. Size, content, type, charset, and a PDF or ZIP password have no
  // equivalent here and stay a named generation-time manual item.
  if (FILE_METHODS.has(method)) {
    if (FILE_MANUAL.has(method)) {
      return call(`await shim.todo(ctx, ${JSON.stringify(`file:${method}`)})`, {
        todo: true,
        constructs: [`file:${method}`],
      });
    }
    return call(`shim.file.${method}(${recv.code}${argList ? `, ${argList}` : ''})`);
  }

  if (method === 'toLowerCase' && textish) return call(`shim.string.toLowerCase(${recv.code})`);
  if (method === 'toUpperCase' && textish) return call(`shim.string.toUpperCase(${recv.code})`);
  if (method === 'trim' && textish) return call(`shim.string.trim(${recv.code})`);
  if (method === 'replaceAll' && !recv.query) return call(`shim.string.replaceAll(${recv.code}, ${argList})`);
  if (method === 'subString' && textish) return call(`shim.string.subString(${recv.code}${argList ? `, ${argList}` : ''})`);
  if (method === GET_PREFIX) return call(`shim.string.getPrefix(${recv.code}, ${args[0]?.code ?? 'null'})`);
  if (method === GET_SUFFIX) return call(`shim.string.getSuffix(${recv.code}, ${args[0]?.code ?? 'null'})`);
  if (method === 'leftPad') return call(`shim.string.leftPad(${recv.code}${argList ? `, ${argList}` : ''})`);
  if (method === 'startsWithIgnoreCase' && textish) return call(`shim.string.startsWithIgnoreCase(${recv.code}, ${args[0]?.code ?? 'null'})`);
  if (method === 'textToHex' && textish) return call(`shim.string.textToHex(${recv.code})`);
  if (method === 'rightPad') return call(`shim.string.rightPad(${recv.code}${argList ? `, ${argList}` : ''})`);
  if (method === 'removeAllAlpha') return call(`shim.string.removeAllAlpha(${recv.code})`);
  if (NULL_FUNCTIONS.has(method)) return call(`shim.isNull(${recv.code})`);
  if (method === 'isEmpty') return call(`shim.isEmpty(${recv.code})`);
  if (method === 'isDate') return call(`shim.date.isDate(${recv.code})`);
  if (method === 'isNumber') return call(`shim.isNumber(${recv.code})`);
  if (method === 'isText') return call(`shim.isText(${recv.code})`);
  if (method === 'sin') return call(`shim.number.sin(${recv.code})`, { decimal: true });
  if (method === 'cos') return call(`shim.number.cos(${recv.code})`, { decimal: true });
  if (method === 'tan') return call(`shim.number.tan(${recv.code})`, { decimal: true });
  if (method === 'asin') return call(`shim.number.asin(${recv.code})`, { decimal: true });
  if (MATH_SHIM_METHODS.has(method)) return call(`shim.math.${method}(${recv.code})`);
  if (method === 'isFile') return call(`shim.isFile(${recv.code})`);
  if (method === 'isEven') return call(`shim.math.isEven(${recv.code})`);
  if (method === 'isOdd') return call(`shim.math.isOdd(${recv.code})`);
  if (method === 'round') return call(`shim.math.round(${recv.code}, ${args[0]?.code ?? '0'})`);
  if (method === 'abs') return call(`shim.math.abs(${recv.code})`);
  if (method === 'exp') return call(`shim.math.exp(${recv.code})`);
  if (method === 'frac') return call(`shim.math.frac(${recv.code})`);
  if (method === 'get') return call(`shim.list.get(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'remove') return call(`shim.list.remove(${recv.code}${argList ? `, ${argList}` : ''})`);
  if (method === 'removeAll') return call(`shim.list.removeAll(${recv.code}, ${args[0]?.code ?? '[]'})`, { list: true });
  if (method === 'removeElement') return call(`shim.list.removeElement(${recv.code}, ${args[0]?.code ?? 'undefined'})`, { list: true });
  if (method === 'delete') return call(`shim.list.deleteItem(${recv.code}, ${args[0]?.code ?? 'undefined'})`, { sideEffect: true });
  if (method === 'deleteAll') return call(`shim.list.deleteAll(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'duplicate') return call(`shim.list.duplicate(${recv.code})`);
  if (method === 'sortKey') return call(`shim.list.sortKey(${recv.code})`, { map: true });
  if (method === 'containValue') return call(`shim.list.containsValue(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'notContains') return call(`shim.list.notContains(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'distinct' && !recv.query) return call(`shim.list.distinct(${recv.code})`, { list: true });
  if (method === 'sort') return call(`shim.list.sort(${recv.code}${args[0] ? `, ${args[0].code}` : ''})`, { list: true });
  if (method === 'intersect') return call(`shim.list.intersect(${recv.code}, ${args[0]?.code ?? '[]'})`, { list: true });
  if (method === 'indexOf') return call(`shim.list.indexOf(${recv.code}${argList ? `, ${argList}` : ''})`);
  if (method === 'lastIndexOf' && !textish) return call(`shim.list.lastIndexOf(${recv.code}${argList ? `, ${argList}` : ''})`);
  if (method === 'length') return call(`shim.list.length(${recv.code})`);
  if (method === 'size') return call(`shim.list.size(${recv.code})`);
  if (method === 'add' && !recv.map && !recv.query) return call(`shim.list.add(${recv.code}${argList ? `, ${argList}` : ''})`, { list: true });
  if (method === 'addAll' && !recv.query) return call(`shim.list.addAll(${recv.code}, ${args[0]?.code ?? '[]'})`, { list: true });
  if (method === 'insertAll') return call(`shim.list.insertAll(${recv.code}${argList ? `, ${argList}` : ''})`, { list: true });
  if (method === 'putAll') return call(`shim.list.putAll(${recv.code}${argList ? `, ${argList}` : ''})`, { map: true });
  if (method === 'contains') return call(`shim.list.contains(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'clear') return call(`shim.list.clear(${recv.code})`, { list: recv.list, map: recv.map });
  if (method === 'insert') return call(`shim.list.insert(${recv.code}${argList ? `, ${argList}` : ''})`, { list: true, sideEffect: true });
  if (method === 'keys') return call(`shim.list.keys(${recv.code})`, { list: true });
  if (method === 'values') return call(`shim.list.values(${recv.code})`, { list: true });
  if (method === 'update') return call(`shim.list.update(${recv.code}${argList ? `, ${argList}` : ''})`, { list: true, map: true, sideEffect: true });
  if (method === 'containKey') return call(`shim.list.containsKey(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'containsValue') return call(`shim.list.containsValue(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'deleteKey') return call(`shim.list.deleteKey(${recv.code}, ${args[0]?.code ?? 'undefined'})`, { list: recv.list, map: recv.map });
  if (method === 'deleteKeys') return call(`shim.list.deleteKeys(${recv.code}, ${args[0]?.code ?? '[]'})`, { list: recv.list, map: recv.map });
  if (method === 'getKey') return call(`shim.list.getKey(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'getLastKey') return call(`shim.list.getLastKey(${recv.code}, ${args[0]?.code ?? 'undefined'})`);
  if (method === 'getJson') return call(`shim.list.getJson(${recv.code}, ${args[0]?.code ?? 'null'})`);
  if (method === 'equalsIgnoreCase') return call(`shim.string.equalsIgnoreCase(${recv.code}, ${args[0]?.code ?? 'null'})`);
  if (BLANK_FUNCTIONS.has(method)) return call(`shim.isBlank(${recv.code})`);
  // reverse() returns TEXT for both call forms; a non-text input is converted
  // to text first (functions/string/reverse.html — its list example returns
  // "31, 2, 1" and leaves the input as it was). No documented rule decides a
  // list's text form here (Deluge `toString()` of a list is its JSON text,
  // which cannot yield "1, 2, 13"), so a list — like a map, query, or date
  // value — stays an untranslated call.
  if (method === 'reverse' && (recv.list || recv.map || recv.query || recv.date)) {
    return mergeFx(`await shim.todo(ctx, "method:reverse")`, [recv, ...args], {
      shim: true,
      todo: true,
      constructs: ['method:reverse'],
    });
  }
  if (TEXT_FUNCTIONS.has(method) && textish) return call(`shim.string.${method}(${recv.code}${argList ? `, ${argList}` : ''})`);
  // `find` is `indexOf` (functions/string/find lists both spellings).
  if (method === 'find' && textish) return call(`shim.list.indexOf(${recv.code}${argList ? `, ${argList}` : ''})`);
  if (method === 'subList' && !recv.query) return call(`shim.list.subList(${recv.code}${argList ? `, ${argList}` : ''})`, { list: true });
  if (method === 'containsIgnoreCase') return call(`shim.string.containsIgnoreCase(${recv.code}, ${args[0]?.code ?? 'null'})`);
  if (method === 'largest') return call(`shim.number.largest(${recv.code})`);
  if (method === 'smallest') return call(`shim.number.smallest(${recv.code})`);
  // A string literal cannot be null, so it keeps the native method. Any other
  // receiver may be null: the shim treats null as empty text and returns false
  // instead of throwing.
  if (method === 'startsWith' && textish && !recv.text) return call(`shim.string.startsWith(${recv.code}${argList ? `, ${argList}` : ''})`);
  if (method === 'endsWith' && textish && !recv.text) return call(`shim.string.endsWith(${recv.code}${argList ? `, ${argList}` : ''})`);

  const stringJs = dispatchGet(NATIVE_STRING_JS, method);
  if (stringJs && textish) return mergeFx(`${recv.code}.${stringJs}(${argList})`, [recv, ...args]);
  if (method === REPLACE_FIRST) return mergeFx(`shim.string.replaceFirst(${recv.code}, ${argList})`, [recv, ...args], { shim: true });
  if (method === 'put' && recv.map && args.length >= 2) {
    return mergeFx(`(shim.set(${recv.code}, ${args[0]!.code}, ${args[1]!.code}))`, [recv, ...args], { map: true, shim: true });
  }
  // A computed receiver (ifnull, a fetched row, a getJson result) is still a
  // map at run time; the shim dispatches on the runtime shape.
  if (method === 'put' && args.length >= 2 && !recv.query) {
    return call(`shim.list.put(${recv.code}, ${argList})`, { list: recv.list, map: recv.map });
  }
  return null;
}

/** Deluge operator → JS. Null-prototype: `toString` must not be Object.prototype.toString. */
const BINARY_JS: Record<string, string> = Object.assign(Object.create(null), {
  '&&': '&&',
  and: '&&',
  '||': '||',
  or: '||',
  '=': '==',
  '==': '==',
  '!=': '!=',
  is: '==',
  'is not': '!=',
});

function binary(op: string, left: Fx, right: Fx): Fx {
  // Date + text is concatenation, not date arithmetic: the date's text form
  // joined to the string, as `concat` does (deluge-docs/pages/functions__string__concat.html,
  // https://www.zoho.com/deluge/help/functions/string/concat.html).
  if (op === '+' && (left.text || right.text)) {
    const l = left.date ? `shim.date.text(${left.code}, ctx)` : left.code;
    const r = right.date ? `shim.date.text(${right.code}, ctx)` : right.code;
    return mergeFx(`(${l} + ${r})`, [left, right], { shim: left.date || right.date, text: true });
  }
  if ((left.date || right.date) && (op === '-' || op === '+')) {
    if (op === '-' && left.date && right.date) return mergeFx(`shim.date.diffDays(${left.code}, ${right.code}, ctx)`, [left, right], { shim: true });
    if (op === '+' && (left.date || right.date)) {
      if (left.date) {
        const dur = tryApplyDuration(left.code, right.code);
        if (dur) return mergeFx(dur, [left, right], { shim: true, date: true });
      }
      if (right.date) {
        const dur = tryApplyDuration(right.code, left.code);
        if (dur) return mergeFx(dur, [left, right], { shim: true, date: true });
      }
      if (left.date) return mergeFx(`shim.date.addDay(${left.code}, ${right.code}, ctx)`, [left, right], { shim: true, date: true });
      return mergeFx(`shim.date.addDay(${right.code}, ${left.code}, ctx)`, [left, right], { shim: true, date: true });
    }
  }
  if ((left.date || right.date) && ['==', '!=', '=', '<', '>', '<=', '>='].includes(op)) {
    const js = op === '=' ? '==' : op;
    // Relational ops go through `rel`. `null <op> date` is false
    // (`date.cmp.*-null`). A date against null, both blank, or text that is
    // not a date throws "UnParsable date". Emitting `(cmp <= 0)` is the JS
    // coercion `null <= 0` (true). Equality stays a boolean: Deluge `== null`
    // is documented.
    return mergeFx(`shim.date.rel(${left.code}, ${right.code}, ${JSON.stringify(js)}, ctx)`, [left, right], {
      shim: true,
    });
  }
  if ((left.decimal || right.decimal) && ['+', '-', '*', '/'].includes(op)) {
    const fn = op === '+' ? 'add' : op === '-' ? 'sub' : op === '*' ? 'mul' : 'div';
    return mergeFx(`shim.decimal.${fn}(${left.code}, ${right.code})`, [left, right], { shim: true, decimal: true });
  }
  if ((left.decimal || right.decimal) && ['<', '>', '<=', '>=', '=', '==', '!=', 'is', 'is not'].includes(op)) {
    const js = op === '=' || op === 'is' ? '==' : op === 'is not' ? '!=' : op;
    if ((left.code === 'null' || right.code === 'null') && (js === '==' || js === '!=')) {
      return mergeFx(`(${left.code} ${js} ${right.code})`, [left, right]);
    }
    return mergeFx(`shim.decimal.cmp(${left.code}, ${right.code}, ${JSON.stringify(js)})`, [left, right], { shim: true });
  }
  if ((left.lookup || right.lookup) && (op === '==' || op === '=' || op === 'is' || op === '!=' || op === 'is not')) {
    // A lookup field holds a reference object; equality tests its id/label,
    // not object identity (`Field == "display"`).
    const fn = op === '!=' || op === 'is not' ? 'ne' : 'eq';
    return mergeFx(`shim.compare.${fn}(${left.code}, ${right.code})`, [left, right], { shim: true });
  }
  if (op === 'in' || op === 'not in') {
    if (right.todo) return untranslatedMethod('in', right, [left]);
    // Not Array.includes: a bigint id (toLong, or a literal past 2^53) must match its digit text.
    return mergeFx(`${op === 'not in' ? '!' : ''}shim.list.contains(${right.code}, ${left.code})`, [left, right], { shim: true });
  }
  if (op === 'not in') {
    if (right.todo) return untranslatedMethod('not in', right, [left]);
    return mergeFx(`!shim.list.contains(${right.code}, ${left.code})`, [left, right], { shim: true });
  }
  const js = dispatchGet(BINARY_JS, op) ?? op;
  return mergeFx(`(${left.code} ${js} ${right.code})`, [left, right]);
}

/** Leaf (op, field) pairs of a criteria, mirroring {@link criteria}. Audit only. */
function criteriaLeaves(e: Expr, scope: Scope, out: { op: string; field: string }[]): void {
  if (e.kind === 'paren') return criteriaLeaves(e.expr, scope, out);
  if (e.kind === 'binary' && (e.op === '&&' || e.op === 'and' || e.op === '||' || e.op === 'or')) {
    criteriaLeaves(e.left, scope, out);
    criteriaLeaves(e.right, scope, out);
    return;
  }
  if (e.kind === 'unary' && (e.op === '!' || e.op === 'not')) return criteriaLeaves(e.expr, scope, out);
  if (e.kind === 'binary') {
    const field = fieldPath(e.left, scope);
    if (field) out.push({ op: e.op === '=' ? '==' : e.op === 'is' ? 'isNull' : e.op === 'is not' ? 'notNull' : e.op === 'not in' ? 'in' : e.op, field });
    return;
  }
  if (e.kind === 'call' && e.callee.kind === 'member') {
    const field = fieldPath(e.callee.object, scope);
    if (field) out.push({ op: e.callee.property, field });
  }
}

/** Full-row stages when one SELECT cannot cover the row, or null. */
function stagedFullRead(scope: Scope, form: string | undefined | null): string[] | null {
  if (!form || !scope.schema) return null;
  return plainRecordStages(scope.schema, form);
}

function queryInvoke(form: string | undefined | null, criteriaCode: string, scope: Scope, extraOpts: readonly string[]): string {
  const opts = [...extraOpts];
  const staged = stagedFullRead(scope, form);
  if (staged) opts.push(`zcql: ${JSON.stringify(staged)}`);
  const opt = opts.length ? `, { ${opts.join(', ')} }` : '';
  return `shim.datastore.query(ctx, ${JSON.stringify(form ?? '')}, ${criteriaCode}${opt})`;
}

function criteriaExpr(e: Extract<Expr, { kind: 'criteria' }>, scope: Scope): Fx {
  const form = staticName(e.object);
  const sink = decimalAuditSink();
  if (sink) {
    const leaves: { op: string; field: string }[] = [];
    criteriaLeaves(e.criteria, scope, leaves);
    sink.queries.push({ form: form ?? '', leaves, ...(e.sort ? { sort: e.sort.field } : {}) });
  }
  const c = criteria(e.criteria, scope);
  const opts: string[] = [];
  if (e.sort) {
    const fields = e.sort.fields
      ? `, fields: [${e.sort.fields.map((k) => `{ field: ${JSON.stringify(k.field)}${k.dir ? `, dir: ${JSON.stringify(k.dir)}` : ''} }`).join(', ')}]`
      : '';
    opts.push(`sort: { field: ${JSON.stringify(e.sort.field)}${e.sort.dir ? `, dir: ${JSON.stringify(e.sort.dir)}` : ''}${fields} }`);
  }
  if (e.range) {
    const from = expr(e.range.from, scope);
    const to = expr(e.range.to, scope);
    opts.push(`range: { from: ${from.code}, to: ${to.code} }`);
    const constructs = [...c.constructs, ...from.constructs, ...to.constructs];
    if (!form) constructs.push('form-dynamic');
    const code = queryInvoke(form, c.code, scope, opts);
    const q = mergeFx(code, [c, from, to], {
      shim: true,
      serverOnly: true,
      query: true,
      ranged: true,
      todo: c.todo || !form,
      constructs,
      rowReads: rowsRowRead(e, code, scope),
    });
    q.clientRange = {
      from,
      to,
      code: queryInvoke(form, c.code, scope, [
        ...opts.slice(0, -1),
        'range: { from: ctx.rangeFrom, to: ctx.rangeTo }',
      ]),
    };
    return q;
  }
  const constructs = [...c.constructs];
  if (!form) constructs.push('form-dynamic');
  const code = queryInvoke(form, c.code, scope, opts);
  return mergeFx(code, [c], {
    shim: true,
    serverOnly: true,
    query: true,
    todo: c.todo || !form,
    constructs,
    rowReads: rowsRowRead(e, code, scope),
  });
}

/** sendmail keys whose value is an address or address list. */
const MAIL_ADDRESS_KEYS = new Set(['from', 'to', 'cc', 'bcc', 'reply to']);
/** invokeurl `type :GET` names the verb; a bare name is not a variable. */
const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

function mailOrHttp(ns: 'mail' | 'http', fn: string, entries: Param[], scope: Scope): Fx {
  const parts = entries.map((en) => {
    const key = en.key.toLowerCase();
    if (ns === 'http' && key === 'type' && en.value.kind === 'name' && HTTP_VERBS.has(en.value.name.toUpperCase()) && !scope.local.has(en.value.name)) {
      return { key, v: fx({ code: JSON.stringify(en.value.name.toUpperCase()) }) };
    }
    if (ns === 'http' && key === 'connection') {
      const literal = stringLiteral(en.value);
      if (literal != null) {
        const resolved = resolveConnectionArgument(literal, scope.connections);
        if (resolved.kind === 'display') return { key, v: fx({ code: JSON.stringify(resolved.link), text: true }) };
      }
    }
    const v = ns === 'mail' && MAIL_ADDRESS_KEYS.has(key) ? mailAddressValue(en.value, scope) : expr(en.value, scope);
    return { key, v };
  });
  const code = `await shim.${ns}.${fn}(ctx, { ${parts.map((p) => `${JSON.stringify(p.key)}: ${p.v.code}`).join(', ')} })`;
  return mergeFx(code, parts.map((p) => p.v), { shim: true, serverOnly: true, sideEffect: true });
}

/** `to`/`cc`/`bcc`/`reply to` accept a comma-separated list (https://www.zoho.com/deluge/help/misc-statements/send-mail.html). */
function mailAddressValue(e: Expr, scope: Scope): Fx {
  if (e.kind === 'list') {
    const els = e.elements.map((x) => mailAddressScalar(x, scope));
    return mergeFx(`[${els.map((x) => x.code).join(', ')}]`, els, { list: true });
  }
  return mailAddressScalar(e, scope);
}

/** Paren-form workflow exports quote `zoho.adminuserid`; it is the variable, not a literal address. */
function mailAddressScalar(e: Expr, scope: Scope): Fx {
  const match = e.kind === 'string' ? /^zoho\.(\w+)$/i.exec(e.value) : null;
  const env = match?.[1] ? dispatchGet(ZOHO_ENV, match[1].toLowerCase()) : undefined;
  if (env) return fx({ code: `shim.zoho.${env}(ctx)`, shim: true });
  return expr(e, scope);
}

/**
 * `attachments:` spec → a typed descriptor list the mail adapter can inspect.
 * `file:` entries carry the uploaded/invoked file expression. `template: ... as
 * inline` renders server-side into the mail body and `template: ... as pdf`
 * renders the same layout into a PDF attachment (`rendered` matching the
 * format, record defaulting to `input`). `view:` and `report:` are Creator
 * renders with no Catalyst Mail equivalent yet: the descriptor stays in the
 * message and a `sendmail-attachment:<kind>` note reports it instead of
 * silently dropping the attachment.
 * https://www.zoho.com/deluge/help/misc-statements/send-mail.html
 */
function mailAttachmentsFx(e: Extract<Expr, { kind: 'mailAttachments' }>, scope: Scope): Fx {
  const parts: Fx[] = [];
  const notes: string[] = [];
  const codes: string[] = [];
  for (const item of e.items) {
    if (item.type === 'file') {
      const v = item.value
        ? expr(item.value, scope)
        : fx({ code: 'null', todo: true, constructs: ['sendmail-attachment:file'] });
      parts.push(v);
      codes.push(`{ kind: "file", file: ${v.code} }`);
      continue;
    }
    if (item.type === 'template' && (item.format === 'inline' || item.format === 'pdf')) {
      // `template: ... as inline` renders the layout into the mail body and
      // `as pdf` into a PDF attachment (c2c-mail.mjs), so neither carries the
      // residual note. View/report renders stay counted for a later step.
      let record = 'shim.input.root(ctx)';
      let shimRecord = true;
      if (item.record) {
        const r = expr(item.record, scope);
        parts.push(r);
        record = r.code;
        shimRecord = false;
      }
      const format = JSON.stringify(item.format);
      codes.push(
        `{ kind: "template", name: ${JSON.stringify(item.name ?? '')}, form: ${JSON.stringify(item.form ?? null)}, record: ${record}, format: ${format}, rendered: ${format} }`,
      );
      if (shimRecord) parts.push(fx({ code: record, shim: true }));
      continue;
    }
    notes.push(`sendmail-attachment:${item.type}`);
    if (item.type === 'template') {
      let record = 'null';
      if (item.record) {
        const r = expr(item.record, scope);
        parts.push(r);
        record = r.code;
      }
      codes.push(
        `{ kind: "template", name: ${JSON.stringify(item.name ?? '')}, form: ${JSON.stringify(item.form ?? null)}, record: ${record}, format: ${JSON.stringify(item.format ?? null)} }`,
      );
      continue;
    }
    let c = 'null';
    if (item.criteria) {
      const f = criteria(item.criteria, scope);
      parts.push(f);
      c = f.code;
    }
    codes.push(
      `{ kind: ${JSON.stringify(item.type)}, name: ${JSON.stringify(item.name ?? '')}, criteria: ${c}, format: ${JSON.stringify(item.format ?? null)} }`,
    );
  }
  return mergeFx(`[${codes.join(', ')}]`, parts, { list: true, notes });
}

function targetLit(e: Expr, scope: Scope): Fx {
  const path = memberPath(e);
  if (e.kind === 'name') return fx({ code: JSON.stringify(e.name) });
  if (path) return fx({ code: JSON.stringify(path.root === 'input' ? path.path.join('.') : [path.root, ...path.path].join('.')) });
  const v = expr(e, scope);
  return v;
}

function applyOp(op: string, left: Fx, right: Fx): Fx {
  return binary(op, left, right);
}
