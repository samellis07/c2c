# Human steps during a live c2c run

A finished `c2c deploy` or `c2c provision` run ends with one numbered
`human checklist:` of the steps only the customer can take — console, inbox
and in-app actions no CLI or API call can do for them. The canonical step
text lives in [`customer-steps.ts`](../../packages/deploy/src/customer-steps.ts)
(`CUSTOMER_STEPS`); the plugin skills and every place that lists the steps
quote it verbatim:

<!-- c2c:human-steps:start -->
1. Slate start: in the Catalyst console open the project → Slate → Start Exploring
2. Accept invite: accept the app invite mail
3. Sign in once: sign in to the deployed app once
4. Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)
5. Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)
<!-- c2c:human-steps:end -->

For the surrounding plan, apply, and read-back workflow, see the
[provision and deploy skill](../../plugin/skills/c2c-provision-and-deploy/SKILL.md).

## Per-project conditions

Which steps a given run prints is decided by the plan, never by a flag the
user passes:

- **Slate start** is dropped once Slate is recorded as started — a provision
  `slate-enable` step already `done` or `existing`, or a deploy that already
  completed a Slate command (`slateStarted`). A fresh project refuses the
  first Slate deploy until the service is opened in the console once; a
  `200 []` app-list response only proves connectivity — the deploy `400` is
  the activation signal. The remaining steps keep contiguous numbering.
- **Verify mail sender** is included only when the app sends mail — a
  provision plan carrying a `mail-sender` step, or a deploy whose generated
  functions call the mail shim (`DeployBundle.sendsMail`).
- `c2c provision` prints the five steps above filtered by those two
  conditions. `c2c deploy` prints its per-project checklist from
  [`human-steps.ts`](../../packages/deploy/src/human-steps.ts)
  (`humanChecklist`): Slate start only for Slate apps not yet started, the
  admin invite always, sign-in only for Slate apps, and sender verification
  only when the app sends mail. The deploy checklist does not print the
  in-app check — that step belongs to the verify flow, which asks for it in
  chat.

## What the customer does and what c2c verifies

| Step | What to do | What you enter | What c2c verifies |
|---|---|---|---|
| Slate start | Open the project in the Catalyst console, open Slate, and choose **Start Exploring** before its first deploy. | Nothing is pasted. | The first Slate deploy gate reports whether the service has been opened. |
| Accept invite | Open the app admin invite email and accept it. | Complete the invite flow in Catalyst. Do not paste account credentials into c2c. | c2c does not prove that the invite was accepted; follow the invite flow and confirm access in the app. |
| Sign in once | Open the deployed app and sign in with the invited account. | Enter credentials only in the app. | c2c does not capture or validate the sign-in. |
| Run the in-app check | Open `#/admin/smoke`, wait for **Done**, press **Copy**, and paste the result into the AI chat helping with the migration. | Paste the copied check code into that chat. Never paste credentials. | c2c does not receive or verify the pasted result; the customer and migration assistant use it to review the app check. |
| Verify mail sender | For apps that send mail, confirm the sender address in Catalyst Mail. | Complete any sender verification in Catalyst. Do not paste verification codes into c2c. | The run includes this step only when mail is configured; it does not prove that the customer completed verification. |
