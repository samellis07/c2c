# Field-level privacy flags

This page is the contract for one construct: a field the `.ds` export flags
`private`, `personal data`, `encrypt`, or `encryptdata` set `true`
(`PRIVACY_PROPERTY_KEYS` in
[`packages/core/src/ir.ts`](../packages/core/src/ir.ts)). Every claim below
names the file that implements it. This is a narrower, additional layer
inside the access policy [security-model.md](security-model.md) already
documents — table permissions and function security rules remain the outer
boundary; this page only covers which *fields* a grant exposes.

## Scope

- Covered: a flag on a **top-level field** of a form. Its protection is
  generated — no manual step is recorded for it.
- Not covered: a flag on a field **nested in a subform or a composite part**
  (a grid's columns, a Name/Address sub-part). `fieldGrant` (below) only
  walks a form's own `fields`, not `subfields`, so a nested flag still gets
  the one app-wide manual-step todo `recordPrivacyFlags` emits
  ([`packages/ui/src/model.ts`](../packages/ui/src/model.ts)) — unchanged
  from before this feature, and counted, never silently dropped
  ([`packages/quality/src/no-silent-drop.ts`](../packages/quality/src/no-silent-drop.ts)
  `fieldSettingItems`: a privacy property item on a field at `path.length > 0`
  still requires that todo to avoid a drop).
- Bulk export of a form's rows is not a generated feature at all today (no
  endpoint exists), so there is nothing to protect there yet. If one is
  added later it must build its row projection the same way every read path
  below does — through `authorizeRead`'s `fields`, never a raw row.

## Allowed roles: derivation and default

For a flagged top-level field, `fieldGrant` in
[`packages/deluge/src/generate.ts`](../packages/deluge/src/generate.ts)
excludes it from a profile's grant **unless** one of three things is true for
that profile:

1. **Explicit `.ds` grant.** The profile's module permission names the field
   with `visibility = true` (`FieldPermission.flags.visibility`, parsed into
   `ModulePermission.fields` — [`packages/core/src/ir.ts`](../packages/core/src/ir.ts)
   `FieldPermission`). This is the same per-field visibility setting
   `fieldGrant` already used for ordinary (non-privacy) fields; a privacy flag
   does not turn off an explicit allow the app owner wrote.
2. **Administrator.** The profile is Administrator-preset
   (`administratorProfiles` / `profilePreset`, same file) — Creator's
   Administrator can always see every field, privacy-flagged or not.
3. **Owner-scoped grant.** The profile's grant on this form has no View All
   (`ownerScope: 'view'` — a portal profile, or an internal profile sharing
   the form through the role hierarchy, with no `ViewAll` flag). Every row
   such a grant reads or writes is a row the caller owns
   (`ownerFilter` unconditionally adds the `Added_User` match for `'view'`
   scope, in every intent — [`packages/shims/src/access.ts`](../packages/shims/src/access.ts)),
   so the field only ever carries the caller's own data. A `'modify'`-scoped
   grant (View All without Modify All) is **not** exempt: `ownerFilter` only
   narrows a `'modify'` grant's rows for a modify intent, so an ordinary read
   under that grant sees every row, including rows the caller does not own.

**Default, with no explicit grant**: only Administrator and an owner-scoped
profile see the field — matching "owner/admin roles only." Every other
profile, including a profile with an unconditional `View All` on the form and
no explicit per-field permission, is denied it.

A profile with no `.ds` module permissions at all (an Administrator, Write,
Read, add-view, or portal-add **preset** — `profilePreset`, same file) is
handled the same way, directly in `buildAccessPolicy`'s preset loop: every
preset but Administrator gets the same denial, with portal-add exempted by
its `ownerScope: 'view'`, exactly as case 3 above.

## Enforcement point: one allow-list, reused by every read and write path

`fieldGrant`'s result becomes `FormGrant.fields` (read) and, through
`writableNames`, `FormGrant.writable` (write) — the exact same per-profile
field allow-list every other hidden-field rule in this codebase already uses
(`allFieldsVisible` / per-field `visibility`, readonly fields, and so on).
Embedded in every generated function module as `access` / `functions/access-policy.json`
([`packages/deluge/src/generate.ts`](../packages/deluge/src/generate.ts)
`accessLiteral`), it is read only through
[`packages/shims/src/access.ts`](../packages/shims/src/access.ts):

- `authorizeRead(policy, principal, form, criteria, field?, intent?)` returns
  `grant.fields`; a named `field` not in that list throws
  `RecordAccessError` (→ 403).
- `projectFields(values, fields)` drops every key not in the list before a
  row reaches a reply.
- `projectReadable` (the write-reply variant) does the same after an insert
  or update.

No new runtime function was added for this feature — the fix is entirely in
what `fieldGrant` puts into the existing allow-list. That is deliberate: it
means every caller of `authorizeRead` / `projectFields` / `projectReadable`
gets the privacy exclusion automatically, including ones this page did not
have to touch.

## Attack classes and how each is closed

Every class below is closed by the single allow-list above, not by a
per-class check — each bullet names the existing generic mechanism that
already consults `grant.fields` for *any* hidden field, privacy-flagged or
not, and the test that proves it for this feature.

| Read/write path | Where it consults the allow-list | 
| --- | --- |
| List / report (`op: "query"`) | `projectFields(row, scoped.fields)` per row — [`packages/ui/src/generate.ts`](../packages/ui/src/generate.ts) `reportStub` |
| Detail (single record) | `projectFields` in `recordStub`, same file |
| Search (`body.q`) | `searchCriteria(q, fields)` only builds a leaf per name in the passed `fields` list — unlisted names are never compiled, same file |
| Sort (`body.sort`) | `readableSort` drops a sort naming a field outside `readable`, same file |
| Filter (`body.filters`, a report link's click parameters) | `filterLeaf`/`filterCriteria` allow-list-check the leaf's field before compiling it, same file |
| Count / aggregate (`op: "aggregate"`) | `aggregateSpec`/`aggregateFieldRef`: a hidden **group** field fails the whole request (400) rather than leaking through bucket keys; a hidden **measure** field is just dropped from the fold, same file |
| Relation traversal (a lookup's display field on another form) | `lookupDisplayScope` calls `authorizeRead(access, principal, form, criteria, display)` for the **parent** form and returns `null` (displayed as `""`) when `display` is not in that grant — same file |
| Write (insert/update) | `writable` (derived from the same allow-list) — a value for an excluded field is rejected, not dropped, like every other hidden/read-only field (`RecordAccessError`, [`packages/shims/src/access.ts`](../packages/shims/src/access.ts)) |
| Write-echo (the reply after a write) | `projectReadable`, same file |

Because every path above is gated by the same `RecordAccessError` /
allow-list miss, the **denial text is uniform** across classes: a field read
denial is always `record access: profile <profile> cannot read <form>.<field>`,
a write denial is the generic field-rejection message every other hidden or
read-only field already produces. Neither message, nor any log statement on
these paths, ever interpolates the field's **value** — only its name and the
profile/form — so a privacy-flagged field's value is never logged on a
denial or on a successful read or write.

## Not provably covered: still a counted manual step

`recordPrivacyFlags` ([`packages/ui/src/model.ts`](../packages/ui/src/model.ts))
only skips the manual-step todo at `depth === 0` — the field's own top-level
position in the form, the exact condition `fieldGrant` protects. A flag
anywhere else (subform or composite child, `depth > 0`) keeps emitting the
pre-existing todo, so it is never a silent drop
(`fieldSettingItems`/`privacyPropertyListed` in
[`packages/quality/src/no-silent-drop.ts`](../packages/quality/src/no-silent-drop.ts)
still count it exactly as before this feature).
