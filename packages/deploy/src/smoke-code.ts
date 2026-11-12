/**
 * The c2c smoke result code: the whole c2c-smoke/1 block the #/admin/smoke
 * page prints, packed into one copy-safe token the user pastes into their AI
 * chat (or `c2c smoke --result-code <code>`). It is the same block, not a
 * summary — `c2c smoke` unpacks it and runs the same verifier as `--result`.
 *
 *   c2cs1 <mode> <payload> <check>
 *   - `c2cs1`  fixed prefix (c2c smoke, code version 1)
 *   - mode     `k` / `c`: the compact form, deflate-raw / plain (the page
 *              writes `c` only where the browser has no CompressionStream);
 *              `z` / `j`: the whole block JSON, deflate-raw / plain (c2c's
 *              fallback for a block the page would never print)
 *   - payload  base64url, no padding, of the canonical (sorted-key) JSON
 *   - check    6 chars: base64url of the first 4 bytes of SHA-256 over
 *              prefix + mode + payload, so a mistyped or cut-short code is
 *              named as such before anything is unpacked
 *
 * The compact form is `[rest, steps]`: the block without `steps` and
 * `digest`, and each step as `[label, ok ? 1 : 0, detail]`, where a label or
 * detail that is a string of the smoke plan (a step label or skip reason) is
 * its index in that plan's string list. The digest is not carried: it is
 * SHA-256 over the rest, so unpacking recomputes it, and the plan strings come
 * from the plan this source produces — the block's own plan digest says which
 * plan that must be. Unpacked, the code is the block byte-for-byte.
 *
 * Only [A-Za-z0-9_-] — no whitespace, URL-safe. Like the block's digest the
 * check is a checksum, not a signature.
 */
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { smokeCanonical, smokePlanDigest, smokeSha256 } from './smoke-result.js';

export const SMOKE_CODE_PREFIX = 'c2cs1';
const CHECK_CHARS = 6;
/** Largest block a code may unpack to — the page's block is a few KiB. */
const MAX_BLOCK_BYTES = 256 * 1024;
const CODE_CHARS = /^[A-Za-z0-9_-]+$/;
const AGAIN = "press Copy on the app's #/admin/smoke page and paste the whole code again";
const STEP_KEYS = ['detail', 'label', 'ok'];

type Step = { label: string; ok: boolean; detail: string };
type Tuple = [string | number, 0 | 1, string | number];

function checkOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest().subarray(0, 4).toString('base64url');
}

/** The plan's strings a step may repeat: each step's label and skip reason, in plan order. */
export function smokePlanStrings(plan: unknown): string[] {
  const out: string[] = [];
  for (const step of Array.isArray(plan) ? plan : []) {
    if (!step || typeof step !== 'object') continue;
    const { label, reason } = step as { label?: unknown; reason?: unknown };
    if (typeof label === 'string') out.push(label);
    if (typeof reason === 'string') out.push(reason);
  }
  return out;
}

function isStep(value: unknown): value is Step {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  return Object.keys(step).sort().join() === STEP_KEYS.join() && typeof step.label === 'string' && typeof step.ok === 'boolean' && typeof step.detail === 'string';
}

/** The compact form, when the block is the shape the page prints and its digest holds; else undefined. */
function compactOf(block: unknown, plan: unknown): [Record<string, unknown>, Tuple[]] | undefined {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const { steps, digest, ...rest } = block as Record<string, unknown>;
  if (!Array.isArray(steps) || !steps.every(isStep)) return undefined;
  if (typeof digest !== 'string' || digest !== smokeSha256(smokeCanonical({ ...rest, steps }))) return undefined;
  const strings = plan !== undefined && rest.plan === smokePlanDigest(plan) ? smokePlanStrings(plan) : [];
  const ref = (text: string) => {
    const at = strings.indexOf(text);
    return at >= 0 ? at : text;
  };
  return [rest, steps.map((step): Tuple => [ref(step.label), step.ok ? 1 : 0, ref(step.detail)])];
}

/** Pack a block the way the page does: compact and deflated when it can be. */
export function encodeSmokeCode(block: unknown, opts: { plan?: unknown; deflate?: boolean } = {}): string {
  const compact = compactOf(block, opts.plan);
  const raw = Buffer.from(smokeCanonical(compact ?? block), 'utf8');
  const packed = opts.deflate === false ? undefined : deflateRawSync(raw, { level: 9 });
  const small = packed && packed.length < raw.length;
  const mode = compact ? (small ? 'k' : 'c') : small ? 'z' : 'j';
  const body = `${SMOKE_CODE_PREFIX}${mode}${(small ? packed : raw).toString('base64url')}`;
  return `${body}${checkOf(body)}`;
}

/**
 * The code in pasted text: the whole text with any line wrapping removed, else
 * the first c2cs1… run in it. Undefined when the text holds no code (a JSON
 * block, say).
 */
export function findSmokeCode(text: string): string | undefined {
  const squeezed = text.replace(/^﻿/, '').replace(/\s+/g, '');
  if (squeezed.startsWith(SMOKE_CODE_PREFIX) && !squeezed.includes('{')) return squeezed;
  if (text.includes('{')) return undefined;
  return /c2cs1[A-Za-z0-9_-]*/.exec(text)?.[0];
}

export type SmokeCodeDecode = { ok: true; json: string } | { ok: false; reason: string };

const UNPACK = `the result code does not unpack to a c2c-smoke/1 block — ${AGAIN}`;

/** Rebuild the block from the compact form; a reason when it cannot be. */
function expand(value: unknown, plan: unknown): SmokeCodeDecode {
  if (!Array.isArray(value) || value.length !== 2) return { ok: false, reason: UNPACK };
  const [rest, tuples] = value as [unknown, unknown];
  if (!rest || typeof rest !== 'object' || Array.isArray(rest) || 'steps' in rest || 'digest' in rest || !Array.isArray(tuples)) return { ok: false, reason: UNPACK };
  const fields = rest as Record<string, unknown>;
  const usesPlan = tuples.some((tuple) => Array.isArray(tuple) && (typeof tuple[0] === 'number' || typeof tuple[2] === 'number'));
  if (usesPlan && (plan === undefined || fields.plan !== smokePlanDigest(plan))) {
    return { ok: false, reason: 'the block ran a different smoke plan than this source produces (redeploy, then rerun the page)' };
  }
  const strings = usesPlan ? smokePlanStrings(plan) : [];
  const text = (ref: unknown): string | undefined => (typeof ref === 'string' ? ref : Number.isInteger(ref) && (ref as number) >= 0 && (ref as number) < strings.length ? strings[ref as number] : undefined);
  const steps: Step[] = [];
  for (const tuple of tuples) {
    if (!Array.isArray(tuple) || tuple.length !== 3 || (tuple[1] !== 0 && tuple[1] !== 1)) return { ok: false, reason: UNPACK };
    const label = text(tuple[0]);
    const detail = text(tuple[2]);
    if (label === undefined || detail === undefined) return { ok: false, reason: UNPACK };
    steps.push({ label, ok: tuple[1] === 1, detail });
  }
  const block = { ...fields, steps };
  return { ok: true, json: JSON.stringify({ ...block, digest: smokeSha256(smokeCanonical(block)) }) };
}

/**
 * Unpack a code to the block's JSON text. `plan` is the smoke plan this source
 * produces (a compact code names the plan's strings by index). Never throws:
 * every bad code gets a reason.
 */
export function decodeSmokeCode(input: string, plan?: unknown): SmokeCodeDecode {
  const code = input.replace(/\s+/g, '');
  if (!code.startsWith(SMOKE_CODE_PREFIX)) return { ok: false, reason: `the result code does not start with ${SMOKE_CODE_PREFIX} — ${AGAIN}` };
  if (!CODE_CHARS.test(code)) return { ok: false, reason: `the result code holds characters a result code never has (only letters, digits, - and _) — ${AGAIN}` };
  if (code.length < SMOKE_CODE_PREFIX.length + 1 + 2 + CHECK_CHARS) return { ok: false, reason: `the result code is cut short — ${AGAIN}` };
  const body = code.slice(0, -CHECK_CHARS);
  if (checkOf(body) !== code.slice(-CHECK_CHARS)) return { ok: false, reason: `the result code is mistyped or cut short (its check characters do not match) — ${AGAIN}` };
  const mode = code.charAt(SMOKE_CODE_PREFIX.length);
  if (!'kczj'.includes(mode)) return { ok: false, reason: `the result code has format letter ${JSON.stringify(mode)}, which this c2c does not read — update c2c or rerun the page` };
  const bytes = Buffer.from(body.slice(SMOKE_CODE_PREFIX.length + 1), 'base64url');
  let raw: Buffer;
  try {
    raw = mode === 'k' || mode === 'z' ? inflateRawSync(bytes, { maxOutputLength: MAX_BLOCK_BYTES }) : bytes;
  } catch {
    return { ok: false, reason: UNPACK };
  }
  if (raw.length > MAX_BLOCK_BYTES) return { ok: false, reason: 'the result code unpacks to more than a c2c-smoke/1 block can be' };
  const json = raw.toString('utf8');
  if (mode === 'z' || mode === 'j') return { ok: true, json };
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, reason: UNPACK };
  }
  return expand(value, plan);
}
