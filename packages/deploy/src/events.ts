/**
 * Async on-success support: the dead-letter and completion-ledger tables a
 * deploy creates for an app that emits event functions. Mirrors the mail log
 * — each table exists only for an app that uses the feature, per
 * docs/table-budget.md.
 */
import { ASYNC_ON_SUCCESS_WARNING, DEAD_LETTER_COLUMNS, DEAD_LETTER_TABLE, PROCESSED_COLUMNS, PROCESSED_TABLE } from '../../deluge/src/events.js';
import type { TableCreateStep } from './tables.js';

export { ASYNC_ON_SUCCESS_WARNING, DEAD_LETTER_TABLE, PROCESSED_TABLE };

/** Data Store table for event-function failure markers. Planned only when the app emits event functions. */
export function deadLetterTableStep(): TableCreateStep {
  return {
    table: DEAD_LETTER_TABLE,
    form: DEAD_LETTER_TABLE,
    nosql: false,
    columns: DEAD_LETTER_COLUMNS.map((column) => ({
      table: DEAD_LETTER_TABLE,
      column_name: column.name,
      data_type: column.type,
      ...(column.type === 'varchar' ? { max_length: 255 } : {}),
      is_unique: column.unique === true,
      is_mandatory: column.mandatory === true,
    })),
  };
}

/** Data Store table for the per-module completion ledger. Planned with the dead-letter table. */
export function processedTableStep(): TableCreateStep {
  return {
    table: PROCESSED_TABLE,
    form: PROCESSED_TABLE,
    nosql: false,
    columns: PROCESSED_COLUMNS.map((column) => ({
      table: PROCESSED_TABLE,
      column_name: column.name,
      data_type: column.type,
      ...(column.type === 'varchar' ? { max_length: 255 } : {}),
      is_unique: column.unique === true,
      is_mandatory: column.mandatory === true,
    })),
  };
}

/** Explicit opt-in flag asserting each table/action record trigger is wired. Required to deploy the lane. */
export const TRIGGERS_WIRED_FLAG = '--triggers-wired';

/**
 * Deploy-time trigger gate for the async on-success lane. The trigger/rule is
 * project configuration the deploy does not create: without it live writes
 * succeed while the deferred actions never run. Returns the blocker text when
 * the bundle emits event functions but the operator did not pass the explicit
 * opt-in, else null.
 */
export function asyncLaneBlocker(usesEvents: boolean, triggersWired: boolean): string | null {
  if (!usesEvents || triggersWired) return null;
  return (
    `${ASYNC_ON_SUCCESS_WARNING.construct}: ${ASYNC_ON_SUCCESS_WARNING.note} ` +
    `Deploy refuses without ${TRIGGERS_WIRED_FLAG}: re-run with it once each table/action ` +
    `record trigger is wired to functions/events/after-commit.mjs.`
  );
}
