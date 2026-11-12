# Security policy

## Supported versions

`creator-to-catalyst` has no stable release line yet. Security fixes land on
`main`; there are no backports to older commits. Track `main` or the newest
tag.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting for this
repository: the repository's **Security** tab → **Report a vulnerability**. Do
not open a public issue.

Include:

- the command you ran,
- the shape of the input (export shape A/B/C, the construct involved) —
  never the contents of a private `.ds` export,
- what happened, and what you expected.

A maintainer acknowledges the report after triage. A fix lands on `main`
before any detail is made public.

## Scope notes

`c2c` runs locally and makes no network calls unless a `--confirm` deploy,
migrate-data or smoke step asks the Catalyst CLI to act, and then only against
the Development environment of the org and project you configure. Deploy,
migrate-data and smoke refuse — with a non-zero exit and no network call —
unless `X_ZC_CREDENTIAL_PATH` is set and the environment is Development. A
`.ds` export can contain connection names, addresses and keys; it is never
uploaded anywhere by this tool.

## Known limits of offline process traps

The offline network trap guards Node's documented child-process APIs. Code that
reaches undocumented native internals through `process.binding('spawn_sync')`
can bypass those wrappers. The trap also cannot prevent code from constructing
raw native TCP handles through `process.binding('tcp_wrap')`. These internals
are outside the supported API surface; tests that need a stronger boundary
must run in an OS-level network sandbox.
