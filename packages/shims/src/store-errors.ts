/**
 * Catalyst Data Store error mapping for generated submit handlers.
 *
 * Data Store returns these error shapes:
 * - 409 DUPLICATE_VALUE "Duplicate value for <Field>. Please give a different value"
 * - 403 MANDATORY_MISSING "Column <Field> is mandatory and cannot be empty"
 * - 400 INVALID_INPUT "Invalid input value for <Field>. <type> value expected"
 *
 * The caller gets the mapped HTTP status and a caller-safe message that
 * names the field. Catalyst's own text never crosses the wire.
 * Diagnosis goes to the function logs via logStoreError: code, table, field and request id only — never record values or secrets.
 */
import { jsonReplacer } from './ids.js';

export type StoreErrorCode = 'DUPLICATE_VALUE' | 'MANDATORY_MISSING' | 'INVALID_INPUT';

export interface ClassifiedStoreError {
  code: StoreErrorCode;
  /** Link name of the offending column, or null when it cannot be told. */
  field: string | null;
}

export function storeErrorStatus(code: StoreErrorCode): 409 | 422 | 400 {
  // The store answers 403 for a missing mandatory column; the caller did
  // submit an unprocessable record, so the mapped status is 422.
  if (code === 'DUPLICATE_VALUE') return 409;
  if (code === 'MANDATORY_MISSING') return 422;
  return 400;
}

/**
 * Caller-safe message. Built by c2c, never Catalyst's text: it names the
 * field (or falls back to the form) so the UI can show it field-level.
 */
export function storeErrorMessage(code: StoreErrorCode, field: string | null, table: string): string {
  const where = field ? `field "${field}"` : `form "${table}"`;
  if (code === 'DUPLICATE_VALUE') return `duplicate value for ${where}: use a different value.`;
  if (code === 'MANDATORY_MISSING') return `${field ? `field "${field}"` : `form "${table}"`} is required.`;
  return `${where} has an invalid value.`;
}

const CODES: readonly StoreErrorCode[] = ['DUPLICATE_VALUE', 'MANDATORY_MISSING', 'INVALID_INPUT'];

/**
 * c2c's own errors never classify: their messages can repeat user data
 * (a Deluge conversion error quotes the value it could not cast), and
 * Creator's text for them must still reach the caller unchanged.
 */
const C2C_CODES: ReadonlySet<string> = new Set([
  'DELUGE_RUNTIME',
  'DELUGE_CONVERSION',
  'RECORD_ACCESS_DENIED',
  'DELETE_REFUSED',
  'SUBMIT_REFUSED',
  'ZOHO_CONNECTION_REFUSED',
  'COUNTER_CONTENTION',
  'COUNTER_VALUE',
]);
const C2C_NAMES: ReadonlySet<string> = new Set([
  'DelugeRuntimeError',
  'DelugeConversionError',
  'RecordAccessError',
  'SubmitRefused',
  'CounterContention',
  'CounterValueError',
]);

function isC2cError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, name } = err as { code?: unknown; name?: unknown };
  return (typeof code === 'string' && C2C_CODES.has(code)) || (typeof name === 'string' && C2C_NAMES.has(name));
}

/**
 * The recorded Catalyst message shapes, anchored to the whole message so
 * user data quoted inside some other error text never matches. The field
 * is the first capture.
 */
const MESSAGE_SHAPES: Readonly<Record<StoreErrorCode, RegExp>> = {
  DUPLICATE_VALUE: /^Duplicate value for ([A-Za-z_][A-Za-z0-9_]*)\. Please give a different value\.?$/i,
  MANDATORY_MISSING: /^Column ([A-Za-z_][A-Za-z0-9_]*) is mandatory and cannot be empty\.?$/i,
  INVALID_INPUT: /^Invalid input value for ([A-Za-z_][A-Za-z0-9_]*)\. [A-Za-z]+ value expected\.?$/i,
};

interface Candidates {
  /** Values of code-like keys: matched by equality only. */
  codes: string[];
  /** Message-like texts: matched only against the anchored shapes. */
  messages: string[];
}

/** Code tokens and message texts on the error, including a JSON-string body. */
function candidatesOf(err: unknown): Candidates {
  const out: Candidates = { codes: [], messages: [] };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || value == null) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return;
      if (text.startsWith('{')) {
        try {
          visit(JSON.parse(text), depth + 1);
          return;
        } catch {
          // not a JSON body: an ordinary message
        }
      }
      out.messages.push(text);
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const key of ['code', 'error_code', 'errorCode']) {
      if (typeof record[key] === 'string') out.codes.push(record[key] as string);
    }
    for (const key of ['message', 'error', 'description']) visit(record[key], depth + 1);
    for (const key of ['data', 'body', 'response', 'cause', 'details']) {
      if (record[key] && typeof record[key] === 'object') visit(record[key], depth + 1);
    }
  };
  visit(err, 0);
  return out;
}

function fieldOf(code: StoreErrorCode, messages: readonly string[]): string | null {
  for (const text of messages) {
    const match = MESSAGE_SHAPES[code].exec(text);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * The Catalyst store error behind a failed insert/update, or null when the
 * error is not a recognized store refusal. c2c's own errors (Deluge
 * runtime and conversion, access denials, refusals) never classify. A code
 * token counts only by equality on code/error_code; a bare message counts
 * only when it is exactly one of the recorded store shapes.
 */
/**
 * A field name carried on the error object (write-rules WriteRuleError sets
 * `field` on a refused write). Taken only when it is a column identifier, so
 * arbitrary text never reaches the reply.
 */
function fieldProp(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const field = (err as { field?: unknown }).field;
  return typeof field === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? field : null;
}

export function classifyStoreError(err: unknown): ClassifiedStoreError | null {
  if (!err || (typeof err !== 'object' && typeof err !== 'string')) return null;
  if (isC2cError(err)) return null;
  const { codes, messages } = candidatesOf(err);
  const token = codes.find((value): value is StoreErrorCode => (CODES as readonly string[]).includes(value));
  if (token) return { code: token, field: fieldOf(token, messages) ?? fieldProp(err) };
  for (const code of CODES) {
    const field = fieldOf(code, messages);
    if (field) return { code, field };
  }
  return null;
}

/** Random per-request id for the structured log line. Runtime-only. */
export function newRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Structured function-log line for a mapped store error. Code, table, field
 * and request id only: never Catalyst's text, never record values, never
 * secrets.
 */
export function logStoreError(detail: { code: string; table: string; field: string | null; requestId: string }): void {
  console.error(
    JSON.stringify({
      level: 'error',
      component: 'c2c-store',
      code: detail.code,
      table: detail.table,
      field: detail.field,
      requestId: detail.requestId,
    }),
  );
}

export interface StoreReplyOptions {
  /** True on a live deploy: the reply carries dryRun false. */
  live: boolean;
  /** Table the write targeted, for the log line. */
  table: string;
  /** True when the form row was already stored (post-write script failure). */
  wrote?: boolean;
}

/**
 * Send the mapped store-error reply and log it. Returns true when err was a
 * recognized store refusal (the caller must return), false otherwise so the
 * handler falls through to its generic fail path. The body never carries
 * the runtime transcript: it holds record values, table names and ops.
 */
export function replyStoreError(
  res: { writeHead: (status: number, headers?: Record<string, string>) => void; end: (body: string) => void },
  err: unknown,
  opts: StoreReplyOptions,
): boolean {
  const classified = classifyStoreError(err);
  if (!classified) return false;
  const requestId = newRequestId();
  logStoreError({ code: classified.code, table: opts.table, field: classified.field, requestId });
  const body: Record<string, unknown> = {
    dryRun: !opts.live,
    error: storeErrorMessage(classified.code, classified.field, opts.table),
    requestId,
  };
  if (classified.field) body.field = classified.field;
  if (opts.wrote !== undefined) body.wrote = opts.wrote;
  res.writeHead(storeErrorStatus(classified.code), { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, jsonReplacer));
  return true;
}
