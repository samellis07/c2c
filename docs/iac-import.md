# IaC project import

`c2c provision --run import --confirm` creates a new project by importing the
generated template bundle (`provision/iac`). The calls use the Catalyst CLI's
own bearer token on the org-scoped `api.catalyst.zoho.<dc>` host:

1. `POST /baas/v1/project/import` — multipart `project_name`,
   `template_format=JSON`, `code` = the STORE zip of `provision/iac`,
   `schedule=false` → 200 `Staged` with the import id.
2. `GET /baas/v1/project/import/<import-id>/deploy?catalyst_org=<org>&redirect_url=<url>`
   — the deploy confirm. The redirect is the loopback success URL
   `http://localhost:3999/success`, the shape `iac:import` uses for its
   browser hand-off; the GET itself returns the confirm (an HTML redirect
   stub), so nothing has to listen on the port. The console URL is refused
   with `400 INVALID_REDIRECT_URL` and the import stays staged. The run checks
   the redirect is a full `http://localhost:<port>/success` URL before any
   call and refuses to start otherwise.
3. `GET /baas/v1/project/import/<import-id>` — polled until the status leaves
   `Scheduled`/`Processing`/`Staged`. `Completed` is the only success; the
   `project_details.id` it mints is the project id.

The import id is written to `provision/state.json` as soon as the POST
answers, before the deploy confirm. A refused deploy confirm leaves a staged
import that holds the name: the report says the import is staged as
`<import-id>` (`"<name>"`), the status and body the confirm failed with, and
to re-run to retry the confirm. The re-run reads that import, finds it
`Staged`, and re-issues its deploy confirm instead of posting a new one — no
second import and no `-2` name. A duplicate name (`409 DUPLICATE_ENTRY`) moves
to the documented `-2` suffix; an import that never leaves the live states
is assumed to keep its name blocked — a stuck import is assumed to be
undeletable [UNVERIFIED] (rule:
[facts/projects.md](../plugin/references/facts/projects.md)) — and the next run
re-polls it once before trying the next name.

## Access-token expiry

The Catalyst CLI access token lives about one hour. A call that lands just as
it lapses answers

    401 {"error_code":"INVALID_TOKEN","message":"invalid oauth token"}

and the same call sent again with a newer token succeeds. Every Catalyst
call c2c makes follows one rule for this answer:

- A read-only call — a `GET` (the import status poll, the project details
  and project list reads, the Slate reads) or a CLI read (`catalyst whoami`,
  `catalyst project:list` in `c2c doctor`) — re-reads the token in the
  Catalyst CLI credential store and sends the same call once more only when
  that token differs from the one that failed. The output carries
  `retried once with a newer token`; with nothing newer it carries
  `not retried: no newer token in the CLI credential store` and the call
  fails as before.
- A write (`POST`, `PUT`, `PATCH`, `DELETE`, the import POST, the deploy
  confirm, or a CLI write) is never re-sent. It fails as before; a failed
  import keeps its stuck-import record, so the next run re-polls it.
- A second `401 INVALID_TOKEN` after the retry is a real failure
  (`still 401 INVALID_TOKEN after one retry`).
- A `401` with any other error code (`OAUTH_SCOPE_MISMATCH`,
  `AUTHENTICATION_FAILURE`, `sign in required`) is never retried.

### Why the retry never refreshes by default

A Catalyst CLI refresh sends the refresh token to the token endpoint and
stores the answer. When the endpoint rotates the refresh token, the old one
stops working at once, so every other holder of it — another c2c run on the
same credential, or anything else that refreshes it — then fails with
`Error when refreshing the access token` until the next `catalyst login`.
The re-read therefore reads only the stored token, through a CLI command that
makes no API call (`catalyst --version`), and never sends a refresh: a token
the store already considers close to expiry reads as "nothing newer". The
retry helps when something else keeps the stored credential fresh; with a
private copy of the credential that nothing refreshes, the call fails as
before and the next run starts with a token the CLI refreshes as usual.

### Opt-in local refresh: `C2C_ALLOW_LOCAL_REFRESH=1`

A user who owns the only copy of the CLI credential can set
`C2C_ALLOW_LOCAL_REFRESH=1`. A read that meets `401 INVALID_TOKEN` then asks
the CLI for one forced refresh and is sent once more; writes are still never
re-sent. Two c2c runs on one credential at the same time race that refresh:
the run that refreshes second sends a refresh token the first already
rotated away and fails with `Error when refreshing the access token`. Run
them one after another, for example behind a per-credential lock.

c2c never writes a token anywhere; the CLI keeps its own credential store.
