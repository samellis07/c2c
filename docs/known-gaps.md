# Known Gaps

These are intended fidelity boundaries; individual analyzer and report behavior must be verified for each input.

- Residual TODOs are counted per app and per kind by `c2c analyze` and recorded in `docs/determinism-status.md`; that document is the reference, and its figures must be recomputed on the release head before they are quoted.
- Server-side Deluge snippets require manual translation (`docs/ui.md`, `docs/fill-todos.md`). Client conditions that read server data, unsupported `openUrl` shapes, camera, lens and scan limits, CSS the sanitizer refuses, and unsupported navigation targets are also reported as manual steps.
- Unsupported or dynamic `openUrl` targets and markup the sanitizer drops are reported as manual steps (`docs/report-action-navigation.md`, `docs/ui.md`).
- Unsupported workflow approver forms (form-field, reporting-level) are denied by the endpoint and counted in `migration-report.json` (`approver-field`, `approver-reporting-level`) (`docs/ui.md`).
- Checkpoint and state files are written by `packages/data/src/checkpoint-file.ts`; inspect them before reuse.
- The toolbar setting is not carried; fields marked private or personal data get no generated privacy control; report `permission` blocks have no generated equivalent (`docs/determinism-status.md`).
- This release's documentation does not record a run of the generated output against a deployed Catalyst project or live Zoho; test the deployment before relying on it.
- Creator placement relative to On Validate and other items marked `[UNVERIFIED]` in the source documentation remain unverified (`docs/ui.md`).
