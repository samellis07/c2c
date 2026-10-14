/**
 * The steps only the customer can take, in order — every place that lists
 * them (deploy and provision output, the plugin skills, README and
 * docs) uses this exact text. packages/deploy/test/customer-steps.test.ts
 * holds them to it.
 */
export const CUSTOMER_STEPS: readonly string[] = [
  'Slate start: in the Catalyst console open the project → Slate → Start Exploring',
  'Accept invite: accept the app invite mail',
  'Sign in once: sign in to the deployed app once',
  "Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)",
  'Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)',
];

/** The steps still ahead, numbered as in the full list, one per line. `done` skips the first ones. */
export function formatCustomerSteps(done = 0): string {
  return CUSTOMER_STEPS.map((step, i) => `  ${i + 1}. ${step}\n`)
    .slice(done)
    .join('');
}
