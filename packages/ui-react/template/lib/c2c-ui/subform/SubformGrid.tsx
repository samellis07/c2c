/**
 * A Creator subform as an editable grid: one row per child record, one cell
 * per column in the Creator column order, each cell the control its column
 * type gets (a lookup column is a lookup picker). Rows are added and removed
 * in place and saved with the parent submit; cells are named
 * `Field[i].Column` (subform/rows.ts reads and checks them). The submit sends
 * the grid's whole list and the server replaces the parent's stored rows with
 * it, so a removed row is deleted and every saved row gets a new ROWID. Cell
 * errors from the row checks show under the cell (and describe its control),
 * and the grid's own error names the rows to fix.
 */
import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '../arc/components/button/button';
import inputStyles from '../arc/components/input/input.module.css';
import type { FieldSpec } from '../types';
import type { FieldProps } from '../runtime/extend';
import { FormContext } from '../form/context';
import { FieldBox, FieldError, LookupControl, LookupMultiControl } from '../lookup/LookupField';
import { cellName, editableColumns } from './rows';
import './subform.css';

const INPUT_TYPE: Record<string, string> = {
  text: 'text', email: 'email', users: 'email', phone: 'tel', url: 'url', number: 'number', decimal: 'number', percent: 'number', currency: 'number',
  date: 'date', datetime: 'datetime-local', time: 'time', richtext: 'text', name: 'text', address: 'text',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '–';
  if (Array.isArray(value)) return value.map(shown).join(', ');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).filter((v) => typeof v === 'string' && v !== '').join(' ') || '–';
  return String(value);
}

interface CellProps {
  column: FieldSpec;
  name: string;
  label: string;
  value: unknown;
  error?: string;
  errorId: string;
  /** Client field rule (`disable Field.Column`): the cell is read-only. */
  off?: boolean;
  /** Fire `on user input` for Arc-widget cells whose hidden input sees no DOM change. */
  notify?: () => void;
}

/** One cell's control, by column widget. */
function Cell({ column, name, label, value, error, errorId, off, notify }: CellProps): ReactNode {
  const invalid = error ? true : undefined;
  const described = error ? errorId : undefined;
  const common = { name, 'aria-label': label, 'aria-invalid': invalid, 'aria-describedby': described, 'aria-required': column.required || undefined, disabled: off || undefined };
  switch (column.widget) {
    case 'lookup':
      return column.lookup ? <LookupControl field={column} name={name} label={label} value={value} error={error} hideLabel links={false} describedBy={described} disabled={off} onChange={notify} /> : <input {...common} className={inputStyles.input} defaultValue={text(value)} />;
    case 'lookup-multi':
      return column.lookup ? <LookupMultiControl field={column} name={name} label={label} value={value} error={error} hideLabel links={false} describedBy={described} disabled={off} onChange={notify} /> : <input {...common} className={inputStyles.input} defaultValue={text(value)} />;
    case 'select':
    case 'radio':
      return (
        <select {...common} className={inputStyles.input} defaultValue={text(value) ?? ''}>
          <option value="">-Select-</option>
          {(column.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      );
    case 'multiselect': {
      const chosen = Array.isArray(value) ? value.map(String) : text(value) !== undefined ? [text(value)!] : [];
      return (
        <select {...common} className={`${inputStyles.input} c2c-cell-multi`} multiple defaultValue={chosen}>
          {(column.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      );
    }
    case 'decision':
      return <input {...common} type="checkbox" value="true" className="c2c-cell-check" defaultChecked={value === true || value === 'true'} />;
    case 'name':
    case 'address':
      if (column.subfields?.length) {
        const parts = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
        return (
          <span className="c2c-cell-parts" role="group" aria-label={label}>
            {column.subfields.map((part, index) => (
              <input key={part.name} name={`${name}.${part.name}`} className={inputStyles.input} aria-label={`${part.label}, ${label}`} aria-invalid={invalid} aria-describedby={described} aria-required={(column.required && index === 0) || undefined} placeholder={part.label} defaultValue={text(parts[part.name])} disabled={off || undefined} />
            ))}
          </span>
        );
      }
      return <input {...common} className={inputStyles.input} defaultValue={text(value)} />;
    case 'textarea':
      return <textarea {...common} className={`${inputStyles.input} c2c-cell-textarea`} rows={1} maxLength={column.maxLength} defaultValue={text(value)} />;
    default: {
      const type = INPUT_TYPE[column.widget] ?? 'text';
      return <input {...common} className={inputStyles.input} type={type} step={type === 'number' ? 'any' : undefined} maxLength={column.maxLength} defaultValue={text(value)} />;
    }
  }
}

export function SubformGrid({ field, error, value }: FieldProps) {
  const state = useContext(FormContext);
  const errors = state?.errors ?? {};
  const stored = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  const initial = stored.length || 1;
  const [rows, setRows] = useState(() => Array.from({ length: initial }, (_, i) => i));
  const [next, setNext] = useState(initial);
  const focusRow = useRef<number | null>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const baseId = useId();
  // `hide Subform.Column` hides that grid column, like the vanilla runtime.
  const columns = (field.subfields ?? []).filter((column) => !state?.hidden?.has(`${field.name}.${column.name}`));
  const editable = new Set(editableColumns(field).map((column) => column.name));

  // A reset puts the grid back to the rows it opened with.
  useEffect(() => {
    const form = tbody.current?.closest('form');
    if (!form) return;
    const reset = () => {
      setRows(Array.from({ length: initial }, (_, i) => i));
      setNext(initial);
    };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, [initial]);

  // After Add, the first control of the new row takes focus.
  useEffect(() => {
    if (focusRow.current === null) return;
    const row = tbody.current?.querySelector<HTMLElement>(`tr[data-row-key="${focusRow.current}"]`);
    focusRow.current = null;
    row?.querySelector<HTMLElement>('input:not([type="hidden"]), select:not([hidden]), textarea, button')?.focus();
  }, [rows]);

  const add = () => {
    const index = rows.length;
    focusRow.current = next;
    setRows((list) => [...list, next]);
    setNext(next + 1);
    state?.rowEvent?.(field.name, 'addrow', index);
  };
  const remove = (key: number, index: number) => {
    setRows((list) => list.filter((k) => k !== key));
    addButton.current?.focus();
    state?.rowEvent?.(field.name, 'deleterow', index);
  };

  return (
    <FieldBox field={field} className="c2c-subform">
      <fieldset data-subform={field.name} aria-invalid={error ? true : undefined} aria-describedby={error ? `${baseId}-error` : undefined}>
        <legend className={inputStyles.label}>{field.label}</legend>
        <div className="c2c-subform-scroll">
          <table>
            <thead>
              <tr>
                <td className="c2c-subform-num"><span className="c2c-sr-only">Row</span></td>
                {columns.map((column) => (
                  <th key={column.name} scope="col" data-column={column.name}>
                    {column.label}
                    {column.required ? <span className="c2c-required-mark" aria-hidden="true"> *</span> : null}
                  </th>
                ))}
                <th scope="col"><span className="c2c-sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody ref={tbody}>
              {rows.map((key, index) => {
                const row = stored[key];
                const rowId = text(row?.ROWID);
                return (
                  <tr key={key} data-row-key={key} className="c2c-subform-row">
                    <th scope="row" className="c2c-subform-num">
                      {index + 1}
                      {rowId ? <input type="hidden" name={cellName(field.name, index, 'ROWID')} value={rowId} /> : null}
                    </th>
                    {columns.map((column) => {
                      const name = cellName(field.name, index, column.name);
                      const cellError = errors[name];
                      const errorId = `${baseId}-${key}-${column.name}`;
                      return (
                        <td key={column.name} data-th={column.label} data-cell={name} aria-invalid={cellError ? true : undefined}>
                          {editable.has(column.name) ? (
                            <Cell column={column} name={name} label={`${column.label}, row ${index + 1}`} value={row?.[column.name]} error={cellError} errorId={errorId} off={state?.disabled?.has(`${field.name}.${column.name}`) || undefined} notify={() => state?.notify?.(name)} />
                          ) : (
                            <output className="c2c-computed" aria-label={`${column.label}, row ${index + 1}`}>{shown(row?.[column.name])}</output>
                          )}
                          <FieldError name={name} error={cellError} id={errorId} />
                        </td>
                      );
                    })}
                    <td>
                      <button type="button" className="c2c-icon-button" aria-label={`Remove row ${index + 1}`} onClick={() => remove(key, index)}>
                        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Button ref={addButton} type="button" variant="secondary" size="sm" onClick={add}>
          <Plus size={16} strokeWidth={1.75} aria-hidden="true" /> Add {field.label} row
        </Button>
      </fieldset>
      <FieldError name={field.name} error={error} id={`${baseId}-error`} />
    </FieldBox>
  );
}
