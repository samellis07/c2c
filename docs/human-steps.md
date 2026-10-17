# The end-of-run human checklist

Everything c2c cannot do for the user is collected into ONE numbered checklist
printed at the end of a successful `c2c deploy` and of a finished
`c2c provision` run (`human checklist:` in stdout; the same list is stored in
the deploy report as `humanChecklist` and in the provision done reply as
`checklist`).

The items, in order:

1. **Accept the admin invite** — the invite mail went to the admin address the
   run was given; open it and set the password.
2. **Sign in once** — open the Slate app URL and sign in; the first sign-in
   finishes activating the login. Shown only when the app ships a Slate web
   client.
3. **Verify the sender email** — Catalyst console → Mail → Email
   Configuration → add the sender address; the service mails a verification
   code to that address and the user enters it. Shown only when the app sends
   mail.
4. **Fill connection secrets in `~/.c2c/<app>-function-env.json`** — for
   declared connections with third-party credentials (e.g. client secrets, API
   keys, auth tokens). `c2c plan` and `c2c provision` autofill all derivable
   keys (`C2C_ZOHO_DC`, bucket names
   `C2C_STRATUS_BUCKET`, `STRATUS_BUCKET`, and table IDs `TABLE_ID`,
   `TABLE_<NAME>_ID`) into `<out>/function-env.json`; copy that file to
   `~/.c2c/<app>-function-env.json` — outside the generated tree and the
   repository — and enter the secret values there. `c2c deploy --function-env`
   reads that file. Third-party secrets of declared connections are the only
   keys left for the user. Those go into the checklist as at most ONE item
   naming the key(s), and never into chat, logs, stdout, or the generated
   tree. Shown only when the app declares third-party connection secrets.

Each item is conditional on the app, detected from the plan — never from a
flag the user passes:

- `slate`: the app ships a Slate client (`slate:link` and `deploy slate` run
  with `-ni`; no first-open console step).
- `sendsMail`: a generated server function calls the mail shim
  (`functionsSendMail` over the UI files, surfaced as
  `DeployBundle.sendsMail`; in a provision plan the `mail-sender` step).
- `connectionSecretKeys`: third-party secret properties declared in the app's
  `connections` blocks. An app without third-party connection secrets has zero
  function-env human items.

Stratus and SmartBrowz first-use gates remain provision steps when their app
uses them; Slate is not a gate. They do not add customer checklist items. The
printed wording is `CUSTOMER_STEPS` in `packages/deploy/src/customer-steps.ts`.
For a provision plan, `planCustomerSteps` picks the items from the plan's
steps: `c2c plan` lists them in `plan.md` under *Human steps*, and
`provision --status` on an all-done plan and `provision`'s done reply print
the same items. A confirmed `deploy` prints the same wording; the deploy
report's `humanChecklist` field uses the item text in
`packages/deploy/src/human-steps.ts` (`humanChecklist`).
