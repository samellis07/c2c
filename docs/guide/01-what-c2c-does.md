# 1. What c2c does — and does not do

c2c converts your Zoho Creator app — its forms, reports, workflows
and records — into a Zoho Catalyst project: Data Store tables,
Node.js functions translated from your Deluge scripts, a Slate web
app (your new screens), sign-in, and scheduled jobs. It runs inside
your own AI assistant, on your own machine, against your own Zoho
accounts. That description comes from the
[c2c plugin readme](../../plugin/README.md).

## What gets converted

- **Forms become tables with columns.** Field types are mapped
  one by one. A subform becomes a linked child table. A lookup
  becomes a link between tables
  ([schema mapping](../../docs/schema-mapping.md)).
- **Workflows and Deluge scripts become app code.** Each script is
  translated, converted with a helper (the analysis calls this
  "shimmed"), or listed as still to do (see below). The analysis
  tells you which, per script.
- **Reports and pages become Slate screens.** A list, kanban,
  calendar, timeline, map, pivot, chart, spreadsheet, summary, or
  detail view is built when the report has what that view needs.
  A view that cannot be built — a chart or pivot with nothing to
  group, a map with no location, a calendar or timeline with no
  date, a kanban with nothing to group by, or a Gantt chart — is
  named in the plan as still to do
  ([what the web app generates](../../docs/ui.md)).
- **Users, roles and permissions become Catalyst sign-in plus roles.**
  Portal users are invited again. Passwords are not copied. The
  first administrator sets a password from the invite mail. That
  invite is always on the end-of-run checklist
  ([human checklist](../../docs/human-steps.md)).
- **Records move over.** Your data is loaded table by table. The
  count in each table has to match Creator's own count for that
  data. A mismatch stops the load.

## What stays manual — counted and listed, never hidden

Anything the converter cannot carry is named in your migration
report. It is never dropped without a trace
([no-silent-drop rule](../../docs/no-silent-drop.md),
rule 8 in [the c2c rules](../../plugin/C2C.md)).

Three Creator pieces are **not applicable (out of scope)**. They
are not work left for you, and they are not counted as manual
items:

- Marketplace publishing.
- The Zia AI builder.
- On-prem Data Bridge.

Several features are **not supported in this version (counted)**.
Each one is named in the report when your app uses it:

- **Payments are not supported in this version (counted).** No
  payment gateway is generated. A payment workflow is counted, and
  saving a record does not take a payment.
- **Offline mode.** The web app does not keep your records on the
  device. While you are offline it says that data is unavailable
  ([what the web app generates](../../docs/ui.md)).
- **Push notifications stay manual.** A Deluge `pushnotification`
  action is not converted. It is counted, and its report item
  carries what the action was sending and names the Catalyst
  push-notification setup step for you to do by hand.
- **Form Email.** Inbound Form Email is not supported in this
  version.
- **Cliq integration-function bots.** Cliq bots relying on Integration
  Functions are not generated in this version.
- **C8 dialect.** Deluge scripts in the C8 dialect are not supported
  yet (C5 and C6 are supported).

**Native mobile apps and MDM are not supported in this version
(counted; on the roadmap).** No native iOS or Android app or mobile
device management (MDM) package is generated in this version; the
installable client is the Slate web app (PWA).

**Single sign-on (Zoho One or SAML)** has no built-in Catalyst
equivalent for app users. The report lists it as a manual item.
People sign in with Catalyst's own sign-in, and existing users are
invited again
([Third-party JWT is the SSO route](../../plugin/references/facts/auth.md#third-party-jwt-is-the-sso-route);
that facts entry has no evidence label).

You get an installable web app (PWA); Creator's own iPhone and
Android apps and MDM are not supported in this version (counted;
on the roadmap). Outgoing mail your app sends through Deluge
`sendmail` is carried over (and the sender address is verified by
you when the app sends mail; that checklist item appears only then),
while inbound Form Email is not supported in this version.

Anything else the converter cannot translate is counted. The
analysis text prints `todo items` with that count. A count of zero
(along with zero applied lock fills) is what makes the analysis say
the result is deterministic. The published sample table writes the
same counts per kind, for example
`2 (2 sendmail-attachment:template)`: two places where a mail
attachment is a record template, and a person still has to decide
what to do with those attachments
([synthetic migration report](../../docs/synthetic-report.md)).

## What the analysis says about your app

`c2c analyze` reads only your export. It prints a score out of 100
and one band:

- **ready** — the score is 85 or higher, and the analysis lists no
  blockers.
- **needs-work** — the score is 60 or higher, and the app is not
  ready. A score of 85 or more that still has a blocker lands here.
- **blocked** — the score is below 60.

The score is features and Deluge only. It does not look at
Catalyst's limits. The plan checks those limits next, before
anything is created. A high score can still be followed by a
refused save: a ZCQL insert of a value longer than the varchar
column writes nothing
([Varchar length](../../plugin/references/facts/limits.md#varchar-length)
[TESTED]), and a Development table can refuse further rows
([Rows per Development table](../../plugin/references/facts/limits.md#rows-per-development-table)
[UNVERIFIED]).

The [synthetic migration report](../../docs/synthetic-report.md) is
a separate table over many sample apps, after the later offline
stages as well. Its three words are:

- **migrates** — nothing in Creator blocks the app, the result can
  be regenerated the same way, and every offline stage finishes
  cleanly.
- **manual-items** — the row names what stays manual (a Creator
  fault, a warning, or a TODO). Most of those sample apps land
  here.
- **FAIL** — the app did not convert cleanly, and the row has no
  manual item and no TODO that explains why.
