# No silent drops

Every construct an app declares is either generated or listed as an explicit manual item in the migration report. Nothing is dropped without a trace.

The rule is enforced in code by the audit in `packages/quality/src/no-silent-drop.ts` and its tests.
