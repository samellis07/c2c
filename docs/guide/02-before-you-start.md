# 2. Before you start

Gather these four things. The AI will ask for anything missing —
you only need to point, click, and sign in where asked.

The things only you do at the **end** of a run are a separate
checklist, printed by the program
([human checklist](../../docs/human-steps.md), and the screens in
[chapter 4](04-your-five-steps.md)). Each item appears only when
it applies:

1. Start Slate once — only when the app has web screens and Slate
   has not already been started on this project.
2. Accept the admin invite — always. Open the invite mail and set
   the password.
3. Sign in once at the app's web address — only when the app has
   web screens.
4. Verify the sender email — only when the app sends mail.

Nothing else on that list is printed. A missing project, described
below, is a different ask and only when the AI was told to use a
project it cannot find.

## 1. A Catalyst account with a free project slot

- Your Catalyst account is in a data centre c2c knows — United
  States, Europe, India, Australia, Canada, Saudi Arabia, Japan,
  or the United Arab Emirates — and it has an organisation the AI
  can see.
- Each migrated app has **its own project**, in **Development**.
  The doctor plans for 50 projects on the account and stops when
  no slot is free
  ([Projects per account](../../plugin/references/facts/limits.md#projects-per-account)
  [UNVERIFIED]).
- When you have not already given the AI a project id, the AI
  creates the project. The name is `c2c-` plus your app's name in
  lower case, with spaces and other marks turned into hyphens. A
  new project is created by importing a template, in Development.
  The AI then reads that project back and records its id
  ([Create a project only through the IaC import](../../plugin/references/facts/projects.md#create-a-project-only-through-the-iac-import),
  [Verify the project before depending on it](../../plugin/references/facts/projects.md#verify-the-project-before-depending-on-it)).
  A direct "create project" call is refused
  ([`400 PROJECT_CREATION_NOT_ALLOWED`](../../plugin/references/facts/errors.md#400-project_creation_not_allowed)).
  When the name is already in use, the AI adds a suffix and tries
  the import once more
  ([`409 DUPLICATE_ENTRY` on project import](../../plugin/references/facts/errors.md#409-duplicate_entry-on-project-import)).
  Those facts entries do not carry an evidence label.
- When you already have a Development project that holds only this
  app, give the AI its id. It uses that project.
- When the AI was told to use a project name that is not in your
  organisation, it stops and asks you to create that project in
  the Catalyst console, then to give it the id. That ask happens
  only for a missing named project.

## 2. Your Creator export

- In Creator: open your app → Settings → **Export** (a `.ds` file).
  If the export comes out empty or blank, tell the AI. A blank
  export usually means a workflow still points at a function whose
  binding changed. The AI's precheck can name that component from
  an earlier export
  ([Workflow corrupted on export](../../plugin/references/facts/errors.md#workflow-corrupted-on-export)).
  That facts entry does not carry an evidence label.
- To move your **records** too, export each report's data and the
  counts Creator shows. Prefer each report's JSON export: it
  always includes each record's ID. A spreadsheet (CSV) export
  includes that ID only when the export itself includes the ID
  column
  ([Take migrated rows from the JSON report export — it always carries record ids](../../plugin/references/facts/datastore.md#take-migrated-rows-from-the-json-report-export--it-always-carries-record-ids)).
  That facts entry does not carry an evidence label. The exact
  Creator menu for this data export is unverified, so follow the
  path the AI gives you in your session. The AI counts every table
  against Creator's own numbers either way.

## 3. The Catalyst plugin, signed in

Two sign-ins connect your AI to Zoho. **You do both in the browser;
the AI never types your passwords or tokens**
([rules 2–3](../../plugin/C2C.md)):

- **The official Catalyst plugin** (its skills plus its MCP
  connector), signed in to the Zoho account that owns your Catalyst
  organisation.
- **The Catalyst CLI** (version 1.27.2 or newer), signed in to the
  same organisation and data centre. 1.27.2 and 1.28.0 are the
  versions already checked. A newer CLI still runs, and the doctor
  warns that it has not been checked.
- Node.js on the machine where the AI runs: 20.20.0 or newer, and
  older than 23. The doctor's install hint names Node 20 or 22.
  20.20.1 is the version c2c is checked on. Another allowed version
  warns, because byte-for-byte results are guaranteed on 20.20.1.

If a sign-in opened the wrong account or data centre, the doctor
(see below) catches it — the AI will ask you to sign out and sign
back in with the owning account.

## 4. The doctor check — your green light

Before anything is created, the AI runs **`c2c doctor`**, a
read-only health check. Read-only means: it never creates, changes
or deletes anything, never logs in, never opens a browser, and
never reads a password or token file
([doctor spec](../../plugin/references/doctor-spec.md)). It checks
the plugin skills, the connector sign-in, the CLI sign-in and its
version, Node, your data centre and organisation, and that a free
project slot exists. Your export file is checked once you have
pointed the doctor at it. It prints one line per check. A failed
line includes the fix, and the AI gives you a numbered list of
only those fixes, for you to run.

What to know about the doctor:

- It must be **green** before the AI is allowed to create anything
  (the project import, provisioning, deploying, and the data load).
  Analysis and planning may still run while it is red. The report
  is marked with the doctor result — green, red, or not run — and
  the AI treats a red result as a preview.
- Green expires. A green result older than **12 hours** is refused.
  So is a result for a different data centre, organisation, or
  project, a result from a different c2c version, or a connector
  check older than 12 hours. The doctor must run again.
- If the AI ever stops with "doctor is not green", the full line
  starts `c2c: doctor is not green for … (run c2c doctor; last: …)`.
  Open [chapter 6](06-troubleshooting.md) — or just ask the AI what
  to do.
