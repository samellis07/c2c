# Human steps during a live c2c run

This guide documents the five customer steps shared by `c2c deploy`, `c2c
provision`, and the plugin skills. Each step is an action the customer takes in
their own Catalyst account or deployed app. Some steps depend on the project:
Slate start and app sign-in apply to Slate apps, and sender verification applies
when the app sends mail. Provision omits Slate start after it is recorded as
done and omits sender verification when no mail step is planned.

For the surrounding plan, apply, and read-back workflow, see the
[provision and deploy skill](../../plugin/skills/c2c-provision-and-deploy/SKILL.md).

## Checklist steps

| Checklist wording | What to do | What you enter | What c2c verifies |
|---|---|---|---|
| “Slate start: in the Catalyst console open the project → Slate → Start Exploring” | Open the selected project in Catalyst, open Slate, and choose **Start Exploring** before its first deploy. | Nothing is pasted. | The first Slate deploy gate reports whether the service has been opened. A `200 []` app-list response only proves connectivity; the deploy `400` is the activation signal. |
| “Accept invite: accept the app invite mail” | Open the app admin invite email and accept it. | Complete the invite flow in Catalyst. Do not paste account credentials into c2c. | c2c does not prove that the invite was accepted; follow the invite flow and confirm access in the app. |
| “Sign in once: sign in to the deployed app once” | Open the deployed app and sign in with the invited account. | Enter credentials only in the app. | c2c does not capture or validate the sign-in. |
| “Run the in-app check and paste its code: open the app's #/admin/smoke page, wait for Done, press Copy and paste the code into your AI chat (Claude or any LLM)” | Open `#/admin/smoke`, wait for **Done**, press **Copy**, and paste the result into the AI chat helping with the migration. | Paste the copied check code into that chat. Never paste credentials. | c2c does not receive or verify the pasted result; the customer and migration assistant use it to review the app check. |
| “Verify mail sender: confirm the Catalyst Mail sender email (only when the app sends mail)” | For apps that send mail, confirm the sender address in Catalyst Mail. | Complete any sender verification in Catalyst. Do not paste verification codes into c2c. | The run includes this step only when mail is configured; it does not prove that the customer completed verification. |

## Per-project conditions

- A project without a Slate app does not need Slate start or app sign-in.
- A provision rerun omits Slate start after that step is recorded as done.
- Sender verification applies only when the app sends mail.
- The in-app check remains one of the five customer steps; it is not a browser action performed by c2c.

Implementation references: [`customer-steps.ts`](../../packages/deploy/src/customer-steps.ts), the [customer-step tests](../../packages/deploy/test/customer-steps.test.ts), and the [provision plan](../../packages/deploy/src/offline-plan.ts).
