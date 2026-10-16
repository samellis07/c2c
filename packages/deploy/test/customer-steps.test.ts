/**
 * The customer's steps are exactly four, in order: accept invite, sign in once,
 * run the in-app check and paste its code, verify mail sender. Every place
 * that lists them — deploy and provision output, the plugin skills and README
 * — uses the same text. Slate itself needs no console "Start Exploring" step:
 * Catalyst CLI 1.28.0 deploys a fresh project with `-ni`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import { CUSTOMER_STEPS, formatCustomerSteps } from '../src/customer-steps.js';

const EXACT = [
  'Accept invite: accept the app invite mail',
  'Sign in once: sign in to the deployed app once',
  "Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)",
  'Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)',
];

const root = repoRoot();

test('the customer steps are exactly the four, in order', () => {
  assert.deepEqual([...CUSTOMER_STEPS], EXACT);
  assert.deepEqual(
    CUSTOMER_STEPS.map((step) => step.slice(0, step.indexOf(':'))),
    ['Accept invite', 'Sign in once', 'Run the in-app check and paste its code', 'Verify mail sender'],
  );
  assert.equal(formatCustomerSteps(), EXACT.map((step, i) => `  ${i + 1}. ${step}\n`).join(''));
  assert.doesNotMatch(formatCustomerSteps(), /Start services|Start Exploring|Slate —/);
});

test('the plugin skills list exactly these steps', () => {
  const numbered = (indent: string) => EXACT.map((step, i) => `${indent}${i + 1}. ${step}`).join('\n');
  for (const [file, indent] of [
    ['plugin/skills/c2c-verify-and-cutover/SKILL.md', ''],
    ['plugin/skills/c2c-provision-and-deploy/SKILL.md', '  '],
  ] as const) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.ok(text.includes(numbered(indent)), `${file} lists the four customer steps verbatim`);
    assert.doesNotMatch(text, /Slate — in the Catalyst console open the project → Slate → Start Exploring/, file);
    // No older hand-off survives beside them.
    assert.doesNotMatch(text, /copy the c2c-smoke\/1 block it shows into a file/, file);
  }
  // The deploy and provision CLIs print the shared list rather than their own wording.
  for (const file of ['packages/deploy/src/cli.ts', 'packages/deploy/src/provision.ts']) {
    const source = readFileSync(join(root, file), 'utf8');
    assert.match(source, /CUSTOMER_STEPS|formatCustomerSteps|planCustomerSteps/, file);
    assert.doesNotMatch(source, /accepts the invite mail, the sender email is verified/, file);
  }
});
