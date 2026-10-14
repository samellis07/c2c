/** The open form's spec, errors and loaded record, shared by its field widgets. */
import { createContext } from 'react';
import type { FormSpec } from '../types';

export interface FormState {
  form: FormSpec;
  /** Error text by field name, and by cell name (`Field[i].Column`) for subform cells. */
  errors: Record<string, string>;
  record: Record<string, unknown>;
  rowId?: string;
  /** Field rules from client handlers: hidden and disabled field/column names. */
  hidden?: ReadonlySet<string>;
  disabled?: ReadonlySet<string>;
  /** Per-field remount counter so a scripted set-value repaints an uncontrolled widget. */
  versions?: Record<string, number>;
  /** Fire `on user input` handlers for a field (Arc widgets mirror state, so no DOM change reaches the form). */
  notify?: (name: string) => void;
  /** Fire `on add row` / `on delete row` handlers for a subform grid. */
  rowEvent?: (field: string, event: 'addrow' | 'deleterow', index: number) => void;
}

export const FormContext = createContext<FormState | null>(null);
