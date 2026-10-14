# 6. Troubleshooting

When something goes wrong, **paste the exact error text into the
chat** — the AI looks it up in its
[error index](../../plugin/references/error-index.md) (matched by
substring against [facts/errors.md](../../plugin/references/facts/errors.md)),
confirms the cause with a read-only check, and only then fixes or
asks you. Never delete things to "start clean": every step resumes
where it stopped.

## The doctor is red

The doctor prints a numbered list of fixes next to each failed
check ([doctor spec](../../plugin/references/doctor-spec.md)).
The usual suspects:

- **Connector not signed in** — only a bare sign-in screen is
  visible in the AI's tool list. You finish the Zoho sign-in in the
  browser.
- **Wrong data centre or account** — the connector or CLI points at
  a different data centre than your Catalyst account, or at an
  account that cannot see your organisation. Sign out, sign back in
  with the owning account.
- **CLI not signed in** — you run the browser sign-in for the CLI.
- **No free project slot** — 50/50 projects used. Delete an unused
  project in the console, or ask Catalyst support to raise the limit.
- **Target project holds another app's tables** — use a fresh
  project for this app. Merging two apps into one project is refused.

## First-use service gates

- **"Please access the Slate service in your project's console
  before deploying via the CLI"** — normal on a new project: do
  [your step 1](04-your-five-steps.md) (open Slate once), then the AI
  re-runs the deploy.
- The same one-time console visit can apply to job scheduling or
  file storage: if a read-back fails there on a brand-new project,
  the AI asks you to open that service once, then re-checks.

## "Authentication required" and sign-in errors

- **`sign in required` / a 401 on your user page** — you are simply
  not signed in yet. Sign in at the app address ([your step
  3](04-your-five-steps.md)).
- **No access on an app address with no sign-in** — this one is
  *good news*: it proves the app's "sign-in required" rule works.
  The AI checks this one itself with a session-free probe.
- **Invite fails while public signup is off** — the AI must use the
  admin-invite route, never flip public signup on as a shortcut. If
  the invitee lands on a dead `/app/` page, the invite went out
  without the app address — tell the AI.
- **Repeated sign-in attempts failing** — stop trying. Too many
  attempts can trip a throttle that holds for hours.

## Quota and "too many requests" waits

- **429 / "concurrency limit reached"** — the platform is busy; the
  AI waits and retries.
- **"You have reached the max limit of your current API limit"** —
  stop creating, keep what was created, and retry later with growing
  waits (observed in testing: the limit can take from 30 minutes to
  a few hours to clear). Deleting a project may not free capacity
  immediately.
- **Creator-side "you have reached your API call limit"** — same
  idea on the Creator side during exports; wait, then resume.

## If the AI says "unverified: needs a probe"

That is the honest answer, not a dodge: the behaviour has no proven
route, so the AI proposes a tiny scratch-resource test (created,
measured, deleted) and asks your permission first. Say yes or no —
either is fine; "no" just records the assumption as a TODO.
