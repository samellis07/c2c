/**
 * The per-project human steps, printed as ONE numbered checklist at the end of
 * a deploy or provision run. Every item is an inbox or console action no
 * CLI/API call can do for the user; each is conditional on the app — the
 * sender-email item appears only when the plan says the app sends mail, and
 * the Slate items only when the app ships a Slate web client. Locations are
 * named in words; no screenshot or browser step is needed.
 */

export interface HumanChecklistInput {
  /** The app ships a Slate web client (the plan carries a slate-enable step, or the deploy ran a slate target). */
  slate: boolean;
  /** The app's generated functions send mail — detected from the plan, not a flag. */
  sendsMail: boolean;
  /**
   * The run already confirmed Slate started (a Slate command completed, or
   * the slate-enable step is done). A re-run then drops the Slate start
   * item; the rest keep contiguous numbering.
   */
  slateStarted?: boolean;
}

/** The ordered items. Numbering is the formatter's job, so callers can store this list verbatim. */
export function humanChecklist(input: HumanChecklistInput): string[] {
  const items: string[] = [];
  if (input.slate && !input.slateStarted) {
    items.push(
      'Start Slate once: Catalyst console → the project → Slate → "Start Exploring". A fresh project refuses the first Slate deploy until the service is opened there once.',
    );
  }
  items.push('Accept the admin invite: open the invite mail sent to the admin address and set the password.');
  if (input.slate) {
    items.push('Sign in to the app once at the Slate app URL — the first sign-in finishes activating the login.');
  }
  if (input.sendsMail) {
    items.push(
      'Verify the sender email (the app sends mail): Catalyst console → Mail → Email Configuration → add the sender address — the service mails a verification code to that address; enter it.',
    );
  }
  return items;
}

/** `human checklist:` followed by `1. …` lines. */
export function formatHumanChecklist(input: HumanChecklistInput): string {
  const items = humanChecklist(input);
  const body = items.length ? items.map((item, index) => `${index + 1}. ${item}`) : ['none'];
  return `${['human checklist:', ...body].join('\n')}\n`;
}
