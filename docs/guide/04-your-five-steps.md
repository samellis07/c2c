# 4. Your five steps — the run's human checklist

The AI cannot click in the console, open mail, or sign in for you —
and it is forbidden from trying
([rules 2 and 13](../../plugin/C2C.md)). So instead of interrupting
you piecemeal, the run collects everything only you can do into
**five** steps. Up to four are printed as one numbered
`human checklist:` at the end of provisioning and deploying — the
invite is always on the list, each other item appears only when your
app actually needs it, and they match the checklist items in
[human-steps.ts](../../packages/deploy/src/human-steps.ts); step 4
is the in-app check from the verify flow, asked while verifying.

## 1. Start services (only for the services your app uses)

- **What you see:** one line per service your app uses, always in the
  same form. Click **Start Exploring** once on each page it names:
  - Stratus — in the Catalyst console open the project → Cloud Scale →
    Stratus → Start Exploring, then on **Create your First Bucket** create
    one bucket (any name). Done when it shows in the Stratus bucket list
    (your app has file fields)
  - SmartBrowz — in the Catalyst console open the project → SmartBrowz →
    Start Exploring (your app makes PDFs)
  - Slate — in the Catalyst console open the project → Slate → Start
    Exploring (your app has web screens)
- **Why:** turning a service on for the first time has no API, CLI or
  MCP path; on a brand-new project the service refuses c2c until it
  has been opened in the console once. An app that uses none of the
  three has no step 1.
- **How the AI verifies:** c2c reads each service back itself (the
  gate probe) and continues only when it answers open; see
  [facts/projects.md](../../plugin/references/facts/projects.md).

## 2. Accept the admin invite

- **What you see:** an invite **email** at the admin address you
  gave the AI. Open it, set your password.
- **Why:** this makes you the first App Administrator. Portal users
  are always re-invited, never copied with passwords.
- **How the AI verifies:** it reads back your user record and sees
  you confirmed. The invite link carries your app's web address —
  open it there. Without it you can land on an unhosted `/app/`
  page (404) where the invite never completes.

## 3. Sign in once (only if your app has web screens)

- **What you see:** your new app's web address, showing a
  **signed-out page with a login form**. Sign in. You should land on
  the app's home screen — not on a dead `/app/` page (if you land
  there, tell the AI the exact address; it knows the fix).
- **Why:** the first sign-in finishes activating the login.
- **How the AI verifies:** your user record flips to confirmed and
  signed-in, and the app's checks pass from your session.

## 4. Run the in-app check and paste its code into the chat (only if your app has web screens)

- **What you see:** your app's web address plus `#/admin/smoke`.
  Open it while signed in, wait until the page says Done, press
  **Copy** beside the result code, and paste the code into the chat.
- **Why:** the code is the first live signal that the migrated app
  really works for a human, not just in the AI's checks — it is
  bound to your app, its checks, and its result.
- **How the AI verifies:** it unpacks the code itself and checks
  every step passed. A wrong, stale, or mistyped code is refused —
  press Copy again and paste afresh.

## 5. Verify the mail sender (only if your app sends mail)

- **What you see:** Catalyst console → **Mail** → Email
  Configuration → add the sender address. The service **emails a
  verification code to that address**; you type the code in.
- **Why:** Catalyst only sends mail from verified senders
  ([facts/auth.md](../../plugin/references/facts/auth.md)).
- **How the AI verifies:** it lists the mail configuration and sees
  yours marked verified.

## What does NOT need you

Everything else — analysis, planning, creating tables and buckets,
deploying code, loading records, probes, counting, log-reading — is
the AI's work, each piece read back and recorded. The exception is
the guided console stages in chapter 3: the project, custom roles
or connections, Deploy to Production, and freezing Creator and
switching links stay yours, each with exact clicks. If the AI asks
you to do anything beyond the five steps plus those stages, ask it
which checklist item it belongs to: ad-hoc chores are how
migrations go wrong.
