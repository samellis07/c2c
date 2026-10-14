/**
 * Lookups and subforms for the React target (docs/react-target.md).
 *
 * A lookup field becomes a searchable picker over the parent form's paged
 * lookup endpoint; a multi lookup a searchable multi-select over the same
 * endpoint; a users field an email control (Creator stores the user's email
 * address). Subform columns keep the Creator order and each column gets the
 * same widget a top-level field of its type gets, so a lookup column is a
 * picker too.
 */
import type { UiField } from '../../ui/src/model.js';
import type { LookupSpec } from '../template/lib/c2c-ui/types.js';

/** Widgets drawn here. A lookup is drawn only when the export names its parent form. */
export const LOOKUP_WIDGETS = new Set(['lookup', 'lookup-multi']);

export function drawsLookup(field: UiField): boolean {
  if (field.widget === 'users') return true;
  return LOOKUP_WIDGETS.has(field.widget) && lookupSpec(field) !== undefined;
}

/**
 * The lookup part of a field spec: the parent form, the display field the
 * options show (the export's display format when it names one field, else
 * the linked field) and the endpoint that pages its options.
 */
export function lookupSpec(field: UiField): LookupSpec | undefined {
  const lookup = field.lookup;
  if (!LOOKUP_WIDGETS.has(field.widget) || !lookup || !lookup.form || !lookup.endpoint) return undefined;
  return { form: lookup.form, display: lookup.field || lookup.form, endpoint: lookup.endpoint };
}
