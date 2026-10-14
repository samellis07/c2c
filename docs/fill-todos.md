# c2c fill-todos

`c2c fill-todos` turns each remaining migration TODO into a task a **host agent** can fill. The plugin does not call a model, does not send source to a service, and does not store prompts. An accepted fill is written to `c2c.lock.json` and spliced back in on later runs, byte for byte.

The command does not change the translator. It reads the `shim.todo(...)` holes the translator already emits.

Without a lock, `generate` output is unchanged. Determinism manifests on the main fixtures do not move.

## Emit

```sh
c2c fill-todos <file-or-directory> --emit <directory>
```

One JSON file per TODO, named `<id>.json`. Ids are sorted with the en-US collator (`compareEnUs`), never `localeCompare`. Running emit twice on the same app writes the same bytes.

`<id>` is the hex sha256 of a canonical JSON preimage:

```json
{
  "ir": {},
  "note": null,
  "sourceSpan": { "start": 0, "end": 0, "text": "" },
  "todo": { "construct": "", "coveredConstructs": [], "ordinal": 0 },
  "translatorVersion": "1"
}
```

Object keys are sorted with `compareEnUs`. `sourceSpan.text` is the Deluge slice (for a field rule, the condition text). `ir` is the owning workflow, function, blueprint phase, field rule, or approver property. `ordinal` separates two TODOs that share that span and construct. `coveredConstructs` lists constructs that collapsed into the same hole. An untranslated receiver, such as `unknownCall().missingMethod()`, is one hole `method:missingMethod` that covers `call:unknownCall`. A chain the translator already emits, such as `rows.get().size()`, is not a hole.

`translatorVersion` is the constant `1` in `packages/deluge/src/fill-todos.ts`. Bump it when the placeholder shape changes. Every old key then goes stale.

A task file also carries:

- `placeholder` — the exact `await shim.todo(...)` text, including the trailing semicolon when the hole is a whole statement
- `role` — `expression`, `statement`, or `note`
- `expectedSignature` — fill `ctx` and `shim`, async, return type `unknown`
- `shimApi` — the only calls the fill may make for this construct. It is not the full shim surface. `task:shareTo` and `task:if` get reads and pure helpers (log, input/record/old reads, convert, string, math, decimal, `isBlank`, list/map/each). A `method:` or `call:` builtin also gets that builtin's shim. A side-effect task gets that one capability (`sendmail` → `shim.mail.send`, `invokeurl` → `shim.http.invokeurl`, `delete` → `shim.datastore.delete`) and not the others. Replay recomputes this list from the construct. It does not trust a copy stored in the lock.
- `acceptanceTests` — parse, shim API, codegen lint, and the D3 golden-vector cases covering the hole (the construct and its covered constructs). An empty `golden-vectors` list means accept will reject any fill for this task. There is no unit execution.

`role: "note"` is a migration note or an approver residual. It has no hole to splice. Accept refuses it.

## Write a fill

The file is the replacement, not a module.

Expression hole (`var n = await shim.todo(...);`):

```js
shim.input.get(ctx, "A")
```

Statement hole (`await shim.todo(...);` is the whole statement). The semicolon is part of the hole, so the fill should include its own:

```js
shim.log.info(ctx, "filled");
```

Allowed: literals, locals, `await`, comparisons, assignments to locals, dotted calls on the listed `shim.*` methods (passing `ctx` through), and `for`, `for-in`, `for-of`, `while`, and `do` up to the loop cap below. Not allowed: `eval`, `Function`, `fetch`, `require`, `process`, `fs`, `net`, `Date.now`, `Math.random`, imports, any call that is not in `shimApi`, aliasing `shim` (`const d = shim.datastore`), destructuring `shim`, or computed members (`shim["datastore"]["delete"]`, `shim['mail'].send`). Quoted keys inside data objects (`{ "op": "true" }`) are data, not callees. The codegen lint also rejects clocks, `localeCompare`, and unordered `Object.keys` / map iteration.

The fill is parsed as the body of `(async function __fill(ctx, shim){ <fill> })`. The program must be that one function, and every character of the fill must sit inside its body. A fill that closes the function and continues at module scope is rejected.

## Accept

```sh
c2c fill-todos <file-or-directory> --accept <task-id> <fill-file> [--lock c2c.lock.json]
```

The app is parsed again and the id must still be one of its tasks. The fill is parsed and linted. It is not executed: running a fill, even in a child process, could let a crafted fill escape and write files on the host. The static check is the gate: one `__fill` function, the fill's characters exactly its body, and only allowlisted dotted shim calls. The hole's vector coverage is the union of the Creator vector cases (`tests/golden/cases.json`) for every builtin it names: the construct and each covered construct (`method:size` → `size`, `call:get` → `get`). Those cases are evaluated through the translator and shim runtime. They are catalogue cases, not the fill text: they prove that the shim calls the lint allows the fill to make for those constructs behave like Creator. A real mismatch blocks acceptance. A pending vector or a known parity-baseline gap does not.

**A fill with no vector coverage is rejected**, with the reason `has no Creator vector coverage`, and the lock is not written. That covers every `task:` hole (`task:shareTo`, `task:if`), translator notes such as `criteria-dynamic`, and any builtin without a captured case. Capture vectors for the builtin first; then the fill can be accepted.

The fill must also fit `FILL_LIMITS` in `packages/deluge/src/fill-check.ts`. `maxBytes` is 8192 UTF-8 bytes, because a fill replaces one hole and that size holds a short shim block with literals. `maxStatements` is 32, because every statement node in the fill counts, including nested ones, and a short sequence fits in 32 statements. `maxLoops` is 2 (`for`, `for-in`, `for-of`, `while`, and `do`), because a fill may contain one traversal and one nested scan. A fill over a cap is refused. The message names the limit and the measured value. The text is not shortened, and the lock is not written.

On success the lock is rewritten with sorted keys and a trailing newline. One trailing newline in the fill file is stripped. The lock entry stores the span, IR, construct, ordinal, fill, and `fillHash` (sha256 hex of the fill text). `fillHash` is not part of the task id. The id is assigned before a fill exists.

## Replay

```ts
import { generate, readLock } from 'creator-to-catalyst/deluge';

const stale = [];
const tree = generate(app, { lock: readLock('c2c.lock.json'), stale });
```

Each matching hole is checked again, then replaced with the fill text. The check is the same static lint as accept, using the allowlist derived from the live construct, and it requires `fillHash` to be the sha256 of `fill`. The same `FILL_LIMITS` check runs before a splice. A stored fill over a cap throws `FillTodoError` with the limit name and the measured value, and the hole is left unchanged. The fill is not shortened to fit. A hash mismatch, a lint failure, or a cap failure throws `FillTodoError` and splices nothing. `c2c fill-todos --report` exits 1 on that error. Server and client copies of the same hole get the same fill. A second run with the same lock produces the same bytes.

A hand-edited fill whose hash was updated to match is still refused when the text fails the lint. The hash does not make a lock entry trusted. It only catches an edit that forgot to update the hash.

`stale` receives entries that were not applied:

| reason | meaning |
| --- | --- |
| `stale` | the span, IR node, or translator version changed, or the TODO is gone |
| `integrity` | the stored fields do not hash to the key (the lock was edited) |
| `note` | the key now points at a note with no placeholder |
| `missing-site` | the placeholder is not in the generated tree |
| `uncovered` | the hole has no Creator vector coverage, the same rule accept enforces; a hand-written entry for it is refused and the `shim.todo` stays |

Nothing in that list is spliced. There is no silent fallback to an old fill.

From the CLI, without rewriting a tree:

```sh
c2c fill-todos <file-or-directory> --lock c2c.lock.json --report
```

Prints `ok <id>` or `stale <id> <reason>`. Exit 1 when any key is stale.

`migration-report.json` still counts what the translator could not translate. The lock is a replay overlay on the holes, not a second translator. Its `fillLockEntries` counts lock entries that apply to the app, and `deterministic` is false whenever that is non-zero (see the README, *What is deterministic*).

Its `alertDiagnostics` list carries a `verdict` per source `alert`. In Creator, `alert` runs in on load, on validate, on change / on user input, and on click (custom action / button) actions; a form-workflow `on success` rejects it at import, which is the only `disallowed` verdict. Everywhere else — schedules, approvals, blueprint phases, bare record events such as `on add`, `on add row`, and `on delete success`, and standalone or inline function bodies (callers are not analysed) — the placement is `unverified`, not proven disallowed; no client alert is emitted either way. When the alert line sits directly under a `//` comment-only line the diagnostic keeps its verdict and adds `note: "follows-comment-line"`, since that is also where the export's wrapped comment tails land; adjacency alone never softens a verdict. Classification uses the innermost event header of the ` / `-joined event path — a `/` inside a field name (`on change of Due/Paid`) is not a separator.

## Note diagnostics

Not every `role: "note"` task is a collapsed TODO. The translator also emits
diagnostics for constructs it translated but cannot fully honour. A
`sendmail` whose `attachments:` are `view:` or `report:` items
(https://www.zoho.com/deluge/help/misc-statements/send-mail.html) is
translated to `shim.mail.send` with a typed descriptor per attachment —
`{ kind: "view", name, criteria, format }`, `{ kind: "report", name, format }` —
because Catalyst Mail cannot render a Creator report into a PDF/inline body.
Each such item adds a `sendmail-attachment:view` / `sendmail-attachment:report`
note task. A `template:` item `as inline` or `as pdf` renders its record
print layout in the mail function instead — into the body for `inline`,
through SmartBrowz to a PDF attachment for `pdf` — so those items carry a
`rendered` descriptor and raise no diagnostic. `file:` attachments carry the
file expression through as `{ kind: "file", file }` and raise no diagnostic.
Like other notes they have no placeholder and `--accept` refuses them; they
exist so the report names what was not carried over.

## What stays offline

Emit, accept, and replay read the local app, the golden vectors already in the repo, and the lock file. They do not call Catalyst, Creator, or a model.
