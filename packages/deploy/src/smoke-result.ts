/**
 * `c2c smoke --result <file|->` / `--result-code <code|->`: verify a
 * c2c-smoke/1 block (or the result code that packs it, smoke-code.ts) the
 * user copied from the app's own #/admin/smoke page, run in their normal browser under
 * their own sign-in. Nothing here drives a browser or handles a credential:
 * the input is the printed block, and a block that carries anything shaped
 * like a token, cookie or password is refused without echoing it.
 *
 * The block must be the shape the page prints, name the app origin and the
 * project this deploy targeted, carry the digest of the plan this source
 * produces, be recent, have every step ok, and still match its own digest.
 * The digest is a checksum, not a signature: it catches an edited or cut-off
 * block; the origin, project and plan binding catch a block from elsewhere.
 */
import { createHash } from 'node:crypto';
import { verdict } from './browser.js';
import { decodeSmokeCode, findSmokeCode } from './smoke-code.js';

export const SMOKE_RESULT_VERSION = 'c2c-smoke/1';
/** Default freshness window for a pasted block. */
export const SMOKE_RESULT_MAX_AGE_MINUTES = 60;
/** Clock skew tolerated for a block stamped slightly in the future. */
const FUTURE_SKEW_MS = 5 * 60_000;

const TOP_KEYS = new Set(['version', 'ok', 'created', 'deleted', 'left', 'exercised', 'steps', 'origin', 'app', 'project', 'plan', 'at', 'digest']);
const STEP_KEYS = new Set(['label', 'ok', 'detail']);
const SECRET_KEY = /token|cookie|authorization|password|secret|session[-_]?id|csrf/i;

/** Sorted-key JSON — the same bytes the page hashes (client-runtime smokeCanonical). */
export function smokeCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => smokeCanonical(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${smokeCanonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function smokeSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The plan digest the page stamps: SHA-256 over the canonical JSON of the embedded plan. */
export function smokePlanDigest(plan: unknown): string {
  return smokeSha256(smokeCanonical(JSON.parse(JSON.stringify(plan ?? [])) as unknown));
}

export interface SmokeResultExpect {
  /** The deployed app origin (from the deploy report, else --url). */
  origin: string;
  /** The Catalyst project id the deploy targeted. */
  projectId: string;
  /** The application name in the source. */
  app: string;
  /** The smoke plan this source produces — the page must have run the same plan. */
  plan: unknown;
  /** Submits in the plan — a passing run with fewer creates is refused. */
  submits: number;
  now: number;
  maxAgeMinutes: number;
}

export interface SmokeResultCheck {
  ok: boolean;
  /** Why the block is refused; empty when it verifies. */
  reasons: string[];
  /** One line per step from the block, as the page painted them. */
  lines: string[];
  block?: Record<string, unknown>;
}

/** The JSON object in pasted text: the whole text, or from its first `{` to its last `}`. */
function parseBlock(text: string): unknown {
  const trimmed = text.replace(/^﻿/, '').trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('the input holds no JSON block');
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      throw new Error('the c2c-smoke/1 block is not valid JSON (copy the whole block the page shows)');
    }
  }
}

function hasSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecretKey);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, inner]) => SECRET_KEY.test(key) || hasSecretKey(inner));
  }
  return false;
}

export function verifySmokeResult(text: string, expect: SmokeResultExpect): SmokeResultCheck {
  // A pasted result code is the same block, packed: unpack it, then verify as usual.
  const code = findSmokeCode(text);
  if (code !== undefined) {
    const unpacked = decodeSmokeCode(code, expect.plan);
    if (!unpacked.ok) return { ok: false, reasons: [unpacked.reason], lines: [] };
    text = unpacked.json;
  }
  let parsed: unknown;
  try {
    parsed = parseBlock(text);
  } catch (err) {
    return { ok: false, reasons: [err instanceof Error ? err.message : 'the input is not a c2c-smoke/1 block'], lines: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reasons: ['the input is not a c2c-smoke/1 JSON object'], lines: [] };
  }
  const block = parsed as Record<string, unknown>;
  if (hasSecretKey(block)) {
    // Never echo it back: the field name alone says enough.
    return { ok: false, reasons: ['the block carries a credential-shaped field; c2c smoke never takes a token or cookie — paste only the block the page prints'], lines: [] };
  }
  const reasons: string[] = [];
  const lines: string[] = [];
  const steps = Array.isArray(block.steps) ? block.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const { label, detail, ok } = step as { label?: unknown; detail?: unknown; ok?: unknown };
    const head = typeof label === 'string' ? label : '(unlabelled step)';
    lines.push(`${head}${typeof detail === 'string' && detail ? `: ${detail}` : ''}${ok === false ? ' [failed]' : ''}`);
  }
  if (block.version !== SMOKE_RESULT_VERSION) reasons.push(`the block is not version ${SMOKE_RESULT_VERSION}`);
  const unknown = Object.keys(block).filter((key) => !TOP_KEYS.has(key));
  if (unknown.length) reasons.push(`the block has fields the page never prints: ${unknown.sort().join(', ')}`);
  for (const step of steps) {
    if (step && typeof step === 'object' && Object.keys(step as object).some((key) => !STEP_KEYS.has(key))) {
      reasons.push('a step has fields the page never prints');
      break;
    }
  }
  const failedSteps = steps.filter((step) => step && typeof step === 'object' && (step as { ok?: unknown }).ok !== true);
  if (failedSteps.length) {
    const names = failedSteps.map((step) => String((step as { label?: unknown }).label ?? '?')).slice(0, 5);
    reasons.push(`${failedSteps.length} step(s) did not pass: ${names.join(', ')}`);
  }
  const check = verdict(block, expect.submits);
  // The step failure is already named above; any other verdict reason is added.
  if (!check.ok && !(failedSteps.length && check.reason === 'a step in the JSON block is not ok')) reasons.push(check.reason);

  // Binding: where, what and when it ran.
  if (typeof block.origin !== 'string' || !block.origin) reasons.push('the block names no app origin');
  else if (block.origin !== expect.origin) reasons.push(`the block ran on ${block.origin}, not this deploy's app ${expect.origin}`);
  if (typeof block.project !== 'string' || !block.project) reasons.push('the block names no project (redeploy with this version of c2c so the page stamps it)');
  else if (block.project !== expect.projectId) reasons.push(`the block names project ${block.project}, not this deploy's project ${expect.projectId}`);
  if (block.app !== expect.app) reasons.push(`the block names app ${JSON.stringify(block.app ?? '')}, not ${JSON.stringify(expect.app)}`);
  if (block.plan !== smokePlanDigest(expect.plan)) reasons.push('the block ran a different smoke plan than this source produces (redeploy, then rerun the page)');
  const at = typeof block.at === 'string' ? Date.parse(block.at) : Number.NaN;
  if (!Number.isFinite(at)) reasons.push('the block carries no finish time');
  else if (at > expect.now + FUTURE_SKEW_MS) reasons.push(`the block is stamped in the future (${block.at})`);
  else if (expect.now - at > expect.maxAgeMinutes * 60_000) {
    reasons.push(`the block is stale: it finished at ${block.at}, more than ${expect.maxAgeMinutes} minute(s) ago — rerun the page`);
  }
  // Integrity last, so a block from elsewhere is named for what it is.
  if (typeof block.digest !== 'string' || !/^[0-9a-f]{64}$/.test(block.digest)) reasons.push('the block carries no digest');
  else {
    const { digest, ...rest } = block;
    if (smokeSha256(smokeCanonical(rest)) !== digest) reasons.push('the block does not match its digest: it was edited or cut short after the page printed it');
  }
  return { ok: reasons.length === 0, reasons, lines, block };
}
