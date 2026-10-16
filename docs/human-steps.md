# The end-of-run human checklist

Everything c2c cannot do for the user is collected into ONE numbered checklist
printed at the end of a successful `c2c deploy` and of a finished
`c2c provision` run (`human checklist:` in stdout; the same list is stored in
the deploy report as `humanChecklist` and in the provision done reply as
`checklist`).

The items, in order:

1. **Start services** — first activation of Stratus, SmartBrowz and Slate has
   no API, CLI or MCP path, so it is one guided console action. The item names
   only the services the app uses, one sentence each, in this order:
   - `Stratus — in the Catalyst console open the project → Cloud Scale → Stratus → Start Exploring, then on Create your First Bucket create one bucket (any name) and wait until it shows in the Stratus bucket list — click Create again if nothing happens after a few seconds.`
     (the app has file fields)
   - `SmartBrowz — in the Catalyst console open the project → SmartBrowz → Start Exploring`
     (the app renders PDF)
   - `Slate — in the Catalyst console open the project → Slate → Start Exploring`
     (the app ships a Slate web client)

   An app that uses none of them has no start item. Example for an app with
   file fields and a Slate web client:
   `1. Start services: Stratus — in the Catalyst console open the project → Cloud Scale → Stratus → Start Exploring, then on Create your First Bucket create one bucket (any name) and wait until it shows in the Stratus bucket list — click Create again if nothing happens after a few seconds; Slate — in the Catalyst console open the project → Slate → Start Exploring`
2. **Accept the admin invite** — the invite mail went to the admin address the
   run was given; open it and set the password.
3. **Sign in once** — open the Slate app URL and sign in; the first sign-in
   finishes activating the login. Shown only when the app ships a Slate web
   client.
4. **Verify the sender email** — Catalyst console → Mail → Email
   Configuration → add the sender address; the service mails a verification
   code to that address and the user enters it. Shown only when the app sends
   mail.
5. **Fill connection secrets in `~/.c2c/<app>-function-env.json`** — for
   declared connections with third-party credentials (e.g. client secrets, API
   keys, auth tokens). `c2c plan` and `c2c provision` autofill all derivable
   keys (`C2C_ZOHO_DC`, `APP_URL`, `CATALYST_APP_URL`, bucket names
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

- `slate`: the provision plan carries the `slate-enable` step, or the deploy
  ran a Slate target (`servicesTouched` reports Web Client Hosting (Slate)).
- `files` (Stratus): the plan carries the `stratus-enable` step; the deploy
  reads the app's file fields.
- `pdf` (SmartBrowz): the plan carries the `smartbrowz-enable` step; the deploy
  reads the app's PDF output.
- `sendsMail`: a generated server function calls the mail shim
  (`functionsSendMail` over the UI files, surfaced as
  `DeployBundle.sendsMail`; in a provision plan the `mail-sender` step).
- `connectionSecretKeys`: third-party secret properties declared in the app's
  `connections` blocks. An app without third-party connection secrets has zero
  function-env human items.

A run that already verified a service started drops that service from the
first item, and drops the item when none is left: the deploy probes each gate
the app needs before its first write and passes the open ones as `started`
(a completed Slate command also proves Slate, `slateStarted`), and provision
drops a service once its `<service>-enable` step is done or already existed.
The remaining items keep contiguous numbering, so a re-run after every service
started lists three items for a Slate app with mail and two without mail.
Even with all services active (Stratus, SmartBrowz, Slate, mail, and connection
secrets), total human steps remain <= 5.

The printed wording is `CUSTOMER_STEPS` in
`packages/deploy/src/customer-steps.ts`, and the per-service sentence in
`packages/deploy/src/first-use.ts` (`activationSentence`). For a provision plan,
`planCustomerSteps` picks the items from the plan's steps: `c2c plan` lists
them in `plan.md` under *Human steps*, and `provision --status` on an all-done
plan and `provision`'s done reply print the same items. Each service start is
the plan's `<service>-enable` step, so it is closed before that list prints. A
confirmed `deploy` prints the same wording; the deploy report's
`humanChecklist` field uses the item text in
`packages/deploy/src/human-steps.ts` (`humanChecklist`).
