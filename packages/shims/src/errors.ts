/**
 * Creator runtime failure. The message is Creator's text without the
 * capture prefix `Error at line : N, `.
 */
export class DelugeRuntimeError extends Error {
  readonly code: string = 'DELUGE_RUNTIME';
  constructor(message: string) {
    super(message);
    this.name = 'DelugeRuntimeError';
  }
}

/**
 * `cancel submit` in on validate. The record is not written. The message is the alert text that
 * preceded it in the same block, so the server response carries what Creator shows the user.
 */
export class SubmitRefused extends Error {
  readonly code: string = 'SUBMIT_REFUSED';
  constructor(alert: string | null) {
    super(alert ?? SUBMIT_REFUSED_DEFAULT_ALERT);
    this.name = 'SubmitRefused';
  }
}

export const SUBMIT_REFUSED_DEFAULT_ALERT = 'The record was not saved.';

/** Creator's modal text for a refused `cancel delete`. */
export const DELETE_REFUSED_HEADER = 'Delete validation failed for the following record';
export const DELETE_REFUSED_DEFAULT_ALERT = 'Failed to Delete Data.';

/** `cancel delete` in on validate, record event on delete. The row is not removed. */
export class DeleteRefused extends Error {
  readonly code: string = 'DELETE_REFUSED';
  constructor(alert: string | null) {
    super(`${DELETE_REFUSED_HEADER} | Alert Message: ${alert ?? DELETE_REFUSED_DEFAULT_ALERT}`);
    this.name = 'DeleteRefused';
  }
}

/**
 * A runtime rejection whose Creator text was never captured. `for each` over a
 * non-collection throws one: Creator refuses the value, but no observed message
 * exists to map, so this is deliberately NOT a DelugeRuntimeError — the quality
 * gate counts it as `unmapped`, not as a mapped Deluge error.
 */
export class UncapturedDelugeError extends Error {
  readonly code: string = 'DELUGE_UNCAPTURED';
  constructor(message: string) {
    super(message);
    this.name = 'UncapturedDelugeError';
  }
}

/**
 * A construct the translator did not translate (for example a criteria it
 * could not make static: `criteria-dynamic`). Creator runs these, so there is
 * no Creator message to map to: this is a coverage gap, kept distinct from
 * Deluge runtime errors so it is never mistaken for Creator behaviour.
 */
export class UntranslatedConstruct extends Error {
  readonly code: string = 'C2C_UNTRANSLATED';
  readonly construct: string;
  constructor(construct: string) {
    super(`criteria: untranslated (${construct})`);
    this.name = 'UntranslatedConstruct';
    this.construct = construct;
  }
}

/**
 * A Creator unique field that the store cannot enforce (Data Store's per-table unique
 * varchar limit) already holds this value. The text mirrors Catalyst's own 409
 * DUPLICATE_VALUE message for a store-level unique column.
 */
export class UniqueRefused extends Error {
  readonly code: string = 'DUPLICATE_VALUE';
  readonly field: string;
  constructor(field: string) {
    super(`Duplicate value for ${field}. Please give a different value`);
    this.name = 'UniqueRefused';
    this.field = field;
  }
}

/** c2c's own stale-read refusal; Data Store does not provide a conflict code. */
export class StaleWriteError extends Error {
  readonly code: string = 'C2C_STALE_WRITE';
  constructor(form: string) {
    super(`c2c stale write: ${form} changed after it was read; reload and retry`);
    this.name = 'StaleWriteError';
  }
}
