# No silent drops

Every construct an app declares is either generated or listed as an explicit manual item in the migration report. Nothing is dropped without a trace.

The rule is enforced in code by the audit in `packages/quality/src/no-silent-drop.ts` and its tests.

A form-event server module is credited only when the generated client posts that route, or the submit and delete runtime calls it. The prefetch URL (`<route>/prefetch`) is not that call. On load, on user input, click, and subform row events the generated client module posts the route through a guarded `shim.client.run(ctx)` — a script with no client half of its own gets a synthetic client part that is nothing but that guarded call. What stays counted as `form-event-server-uninvoked` is what no generated caller reaches: a `submit`-route body every post of whose scope an on-success handler takes over (add posts go to the add-scoped success route; edit posts to the edit-scoped one, or to the add-scoped one when there is no edit-scoped handler). An `on start` (presuccess) body is credited: no client event dispatches its `/handler` route, but the submit pipeline runs it — the submit stub and every live module that owns the submit URL import the module (marked `export const presuccess = true`) after the access gate and before the on-validate siblings, on the record event scope its script declares. A `/handler` route that also merges a non-presuccess server script is not marked, is not run, and stays counted.

Every silent drop carries a guided next step in the migration report that names what to do by hand.

A function that emits no module is credited only by a TODO inside its span. A migration-report warning that names the function is not a counted manual item, so a warned-but-otherwise-unlisted function is reported as a silent drop, with the drop note naming the warning. A TODO inside a warned function still counts once.
