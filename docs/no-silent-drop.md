# No silent drops

Every construct an app declares is either generated or listed as an explicit manual item in the migration report. Nothing is dropped without a trace.

The rule is enforced in code by the audit in `packages/quality/src/no-silent-drop.ts` and its tests.

A form-event server module is credited only when the generated client posts that route, or the submit and delete runtime calls it. The prefetch URL (`<route>/prefetch`) is not that call. On load, on user input, click, and subform row events do not post the server route, so each server body on those events is counted as `form-event-server-uninvoked` and is not treated as generated.
