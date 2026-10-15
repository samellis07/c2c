import { useEffect, useState } from 'react';
import { Alert } from '../arc/components/alert/alert';
import { useEnv } from '../runtime/env';
import type { FormSpec } from '../types';

type Row = Record<string, unknown>;
type State = { status: 'loading' } | { status: 'ready'; row: Row } | { status: 'empty' } | { status: 'error'; code: number };

function valueText(value: unknown, field?: FormSpec['fields'][number]): string {
  if (value == null || value === '') return '–';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map((item) => valueText(item, field)).join(', ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.label === 'string') return obj.label;
    if (field?.widget === 'subform') {
      const visible = new Set((field.subfields ?? []).map((sub) => sub.name));
      return Object.entries(obj).filter(([name]) => visible.has(name)).map(([, item]) => valueText(item)).filter(Boolean).join(', ') || '–';
    }
    return Object.values(obj).filter((item) => item != null && item !== '').map((item) => valueText(item)).join(', ') || '–';
  }
  return String(value);
}

/** A standalone, read-only record view. The untrusted route id is always scoped by the server's record endpoint. */
export function RecordSummary({ form, rowId }: { form: FormSpec; rowId?: string }) {
  const { api } = useEnv();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    if (!rowId) { setState({ status: 'empty' }); return () => { current = false; }; }
    setState({ status: 'loading' });
    api.post<{ record?: Row }>(form.recordEndpoint, { ROWID: rowId }).then((reply) => {
      if (!current) return;
      if (!reply.ok) {
        setState(reply.status === 404 ? { status: 'empty' } : { status: 'error', code: reply.status });
        return;
      }
      const record = reply.body?.record;
      setState(record && typeof record === 'object' && !Array.isArray(record) ? { status: 'ready', row: record } : { status: 'empty' });
    }).catch(() => { if (current) setState({ status: 'error', code: 0 }); });
    return () => { current = false; };
  }, [api, form.recordEndpoint, rowId]);

  return (
    <section className="c2c-card" data-record-summary={form.name}>
      {state.status === 'loading' ? <p>Loading record…</p> : null}
      {state.status === 'empty' ? <p data-record-empty="">No record is available.</p> : null}
      {state.status === 'error' ? <Alert tone="danger" title={state.code === 403 ? 'This record is not available.' : 'This record could not be loaded.'} /> : null}
      {state.status === 'ready' ? (
        <table><tbody>{form.fields.filter((field) => Object.prototype.hasOwnProperty.call(state.row, field.name)).map((field) => (
          <tr key={field.name}><th scope="row">{field.label || field.name}</th><td>{valueText(state.row[field.name], field)}</td></tr>
        ))}</tbody></table>
      ) : null}
    </section>
  );
}
