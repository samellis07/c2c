# Draft: A practical bridge from Zoho Creator to Zoho Catalyst

**Status: draft for owner review — do not publish yet**

## Suggested community post

### Moving a Creator app to Catalyst? Here is what the adapter actually does

If you have a Zoho Creator app and are considering Zoho Catalyst, the hard
part is not copying a few tables. The hard part is preserving the behavior
around those tables: forms, lookups, subforms, Deluge workflows, reports,
permissions, files, and the records already in production.

That is the problem this Creator-to-Catalyst adapter is designed to solve.

### What it is

It is a local, report-first migration tool. You give it a Creator `.ds`
export and, when moving data, the corresponding record exports. It analyzes
the app offline, produces a plan, and then—with your approval—builds the
Catalyst pieces: Data Store tables, translated Node.js functions, a Slate web
app, authentication and roles, scheduled jobs, and file storage paths.

It does not replace your Creator app or silently make decisions on your
behalf. Creator stays available while you review the result and decide when
to cut over.

### How it works

1. **Precheck and analyze.** The tool reads the export without contacting
   Zoho. It identifies blockers, estimates Deluge coverage, and gives a
   readiness result.
2. **Plan.** It maps forms to tables, lookups to relationships, subforms to
   child tables, reports to screens, and users/roles to Catalyst access. It
   also checks Catalyst limits before anything is created.
3. **Review the gaps.** Unsupported or different behavior is named in the
   migration report with a concrete follow-up. Nothing is quietly dropped.
4. **Provision and deploy.** After you approve each stage, it creates the
   infrastructure and deploys the generated functions and web app.
5. **Load and verify.** Records are moved in batches, links are remapped,
   and per-table counts are compared with Creator. Verification covers the
   generated screens and the business rules you choose to smoke-test.

### What it solves

- **Schema translation:** Creator fields become Catalyst-compatible columns,
  including practical handling for lookups, multi-lookups, subforms, files,
  decimal values, and system fields.
- **Behavior migration:** Deluge is translated where supported, shimmed where
  Catalyst behaves differently, and listed as a manual item where it cannot
  be carried over exactly.
- **Catalyst limits:** The plan surfaces decisions such as unique-column
  limits, text lengths, table sizing, and function/deployment constraints
  before a live write fails.
- **Data integrity:** Creator IDs are retained for reconciliation, foreign
  keys are remapped, and a count mismatch stops the load instead of being
  hidden.
- **A usable handoff:** The output includes a migration report, plan,
  deployment record, proof results, and a human checklist—not just generated
  code.

### What it does not promise

No migration can make two platforms identical. Some Creator features remain
manual or are not supported in the current version, such as inbound Form
Email, offline mode, some integrations, and native mobile/MDM packaging.
Those items are counted and explained so you can make an informed decision.

If you are evaluating a migration, start with the offline analysis on a copy
of your export. The most useful first question is not “can it convert?” but
“what will be different, and is every difference visible before cutover?”

Questions and real-world edge cases are welcome—especially examples where a
Creator workflow, report, or data relationship must remain faithful in the
new app.

## Owner notes (remove before publishing)

- Keep the tone educational and avoid implying that every Creator feature is
  supported. Link to the project README and the migration guide after the
  owner selects the canonical public URLs.
- Step-0 OSS evaluation: the repository already uses the maintained
  `lossless-json` package for lossless JSON handling, but no general-purpose
  open-source Creator-to-Catalyst migration adapter was found in the checked
  repository/dependency surface. Reusing a generic ETL or SDK would not solve
  the required `.ds` parsing, Deluge translation, Catalyst limit planning,
  no-silent-drop reporting, and record/link verification. Therefore no
  external adapter was selected; the existing project adapter remains the
  appropriate implementation.
