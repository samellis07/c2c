/**
 * Quality gate Q4: every generated handler runs without an uncaught JS error.
 *
 * A handler is an exported generated function whose first parameter is `ctx`
 * (`handle`, `prefetch`, `clientActions`, custom functions). Each runs on a
 * dry-run shim runtime with seeded in-memory Data Store rows, a fixed clock,
 * and records from IR field types (inputs.ts). Iteration 0..4 fix one variant
 * for every field (valid, null, empty, boundary, wrong-type); later
 * iterations draw a variant per field. Subform and seeded row counts cycle
 * 0 / 1 / n.
 *
 * Outcome per call:
 *   crash      TypeError, ReferenceError, RangeError, SyntaxError, a timeout,
 *              or a non-Error throw. Fails the gate.
 *   deluge     A shim error that maps to a Creator runtime message
 *              (DELUGE_ERROR_NAMES). Allowed.
 *   unmapped   Any other Error subclass or plain Error (for example a shim
 *              `date: unsupported literal`). Allowed by Q4, counted: it has
 *              no Creator message yet.
 */
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Form } from '../../core/src/index.js';
import { createRuntime, type Runtime } from '../../shims/src/index.js';
import type { GeneratedTree } from './modules.js';
import { ROW_COUNTS, VARIANTS, paramValue, pick, recordFor, rng, seedRows, signatureParams, slotValue, type Variant } from './inputs.js';
import { materialize, sortedCounts } from './static.js';

export const CRASH_NAMES: ReadonlySet<string> = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError']);
export const DELUGE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'DelugeRuntimeError',
  'DelugeConversionError',
  'DeleteRefused',
  // cancel submit: Creator stops the submit with its alert; not a fault.
  'SubmitRefused',
  'RangeIndexError',
  'RecordAccessError',
  'ZcqlRowCapError',
  'EncryptedCriteriaError',
  'NonexistentLocalTime',
  'TimeZoneRequired',
  'MissingRowIdError',
]);

/** Iteration cap for `npm test`. The gallery sweep passes its own. */
export const DEFAULT_ITERATIONS = 6;
export const DEFAULT_SEED = 'c2c-q4';
const CALL_TIMEOUT_MS = 2000;
const FIXED_NOW = new Date('2026-01-15T10:00:00Z');

export type Outcome = 'ok' | 'crash' | 'deluge' | 'unmapped';

export interface SmokeFinding {
  path: string;
  handler: string;
  iteration: number;
  /** Input variant for every field, or `mixed`; `import` when the module did not load. */
  mode: Variant | 'mixed' | 'import';
  outcome: Exclude<Outcome, 'ok'>;
  /** Error name, `Timeout`, or `NonError`. */
  errorClass: string;
  /** Normalized message plus the throwing frame (generated module or shim file), no values. */
  signature: string;
}

export interface SmokeCleanReport {
  /** True when no handler crashed. */
  ok: boolean;
  handlers: number;
  calls: number;
  /** Handlers with at least one crash. */
  handlersWithCrash: number;
  /** Handlers that crash on the all-valid input (iteration 0) or fail to import. */
  handlersCrashOnValid: number;
  /** Error class → handlers that crashed with it. */
  crashByClass: Record<string, number>;
  /** Error class → calls ending in an allowed Deluge-mapped error. */
  delugeByClass: Record<string, number>;
  /** Error class → calls ending in an error with no Creator mapping. */
  unmappedByClass: Record<string, number>;
  /** Handler modules that failed to import (counted as crashes). */
  importFailures: number;
}

/** Message with quoted text, numbers and long identifiers replaced, so one bug is one signature. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .slice(0, 160);
}

function frameOf(err: unknown, dir: string): string {
  const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
  for (const line of stack.split('\n').slice(1)) {
    const m = /\((.*?):\d+:\d+\)$/.exec(line.trim()) ?? /at (.*?):\d+:\d+$/.exec(line.trim());
    if (!m) continue;
    let file = m[1]!.replace(/^file:\/\//, '');
    if (file.startsWith('node:')) continue;
    if (file.includes(dir)) {
      file = file.slice(file.indexOf(dir) + dir.length + 1);
      // functions/aio/<form>/<event>.mjs → functions/aio. The deploy tree nests the
      // generated functions under functions/c2c_api/; the bucket stays aio, custom, flow.
      const parts = file.replace(/^functions\/c2c_api\//, 'functions/').split('/');
      return `generated:${parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0]}`;
    }
    const at = file.indexOf('/dist/');
    if (at >= 0) return file.slice(at + 6).replace(/\.js$/, '');
    return 'other';
  }
  return 'unknown';
}

export function classify(err: unknown, dir: string): { outcome: Exclude<Outcome, 'ok'>; errorClass: string; signature: string } {
  if (!(err instanceof Error)) {
    return { outcome: 'crash', errorClass: 'NonError', signature: `NonError: ${typeof err}` };
  }
  const name = err.name || 'Error';
  const outcome = name === 'Timeout' || CRASH_NAMES.has(name) ? 'crash' : DELUGE_ERROR_NAMES.has(name) ? 'deluge' : 'unmapped';
  return { outcome, errorClass: name, signature: `${name}: ${normalizeMessage(err.message)} @ ${frameOf(err, dir)}` };
}

class Timeout extends Error {
  constructor() {
    super(`handler did not settle in ${CALL_TIMEOUT_MS} ms`);
    this.name = 'Timeout';
  }
}

async function settle(p: unknown): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Timeout()), CALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const HANDLER_RE = /^export (?:async )?function\s+(\w+)\s*\(\s*ctx\b/gm;

/** Parameter names after `ctx` of exported function `name`. */
export function extraParams(text: string, name: string): string[] {
  const m = new RegExp(`^export (?:async )?function\\s+${name}\\s*\\(\\s*ctx\\s*,?([^)]*)\\)`, 'm').exec(text);
  return m ? m[1]!.split(',').map((p) => p.trim()).filter(Boolean) : [];
}

/** Deluge signature the generator copies into a custom function header. */
export function verbatimSignature(text: string): string | undefined {
  return /^ \* Signature \(verbatim\): (.*)$/m.exec(text)?.[1];
}

/** Exported functions whose first parameter is `ctx`. */
export function handlerNames(text: string): string[] {
  return [...text.matchAll(HANDLER_RE)].map((m) => m[1]!);
}

function formOf(mod: Record<string, unknown>, app: App): Form | undefined {
  const fromExports =
    (typeof mod.formName === 'string' && mod.formName) ||
    (mod.c2cHandler && typeof (mod.c2cHandler as { form?: unknown }).form === 'string' && (mod.c2cHandler as { form: string }).form) ||
    (mod.schedule && typeof (mod.schedule as { form?: unknown }).form === 'string' && (mod.schedule as { form: string }).form) ||
    (mod.endpoint && typeof (mod.endpoint as { path?: unknown }).path === 'string' && /^\/forms\/([^/]+)\//.exec((mod.endpoint as { path: string }).path)?.[1]) ||
    '';
  return app.forms.find((f) => f.name === fromExports);
}

export interface SmokeOptions {
  iterations?: number;
  seed?: string;
  /** Existing materialized tree (static.ts `materialize`). Not removed. */
  dir?: string;
}

export async function smokeApp(app: App, tree: GeneratedTree, opts: SmokeOptions = {}): Promise<{ report: SmokeCleanReport; details: SmokeFinding[] }> {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const seed = opts.seed ?? DEFAULT_SEED;
  const dir = opts.dir ?? materialize(tree);
  const details: SmokeFinding[] = [];
  const crashByClass: Record<string, number> = {};
  const delugeByClass: Record<string, number> = {};
  const unmappedByClass: Record<string, number> = {};
  let handlers = 0;
  let calls = 0;
  let handlersWithCrash = 0;
  let handlersCrashOnValid = 0;
  let importFailures = 0;
  try {
    const loaded: { m: GeneratedTree['modules'][number]; names: string[]; mod: Record<string, unknown> }[] = [];
    for (const m of tree.modules) {
      if (m.copyOf || m.kind === 'ui') continue;
      const names = handlerNames(m.text);
      if (!names.length) continue;
      try {
        loaded.push({ m, names, mod: (await import(pathToFileURL(join(dir, m.path)).href)) as Record<string, unknown> });
      } catch (err) {
        importFailures++;
        for (const name of names) {
          handlers++;
          handlersWithCrash++;
          handlersCrashOnValid++;
          const c = classify(err, dir);
          crashByClass[c.errorClass] = (crashByClass[c.errorClass] ?? 0) + 1;
          details.push({ path: m.path, handler: name, iteration: -1, mode: 'import', outcome: 'crash', errorClass: c.errorClass, signature: `import ${c.signature}` });
        }
      }
    }
    // Client handlers fetch slots from POST <path>; answer with the generated server prefetch for that path.
    const prefetchByPath = new Map<string, (ctx: unknown) => unknown>();
    for (const { mod } of loaded) {
      const path = (mod.endpoint as { path?: unknown } | undefined)?.path;
      if (typeof mod.prefetch === 'function' && typeof path === 'string') prefetchByPath.set(path, mod.prefetch as (ctx: unknown) => unknown);
    }
    for (const { m, names, mod } of loaded) {
      const form = formOf(mod, app);
      for (const name of names) {
        const fn = mod[name];
        if (typeof fn !== 'function') continue;
        handlers++;
        const crashed = new Set<string>();
        let crashedOnValid = false;
        // Arity from the generated JS; Deluge types by position from the verbatim signature.
        const types = signatureParams(verbatimSignature(m.text));
        const paramNames = extraParams(m.text, name);
        const params = paramNames.map((_, i) => types[i]?.type ?? '');
        // A form-typed parameter the body iterates is the selected-record collection.
        const iterated = paramNames.map((p) => m.text.includes(`shim.each(ctx, ${p})`));
        // A subform row event fires on one row of that subform: the first, when it has any.
        const subformField = /shim\.subform\.currentRow\(ctx, ("(?:[^"\\]|\\.)*")\)/.exec(m.text)?.[1];
        const subformRow = subformField ? { field: JSON.parse(subformField) as string, index: 0 } : undefined;
        for (let i = 0; i < iterations; i++) {
          const r = rng(`${seed}|${app.name ?? ''}|${m.path}|${name}|${i}`);
          const mode: Variant | 'mixed' = i < VARIANTS.length ? VARIANTS[i]! : 'mixed';
          const subformRows = ROW_COUNTS[i % ROW_COUNTS.length]!;
          const record = recordFor(form, mode, r, { subformRows });
          const old = recordFor(form, 'valid', r, { subformRows: pick(r, ROW_COUNTS) });
          const slots = new Map<string, unknown>();
          const principal = { profile: 'Administrator', userId: 'user@example.com', loginUser: 'user' };
          const runtime: Runtime = createRuntime({
            dryRun: true,
            now: FIXED_NOW,
            appTimeZone: 'UTC',
            seed: seedRows(app, pick(r, ROW_COUNTS), r),
            // A function's client handler sends its arguments with the prefetch (ctx.args).
            clientPrefetch: async (path, nonce, request) => {
              const server = prefetchByPath.get(path);
              if (server) return { nonce, slots: await server(runtime.context({ record, old, principal, formNonce: nonce, subformRow, args: request?.args })) };
              // No generated prefetch for the path: any slot gets a seeded value.
              const proxy = new Proxy(
                {},
                {
                  get(_t, key) {
                    if (typeof key !== 'string') return undefined;
                    if (!slots.has(key)) slots.set(key, slotValue(r));
                    return slots.get(key);
                  },
                },
              );
              return { nonce, slots: proxy };
            },
          });
          const ctx = runtime.context({
            record,
            old,
            principal,
            row: form ? { __row: true, form: form.name, values: record } : undefined,
            rowId: i % 2 ? '3000000000001' : '',
            subformRow,
          });
          const extra = params.map((type, p) => {
            const variant = mode === 'mixed' ? pick(r, VARIANTS) : mode;
            const recordForm = app.forms.find((f) => f.name.toLowerCase() === type);
            if (!recordForm) return paramValue(type, variant, r);
            if (variant === 'null') return null;
            if (!iterated[p]) return recordFor(recordForm, variant, r, { subformRows });
            return Array.from({ length: subformRows }, () => recordFor(recordForm, variant, r, { subformRows }));
          });
          calls++;
          try {
            await settle((fn as (...a: unknown[]) => unknown)(ctx, ...extra));
          } catch (err) {
            const c = classify(err, dir);
            if (c.outcome === 'crash') {
              crashed.add(c.errorClass);
              if (mode === 'valid') crashedOnValid = true;
            }
            else if (c.outcome === 'deluge') delugeByClass[c.errorClass] = (delugeByClass[c.errorClass] ?? 0) + 1;
            else unmappedByClass[c.errorClass] = (unmappedByClass[c.errorClass] ?? 0) + 1;
            details.push({ path: m.path, handler: name, iteration: i, mode, ...c });
          }
        }
        if (crashed.size) handlersWithCrash++;
        if (crashedOnValid) handlersCrashOnValid++;
        for (const cls of crashed) crashByClass[cls] = (crashByClass[cls] ?? 0) + 1;
      }
    }
  } finally {
    if (!opts.dir) rmSync(dir, { recursive: true, force: true });
  }
  return {
    report: {
      ok: handlersWithCrash === 0,
      handlers,
      calls,
      handlersWithCrash,
      handlersCrashOnValid,
      crashByClass: sortedCounts(crashByClass),
      delugeByClass: sortedCounts(delugeByClass),
      unmappedByClass: sortedCounts(unmappedByClass),
      importFailures,
    },
    details,
  };
}

