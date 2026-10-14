# 4. Your five steps — the ONLY things that need a human

The AI cannot click in the console, open mail, or sign in for you —
and it is forbidden from trying
([rules 2 and 13](../../plugin/C2C.md)). So the run pauses and
asks for you at most **five** times, printed as one numbered
checklist at the end of provisioning and deploying. Each item only
appears when your app actually needs it. Steps 1–3 and 5 mirror
the run's [human checklist](../../docs/human-steps.md); step 4 is
the in-app check from the verify flow.

## 1. Start Slate once (only if your app has web screens)

- **What you see:** Catalyst console → your project → **Slate** →
  a **"Start Exploring"** button. Click it once.
- **Why:** on a brand-new project the first Slate deploy fails
  until the service has been opened in the console once.
- **How the AI verifies:** the next Slate deploy finishes and your
  app address answers. (Data Store, Functions and sign-in never need
  this — Slate is the exception.)

## 2. Accept the admin invite

- **What you see:** an invite **email** at the admin address you
  gave the AI. Open it, set your password.
- **Why:** this makes you the first App Administrator. Portal users
  are always re-invited, never copied with passwords.
- **How the AI verifies:** it reads back your user record and sees
  you confirmed. Open the invite at your new app's web address — an
  invite opened anywhere else can land on a dead page.

## 3. Sign in once (only if your app has web screens)

- **What you see:** your new app's web address, showing a
  **signed-out page with a login form**. Sign in. You should land on
  the app's home screen — not on a dead `/app/` page (if you land
  there, tell the AI verbatim; it knows the cause).
- **Why:** the first sign-in finishes activating the login.
- **How the AI verifies:** your user record flips to confirmed and
  signed-in, and the app's checks pass from your session.

## 4. Run the in-app check and paste its code into the chat

- **What you see:** with you signed in, the AI asks you to try the
  app — submit one record per main form, open each main report —
  and to paste back what the app shows you.
- **Why:** this is the first live signal that the migrated app
  really works for a human, not just in the AI's checks.
- **How the AI verifies:** it matches your pasted result against
  the stored rows and the function logs it reads itself.
- If your app does not show a code yet, just describe what you did
  and saw; the AI checks the stored rows and logs itself.

## 5. Verify the mail sender (only if your app sends mail)

- **What you see:** Catalyst console → **Mail** → Email
  Configuration → add the sender address. The service **emails a
  verification code to that address**; you type the code in.
- **Why:** Catalyst only sends mail from verified senders.
- **How the AI verifies:** it lists the mail configuration and sees
  yours marked verified.

## What does NOT need you

Everything else — analysis, planning, creating tables and buckets,
deploying code, loading records, probes, counting, log-reading — is
the AI's work, each piece read back and recorded. If the AI asks you
to do anything not on this list of five, ask it which checklist item
it belongs to: ad-hoc chores are how migrations go wrong.
