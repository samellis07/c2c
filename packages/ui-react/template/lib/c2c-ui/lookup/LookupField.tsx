/**
 * Lookup widgets. A lookup field is an Arc combobox and a multi lookup an Arc
 * multi-select, both over the parent form's paged lookup endpoint (see
 * source.ts): the first page is read when the control opens (or at once when
 * the record already holds a value, to show its display text), more pages on
 * request, and the search filters the pages read, asking the endpoint for
 * matching records the read pages do not hold. The submitted value is the
 * parent ROWID (a list of them for a multi lookup), carried by a named hidden
 * control so the record reader sees it like any other field. When the parent
 * form has a screen in this app, the chosen record links to its edit screen.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ExternalLink, RotateCw } from 'lucide-react';
import { Combobox } from '../arc/components/combobox/combobox';
import { MultiSelect } from '../arc/components/multi-select/multi-select';
import type { FieldSpec, LookupSpec } from '../types';
import { useEnv } from '../runtime/env';
import { hrefFor } from '../runtime/router';
import { failureText, retryable, useAccessDenied } from '../runtime/StatusScreens';
import type { FieldProps } from '../runtime/extend';
import './lookup.css';
import { lookupIds, lookupKnownLabels, lookupSource, type LookupOption, type LookupSnapshot, type LookupSource } from './source';

/** The [data-field] box every field widget renders. */
export function FieldBox({ field, children, className }: { field: FieldSpec; children: ReactNode; className?: string }) {
  return (
    <div className={['c2c-field', className].filter(Boolean).join(' ')} data-field={field.name} data-widget={field.widget} data-required={field.required || undefined}>
      {children}
    </div>
  );
}

export function FieldError({ name, error, id }: { name: string; error?: string; id?: string }) {
  return error ? (
    <p className="c2c-error" id={id} data-error-for={name} role="alert">
      {error}
    </p>
  ) : null;
}

function useLookup(lookup: LookupSpec, eager: boolean): { source: LookupSource; snap: LookupSnapshot } {
  const { api } = useEnv();
  const source = useMemo(() => lookupSource(api, lookup.endpoint), [api, lookup.endpoint]);
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const read = useCallback(() => source.snapshot(), [source]);
  const snap = useSyncExternalStore(subscribe, read, read);
  const deny = useAccessDenied();
  useEffect(() => {
    if (eager) void source.open();
  }, [source, eager]);
  useEffect(() => {
    if (snap.status === 403) deny();
  }, [deny, snap.status]);
  return { source, snap };
}

/** The pages read so far, plus any selected record they do not hold yet (shown by its stored text, else its ROWID). */
function withSelected(options: readonly LookupOption[], selected: readonly string[], known: Map<string, string>): LookupOption[] {
  const have = new Set(options.map((option) => option.value));
  const missing = selected.filter((id) => !have.has(id)).map((id) => ({ value: id, label: known.get(id) ?? id }));
  return [...missing, ...options];
}

function emptyText(snap: LookupSnapshot): string {
  if (snap.state === 'loading') return 'Loading records…';
  if (snap.state === 'error') return failureText(snap.status ?? 0) || 'The records could not be loaded.';
  if (!snap.options.length) return 'No records yet.';
  return snap.done ? 'No record matches.' : `No match in the first ${snap.options.length} records. Load more to search further.`;
}

/** Paging status and controls inside the open menu: loading, retry after a failure, load the next page. */
function LookupFooter({ source, snap, label }: { source: LookupSource; snap: LookupSnapshot; label: string }) {
  const hold = (event: { preventDefault(): void }) => event.preventDefault();
  if (snap.state === 'loading') return <p className="c2c-lookup-status" role="status">Loading records…</p>;
  if (snap.state === 'error') {
    if (!retryable(snap.status ?? 0)) return null;
    return (
      <button type="button" className="c2c-lookup-more" onMouseDown={hold} onClick={() => void source.retry()} aria-label={`Retry loading ${label} records`}>
        <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" /> Retry
      </button>
    );
  }
  if (snap.done || snap.pages === 0) return null;
  return (
    <button type="button" className="c2c-lookup-more" onMouseDown={hold} onClick={() => void source.more()}>
      Load more records <span className="c2c-lookup-count">({snap.options.length} shown)</span>
    </button>
  );
}

/** Links to the chosen parent records' edit screens, when the parent form has one in this app. */
function RecordLinks({ lookup, ids, options }: { lookup: LookupSpec; ids: readonly string[]; options: readonly LookupOption[] }) {
  const { spec } = useEnv();
  if (!ids.length || !spec.forms[lookup.form]) return null;
  const label = (id: string) => options.find((option) => option.value === id)?.label ?? id;
  return (
    <p className="c2c-lookup-links">
      {ids.map((id) => (
        <a key={id} className="c2c-lookup-open" href={hrefFor('form', lookup.form, 'edit', id)} data-lookup-record={id}>
          <ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" /> Open {label(id)}
        </a>
      ))}
    </p>
  );
}

/** Puts the control back to its first value when the form is reset. */
function useResetTo<T>(ref: React.RefObject<HTMLElement | null>, initial: T, set: (value: T) => void): void {
  const first = useRef(initial);
  useEffect(() => {
    const form = (ref.current as HTMLInputElement | null)?.form;
    if (!form) return;
    const reset = () => set(first.current);
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, [ref, set]);
}

export interface LookupControlProps {
  field: FieldSpec;
  /** The submitted control name: the field, or a subform cell (`Field[i].Column`). */
  name: string;
  /** The accessible name; in a grid cell it names the row. */
  label: string;
  value?: unknown;
  error?: string;
  /** Hide the visible label (a grid cell is named by its column header). */
  hideLabel?: boolean;
  /** Show links to the chosen records. */
  links?: boolean;
  describedBy?: string;
  /** Client field rule: the cell is read-only. */
  disabled?: boolean;
  /** Fired after a pick so a host (subform cell) can notify `on user input` handlers. */
  onChange?: () => void;
}

/** One lookup: a searchable single choice over the parent's pages, submitted as the parent ROWID. */
export function LookupControl({ field, name, label, value, error, hideLabel, links = true, describedBy, disabled, onChange }: LookupControlProps) {
  const lookup = field.lookup!;
  const initial = lookupIds(value)[0] ?? '';
  const [selected, setSelected] = useState(initial);
  const hidden = useRef<HTMLInputElement>(null);
  useResetTo(hidden, initial, setSelected);
  const { source, snap } = useLookup(lookup, initial !== '');
  const known = useMemo(() => lookupKnownLabels(value), [value]);
  const options = withSelected(snap.options, selected ? [selected] : [], known);
  return (
    <>
      <Combobox
        label={label}
        hideLabel={hideLabel}
        options={options}
        value={selected}
        onValueChange={(next) => {
          setSelected(next);
          onChange?.();
        }}
        onOpenChange={(open) => {
          if (open) void source.open();
        }}
        onQueryChange={(query) => void source.search(query)}
        emptyMessage={emptyText(snap)}
        footer={<LookupFooter source={source} snap={snap} label={label} />}
        required={field.required}
        disabled={disabled}
        aria-required={field.required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        data-lookup={lookup.endpoint}
      />
      <input ref={hidden} type="hidden" name={name} value={selected} />
      {links ? <RecordLinks lookup={lookup} ids={selected ? [selected] : []} options={options} /> : null}
    </>
  );
}

/** A multi lookup: a searchable multi-select over the parent's pages, submitted as a list of parent ROWIDs. */
export function LookupMultiControl({ field, name, label, value, error, hideLabel, links = true, describedBy, disabled, onChange }: LookupControlProps) {
  const lookup = field.lookup!;
  const initial = useMemo(() => lookupIds(value), [value]);
  const [selected, setSelected] = useState<string[]>(initial);
  const hidden = useRef<HTMLSelectElement>(null);
  useResetTo(hidden, initial, setSelected);
  const { source, snap } = useLookup(lookup, initial.length > 0);
  const known = useMemo(() => lookupKnownLabels(value), [value]);
  const options = withSelected(snap.options, selected, known);
  return (
    <>
      <MultiSelect
        label={label}
        hideLabel={hideLabel}
        options={options}
        value={selected}
        onValueChange={(next) => {
          setSelected(next);
          onChange?.();
        }}
        onOpenChange={(open) => {
          if (open) void source.open();
        }}
        onQueryChange={(query) => void source.search(query)}
        disabled={disabled}
        searchable
        emptyMessage={emptyText(snap)}
        footer={<LookupFooter source={source} snap={snap} label={label} />}
        placeholder="Select records"
        invalid={!!error}
        describedBy={describedBy}
      />
      {/* The chosen records are the field's real control: a native multi-select the combobox adds to and the user can trim directly. */}
      <select
        ref={hidden}
        name={name}
        multiple
        size={Math.min(Math.max(selected.length, 2), 6)}
        className="c2c-lookup-chosen"
        aria-label={`${label} selected`}
        required={field.required}
        value={selected}
        onChange={(event) => setSelected(Array.from(event.target.selectedOptions, (option) => option.value))}
        data-lookup={lookup.endpoint}
      >
        {selected.map((id) => (
          <option key={id} value={id}>
            {options.find((option) => option.value === id)?.label ?? id}
          </option>
        ))}
      </select>
      {links ? <RecordLinks lookup={lookup} ids={selected} options={options} /> : null}
    </>
  );
}

export function LookupField({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  const errorId = useId();
  return (
    <FieldBox field={field} className="c2c-lookup">
      <LookupControl field={field} name={name} label={field.label} value={value} error={error} describedBy={error ? errorId : undefined} />
      <FieldError name={name} error={error} id={errorId} />
    </FieldBox>
  );
}

export function LookupMultiField({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  const errorId = useId();
  return (
    <FieldBox field={field} className="c2c-lookup">
      <LookupMultiControl field={field} name={name} label={field.label} value={value} error={error} describedBy={error ? errorId : undefined} />
      <FieldError name={name} error={error} id={errorId} />
    </FieldBox>
  );
}
