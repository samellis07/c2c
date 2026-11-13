# Report custom action navigation

A report custom action runs its workflow against the selected record(s)
through the dispatch endpoint `POST /reports/<report>/actions/<action>`. When
that workflow's Deluge also calls `openUrl(...)`, Creator navigates the
browser after the workflow finishes. A generated function cannot perform that
navigation itself — it runs on the server, after the HTTP response has not
yet been sent, with no browser to redirect — so the navigation is carried as
data in the response instead, and the generated page performs it only after
checking it against a client-side policy.

## The protocol

The dispatch endpoint's JSON reply may carry an optional `nav` field
alongside its existing `dryRun`/`wrote`/`action` fields:

```ts
nav?: {
  kind: 'navigate';
  url: string;
  target?: 'same' | 'new'; // default 'same'
}
```

`url` is the fully resolved navigation target — a same-app hash route
(`#/report/Orders`), a relative path, or an `https:` URL — with every dynamic
part (a record id, a field value) already substituted with its real,
server-computed value. `target` mirrors Deluge's `openUrl` window argument:
anything other than `"same window"` becomes `'new'`.

The server only emits `nav` when the navigation target is a same-app route —
the whole body of the `openUrl` is a same-app route (`#Form:`, `#Report:`,
`#Page:`, a relative path, a record-edit or record-summary link, `mailto:`,
`tel:`) — the same shape `classifyClientOpenUrl` already recognizes for a
workflow whose *entire* body is a navigation (see
`packages/deluge/src/generate.ts`).

Anything else — an `openUrl` whose scheme or host is itself built from a
Deluge value (a field, a variable, a function argument), a literal
`https://` target, a `#Script:` pseudo route, or a target this scan cannot
resolve — is **never** turned into a `nav` reply. It stays a counted manual
item with a location-specific `manualStep` (`Custom action "X" on report "Y"
runs its workflow, but a navigation (openUrl) inside it is not carried
over...`), exactly as before. A value this analysis cannot see statically
cannot be trusted as a navigation target at runtime either; and a literal
`https://` host found in the `.ds` source is not trusted either, since it
would let an attacker-authored `openUrl("https://evil.example.com")` allowlist
its own host (see `packages/deluge/src/generate.ts:2885-2892`,
`classifyOpenUrlStmt`).

## The per-app allowlist (declared, not yet populated)

`AppSpec` declares an optional `navigationAllowlist?: string[]` field (see
`packages/ui-react/template/lib/c2c-ui/types.ts`) as the mechanism a future,
owner-approved source of trusted hosts could use to let a report custom
action's navigation target an external `https:` host. Nothing in the
generator populates it today: `extractLiteralHttpsHosts` in
`packages/ui/src/url-policy.ts` exists and is unit-tested, but it is never
called when building the `AppSpec` that ships to a generated app
(`packages/ui/src/model.ts` has no such wiring). `navigationAllowlist` is
therefore always absent in every generated app, `allowedHosts` always
resolves to `[]` on the client, and an `https:` navigation target is
unconditionally refused — there is currently no way for a report custom
action to navigate to an external host at all, only to a same-app route.

## The client-side policy check

The generated page never navigates on a server reply's say-so alone. Before
acting on a `nav` instruction, it runs the **same** check the server used to
decide whether to emit one — `navigationAllowed(url, allowedHosts)` in
`packages/ui/src/url-policy.ts`, mirrored by hand (not generated) in the
ui-react runtime as `c2cNavOk`, the same split `url-policy.ts` already uses
between `safeUrl` and the vanilla client's `c2cUrlOk` (`client-runtime.js`):

| Target shape | Verdict |
| --- | --- |
| Same-app hash route (`#...`) | **allow** |
| Relative path (`/report/...`, not `//host/...`) | **allow** |
| `https://` URL whose host is on this app's allowlist | **allow** |
| `javascript:`, `data:`, `vbscript:`, `file:` (literal or revealed after flattening control/whitespace characters) | **deny** |
| Protocol-relative (`//host/...`) — an open redirect wearing a relative path's clothes | **deny** |
| Plain `http:`, even to an allowlisted host | **deny** |
| Any other `https:` host, including one a caller supplied with no allowlist match | **deny** |

A denied target is dropped: the action's HTTP response is still treated as a
success (the workflow ran), but no navigation happens. This re-check is
deliberate defense in depth — the server-side classification in
`generate.ts` is the thing that decides *whether* to emit a `nav` field at
all, but the page that actually calls `location.hash =` or `window.open(...)`
never assumes that decision was correct.

Opening in a new tab (`target: 'new'`) always uses
`window.open(url, '_blank', 'noopener,noreferrer')` — the opened tab never
gets a handle back to the page that opened it.

## What stays manual

A navigation whose target is not a same-app route — most commonly a literal
or dynamically built `https:` URL (a host itself coming from a field, a
variable, or string concatenation), or a `#Script:` pseudo-route
(`page.refresh`, which is not a real navigation target) — is not carried. The custom action still
dispatches and runs its workflow; only the navigation is dropped, and it is
always counted with a `manualStep` naming the action, the report, and (where
known) why the target could not be resolved.
