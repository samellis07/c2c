import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { ALLOWED_ENV, catalystProjectName, type GuardOk } from '../src/guards.js';
import type { ProjectRegistry } from '../src/registry.js';
import { deployFiles, type DeployFile } from '../src/plan.js';

const root = repoRoot();

/** Known synthetic email domains are deliberately used throughout examples and tests. */
const SYNTHETIC_EMAIL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'example.test', 'test.invalid']);

/**
 * Generated app files and source fixtures must not contain credentials or real
 * customer identifiers. Keep the rules deliberately narrow enough to permit
 * documented placeholders and synthetic fixture data.
 */
function generatedSecretFindings(text: string): string[] {
  const findings: string[] = [];
  const rules: [string, RegExp][] = [
    ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
    ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/i],
    ['provider token', /\b(?:sk_live|sk_test|gh[pousr]_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{8,}/i],
    ['credential assignment', /\b(?:client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[=:]\s*["'](?!\$\{|\$[A-Z_]|<|FILL_)[^"']{6,}["']/i],
    ['long numeric org id', /\b\d{10,}\b/],
  ];
  for (const [label, pattern] of rules) if (pattern.test(text)) findings.push(label);
  for (const match of text.matchAll(/[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g)) {
    if (!SYNTHETIC_EMAIL_DOMAINS.has(match[1]!.toLowerCase())) findings.push('non-synthetic email');
  }
  return findings;
}

function assertSecretFree(label: string, text: string): void {
  assert.deepEqual(generatedSecretFindings(text), [], `${label} contains a credential or real identifier`);
}

async function sampleAppSource(): Promise<string> {
  const fixture = await import(new URL('../../../fixtures/sample-app/sample-app.mjs', import.meta.url).href) as {
    sampleItemForm(): string[];
    sampleItemReport(): string[];
    sampleWorkflow(): string[];
  };
  return [
    'application "sample-app"', '{', '\ttime zone = "Asia/Kolkata"',
    '\tforms', '{', ...fixture.sampleItemForm(), '}',
    '\treports', '{', ...fixture.sampleItemReport(), '}',
    ...fixture.sampleWorkflow(), '}', '',
  ].join('\n');
}

function guardFor(app: ReturnType<typeof deriveIr>): GuardOk {
  const org = '10000000000';
  const registry: ProjectRegistry = { org, env: 'Development', projects: {}, dc: 'in' };
  return {
    org,
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: catalystProjectName(app.name || 'app'),
    dc: 'in',
    registry,
  };
}

function generatedText(files: readonly DeployFile[]): string {
  return files.map((file) => `${file.path}\n${typeof file.data === 'string' ? file.data : file.data.toString('utf8')}`).join('\n');
}

test('sample and synthetic app generation keeps secrets and real identifiers out of generated output', async () => {
  const sampleSource = await sampleAppSource();
  const syntheticSource = readFileSync(join(root, 'fixtures/synthetic/kitchen-sink/kitchen_sink.ds'), 'utf8');
  for (const [name, source] of [['sample-app fixture', sampleSource], ['kitchen-sink fixture', syntheticSource]] as const) {
    assertSecretFree(name, source);
    const app = deriveIr(parse(source));
    const files = deployFiles(app, guardFor(app), false, { mode: 'live' }).files;
    assertSecretFree(`${name} generated app`, generatedText(files));
  }
});

test('generated-output scanner catches a planted token', () => {
  const planted = 'const leaked = "sk_live_planted-secret-value-012345";';
  assert.ok(generatedSecretFindings(planted).includes('provider token'));
  assert.throws(() => assertSecretFree('planted output', planted), /credential or real identifier/);
});
