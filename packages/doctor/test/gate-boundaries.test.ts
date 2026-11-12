/**
 * Gate edges the main suite does not reach: malformed doctor.json values,
 * the exact 12 h boundaries, clock skew, empty scope fields and the
 * required-check list. Each case fails if the matching guard is dropped.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { DOCTOR_MAX_AGE_MS, GATE_REQUIRED_CHECKS, c2cVersion, doctorJsonPath, doctorStamp, evaluateGate, gateRefusalMessage } from '../src/index.js';

const ORG = '10000000000';
const PROJECT = '10000000000013200';
const SCOPE = { dc: 'in', org: ORG, project: PROJECT };
const REQUIRED_IDS = ['D-C1', 'D-C3', 'D-C5', 'D-E1', 'D-B1', 'D-B3', 'D-B5', 'D-B7', 'D-V1', 'D-V2'];
const NOW = new Date('2026-03-01T12:00:00.000Z');

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(`${tmpdir()}/c2c-gate-edges-`);
  dirs.push(dir);
  return dir;
}
process.on('exit', () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function writeRaw(dir: string, text: string): void {
  const path = doctorJsonPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function doctorJson(overrides: Record<string, unknown> = {}, mcp: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    c2c: c2cVersion(),
    at: NOW.toISOString(),
    host: 'claude-code',
    scope: { ...SCOPE },
    checks: REQUIRED_IDS.map((id) => ({ id, status: 'pass', detail: 'ok', fix: null })),
    mcp: { server: 'catalyst-by-zoho', host: 'catalystbyzoho.zohomcp.in', at: NOW.toISOString(), scope: { ...SCOPE }, ...mcp },
    green: true,
    ...overrides,
  };
}

function gate(dir: string, extra: Partial<Parameters<typeof evaluateGate>[0]> = {}) {
  return evaluateGate({ workspace: dir, scope: SCOPE, now: NOW, ...extra });
}

test('gate edges: the baseline file is green at the injected clock', () => {
  const dir = tmp();
  writeRaw(dir, JSON.stringify(doctorJson()));
  assert.equal(gate(dir).status, 'green');
});

test('gate edges: a doctor.json holding null or a bare number is unreadable, and the stamp is not-run', () => {
  for (const text of ['null', '42', '{']) {
    const dir = tmp();
    writeRaw(dir, text);
    assert.equal(gate(dir).status, 'invalid', text);
    assert.equal(doctorStamp({ workspace: dir, now: NOW }).status, 'not-run', text);
  }
});

test('gate edges: green must be the boolean true, not a truthy value', () => {
  for (const green of ['true', 1, undefined]) {
    const dir = tmp();
    writeRaw(dir, JSON.stringify(doctorJson({ green })));
    assert.equal(gate(dir).status, 'red', String(green));
  }
});

test('gate edges: doctor age is inclusive at 12 h, stale 1 ms later, and refused when dated in the future or undated', () => {
  const dir = tmp();
  const mcpNow = { at: NOW.toISOString() };
  writeRaw(dir, JSON.stringify(doctorJson({ at: new Date(NOW.getTime() - DOCTOR_MAX_AGE_MS).toISOString() }, mcpNow)));
  assert.equal(gate(dir).status, 'green');
  writeRaw(dir, JSON.stringify(doctorJson({ at: new Date(NOW.getTime() - DOCTOR_MAX_AGE_MS - 1).toISOString() }, mcpNow)));
  assert.equal(gate(dir).status, 'stale');
  writeRaw(dir, JSON.stringify(doctorJson({ at: new Date(NOW.getTime() + 60_000).toISOString() }, mcpNow)));
  assert.equal(gate(dir).status, 'stale');
  writeRaw(dir, JSON.stringify(doctorJson({ at: 'not a date' }, mcpNow)));
  assert.equal(gate(dir).status, 'stale');
});

test('gate edges: the 12 h window is the documented constant', () => {
  assert.equal(DOCTOR_MAX_AGE_MS, 12 * 60 * 60 * 1000);
});

test('gate edges: an MCP record dated in the future, undated or unparseable is stale', () => {
  for (const at of [new Date(NOW.getTime() + 60_000).toISOString(), undefined, 'yesterday']) {
    const dir = tmp();
    writeRaw(dir, JSON.stringify(doctorJson({}, { at })));
    assert.equal(gate(dir).status, 'stale-mcp', String(at));
  }
  const dir = tmp();
  writeRaw(dir, JSON.stringify(doctorJson({}, { at: new Date(NOW.getTime() - DOCTOR_MAX_AGE_MS).toISOString() })));
  assert.equal(gate(dir).status, 'green');
});

test('gate edges: an empty scope field is unresolved, and the refusal names it', () => {
  const dir = tmp();
  writeRaw(dir, JSON.stringify(doctorJson()));
  const scope = { ...SCOPE, org: '' };
  const verdict = gate(dir, { scope });
  assert.equal(verdict.status, 'scope-missing');
  assert.deepEqual(verdict.missingScope, ['org']);
  assert.match(gateRefusalMessage(verdict, scope), /: missing org$/);
});

test('gate edges: createsProject allows an absent project but not an empty one', () => {
  const dir = tmp();
  const orgScope = { dc: 'in', org: ORG };
  writeRaw(dir, JSON.stringify(doctorJson({ scope: orgScope }, { scope: orgScope })));
  assert.equal(gate(dir, { scope: orgScope, createsProject: true }).status, 'green');
  const verdict = gate(dir, { scope: { ...orgScope, project: '' }, createsProject: true });
  assert.equal(verdict.status, 'scope-missing');
  assert.deepEqual(verdict.missingScope, ['project']);
});

test('gate edges: an empty scope error still refuses', () => {
  const dir = tmp();
  writeRaw(dir, JSON.stringify(doctorJson()));
  assert.equal(gate(dir, { scopeError: '' }).status, 'scope-error');
});

test('gate edges: partial-scope mode compares every field the caller names', () => {
  const dir = tmp();
  writeRaw(dir, JSON.stringify(doctorJson()));
  assert.equal(gate(dir, { scope: { org: ORG }, allowPartialScope: true }).status, 'green');
  assert.equal(gate(dir, { scope: { org: '999' }, allowPartialScope: true }).status, 'scope-mismatch');
  assert.equal(gate(dir, { scope: { dc: 'eu' }, allowPartialScope: true }).status, 'scope-mismatch');
});

test('gate edges: a check with an unknown status refuses, even on a non-required id', () => {
  const dir = tmp();
  const checks = [...REQUIRED_IDS.map((id) => ({ id, status: 'pass', detail: 'ok', fix: null })), { id: 'D-D1', status: 'bogus', detail: 'x', fix: null }];
  writeRaw(dir, JSON.stringify(doctorJson({ checks })));
  assert.equal(gate(dir).status, 'checks');
});

test('gate edges: every required check is needed — dropping any one refuses', () => {
  assert.deepEqual([...GATE_REQUIRED_CHECKS], REQUIRED_IDS);
  for (const missing of REQUIRED_IDS) {
    const dir = tmp();
    const checks = REQUIRED_IDS.filter((id) => id !== missing).map((id) => ({ id, status: 'pass', detail: 'ok', fix: null }));
    writeRaw(dir, JSON.stringify(doctorJson({ checks })));
    assert.equal(gate(dir).status, 'checks', missing);
  }
});
