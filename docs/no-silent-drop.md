# No silent drops

Every construct an app declares is either generated or listed as an explicit manual item in the migration report. Nothing is dropped without a trace.

The rule is enforced in code by the audit in `packages/quality/src/no-silent-drop.ts` and its tests.

A form-event server module is credited only when the generated client posts that route, or the submit and delete runtime calls it. The prefetch URL (`<route>/prefetch`) is not that call. On load, on user input, click, and subform row events the generated client module posts the route through a guarded `shim.client.run(ctx)` — a script with no client half of its own gets a synthetic client part that is nothing but that guarded call. What stays counted as `form-event-server-uninvoked` is what no generated caller reaches: a `submit`-route body whose submit URL an add-scoped on-success handler owns, and an `on start` (presuccess) body, which no client event dispatches and the submit pipeline does not call.
