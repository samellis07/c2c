import { translate } from './translate.js';

export interface ServerConditionOptions {
  /** Names supplied by the caller as bound (never interpolated) parameters. */
  inputFields?: string[];
  decimalFields?: string[];
  /** Lookup-type fields, forwarded to the inner translate for `==` on record references. */
  lookupFields?: string[];
  name?: string;
}

const FORBIDDEN = /\b(?:insert|update|delete|sendmail|invokeurl|invokeUrl|http(?:get|post|put|delete)?|http)\s*(?:\.|\()/i;

function withoutLiterals(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

function returnExpression(server: string): string | null {
  const match = /^(?:\/\/.*\n)*return\s+([\s\S]*);$/.exec(server.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Emit a read-only Catalyst function for a client condition that needs server data.
 * A null result is deliberate: callers retain the condition as a counted TODO.
 */
export function emitServerConditionFunction(condition: string, options: ServerConditionOptions = {}): string | null {
  if (!condition.trim() || FORBIDDEN.test(withoutLiterals(condition))) return null;
  // determinism-allow: Set keeps first-seen order of the caller's field list, which is source order
  const inputFields = [...new Set(options.inputFields ?? [])].filter((name) => /^[$A-Za-z_][$\w]*$/.test(name));
  const translated = translate(`return (${condition});`, {
    inputFields,
    decimalFields: options.decimalFields ?? [],
    lookupFields: options.lookupFields ?? [],
    serverOnly: true,
  });
  if (translated.todos.length || translated.server.includes('shim.todo(') || translated.client.trim()) return null;
  let expression = returnExpression(translated.server);
  if (!expression) return null;
  // `inputFields` normally read from the browser input shim. Server functions
  // receive those values as typed parameters, so bind the translated reads to
  // the parameter identifiers without interpolating caller data.
  for (const field of inputFields) {
    expression = expression.replace(new RegExp(`shim\\.input\\.get\\(ctx, ${JSON.stringify(field)}\\)`, 'g'), field);
  }
  const name = options.name ?? 'evaluateCondition';
  if (!/^[$A-Za-z_][$\w]*$/.test(name)) return null;
  return `async function ${name}(ctx, shim, ${inputFields.join(', ')}) {\n  return { value: Boolean(await (${expression})) };\n}`;
}

/** Compatibility alias for callers that describe this as generating a function. */
export const generateServerConditionFunction = emitServerConditionFunction;

/** False when the source names a write or callout the read-only envelope must never hold. */
export function serverConditionSafeSource(source: string): boolean {
  return !!source.trim() && !FORBIDDEN.test(withoutLiterals(source));
}

/**
 * Wrap an already-translated server expression — plus the replayed bindings
 * its names need — in the same read-only `{ value }` envelope
 * {@link emitServerConditionFunction} emits. The caller vetted both for the
 * same refusal set (no todos, no writes, no side-effect calls, no record or
 * `old` reads beyond the bound parameters).
 */
export function emitServerConditionFromCode(expression: string, prelude: readonly string[] = [], params: readonly string[] = [], name = 'evaluateCondition'): string | null {
  if (!/^[$A-Za-z_][$\w]*$/.test(name)) return null;
  const fields = params.filter((p, i) => /^[$A-Za-z_][$\w]*$/.test(p) && params.indexOf(p) === i);
  if (fields.length !== params.length || !expression.trim()) return null;
  const head = prelude.map((line) => `  ${line}\n`).join('');
  return `async function ${name}(ctx, shim${fields.length ? `, ${fields.join(', ')}` : ''}) {\n${head}  return { value: Boolean(await (${expression})) };\n}`;
}
