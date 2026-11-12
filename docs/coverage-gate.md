# c2c coverage vs the 95% bar

A snapshot measurement of the Creator→Catalyst converter against the stated v1
definition: **at least 95% of components convert and pass parity; 100% of the
rest are flagged with a reason.**

## Denominator and statuses

- Denominator: the Creator feature inventory
  (an inventory of Creator help topics, 2,915 items across 2,808 doc pages;
  not included).
- Each item is classified into:
  - **converts+parity-tested** — converts and has **test-backed** parity
    evidence. The only paths are:
    * a feature-matrix row `verified` whose `evidence.testId` resolves to a
      real test in this tree (`file#exact test name`, the convention
      `tools/matrix-check.mjs` enforces). The feature-matrix snapshot used
      here carries no `evidence` fields, so no row qualifies — a bare
      `verified` status is a claim, not proof;
    * a Deluge builtin (`supported`/`shimmed`) with at least one golden case
      in `tests/golden/cases.json` that has a **compared** Creator vector —
      stored in the vectors bundle and neither a pending capture artifact
      nor a `parity-baseline.json` known gap. The compared case ids are
      cited per item;
    * a classification rule that names a test (`file#name`) or golden case
      ids.
    Every citation is re-resolved at measure time; a missing one downgrades
    the item to converts-untested.
  - **converts-untested** — converts but no parity test evidence (matrix
    `migrated`/`adapter-written`/`verified` without resolvable test evidence,
    Deluge catalogue `supported`/`shimmed` without a compared golden vector,
    schema/UI constructs that generate output).
  - **flagged-with-reason** — the converter reports why it cannot convert:
    *pipeline* flags are emitted by the pipeline itself (matrix
    `built-in-Creator`/`hard-gap`/`not a Creator feature`/`unknown`, `shim.todo`,
    schema `unsupported`, UI `todo`, shim unsupported-task warnings, analyzer
    needs-assessment); *audit* flags are non-portable verdicts declared by the
    classification rules (builder/docs/admin/SDK/platform surfaces with no `.ds`
    component), each with a reason.
  - **unflagged-gap** — a portable app component the converter neither handles
    nor flags.
- Category `9-limits` is a separate bucket (enforced / surfaced / documented),
  not part of the conversion denominator.

## Usage level

Usage is measured over local fixture apps (scratch directories and
re-export artifacts are excluded): every
form, field, report, page/page-element, workflow,
function, Deluge statement and integration block in the parsed IR. A used
instance "converts and passes parity" when the pipeline emits it **and** the
app passes the gate: Q1 (two `generatedTree` runs byte-identical), the
`analyze` deterministic flag (zero residual TODOs, no lock fills), Q2
(`compiles.ok`) and Q4 (`smokeClean.ok`). Q3 parity is only evidenced per
builtin via the golden vectors at inventory level — no per-app parity run
exists yet (quality gate Q3/Q5/Q6 are partial; see `docs/quality-gate.md`).

## Results

| category | items | converts+parity | converts-untested | flagged (pipeline/audit) | unflagged-gap | parity % |
|---|---|---|---|---|---|---|
| 1-fields | 488 | 0 | 228 | 1 / 103 | 156 | 0% |
| 3-workflows | 220 | 0 | 142 | 7 / 61 | 10 | 0% |
| 7-integrations-apis | 241 | 0 | 23 | 2 / 213 | 3 | 0% |
| 8-app-level | 387 | 0 | 44 | 0 / 312 | 31 | 0% |
| 5-pages | 82 | 0 | 44 | 0 / 30 | 8 | 0% |
| 2-forms | 51 | 0 | 7 | 0 / 22 | 22 | 0% |
| 4-reports | 105 | 0 | 30 | 7 / 9 | 59 | 0% |
| 6-deluge | 789 | 64 | 261 | 360 / 96 | 8 | 8.1% |
| **total** | **2363** | **64** | **779** | **377 / 846** | **297** | **2.7%** |

Limits bucket (separate): 552 items — enforced 0, surfaced 196, documented 356.

Usage level over 101 apps (37 passing the full gate Q1+Q2+Q4+deterministic):
Input corpora: a corpus of sample Creator apps (not included), 67 apps (20 passing); the synthetic fixtures, 34 apps (17 passing).

| component | instances | converts | converts+gate | flagged | unflagged-gap | gate-pass % |
|---|---|---|---|---|---|---|
| fields | 6413 | 6413 | 1802 | 0 | 0 | 28.1% |
| forms | 830 | 830 | 252 | 0 | 0 | 30.4% |
| reports | 1321 | 1208 | 332 | 113 | 0 | 25.1% |
| pages | 145 | 138 | 34 | 7 | 0 | 23.4% |
| pageElements | 743 | 700 | 187 | 43 | 0 | 25.2% |
| workflows | 3630 | 3630 | 852 | 0 | 0 | 23.5% |
| deluge statements | 16236 | 16088 | 3361 | 148 | 0 | 20.7% |
| integrations | 11 | 0 | 0 | 11 | 0 | 0% |

Top unflagged gaps by app impact (detectors over app facts):

| # | inventory item | apps | instances |
|---|---|---|---|
| 1 | 01.field-property-ar-field-augmented-reality-field-size AR field (augmented reality): Field size | 90 | 6398 |
| 2 | 01.field-property-date-field-size Date: Field size | 90 | 6398 |
| 3 | 01.field-property-date-time-field-size Date-time: Field size | 90 | 6398 |
| 4 | 01.field-property-decimal-field-size Decimal: Field size | 90 | 6398 |
| 5 | 01.field-property-drop-down-field-size Drop down: Field size | 90 | 6398 |
| 6 | 01.field-property-email-field-size Email: Field size | 90 | 6398 |
| 7 | 01.field-property-formula-field-size Formula: Field size | 90 | 6398 |
| 8 | 01.field-property-generic-set-height-for-form-fields Set Height for Form Fields | 90 | 6398 |
| 9 | 01.field-property-generic-set-size-for-form-fields Set Size for Form Fields | 90 | 6398 |
| 10 | 01.field-property-keyword-extraction-field-ai-field-height Keyword extraction field (AI): Field height | 90 | 6398 |
| 11 | 01.field-property-keyword-extraction-field-ai-field-size Keyword extraction field (AI): Field size | 90 | 6398 |
| 12 | 01.field-property-multi-line-field-size Multi line: Field size | 90 | 6398 |
| 13 | 01.field-property-object-detection-field-ai-field-size Object detection field (AI): Field size | 90 | 6398 |
| 14 | 01.field-property-ocr-text-analysis-field-ai-field-size OCR / Text analysis field (AI): Field size | 90 | 6398 |
| 15 | 01.field-property-percent-field-size Percent: Field size | 90 | 6398 |
| 16 | 01.field-property-prediction-field-ai-field-size Prediction field (AI): Field size | 90 | 6398 |
| 17 | 01.field-property-radio-field-size Radio: Field size | 90 | 6398 |
| 18 | 01.field-property-sentiment-analysis-field-ai-field-size Sentiment analysis field (AI): Field size | 90 | 6398 |
| 19 | 01.field-property-single-line-field-size Single line: Field size | 90 | 6398 |
| 20 | 01.field-property-subform-field-width Subform: Field width | 90 | 6398 |

Unflagged gaps with no .ds detector (impact not measurable): 172 of 297.

Synthetic parity cases: 564 pending across 33 apps (given/when/then specs; not counted as passes until they run against a store adapter).

## Caveats

- The feature matrix is provisional (`provisional: true`) and its
  statuses are the source of truth here only for items they cover; items
  without a matrix row are assessed by the coverage map rules.
- "Audit" flags are declared by the classification rules, not emitted at
  runtime — the report keeps the pipeline/audit split visible so the flagging
  gap is not hidden.
- Not-observable features (no `.ds` presence) cannot be usage-measured; they
  are reported as such, never counted as zero usage.
