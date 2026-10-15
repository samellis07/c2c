import { ACTIVATION_SERVICES, activationSentence, FIRST_USE_GATES, type ActivationServiceId } from './first-use.js';
import { connectionSecretItem } from './human-steps.js';

/**
 * The steps only the customer can take, in order — every place that lists
 * them (deploy and provision output, the plugin skills, README and
 * docs) uses this exact text. packages/deploy/test/customer-steps.test.ts
 * holds them to it.
 */
export const CUSTOMER_STEPS: readonly string[] = [
  'Start services: for each service the app uses (Stratus, SmartBrowz, Slate), in the Catalyst console open the project → its page → Start Exploring',
  'Accept invite: accept the app invite mail',
  'Sign in once: sign in to the deployed app once',
  "Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)",
  'Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)',
];

/**
 * Step 1 for one app: one activation sentence per service still to start, in
 * checklist order; undefined when the app uses none of them or all are started.
 */
export function startServicesStep(pending: readonly ActivationServiceId[]): string | undefined {
  return pending.length ? `Start services: ${pending.map(activationSentence).join('; ')}` : undefined;
}

/**
 * The steps still ahead, numbered as in the full list, one per line. Without
 * `pending` step 1 is the general wording; with it step 1 names exactly those
 * services, and is skipped when there are none.
 */
export function formatCustomerSteps(pending?: readonly ActivationServiceId[]): string {
  const steps = pending === undefined ? [...CUSTOMER_STEPS] : [startServicesStep(pending), ...CUSTOMER_STEPS.slice(1)];
  return steps.map((step, i) => (step === undefined ? '' : `  ${i + 1}. ${step}\n`)).join('');
}

/**
 * The customer's steps a provision plan ends with, unnumbered: what
 * `c2c plan` lists in plan.md and what `c2c provision` prints once every step
 * is done. Step 1 names only the services whose gate step the plan carries
 * (the app uses them) and that are not in `started`; with none it is dropped.
 * The mail step applies only when the plan carries the mail-sender step.
 * Connection secrets add one item naming the keys.
 */
export function planCustomerSteps(
  steps: readonly { id: string }[],
  opts: { started?: readonly ActivationServiceId[]; connectionSecretKeys?: readonly string[] } = {},
): string[] {
  const mail = steps.some((step) => step.id === 'mail-sender');
  const started = new Set<ActivationServiceId>(opts.started ?? []);
  const pending = ACTIVATION_SERVICES.filter(
    (id) => steps.some((step) => step.id === FIRST_USE_GATES[id].stepId) && !started.has(id),
  );
  const start = startServicesStep(pending);
  const items = [
    ...(start ? [start] : []),
    ...CUSTOMER_STEPS.slice(1).filter((step) => mail || !step.startsWith('Verify mail sender:')),
  ];
  if (opts.connectionSecretKeys?.length) items.push(connectionSecretItem(opts.connectionSecretKeys));
  return items;
}
