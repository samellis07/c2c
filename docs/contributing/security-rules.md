# Security rules for contributors

Reporting policy lives in [SECURITY.md](../../SECURITY.md). This page is the
rules code review applies.

## Enforce on the server, never the client

The generated `c2c_api` Advanced I/O function is the boundary. Browser-side
checks exist for the user — a valid submission still meets the server:

- The caller is the platform principal (`principalFromRequest` —
  `req.user`/`req.catalyst.user`); a profile or role sent in the request body
  is ignored. Unauthenticated is 401; a form the profile cannot view is 403
  with nothing returned, not an empty set.
- Field permission drops fields the profile cannot read; record permission
  ANDs the Creator reports the profile can `View` onto every query, with
  `zoho.loginuser` filters bound to the principal, not to client input.
  Writes go through `authorizeWrite` — a file-field value is `{ key }` from
  the upload dry run, nothing else.
- When you add an endpoint, a write path or a client feature that needs
  server data, put the check in the function. A client-side gate alone is a
  defect. The prefetch mechanism and its authorization rules are specified in
  `packages/deluge/CLIENT-SPLIT.md`.

## No secrets in client bundles or the repository

- The client bundle gets configuration only (`public/c2c-config.js` carries
  the API base). No credential, token or connection secret belongs in
  generated `web/`/`slate/` output, plan output, logs, or committed files.
  The plan test asserts known id-like strings never appear in output
  (`packages/deploy/test/plan.test.ts`).
- The function's console environment may carry secrets; it moves through
  `c2c deploy --confirm --function-env <file>` — the file lives outside the
  repo, and only key names are ever printed. `catalyst deploy` replaces the
  whole env, so a deploy must carry every existing key — see
  [docs/deploy-functions.md](../deploy-functions.md).
- Live `invokeurl` calls are deny-by-default: https only, to hosts listed in
  `c2c-deploy.json` `outboundHosts`; redirects re-check the host and a
  cross-origin hop drops the body and every header. Transcripts mask
  `Authorization` and any value named like a secret.
- `deploy`, `migrate-data` and `smoke` make no network call unless
  `X_ZC_CREDENTIAL_PATH` is set and the environment is Development; without
  `--confirm` they refuse outright.
- `.gitignore` covers `.env*`; the hygiene check (`npm run check:hygiene`)
  rejects real-looking org/project ids, home paths and non-example emails —
  do not fixture real credentials or export contents anywhere.
