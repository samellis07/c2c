# Human steps during a live c2c run

This page describes the checklist currently printed at the end of `c2c deploy`
and `c2c provision`. It is per project (the org and project selected for that
run). The exact runtime wording is quoted below so it stays aligned with the
checklist implementation. Steps are conditional: Slate steps appear only when
the app uses Slate; sender verification appears only when the app sends mail.

For the surrounding plan/apply/read-back workflow, see the
[provision and deploy skill](../../plugin/skills/c2c-provision-and-deploy/SKILL.md).

## Checklist steps

| Checklist wording | What you see and do | What you enter | How c2c checks it |
|---|---|---|---|
| “Start Slate once: Catalyst console → the project → Slate → "Start Exploring". A fresh project refuses the first Slate deploy until the service is opened there once.” | In the Catalyst console for this project, open Slate and choose **Start Exploring**. This is needed before the first Slate deploy on a fresh project. | Nothing is pasted. | The Slate apps endpoint can return HTTP 200 with an empty list before activation, so that read-back proves connectivity only. The deploy CLI enforces activation: an unopened service returns the documented HTTP 400 gate; a completed Slate deploy means the prerequisite passed. |
| “Accept the admin invite: open the invite mail sent to the admin address and set the password.” | When the plan includes the `app-users` step, open the invitation sent to the configured user address, follow its link, and set the password. For a Slate client, the planner includes `app-users` only when both roles and portal users are configured; without a client, it includes the step when portal users are configured under roles. If the plan has no `app-users` step, no invite is sent by this run and this checklist row does not apply. | The password is entered in Catalyst’s invite flow; it is not pasted into c2c. | The deploy flow reads `GET /project-user` and checks that the admin address is listed. This proves the user is listed, not that the user has successfully signed in. |
| “Sign in to the app once at the Slate app URL — the first sign-in finishes activating the login.” | Open the Slate app URL and confirm the Catalyst sign-in page appears in the sign-in box. Record `{"sign_in_page": true}` with `c2c provision --record sign-in-check --result <file>`. This records that the sign-in page loaded; it does **not** prove a successful sign-in. Afterward, sign in with the account whose invite you accepted, if an invite applies. | The page check result is recorded with c2c. Enter account credentials only in the app. | c2c checks the recorded result for `sign_in_page: true`; this proves the sign-in page was visible, not that anyone successfully signed in. |
| “Verify the sender email (the app sends mail): Catalyst console → Mail → Email Configuration → add the sender address — the service mails a verification code to that address; enter it.” | Only for apps that send mail: add the sender address in the Catalyst console, retrieve the verification code from that address’s inbox, and enter it in Email Configuration. | Enter the sender address in the console, then the emailed verification code in the console. Do not paste either into c2c chat or a report. | The provision flow reads the email configuration list and matches the configured sender address. The current match does not assert a `VERIFIED` status, so c2c does not independently prove the code was accepted. |

The checklist currently contains these four quoted items. The planner also
emits a `sign-in-check` stage for every Slate client. The human records
`sign_in_page: true` after the Catalyst sign-in page loads; this proves the
sign-in page loaded, **not a successful sign-in**. The proposed “in-app check + paste code” step is **not implemented** and is not part of the current live-run
checklist. No code should be pasted into the app for that step today.

## Current limits

- A run with Slate already started omits the Slate start item.
- A run without a Slate client omits both Slate items.
- A run whose app does not send mail omits sender verification.
- The admin invite item is included in the shared checklist, but `app-users`
  and its invite email are conditional. The planner emits it for a non-Slate
  app when portal users are configured with roles, or for a Slate app when
  both roles and portal users are configured. If the plan omits `app-users`,
  skip the invite checklist row; no invitation was sent by that run.
- The checklist has no stable `HUMAN_STEP_IDS` allowlist yet. The checklist
  strings in the deploy package are its current source of truth.

Implementation references: [`human-steps.ts`](../../packages/deploy/src/human-steps.ts),
the [human-step tests](../../packages/deploy/test/human-steps.test.ts), and the
[provision plan](../../packages/deploy/src/offline-plan.ts).
