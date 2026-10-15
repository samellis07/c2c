/**
 * The customer's steps are exactly five, in order: start services, accept invite,
 * sign in once, run the in-app check and paste its code, verify mail sender.
 * Every place that lists them — deploy and provision output, the plugin
 * skills and README — uses the same text.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../core/src/toolchain.js';
import { CUSTOMER_STEPS, formatCustomerSteps, startServicesStep } from '../src/customer-steps.js';
import { ACTIVATION_SERVICES, activationSentence } from '../src/first-use.js';

const EXACT = [
  'Start services: for each service the app uses (Stratus, SmartBrowz, Slate), in the Catalyst console open the project → its page → Start Exploring',
  'Accept invite: accept the app invite mail',
  'Sign in once: sign in to the deployed app once',
  "Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)",
  'Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)',
];

const root = repoRoot();

test('the customer steps are exactly the five, in order', () => {
  assert.deepEqual([...CUSTOMER_STEPS], EXACT);
  assert.deepEqual(
    CUSTOMER_STEPS.map((step) => step.slice(0, step.indexOf(':'))),
    ['Start services', 'Accept invite', 'Sign in once', 'Run the in-app check and paste its code', 'Verify mail sender'],
  );
  assert.equal(formatCustomerSteps(), EXACT.map((step, i) => `  ${i + 1}. ${step}\n`).join(''));
  // An app that uses none of the services (or started them all) starts at step 2, numbered as in the full list.
  assert.equal(formatCustomerSteps([]), EXACT.slice(1).map((step, i) => `  ${i + 2}. ${step}\n`).join(''));
});

/** The exact activation sentence for each service: one pattern, the console page named. */
const ACTIVATION = {
  stratus: 'Stratus — in the Catalyst console open the project → Cloud Scale → Stratus → Start Exploring',
  smartbrowz: 'SmartBrowz — in the Catalyst console open the project → SmartBrowz → Start Exploring',
  slate: 'Slate — in the Catalyst console open the project → Slate → Start Exploring',
} as const;

const REST = EXACT.slice(1).map((step, i) => `  ${i + 2}. ${step}\n`).join('');

test('step 1 names exactly the services the app uses, one sentence each', () => {
  assert.deepEqual([...ACTIVATION_SERVICES], ['stratus', 'smartbrowz', 'slate']);
  for (const id of ACTIVATION_SERVICES) {
    assert.equal(activationSentence(id), ACTIVATION[id]);
    assert.equal(formatCustomerSteps([id]), `  1. Start services: ${ACTIVATION[id]}\n${REST}`, id);
  }
  assert.equal(
    formatCustomerSteps(['stratus', 'smartbrowz', 'slate']),
    `  1. Start services: ${ACTIVATION.stratus}; ${ACTIVATION.smartbrowz}; ${ACTIVATION.slate}\n${REST}`,
  );
  // An app that uses none of them prints no step 1 at all.
  assert.equal(formatCustomerSteps([]), REST);
  assert.equal(startServicesStep([]), undefined);
  assert.doesNotMatch(formatCustomerSteps([]), /Start services|Start Exploring/);
  // Only the named service appears: a Slate-only app never hears of Stratus or SmartBrowz.
  assert.doesNotMatch(formatCustomerSteps(['slate']), /Stratus|SmartBrowz/);
  assert.doesNotMatch(formatCustomerSteps(['stratus']), /Slate|SmartBrowz/);
  // Never a sixth step.
  assert.equal(formatCustomerSteps(['stratus', 'smartbrowz', 'slate']).trimEnd().split('\n').length, 5);
});

test('the plugin skills list exactly these steps', () => {
  const numbered = (indent: string) => EXACT.map((step, i) => `${indent}${i + 1}. ${step}`).join('\n');
  for (const [file, indent] of [
    ['plugin/skills/c2c-verify-and-cutover/SKILL.md', ''],
    ['plugin/skills/c2c-provision-and-deploy/SKILL.md', '  '],
  ] as const) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.ok(text.includes(numbered(indent)), `${file} lists the five customer steps verbatim`);
    for (const sentence of Object.values(ACTIVATION)) assert.ok(text.includes(sentence), `${file} names: ${sentence}`);
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
