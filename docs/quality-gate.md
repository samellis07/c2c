# Quality gate (Q1–Q7)

Generated code must be deterministic, correct, compile, and run without crashing. The gate has seven layers. An app counts as **verified** only when it passes every layer. No app is verified today, because Q3, Q5 and Q6 do not yet run per app.

| Layer | Definition | Status today |
| --- | --- | --- |
| Q1 determinism | Same input, same toolchain, byte-identical generated tree, in one process and across processes. | **Exists.** `packages/determinism` (tree manifests, codegen lint) and `npm run determinism:gallery`. A per-app `deterministic` field in `c2c analyze` and a CI job are planned. |
| Q2 static | Every generated module parses (`node --check`), has zero free identifiers, and type-checks against the shim and `ctx` surface (`tsc --checkJs`). | **Exists (this doc).** `packages/quality/src/static.ts`, `scope.ts`. Per app: `c2c analyze --quality` → `compiles`. |
| Q3 semantics | Translated Deluge matches values captured from Creator (golden vectors). | **Partial.** `tests/golden/parity.mjs` and `packages/deluge/test/golden.test.ts` compare translator output with captured vectors, with a shrinking baseline. Not reported per app. |
| Q4 smoke / fuzz | Every generated handler runs on seeded inputs from IR field types with no uncaught JS error. | **Exists (this doc).** `packages/quality/src/smoke.ts`, `inputs.ts`. Per app: `c2c analyze --quality` → `smokeClean`. |
| Q5 differential | Migrated app behaviour matches recorded Creator behaviour for the same inputs (saved rows, messages). | **Not yet.** Planned: compare saved rows and messages with captured Creator behaviour, per app. |
| Q6 Catalyst E2E + data parity | Deployed to Catalyst, exercised end to end, with data parity against Creator. This is the **verified** bar. | **Partial.** Deploy smoke (`c2c smoke`), the generated Playwright suite (`packages/determinism/src/e2e.ts`) and the Slate live tests exist for single apps. The offline data-parity checker (`c2c verify --data-parity`) compares a loaded export with stored-row dumps by per-table counts and canonical record hashes keyed by `c2c_source_id` (`packages/deploy/src/parity.ts`). Live parity reads ZCQL rows separately; no per-app result is recorded yet. |
| Q7 corpus CI | Q1–Q6 run in CI over a local corpus of 67 sample Creator apps (not included) and the 953 public `.ds` files. | **Not yet.** `npm run smoke:gallery` runs Q2 and Q4 over a local corpus. No CI job, and no public-corpus sweep for Q2/Q4. |

## Q2: compiles

For every generated `.mjs` / `.js` in the deploy tree (server functions, client handlers, Slate runtime, model and service worker):

1. **`node --check`** on each file.
2. **Free identifiers.** Each module is parsed with the TypeScript compiler API (already a dev dependency; no new dependency). `scope.ts` resolves module, function, block, `for`, `catch` and class scopes with hoisting. A reference that no scope declares and that is not an allowed global is reported. Allowed globals: the ECMAScript built-ins of the pinned Node, plus a fixed Node list for server modules (and the CommonJS wrapper names `require`, `module`, `exports`, `__dirname`, `__filename` for a server `.js` entry such as `functions/c2c_api/index.js`), plus a fixed browser and service-worker list for client and Slate modules. The browser list has no Node-only name (`process`, `Buffer`, `setImmediate`, `clearImmediate`, `require`, ...): Q4 runs client handlers on Node, so a client `process` reference would pass Q4 and still throw in the browser. `shim` and `ctx` are locals in generated code, so they need no allowance. This is the check that catches the unbound subform `row`.
3. **`tsc --checkJs --noEmit`** (compiler API, same options) over server and client handler modules, as two programs: server modules with `@types/node` and no DOM lib, client modules with the DOM lib and no `@types/node`, so a Node-only name in a client module is a gating `TS2304` / `TS2591`. The shim surface is typed by the declarations `tsc` emits for `packages/shims` (`dist/shims/src/*.d.ts`), so the typings are generated from source and never hand-maintained. Each exported `function name(ctx, ...)` gets a JSDoc `ShimContext` type for `ctx` in memory (same line count; the written tree is unchanged), so `ctx.shim.*` is fully typed and a wrong member or arity is an error.
   - **Gating** diagnostics are those inside translated handler bodies (functions whose first parameter is `ctx`) with codes for an unbound name, a missing member, a wrong arity, a wrong argument type, or a TDZ initialization (`GATING_CODES` in `static.ts`). A missing member or argument mismatch on a value the shim types as `unknown` does not gate.
   - **Advisories** are other handler-body diagnostics: arithmetic and comparison on `unknown` shim values, and JS-inferred assignability. checkJs cannot type Deluge's dynamic values, so these are counted but are not evidence of a fault.
   - **Template** diagnostics are outside handler bodies (request wrappers, JSON policy literals). They are counted, not gating.
   - The Slate runtime (`ui` modules) gets `node --check` and the free-identifier pass, not the type pass.
   - Slate copies of client handlers (`slate/assets/handlers/*`, byte-identical to `client/handlers/*`) get `node --check` only.

`compiles.ok` is true when there are zero `node --check` failures, zero free identifiers, and zero gating type errors.

The checks are proven to bite (`packages/quality/test/quality.test.ts`): a clean handler passes, then an injected unbound `row` fails the free-identifier pass, `TS2304` and Q4 (ReferenceError); `shim.string.toLower` fails as `TS2339` and Q4 (TypeError); a dropped `ctx` argument fails as `TS2554`; a syntax error fails `node --check` and the import; a client module reading `process`, `Buffer` or `setImmediate` fails the free-identifier pass and the DOM-typed type pass.

## Q4: smoke and seeded fuzz

A handler is an exported generated function whose first parameter is `ctx`: `handle`, `prefetch`, `clientActions` and custom functions. Report readers and other `(req, res)` wrappers are not handlers here. They carry no translated Deluge.

Each handler runs on a fresh dry-run runtime (`createRuntime({ dryRun: true })`) with:

- a fixed clock and the UTC zone;
- seeded in-memory Data Store rows for every form (`seed` option; 0, 1 or 3 rows);
- `ctx.record` built from the handler's form fields by IR type, and a valid `ctx.old`;
- `ctx.row` bound to the record, for for-each-record functions;
- `ctx.subformRow` set to row 0 of the subform, for a subform row event (`on user input of Sub.Field`, `on add row of Sub`, `on delete row of Sub`): the generated handler names the subform in `shim.subform.currentRow(ctx, "Sub")`. With 0 subform rows the row is null;
- custom-function arguments: arity from the generated function, Deluge types by position from the verbatim signature in the module header. A form-typed parameter gets a generated record of that form, or a list of records when the body iterates it (`for each rec in form`, a report action over selected records);
- client prefetches answered by running the app's own generated server `prefetch` for that path on the same seeded store. A path with no generated prefetch answers any slot with a seeded value.

Iterations 0–4 set every field to one variant: valid, null, empty, boundary, wrong-type. Later iterations draw a variant per field. Subform (grid) fields get 0, 1 or n rows, cycling by iteration. The PRNG is mulberry32 over an FNV-1a seed of `seed|app|module|handler|iteration`, so every run is identical. `npm test` uses 6 iterations on small fixtures; `npm run smoke:gallery` uses `GALLERY_ITERATIONS`.

Outcome of each call:

- **crash**: `TypeError`, `ReferenceError`, `RangeError`, `SyntaxError`, a 2 s timeout, or a non-Error throw. Fails the layer.
- **deluge**: a shim error mapped to a Creator runtime message (`DelugeRuntimeError`, `DelugeConversionError`, `DeleteRefused`, `SubmitRefused`, `RecordAccessError`, and the others in `DELUGE_ERROR_NAMES`). Allowed.
- **unmapped**: any other `Error`, such as `UntranslatedConstruct` (a criteria the translator left as `criteria-dynamic`) or `UncapturedDelugeError` (a rejection whose Creator message was never captured). Allowed by Q4 and counted, because it has no Creator message.

`smokeClean.ok` is true when no handler crashed. A crash on the all-valid input (iteration 0) is reported separately from a crash that only fuzzed inputs reach.

## Commands

```sh
npm test                                                     # Q2/Q4 unit tests and the redistributable fixtures
node dist/cli/src/c2c.js analyze <file|dir> --quality [--json]   # one app: compiles + smokeClean next to the readiness report
C2C_FIXTURES_DIR=<dir> npm run smoke:gallery                 # the local corpus, counts only (about 5 minutes)
C2C_FIXTURES_DIR=<dir> npm run smoke:gallery -- --json       # machine-readable summary
C2C_FIXTURES_DIR=<dir> npm run smoke:gallery -- --markdown   # the block below
```

The corpus sweep runs each app in its own process. The number of processes at once follows the load: the cores not taken by other work (cores minus the one-minute load average, not counting the sweep's own processes), between 1 and 4. A worker thread in each app process reports the process CPU time every 5 seconds. A report counts as progress only when the CPU time rose by at least 50 ms (1% of one core) since the previous one, since the reporting thread's own cost keeps it rising slightly even while the app is blocked. The process is killed when no report has counted for 10 minutes (blocked, stalled or stopped), when its CPU time reaches 60 minutes (a busy loop), or after 45 minutes of wall-clock time whatever its progress. An app that is slow on its own, or slow because the machine is busy, keeps running while it makes progress, up to that backstop.

A process that fails for an environmental reason (it timed out, was killed by a signal, could not be spawned, or reported `ENOMEM`, `EAGAIN`, `EMFILE`, `ENFILE`, `ENOSPC` or a heap out-of-memory) is retried up to 2 more times, one at a time, after the parallel pass. A failure the app raises itself (an error thrown while generating or measuring it, which the process reports and exits 1) is not retried: it fails the same way every time. If any app still fails after the retries, the sweep exits 1, lists the failed apps by index on stderr and prints no summary, so a partial table cannot be committed. Attempt, retry and timeout counts are printed on stderr only; the `--json` and `--markdown` output of a run with retries is the same as a run without.

The sweep prints counts, identifier names and normalized error signatures only: no app names and no source text. `migration-report.json` does not carry these fields yet. The report is written inside the tree that the gate measures, so adding them there needs a second generation pass.

## Local corpus summary

Regenerate the block with `--markdown` and paste it between the markers. The `inputs` digest covers every generated corpus tree, the gate source and the shim source. With `C2C_FIXTURES_DIR` set, `npm test` fails when the digest is stale. The `table` digest is the sha256 of the table body, so `npm test` fails on a hand-edited count with or without fixtures.

<!-- quality-gallery:begin table=bc856a8430b7953697564aba6da6770b647e1ca0f723b3ccd3617350dea3ab80 -->
Apps: 67 (errors 0). Q4 iterations per handler: 24, seed `c2c-q4`.

| Layer | Measure | Count |
| --- | --- | ---: |
| Q2 | apps passing (compiles) | 66 / 67 |
| Q2 | generated .mjs/.js modules | 16786 |
| Q2 | `node --check` failures | 0 |
| Q2 | modules scanned for free identifiers | 14258 |
| Q2 | free identifier references | 4 |
| Q2 | modules with a free identifier | 2 |
| Q2 | apps with a free identifier | 1 |
| Q2 | apps with an unbound `row` | 0 |
| Q2 | modules type-checked (checkJs) | 13923 |
| Q2 | type errors in handler bodies | 4 |
| Q2 | type advisories in handler bodies (not gating) | 3008 |
| Q2 | type errors in template code (not gating) | 4487 |
| Q4 | apps passing (smokeClean) | 67 / 67 |
| Q4 | handlers exercised | 6911 |
| Q4 | calls | 165864 |
| Q4 | handlers with an uncaught error | 0 |
| Q4 | handlers with an uncaught error on all-valid input | 0 |
| Q4 | handler modules failing to import | 0 |
| Q4 | calls ending in allowed DelugeRuntimeError | 4009 |
| Q4 | calls ending in allowed DelugeConversionError | 2190 |
| Q4 | calls ending in allowed SubmitRefused | 1303 |
| Q4 | calls ending in allowed DeleteRefused | 678 |
| Q4 | calls ending in allowed RangeIndexError | 120 |
| Q4 | calls ending in unmapped Error | 4385 |
| Q4 | calls ending in unmapped UncapturedDelugeError | 1363 |
| Q4 | calls ending in unmapped UntranslatedConstruct | 41 |
| Prefetch | endpoint modules scanned | 589 |
| Prefetch | non-read calls in prefetch endpoints | 0 |
| Prefetch | apps with a prefetch non-read | 0 |

Top free identifiers (references, apps):

| Identifier | References | Apps |
| --- | ---: | ---: |
| `d_class` | 4 | 1 |

Top Q4 crash signatures (handlers, apps):

| Signature | Handlers | On valid input | Apps |
| --- | ---: | ---: | ---: |
<!-- quality-gallery:end -->

