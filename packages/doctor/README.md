# c2c doctor

`c2c doctor` is the read-only prerequisite check. It never creates, updates or
deletes anything, never signs in, never opens a browser, and never prints a URL
path or an email address into `doctor.json`. Every FAIL line carries the exact
fix for the user to run; doctor runs no fix itself.

```
c2c doctor [--app <file.ds|dir>] [--dc <dc>] [--org <id>] [--project <id>] [--ui vanilla|react] [--json]
c2c doctor --mcp-begin [--json]    open a one-time request naming the MCP calls to make
c2c doctor --mcp-observed -        record evidence from the observed call results (stdin), then run D-B*/D-V*
c2c doctor --record-mcp <file> --operator   operator-only: merge a supplied evidence file
c2c doctor --local --quiet         local checks only; writes nothing
```

Exit 0 green, 1 on any FAIL or a rejected or stale evidence file, 2 usage or
a missing evidence file, 6 on Node/vendor integrity. Output is
`c2c-out/.c2c/doctor.json` plus a table on screen.

## The two halves

The CLI cannot see the host's MCP session, so doctor runs in two halves:

- **CLI half** (`c2c doctor`): D-A1/A4 skills on disk, D-C* Catalyst CLI,
  D-D* Creator export and data source, D-E* Node and plugin integrity,
  D-F* org/project budgets, D-C5 data centre, D-R* React build prerequisites
  (run for the default React target; `--ui vanilla` or `"ui": "vanilla"`
  selects the fallback, which reports none of them).
- **Host half** (`--mcp-begin` then `--mcp-observed -`): evidence derived
  from Catalyst MCP calls made in the user's session feeds D-A2/A3, D-B1..B7
  and D-V1..V3 (DC agreement, 12-hour freshness, single server).

The gate (`provision --confirm`, `deploy --confirm`, `migrate-data --confirm`,
`verify --confirm`, `probe`, `cutover`) refuses with exit 5 unless doctor.json
is green, ≤ 12 h old, the same c2c version, bound to the same dc/org/project
scope, and holds an MCP record < 12 h old.

## Recording MCP evidence in the session (the plugin path)

The plugin never asks the user for an evidence file. `/c2c:doctor` runs:

1. `c2c doctor --mcp-begin` — opens a one-time request in
   `c2c-out/.c2c/mcp-request.json` (a random request id, when it was
   issued, the probe bucket it named, this run's nonce, and the scope it
   was opened under, authenticated by an HMAC-SHA256 under the per-user
   key kept outside the workspace — a completion in a different scope, an
   edited file, or a request file written by an older c2c is refused; it
   expires after 15 minutes) and
   prints the calls to make.
2. The agent makes the calls the request names in the session — first
   `CatalystbyZoho_Create_Bucket`, the probe bucket (`c2cprobe-p<project-id>`
   — one bucket per project, reused across runs, so a repeated doctor run
   never creates a second bucket; an already-exists answer means an earlier
   run left it), then `CatalystbyZoho_Create_Upload_Signature` to write an
   object whose key is this run's nonce, then
   `CatalystbyZoho_List_All_Organizations` —
   and the user approves each call at the host's normal prompt. No setting
   changes. The agent never calls `CatalystbyZoho_List_All_Projects` or
   `CatalystbyZoho_Get_Project_By_Id`: they return project secrets
   (jwtSecret, clientSecret) into the transcript, and an observation quoting
   either is refused. Projects come from the Catalyst CLI (`project:list`).
   The probe write is the security check: a submitted JSON can echo the
   request id, so the doctor instead reads this run's nonce object back over
   the Catalyst REST API with the user's own CLI credential
   (the bucket list `GET /baas/v1/project/<id>/bucket`, then
   `GET /baas/v1/project/<id>/bucket/objects` matched on the exact object
   key). A pre-existing bucket without this run's key does not pass. A match
   proves the MCP connector is bound to the same org/DC/project as the CLI —
   the only evidence a stdio/local connector can offer. The observation must
   include the bucket create and the org list; the upload-signature result
   may be included and is not required. Afterwards the agent deletes that
   nonce object (the bucket stays) and removes the probe bucket with
   `CatalystbyZoho_Delete_Bucket` (the delete call is printed
   on every run while the probe may still exist, and D-B8 warns until a
   read-back shows the bucket gone).
3. The agent pipes one observation into `c2c doctor --mcp-observed -` (with
   the usual scope flags):

```json
{
  "kind": "c2c-mcp-observation",
  "schema": 1,
  "request": "<request-id>",
  "server": "catalyst-by-zoho",
  "host_of_url": "catalystbyzoho.zohomcp.<dc>",
  "transport": "http",
  "shape": "meta",
  "tools": ["CatalystbyZoho_List_All_Organizations", "..."],
  "calls": [
    { "tool": "CatalystbyZoho_Create_Bucket", "result": "<the call result, verbatim>" },
    { "tool": "CatalystbyZoho_List_All_Organizations", "result": "<the call result, verbatim>" }
  ]
}
```

For a local/stdio connector, set `transport` to `stdio` (or `local`) and omit
`host_of_url`. Its DC is proven by the probe read-back alone: the observed
org hosts and the CLI's own selection are caller-side facts, so D-B2 passes
only when the probe bucket was found in the selected project. Do not guess
or type a host/DC into the observation.

The doctor derives the record from that observation:

- the org ids come from the call result itself — only the decimal ids are kept, never another
  field a result carried;
- `at` and the workspace are stamped by the doctor when the observation
  arrives;
- each call's result is digested (`sha256`), and doctor.json's `mcp` block
  records `source: "observed"` and `observed: { request, orgs, projects?,
  calls: [{ tool, digest }] }`;
- the request is closed with an exclusive `mcp-request.<id>.closed` marker, so
  the same observation cannot be recorded twice — not even by two runs
  answering one request at once. The marker is written before doctor.json:
  if that write then fails, the request stays consumed (fail closed) — open
  a new request with `--mcp-begin`, which clears old closed markers. A stale
  id can never match the new open id, so the cleanup is safe.

It refuses (exit 1, nothing written) an observation that is not
`c2c-mcp-observation` schema 1 (a legacy evidence file included), is larger
than 4 MiB, carries a call result over 1 MiB, sets its own `orgs`, `projects`,
`at`, `workspace` or `binding`, answers a request this workspace did not issue or already
used, arrives after the request expired, has no `List_All_Organizations` or
`Create_Bucket` result, carries a `calls[]` entry with fields other than
`tool` and `result`,
or quotes a call that returned an error — an `isError` flag anywhere in the
result (the top envelope, a later text block, a bare-array entry, or a
data-style list), as boolean `true` or the string `"true"`. A result that
does not list the target org records fine and fails D-B7.

A valid result nested through several JSON-string layers is accepted: each
layer counts toward the nesting cap, and the digest stays over the verbatim
result bytes. Standard input is read in bounded chunks and refused past 4 MiB
without buffering the whole pipe first.

Under `--local` the observation is validated and the checks run, but nothing
is written and the request stays open for the run that persists it.

## Operator-supplied evidence (`--record-mcp <file> --operator`)

`--record-mcp <file>` reads a free-standing evidence file and is
operator-only: without `--operator` it exits 2 and names the session flow
above, and with no file at all it is a usage error (exit 2). It exists for
maintainers' scripted runs and is never the plugin default;
doctor.json marks such a record `source: "operator"`.

### The evidence record

`--record-mcp <file> --operator` accepts a JSON object of facts: `server`,
`host_of_url`, `transport`, `shape`, `features`, `tools`, `schemas`, `orgs`,
`projects`, `tables`, `orgTableCount`, `catalyst_skills_visible`, `at` and
`workspace`. Strings are short and plain — no email, no URL path, no value
over 200 characters — and `orgs`/`projects` hold decimal ids or `id name`
pairs only; a pasted read-back entry is reduced to its id. A rejected file
never reaches doctor.json.

### Projects come from the Catalyst CLI only

Every record is org-scoped: it proves the MCP reaches the right org and DC —
server, host, transport, the `CatalystbyZoho_*` tool catalog, an `orgs` list
that contains the target org, a fresh `at`. The project list comes from
`catalyst --org <org> project:list` alone (Project Name / Project ID cells —
no secrets): D-C4 passes when the CLI sees the org, D-F1 counts its projects,
and D-B7 notes whether the target project is visible to the CLI. A `projects`
key in an older operator record is ignored, never compared. Every other check
stays strict: D-B1 server/host, D-B2 and D-V1 DC agreement, D-B3 connected,
D-B5 required tools, D-B7 org membership, D-V2 freshness. A record with the
wrong org or a stale `at` still fails.
