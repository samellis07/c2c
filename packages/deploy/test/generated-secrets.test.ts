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
/** RFC 2606 reserved TLDs are synthetic by construction; a mail address ending in one is never real. */
const SYNTHETIC_TLDS = new Set(['example', 'test', 'invalid', 'localhost']);
/** Digit strings the tests and docs use deliberately (the guard org id, sample ids) — not leaked identifiers. */
const SYNTHETIC_IDS = new Set(['10000000000', '1001', '1002']);

function syntheticEmail(domain: string): boolean {
  const lower = domain.toLowerCase();
  return SYNTHETIC_EMAIL_DOMAINS.has(lower) || SYNTHETIC_TLDS.has(lower.split('.').at(-1) ?? '');
}

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
  ];
  for (const [label, pattern] of rules) if (pattern.test(text)) findings.push(label);
  for (const match of text.matchAll(/\b\d{10,}\b/g)) {
    if (!SYNTHETIC_IDS.has(match[0])) findings.push('long numeric org id');
  }
  for (const match of text.matchAll(/[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})/g)) {
    if (!syntheticEmail(match[1]!)) findings.push('non-synthetic email');
  }
  return findings;
}

/**
 * The vendored shims ship compiled library code that carries documented
 * synthetic ids and example addresses; the identifier heuristics do not apply
 * there, while the credential rules still do. A secret value inside a vendored
 * file is still caught by the literal-value check in the env test below.
 */
function fileSecretFindings(path: string, text: string): string[] {
  const findings = generatedSecretFindings(text);
  if (!path.includes('/vendor/')) return findings;
  return findings.filter((finding) => finding !== 'long numeric org id' && finding !== 'non-synthetic email');
}

function assertSecretFree(label: string, text: string): void {
  assert.deepEqual(generatedSecretFindings(text), [], `${label} contains a credential or real identifier`);
}

function assertFilesSecretFree(label: string, files: readonly DeployFile[]): void {
  const findings = files.flatMap((file) => fileSecretFindings(file.path, typeof file.data === 'string' ? file.data : file.data.toString('utf8')).map((finding) => `${file.path}: ${finding}`));
  assert.deepEqual(findings, [], `${label} contains a credential or real identifier`);
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
    assertFilesSecretFree(`${name} generated app`, files);
  }
});

test('generated-output scanner catches a planted token', () => {
  const planted = 'const leaked = "sk_live_planted-secret-value-012345";';
  assert.ok(generatedSecretFindings(planted).includes('provider token'));
  assert.throws(() => assertSecretFree('planted output', planted), /credential or real identifier/);
});

test('a secret --function-env value never reaches any file of the generated output', async () => {
  const app = deriveIr(parse(await sampleAppSource()));
  const secretValue = 'owner-approval-token-value-9f8e7d6c';
  const { files } = deployFiles(app, guardFor(app), false, {
    mode: 'live',
    functionEnv: { C2C_OWNER_APPROVAL_TOKEN: secretValue, C2C_APP_TIMEZONE: 'Asia/Kolkata' },
  });
  const text = generatedText(files);
  assert.ok(!text.includes(secretValue), 'a secret env value leaked into generated output');
  assertFilesSecretFree('generated app with a secret env', files);
  // The name stays as a name-only placeholder so `catalyst deploy` neither
  // erases the variable nor gains the value; non-secret values stay inline.
  const config = JSON.parse(files.find((file) => file.path === 'functions/c2c_api/catalyst-config.json')?.data as string) as {
    deployment: { env_variables: Record<string, string> };
  };
  assert.equal(config.deployment.env_variables.C2C_OWNER_APPROVAL_TOKEN, '');
  assert.equal(config.deployment.env_variables.C2C_APP_TIMEZONE, 'Asia/Kolkata');
  // Negative control: the same value under a non-secret name DOES land in the
  // output — so the absence above is the classification, not dead code.
  const leaked = deployFiles(app, guardFor(app), false, { mode: 'live', functionEnv: { PLAIN_SETTING: secretValue } }).files;
  assert.ok(generatedText(leaked).includes(secretValue));
});
