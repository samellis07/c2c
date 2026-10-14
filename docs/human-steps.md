# The end-of-run human checklist

Everything c2c cannot do for the user is collected into ONE numbered checklist
printed at the end of a successful `c2c deploy` and of a finished
`c2c provision` run (`human checklist:` in stdout; the same list is stored in
the deploy report as `humanChecklist` and in the provision done reply as
`checklist`).

The items, in order:

1. **Start Slate once** — Catalyst console → the project → Slate → "Start
   Exploring". A fresh project refuses the first Slate deploy until the
   service is opened in the console once. Shown only when the app ships a
   Slate web client.
2. **Accept the admin invite** — the invite mail went to the admin address the
   run was given; open it and set the password.
3. **Sign in once** — open the Slate app URL and sign in; the first sign-in
   finishes activating the login. Shown only when the app ships a Slate web
   client.
4. **Verify the sender email** — Catalyst console → Mail → Email
   Configuration → add the sender address; the service mails a verification
   code to that address and the user enters it. Shown only when the app sends
   mail.

Each item is conditional on the app, detected from the plan — never from a
flag the user passes:

- `slate`: the provision plan carries the `slate-enable` step, or the deploy
  ran a Slate target (`servicesTouched` reports Web Client Hosting (Slate)).
- `sendsMail`: a generated server function calls the mail shim
  (`functionsSendMail` over the UI files, surfaced as
  `DeployBundle.sendsMail`; in a provision plan the `mail-sender` step).

A run that already confirmed Slate started drops the first item: the deploy
passes `slateStarted` once a Slate command completed (a fresh project refuses
the Slate deploy until the service is opened, so a completed Slate command
proves it), and provision passes it once the `slate-enable` step is done or
already existed. The remaining items keep contiguous numbering, so a re-run
after Slate started lists three items for a mail app and two without mail.

The checklist text lives in `packages/deploy/src/human-steps.ts`
(`humanChecklist`, `formatHumanChecklist`) so `deploy`, `provision --status`
on an all-done plan, and `provision`'s done reply all print the same list.
