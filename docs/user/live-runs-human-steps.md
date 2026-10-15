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

Which steps a given run emits is decided by the plan and run state, never by a
flag the user passes:

- **`c2c deploy` stdout** prints `human checklist:` from
  [`customer-steps.ts`](../../packages/deploy/src/customer-steps.ts)
  (`formatCustomerSteps(!slate || slateStarted ? 1 : 0)`). On a Slate app
  before a Slate command completes (`slate && !slateStarted`), it prints all
  five `CUSTOMER_STEPS` lines numbered `1..5`. When the app has no Slate
  service (`!slate`) or a Slate command completed (`slateStarted`),
  `formatCustomerSteps(1)` drops step 1 (**Slate start**) and prints steps
  `2..5` with their original numbers (`2..5`); **Accept invite**, **Sign in
  once**, **Run the in-app check and paste its code**, and **Verify mail
  sender** (with its parenthetical `(only when the app sends mail)` condition)
  are always printed. A fresh project refuses the first Slate deploy
  until the service is opened in the console once; a
  `200 []` app-list response only proves connectivity — the deploy `400`
  is the activation signal.
- **`c2c provision`** (`--status` and `--next` once all steps finish) filters
  `CUSTOMER_STEPS`: it drops **Slate start** once a `slate-enable` step is
  recorded as `done` or `existing`, and drops **Verify mail sender** when the
  plan has no `mail-sender` step. `--status` numbers the remaining steps
  contiguously (`1..N`), and `--next` emits them in its JSON `checklist` array.
- **`.c2c-deploy-report.json` (`humanChecklist` field)** is populated by
  [`human-steps.ts`](../../packages/deploy/src/human-steps.ts)
  (`humanChecklist({ slate, sendsMail, slateStarted })`): **Start Slate once**
  only when `slate && !slateStarted`, **Accept the admin invite** always,
  **Sign in to the app once at the Slate app URL** only when `slate`, and
  **Verify the sender email (the app sends mail)** only when generated
  functions send mail (`DeployBundle.sendsMail`). It does not include the
  in-app check step, and `formatHumanChecklist` numbers its remaining items
  contiguously (`1..N`).

| Surface | Condition | Emitted steps |
|---|---|---|
| `c2c deploy` stdout (`formatCustomerSteps`) | `slate && !slateStarted` | `1. Slate start`, `2. Accept invite`, `3. Sign in once`, `4. Run the in-app check and paste its code`, `5. Verify mail sender` |
| `c2c deploy` stdout (`formatCustomerSteps`) | `!slate \|\| slateStarted` | `2. Accept invite`, `3. Sign in once`, `4. Run the in-app check and paste its code`, `5. Verify mail sender` |
| `c2c provision --status` (`CUSTOMER_STEPS` filter) | no `done`/`existing` `slate-enable`, `mail-sender` in plan | `1. Slate start`, `2. Accept invite`, `3. Sign in once`, `4. Run the in-app check and paste its code`, `5. Verify mail sender` |
| `c2c provision --status` (`CUSTOMER_STEPS` filter) | `slate-enable` `done` or `existing`, `mail-sender` in plan | `1. Accept invite`, `2. Sign in once`, `3. Run the in-app check and paste its code`, `4. Verify mail sender` |
| `c2c provision --status` (`CUSTOMER_STEPS` filter) | `slate-enable` `done` or `existing`, no `mail-sender` in plan | `1. Accept invite`, `2. Sign in once`, `3. Run the in-app check and paste its code` |
| `.c2c-deploy-report.json` `humanChecklist` (`humanChecklist`) | `slate && !slateStarted && sendsMail` | `1. Start Slate once`, `2. Accept the admin invite`, `3. Sign in to the app once at the Slate app URL`, `4. Verify the sender email (the app sends mail)` |
| `.c2c-deploy-report.json` `humanChecklist` (`humanChecklist`) | `slate && slateStarted && !sendsMail` | `1. Accept the admin invite`, `2. Sign in to the app once at the Slate app URL` |
| `.c2c-deploy-report.json` `humanChecklist` (`humanChecklist`) | `!slate && !sendsMail` | `1. Accept the admin invite` |

## What the customer does and what c2c verifies

| Step | What to do | What you enter | What c2c verifies |
|---|---|---|---|
| Slate start | Open the project in the Catalyst console, open Slate, and choose **Start Exploring** before its first deploy. | Nothing is pasted. | The first Slate deploy gate reports whether the service has been opened. |
| Accept invite | Open the app admin invite email and accept it. | Complete the invite flow in Catalyst. Do not paste account credentials into c2c. | c2c does not prove that the invite was accepted; follow the invite flow and confirm access in the app. |
| Sign in once | Open the deployed app and sign in with the invited account. | Enter credentials only in the app. | c2c does not capture or validate the sign-in. |
| Run the in-app check | Open `#/admin/smoke`, wait for **Done**, press **Copy**, and paste the result into the AI chat helping with the migration. | Paste the copied check code into that chat. Never paste credentials. | c2c does not receive or verify the pasted result; the customer and migration assistant use it to review the app check. |
| Verify mail sender | For apps that send mail, confirm the sender address in Catalyst Mail. | Complete any sender verification in Catalyst. Do not paste verification codes into c2c. | The run includes this step only when mail is configured; it does not prove that the customer completed verification. |
