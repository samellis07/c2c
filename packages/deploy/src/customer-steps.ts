import { connectionSecretItem } from './human-steps.js';

/**
 * The steps only the customer can take, in order — every place that lists
 * them (deploy and provision output, the plugin skills, README and
 * docs) uses this exact text. packages/deploy/test/customer-steps.test.ts
 * holds them to it.
 */
export const CUSTOMER_STEPS: readonly string[] = [
  'Accept invite: accept the app invite mail',
  'Sign in once: sign in to the deployed app once',
  "Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)",
  'Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)',
];

/** The steps still ahead, numbered as in the full list, one per line. */
export function formatCustomerSteps(): string {
  return CUSTOMER_STEPS.map((step, i) => `  ${i + 1}. ${step}\n`).join('');
}

/**
 * The customer's steps a provision plan ends with, unnumbered: what
 * `c2c plan` lists in plan.md and what `c2c provision` prints once every step
 * is done. The mail step applies only when the plan carries the mail-sender
 * step. Connection secrets add one item naming the keys.
 */
export function planCustomerSteps(steps: readonly { id: string }[], opts: { connectionSecretKeys?: readonly string[] } = {}): string[] {
  const mail = steps.some((step) => step.id === 'mail-sender');
  const items = CUSTOMER_STEPS.filter((step) => mail || !step.startsWith('Verify mail sender:'));
  if (opts.connectionSecretKeys?.length) items.push(connectionSecretItem(opts.connectionSecretKeys));
  return items;
}
