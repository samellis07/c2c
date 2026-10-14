/**
 * Golden parity comparison and the shrinking baseline file.
 *
 * Imported by packages/deluge/test/golden.test.ts and tests/golden/baseline.mjs.
 * Imports compiled dist/, so `npm run build` must have run first.
 * The case catalog is the committed tests/golden/cases.json.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { translate } from '../../dist/deluge/src/translate.js';
import { DelugeDate } from '../../dist/shims/src/date.js';
import { Decimal } from '../../dist/shims/src/decimal.js';
import { createRuntime, DRY_RUN_ADMIN_USER_ID } from '../../dist/shims/src/runtime.js';
import { DEFAULT_SUCCESS_BANNER } from '../../packages/ui/src/client-runtime.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The committed golden case catalog (tests/golden/cases.json). */
export const cases = JSON.parse(readFileSync(join(root, 'tests/golden/cases.json'), 'utf8')).cases;

/**
 * Creator's if() treats isNull(bool) as criteria. That call returns null, so
 * every bool that reached the capture encoder came back as this error. These
 * ids are a capture artifact, not Creator semantics, and stay out of the
 * compared vector set until recaptured.
 */
export const BOOL_CAPTURE_ARTIFACT_ERROR =
  'Function specified in criteria has returned null value and it cannot be evaluated';

/** Bool case ids hit by the capture artifact (listed under "invalid" in vectors.json). */
export const BOOL_CAPTURE_ARTIFACTS = [
  'isEmpty.list-empty',
  'isEmpty.list-nonempty',
  'isEmpty.map-empty',
  'isEmpty.map-nonempty',
  'isEmpty.string-empty',
  'isEmpty.string-nonempty',
  'isEmpty.string-space',
  'isEmpty.fn-empty-string',
  'isNumber.int',
  'isNumber.negative',
  'isNumber.decimal-string',
  'isNumber.decimal-value',
  'isNumber.text',
  'isNumber.empty',
  'isNumber.space',
  'isNumber.scientific',
  'contains.string-hit',
  'contains.string-case',
  'contains.string-empty',
  'contains.list-hit',
  'contains.list-miss',
  'startsWith.hit',
  'startsWith.miss',
  'startsWith.empty',
  'endsWith.hit',
  'endsWith.miss',
  'containKey.hit',
  'containKey.miss',
  'containKey.null-value',
  'date.cmp.gt',
  'date.cmp.eq',
  'date.cmp.lt-null',
  'date.cmp.gt-null',
  'date.cmp.lte-null',
  'date.cmp.gte-null',
  'isNull.null',
  'isNull.empty-string',
  'isNull.zero',
  'isBlank.empty',
  'isBlank.null',
  'isBlank.space',
  'isBlank.zero',
];

/** True when a saved vector is the bool-encoder artifact, not a Creator result. */
export function isCaptureArtifact(id, value) {
  if (!BOOL_CAPTURE_ARTIFACTS.includes(id)) return false;
  const blob = typeof value === 'string' ? value : JSON.stringify(value);
  return blob.includes(BOOL_CAPTURE_ARTIFACT_ERROR);
}

const ZONE = 'Asia/Calcutta';
const CLOCK = '2026-10-06T08:30:00.000Z';

/** Typed rows of a committed criteria CSV. Header names the fields; cells are 'true'/'false', integers, or text. */
function criteriaCsvRows(file) {
  const lines = readFileSync(join(root, file), 'utf8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const row = {};
    line.split(',').forEach((cell, i) => {
      row[headers[i]] = cell === 'true' ? true : cell === 'false' ? false : /^-?\d+$/.test(cell) ? Number(cell) : cell;
    });
    return row;
  });
}

/**
 * Four synthetic GoldenRow rows (same order as criteria-data.json and
 * criteria-goldenrow.csv) plus the FlagRow rows the criteria cases query.
 * CSV row order is the submit order, so it is the dry-run insertion order.
 */
function goldenSeed() {
  const doc = JSON.parse(readFileSync(join(root, 'tests/golden/data-rows.json'), 'utf8'));
  if (!doc || doc.form !== 'GoldenRow' || !Array.isArray(doc.rows)) {
    throw new Error('tests/golden/data-rows.json must be { form: "GoldenRow", rows }');
  }
  const goldenCsv = criteriaCsvRows('tests/golden/criteria-goldenrow.csv');
  if (!isDeepStrictEqual(goldenCsv, doc.rows)) {
    throw new Error('tests/golden/criteria-goldenrow.csv and tests/golden/data-rows.json disagree on GoldenRow');
  }
  return { GoldenRow: doc.rows, FlagRow: criteriaCsvRows('tests/golden/criteria-flagrow.csv') };
}

const GOLDEN_SEED = goldenSeed();

export const BASELINE_FILE = 'tests/golden/parity-baseline.json';

/** Recapture path, relative to C2C_FIXTURES_DIR (see resolveFixturesDir). */
export const RECAPTURE_FILE = 'golden/recapture.json';

/** Same fixture directory as the recapture. Overlays after recapture.json. */
export const RESIDUAL_FILE = 'golden/residual.json';

/** Same fixture directory as residual. Overlays after residual.json. */
export const SUBMIT_FILE = 'golden/submit.json';

/** Leading // lines. JSON.parse cannot keep them; readers strip this header. */
export const BASELINE_HEADER = `// Parity baseline: case ids whose Creator vector does not match the shim.
// A listed id that still fails is a known gap (the harness reports it as todo, not a failure).
// A listed id that passes fails the suite with "remove <id> from parity-baseline.json".
// The list only shrinks. An unlisted id that fails is a real failure.
// Regenerate with \`npm run golden:baseline\`. Adding ids requires --allow-add.
// Generated. Ids are sorted. Do not add ids by hand.`;

export function shrinkMessage(id) {
  return `remove ${id} from parity-baseline.json`;
}

/**
 * @param {boolean} compared  vector present and not a pending capture artifact
 * @param {boolean} matches
 * @param {boolean} inBaseline
 * @returns {'pending' | 'pass' | 'fail' | 'known-gap' | 'shrink'}
 */
export function parityVerdict(compared, matches, inBaseline) {
  if (!compared) return inBaseline ? 'shrink' : 'pending';
  if (matches) return inBaseline ? 'shrink' : 'pass';
  return inBaseline ? 'known-gap' : 'fail';
}

/** Creator's capture prefix is not part of the runtime message. */
const LINE_PREFIX = /^Error at line : \d+, /;

/** Drop `Error at line : N, ` from a captured `$error`. Other values pass through. */
export function stripCreatorLinePrefix(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (typeof value.$error !== 'string' || !LINE_PREFIX.test(value.$error)) return value;
  return { ...value, $error: value.$error.replace(LINE_PREFIX, '') };
}

export function sameValue(actual, expected) {
  return isDeepStrictEqual(stripCreatorLinePrefix(actual), stripCreatorLinePrefix(expected));
}

function canon(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $nan: true };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof DelugeDate) return { $date: value.toString() };
  if (value instanceof Decimal) return { $decimal: value.toString() };
  if (Array.isArray(value)) return value.map((item) => canon(item));
  if (typeof value === 'object') {
    const rec = value;
    if (rec.__query === true) return { $query: true, form: rec.form ?? null };
    const out = {};
    for (const key of Object.keys(rec).sort()) out[key] = canon(rec[key]);
    return out;
  }
  return { $error: 'unencodable' };
}

function clientOps(client) {
  return [...client.matchAll(/op:\s*"([^"]+)"/g)].map((match) => match[1]).filter((op) => op.length > 0);
}

async function runServer(server, runtime) {
  const ctx = runtime.context({ appTimeZone: ZONE });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    'shim',
    'ctx',
    'actions',
    `${server}\nreturn typeof golden === 'undefined' ? undefined : golden;`,
  );
  return fn(runtime.shim, ctx, []);
}

/** Node output for one case. This is the shim, not Creator. */
export async function evaluateCase(entry) {
  const runtime = createRuntime({ dryRun: true, appTimeZone: ZONE, now: new Date(CLOCK), seed: GOLDEN_SEED });
  const translated = translate(entry.script);
  if (entry.capture === 'mock') {
    await runServer(translated.server, runtime);
    const mail = runtime.transcript.find((item) => item.op === 'sendmail');
    return {
      $sendmail: {
        performed: mail?.performed === true,
        dryRun: mail?.dryRun !== false,
      },
    };
  }
  if (entry.capture === 'client') return { $client: clientOps(translated.client) };
  if (entry.capture === 'workflow') return { $workflow: 'on success', $client: clientOps(translated.client) };
  try {
    return canon(await runServer(translated.server, runtime));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { $error: message };
  }
}

/** Accept a raw function return, a `{ cases }` wrapper, a quoted JSON string, or `c2c<TAB>` info lines. */
export function parseVectors(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
    let value = JSON.parse(trimmed);
    if (typeof value === 'string') value = JSON.parse(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('golden vectors must be a JSON object');
    }
    if (value.cases && typeof value.cases === 'object' && !Array.isArray(value.cases)) {
      return value.cases;
    }
    return value;
  }
  const out = {};
  let found = false;
  for (const line of trimmed.split(/\r?\n/)) {
    const at = line.indexOf('c2c\t');
    if (at < 0) continue;
    const rest = line.slice(at + 4);
    const tab = rest.indexOf('\t');
    if (tab < 0) throw new Error(`golden info line is missing a value: ${line}`);
    const id = rest.slice(0, tab);
    out[id] = JSON.parse(rest.slice(tab + 1));
    found = true;
  }
  if (!found) throw new Error('golden vectors were not a JSON object or c2c info lines');
  return out;
}

/**
 * Compared cases, plus ids that must stay pending.
 * `invalid: { id: "capture-artifact" }` records the bool-encoder bug.
 * That id is pending only while it has no stored case value, or while the
 * stored value is the criteria-null artifact error. An invalid mark does not
 * keep a later true, false, null, or different `$error` pending.
 * The same error string on an artifact id is pending even with no invalid map.
 * Returned `$error` strings have the Creator `Error at line : N, ` prefix removed.
 */
export function vectorStatus(text, artifactIds) {
  const parsed = parseVectors(text);
  const pending = new Set();
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
    let raw = JSON.parse(trimmed);
    if (typeof raw === 'string') raw = JSON.parse(raw);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const invalid = raw.invalid;
      if (invalid && typeof invalid === 'object' && !Array.isArray(invalid)) {
        for (const [id, mark] of Object.entries(invalid)) {
          if (mark !== 'capture-artifact') continue;
          const stored = Object.prototype.hasOwnProperty.call(parsed, id);
          if (!stored || isCaptureArtifact(id, parsed[id])) pending.add(id);
        }
      }
    }
  }
  for (const id of artifactIds) {
    if (Object.prototype.hasOwnProperty.call(parsed, id) && isCaptureArtifact(id, parsed[id])) pending.add(id);
  }
  const cases = {};
  for (const [id, value] of Object.entries(parsed)) cases[id] = stripCreatorLinePrefix(value);
  return { cases, pending };
}

/** Outer JSON object, or the flat id map when the file is info lines. */
function parseVectorDocument(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('"')) {
    let value = JSON.parse(trimmed);
    if (typeof value === 'string') value = JSON.parse(value);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('golden vectors must be a JSON object');
    }
    return value;
  }
  return parseVectors(text);
}

/**
 * Recapture keys replace the same ids. A base `{ cases }` wrapper is kept,
 * including its `invalid` map. The overlay may be a raw object, a wrapper,
 * a quoted JSON string, or `c2c<TAB>` info lines.
 */
export function mergeRecaptureText(baseText, recaptureText) {
  const overlay = parseVectors(recaptureText);
  const base = parseVectorDocument(baseText);
  if (base.cases && typeof base.cases === 'object' && !Array.isArray(base.cases)) {
    return JSON.stringify({ ...base, cases: { ...base.cases, ...overlay } });
  }
  return JSON.stringify({ ...base, ...overlay });
}

/**
 * Directory that holds golden/vectors.json, golden/recapture.json, and
 * golden/residual.json: C2C_FIXTURES_DIR (even when that directory is empty).
 * Null when it is unset. No default location is assumed.
 * @param {string} [_rootDir]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function resolveFixturesDir(_rootDir = root, env = process.env) {
  const fromEnv = env.C2C_FIXTURES_DIR;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return null;
}

function caseCount(text) {
  return Object.keys(parseVectors(text)).length;
}

/**
 * Committed or local vectors, with recapture.json overlaid when present,
 * then residual.json overlaid the same way, then submit.json overlaid after residual.
 * A later key replaces the same id.
 * @param {string} [rootDir]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadVectorBundle(rootDir = root, env = process.env) {
  const fixturesDir = resolveFixturesDir(rootDir, env);
  const committedFile = join(rootDir, 'tests/golden/vectors.json');
  const localFile = fixturesDir ? join(fixturesDir, 'golden/vectors.json') : null;
  const useLocal = Boolean(localFile && existsSync(localFile));
  const baseFile = useLocal ? localFile : committedFile;
  const baseText = readFileSync(baseFile, 'utf8');
  const recaptureFile = fixturesDir ? join(fixturesDir, 'golden/recapture.json') : null;
  const residualFile = fixturesDir ? join(fixturesDir, 'golden/residual.json') : null;
  const submitFile = fixturesDir ? join(fixturesDir, 'golden/submit.json') : null;
  let text = baseText;
  /** @type {{ file: string, count: number } | null} */
  let recapture = null;
  if (recaptureFile && existsSync(recaptureFile)) {
    const recText = readFileSync(recaptureFile, 'utf8');
    text = mergeRecaptureText(text, recText);
    recapture = { file: recaptureFile, count: caseCount(recText) };
  }
  /** @type {{ file: string, count: number } | null} */
  let residual = null;
  if (residualFile && existsSync(residualFile)) {
    const residualText = readFileSync(residualFile, 'utf8');
    text = mergeRecaptureText(text, residualText);
    residual = { file: residualFile, count: caseCount(residualText) };
  }
  /** @type {{ file: string, count: number } | null} */
  let submit = null;
  if (submitFile && existsSync(submitFile)) {
    const submitText = readFileSync(submitFile, 'utf8');
    text = mergeRecaptureText(text, submitText);
    submit = { file: submitFile, count: caseCount(submitText) };
  }
  return {
    text,
    base: {
      kind: useLocal ? 'local' : 'committed',
      file: baseFile,
      count: caseCount(baseText),
    },
    recapture,
    residual,
    submit,
  };
}

/** One line: committed or local, plus recapture, residual, and submit (when present), each with a count. */
export function formatVectorSources(bundle) {
  const recapture = bundle.recapture ? `recapture ${bundle.recapture.count} ${bundle.recapture.file}` : 'recapture 0';
  const residual = bundle.residual ? `residual ${bundle.residual.count} ${bundle.residual.file}` : 'residual 0';
  const submit = bundle.submit ? `; submit ${bundle.submit.count} ${bundle.submit.file}` : '';
  return `golden vectors: ${bundle.base.kind} ${bundle.base.count} ${bundle.base.file}; ${recapture}; ${residual}${submit}`;
}

/** Local vectors.json replaces the committed file. recapture.json, then residual.json, overlay either. */
export function loadVectorText(rootDir = root, env = process.env) {
  return loadVectorBundle(rootDir, env).text;
}

export function stripBaselineHeader(text) {
  return text.replace(/^\uFEFF/, '').replace(/^(?:\/\/[^\n]*(?:\n|$))+/, '').trim();
}

/** @returns {string[]} case ids, file order preserved */
export function readBaseline(text) {
  let value;
  try {
    value = JSON.parse(stripBaselineHeader(text));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${BASELINE_FILE} is not a JSON array after its // header: ${message}`);
  }
  if (!Array.isArray(value)) throw new Error(`${BASELINE_FILE} must be a JSON array of case ids`);
  const ids = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${BASELINE_FILE} ids must be non-empty strings`);
    }
    if (seen.has(id)) throw new Error(`duplicate parity baseline id ${id}`);
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function loadBaselineIds() {
  const file = join(root, BASELINE_FILE);
  if (!existsSync(file)) return [];
  return readBaseline(readFileSync(file, 'utf8'));
}

export function formatBaseline(ids) {
  const sorted = [...ids].sort();
  return `${BASELINE_HEADER}\n${JSON.stringify(sorted, null, 2)}\n`;
}

export function writeBaseline(ids) {
  const file = join(root, BASELINE_FILE);
  const text = formatBaseline(ids);
  writeFileSync(file, text);
  return text;
}

/**
 * @param {readonly string[]} previous
 * @param {readonly string[]} failing  ids that mismatch right now
 * @param {boolean} allowAdd
 */
export function planBaselineUpdate(previous, failing, allowAdd) {
  const prev = [...previous].sort();
  const nextFailing = [...new Set(failing)].sort();
  const prevSet = new Set(prev);
  const nextSet = new Set(nextFailing);
  const added = nextFailing.filter((id) => !prevSet.has(id));
  const removed = prev.filter((id) => !nextSet.has(id));
  if (added.length > 0 && !allowAdd) {
    return { added, removed, next: null, refused: true };
  }
  return { added, removed, next: nextFailing, refused: false };
}

/** Case ids that have a vector, are not pending artifacts, and do not match. */
export async function failingParityIds(caseList, vectors, pending) {
  const ids = [];
  for (const entry of caseList) {
    const compared = Object.prototype.hasOwnProperty.call(vectors, entry.id) && !pending.has(entry.id);
    if (!compared) continue;
    const actual = await evaluateCase(entry);
    if (!sameValue(actual, vectors[entry.id])) ids.push(entry.id);
  }
  ids.sort();
  return ids;
}

/** Admin email is never committed. Both the shim and a captured To reduce to this class. */
export const ADMIN_ADDRESS = '<admin>';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WRITE_OPS = new Set(['insert', 'update', 'delete', 'setField']);
const SEED_BEA = { Name: 'Bea', Qty: 0, Status: 'Open' };
const SUBMITTED_ZED = { Name: 'Zed', Qty: 1, Status: 'Open' };

function addressClass(value) {
  if (value === DRY_RUN_ADMIN_USER_ID) return ADMIN_ADDRESS;
  return typeof value === 'string' && EMAIL.test(value) ? ADMIN_ADDRESS : value;
}

async function runBody(code, runtime, record) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const actions = [];
  const ctx = runtime.context({ record, appTimeZone: ZONE });
  await new AsyncFunction('shim', 'ctx', 'actions', code)(runtime.shim, ctx, actions);
  return actions;
}

/**
 * Shim output for one submit.json case. Built from the translated script run
 * against the dry-run runtime: the refusal, the client op, the recorded mail.
 * Keys are the fields a dry run can observe. Creator-only fields are not here.
 */
export async function evaluateSubmit(id, shape) {
  const runtime = createRuntime({ dryRun: true, appTimeZone: ZONE, now: new Date(CLOCK), seed: GOLDEN_SEED });
  const translated = translate(shape.paste);
  if (shape.$task === 'cancel delete') {
    let message = null;
    let rowRemains = false;
    try {
      await runBody(translated.server, runtime, SEED_BEA);
    } catch (err) {
      if (err?.code !== 'DELETE_REFUSED') throw err;
      message = err.message;
      rowRemains = true;
    }
    return {
      $workflow: 'on validate',
      $event: 'delete',
      $task: 'cancel delete',
      target: { ...SEED_BEA },
      rowRemains,
      message,
      otherRowsUnchanged: !runtime.transcript.some((item) => WRITE_OPS.has(item.op)),
    };
  }
  if (shape.$task === 'success message') {
    const actions = await runBody(translated.client, runtime, SUBMITTED_ZED);
    const set = actions.find((action) => action.op === 'successMessage');
    return { $workflow: 'on success', $task: 'success message', message: set ? set.message : DEFAULT_SUCCESS_BANNER };
  }
  if (shape.$task === 'sendmail') {
    await runBody(translated.server, runtime, SUBMITTED_ZED);
    const mail = runtime.transcript.find((item) => item.op === 'sendmail');
    if (!mail) throw new Error(`${id}: the dry run recorded no sendmail`);
    const sent = mail.message;
    return {
      $workflow: 'on success',
      $task: 'sendmail',
      headers: { Subject: sent.subject, From: sent.from, To: addressClass(sent.to) },
      body: sent.message,
      formBanner: DEFAULT_SUCCESS_BANNER,
    };
  }
  throw new Error(`${id}: no submit evaluator for ${shape.$task}`);
}

/**
 * The captured Creator value, reduced to the keys `evaluateSubmit` returned.
 * The admin address is reduced to ADMIN_ADDRESS on this side too.
 */
export function submitCapturedView(captured, keys) {
  const out = {};
  for (const key of keys) {
    if (key === 'headers') {
      out.headers = { Subject: captured.headers.Subject, From: captured.headers.From, To: addressClass(captured.headers.To) };
    } else {
      out[key] = captured[key];
    }
  }
  return out;
}
