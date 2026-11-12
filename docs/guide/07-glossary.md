# 7. Glossary

The words the AI will use, in plain language.

| Word | What it means for you |
|---|---|
| **Creator app** | The app you built in Zoho Creator — forms, reports, workflows, records. |
| **Catalyst project** | The new home for your app inside Zoho Catalyst. One app = one project. |
| **`.ds` export** | The file Creator produces (app → Settings → Export) that carries your whole app definition. The AI starts from this file. |
| **c2c plugin** | The assistant's migration toolkit: chat commands plus the know-how for each step. |
| **AI chat / host** | The assistant you talk to (Claude, or another LLM) with the c2c plugin installed. |
| **Doctor (`c2c doctor`)** | The read-only green-light check. Green means the AI may create things; red means fix the printed list first. |
| **Analyse / precheck** | The offline "is it convertible" scan. Finds blockers with Creator's own error text. |
| **Plan** | The full blueprint (tables, screens, sign-in, steps) you approve before anything runs. |
| **Provision** | Building the empty infrastructure: tables, permissions, job pool, file bucket, sign-in config. |
| **Deploy** | Moving the translated code and your web screens into the project. |
| **Slate** | Catalyst's web-screen builder — your new app screens live here. |
| **Data centre (DC)** | The region your Zoho account lives in (US, EU, India…). Everything must point at the same one. |
| **Organisation (org)** | Your Zoho organisation account that owns the Catalyst project. |
| **Development vs Production** | You migrate and test in Development; going live (Production) is console clicks you do at cutover — switching Production on, reviewing the difference, moving it over — after paying. |
| **Admin invite** | The email that makes you the first administrator of the new app. |
| **Authorised domain** | Your app's web address, registered so the browser lets the app and sign-in talk to each other. |
| **Mail sender** | The "from" address your app sends mail as. Must be verified with a code (your step 5). |
| **Migration report** | The verdict plus the three lists: fix-in-Creator, converts-with-TODO, your decisions. See [chapter 5](05-reading-the-report.md). |
| **Manual item** | Something with no automatic conversion — counted, named, and assigned to a human. Never hidden. |
| **TODO** | A numbered review flag on converted work: what was approximated, what to check. |
| **Read-back** | How the AI proves a step: it reads the created thing back and compares. No match = the step failed. |
| **Probe** | A tiny scratch-resource test for something unproven: created, measured, deleted, with your permission. |
| **Smoke test** | You trying the app in the browser (one record per form, each report) while the AI checks the stored results. |
| **Parity case** | One of your 3–5 most important business rules, tried through the new screens and verified in the data. |
| **Cutover** | Going live: Production deploy (your click), freezing Creator, switching links. Reversible until you sign off. |
| **Deluge** | Creator's scripting language. Your scripts are translated into the new app's code. |
| **ZCQL** | The query language the new app uses to read its tables. You never type it — it is here so the phrase rings a bell. |
| **IaC import/export** | A packaged way to create (import) or snapshot (export) a whole project's setup in one file. |
| **MCP connector** | The signed-in link between your AI and Zoho that lets the AI check and create things with your approval. |
