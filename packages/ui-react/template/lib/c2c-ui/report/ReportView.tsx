/**
 * A Creator report: heading, search, filters, the record table, paging, and
 * the data states. Rows come from POST <queryEndpoint> { op: "query", page,
 * pageSize, sort, q, filter } on c2c_api (the endpoint applies the Creator
 * criteria, sort and the caller's access policy). A static host with no data
 * function (404/405/501) is an empty report, not an error.
 *
 * List views group by the first `group by` field. Other views (kanban,
 * calendar, ...) stay a counted stub until they are generated. A record
 * route (`#/report/<name>/row/<ROWID>`) renders the detail layout when the
 * export has one.
 *
 * A 403 on the list or a record read swaps the screen for the access-denied
 * screen; an ended session, an outage or a dropped network each get their own
 * line, and only the last two offer Retry. A row or header action that is
 * refused says so in the notice. The server's text is never shown.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { RotateCw, Search } from 'lucide-react';
import { Alert } from '../arc/components/alert/alert';
import { Button } from '../arc/components/button/button';
import { EmptyState } from '../arc/components/empty-state/empty-state';
import { FilterToolbar } from '../arc/components/filter-toolbar/filter-toolbar';
import { Pagination } from '../arc/components/pagination/pagination';
import { SortableDataTable, type DataColumn, type SortState } from '../arc/components/sortable-data-table/sortable-data-table';
import type { FormSpec, ReportSpec } from '../types';
import { useEnv } from '../runtime/env';
import { Slot, useCustomization } from '../runtime/extend';
import { hrefFor } from '../runtime/router';
import { failureText, retryable, useAccessDenied } from '../runtime/StatusScreens';
import { criteriaTodo, matchCriteria } from './criteria';

type Row = Record<string, unknown>;
type Load = { state: 'loading' } | { state: 'error'; status: number } | { state: 'ready'; rows: Row[]; notice?: string };

/** The error state of a failed read: the status's own line, and Retry only where asking again can help. */
function LoadError({ status, what, onRetry }: { status: number; what: string; onRetry: () => void }) {
  return (
    <div data-state="error">
      <Alert tone="danger" title={failureText(status) || `The ${what} could not be loaded.`}>
        {retryable(status) || !failureText(status) ? (
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" /> Retry
          </Button>
        ) : null}
      </Alert>
    </div>
  );
}

/** The notice line for a refused or failed row/header action. */
function actionFailure(status: number, fallback: string): string {
  return failureText(status) || fallback;
}

/** A cell's text: composite values joined, lists comma-separated, decisions as Yes/No, file references by name. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '–';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.key === 'string') return obj.key.split('/').pop() ?? obj.key;
    return Object.values(obj).filter((v) => v !== '' && v !== null && v !== undefined).map(formatValue).join(', ') || '–';
  }
  return String(value);
}

/** The query the report endpoint answers: the Creator sort (or the header sort), search text and named filter. */
export function buildQuery(report: ReportSpec, opts: { page: number; q: string; filter: string; sort: SortState | null }): Record<string, unknown> {
  const sort = opts.sort
    ? [{ field: opts.sort.key, order: opts.sort.direction === 'desc' ? 'descending' : 'ascending' }]
    : report.sort.map((s) => ({ field: s.field, ...(s.order ? { order: s.order } : {}) }));
  return { op: 'query', page: opts.page, pageSize: report.pageSize, sort, q: opts.q, filter: opts.filter };
}

/** Group rows in first-seen order, like the export's lanes. Keys are display text; '' is the empty group. */
export function groupRows(rows: Row[], field: string): { key: string; rows: Row[] }[] {
  const lanes: { key: string; rows: Row[] }[] = [];
  const byKey = new Map<string, { key: string; rows: Row[] }>();
  for (const row of rows) {
    const text = formatValue(row[field]);
    const key = text === '–' ? '' : text;
    let lane = byKey.get(key);
    if (!lane) {
      lane = { key, rows: [] };
      byKey.set(key, lane);
      lanes.push(lane);
    }
    lane.rows.push(row);
  }
  return lanes;
}

const CAMEL = /-([a-z])/g;

/** A `conditional formatting` fragment (`color:#19bc9f;`) as a React style. */
export function parseFormat(format: string): CSSProperties {
  const style: Record<string, string> = {};
  for (const part of String(format ?? '').split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const name = part.slice(0, at).trim().toLowerCase().replace(CAMEL, (_, ch: string) => ch.toUpperCase());
    const value = part.slice(at + 1).trim();
    if (name && value) style[name] = value;
  }
  return style as CSSProperties;
}

/** Cell paint per column index, from the formats whose condition holds for the row. */
function rowStyles(report: ReportSpec, row: Row): Map<number, CSSProperties> {
  const styles = new Map<number, CSSProperties>();
  if (!report.conditionalFormats.length) return styles;
  for (const format of report.conditionalFormats) {
    if (!format.format) continue;
    let hit = false;
    try {
      hit = matchCriteria(row, format.criteria);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    const targets = format.fields?.length ? format.fields : report.columns.map((c) => c.field);
    for (const name of targets) {
      const index = report.columns.findIndex((c) => c.field === name);
      if (index < 0) continue;
      styles.set(index, { ...styles.get(index), ...parseFormat(format.format) });
    }
  }
  return styles;
}

export function ReportView({ report, row }: { report: ReportSpec; row?: string }) {
  const { spec } = useEnv();
  // A page can embed a report its caller may not open (a hidden-section
  // target): the router only gates the report's own route, so the embed
  // refuses it here, before any rows request — the same denied state, in
  // place, with the rest of the page untouched.
  if (spec.denied?.includes(report.name)) {
    return <p data-access-status="403">This page is not available.</p>;
  }
  if (row && report.detail) return <RecordDetail report={report} rowId={row} />;
  if (report.view !== 'list') return <ViewStub report={report} />;
  return <ReportList report={report} />;
}

const BULK_WIDGETS = new Set(['text', 'textarea', 'email', 'phone', 'number', 'decimal', 'percent', 'currency', 'date', 'datetime', 'time', 'decision', 'select', 'radio', 'url']);

/**
 * Fields a blueprint stage hides or locks. A bulk edit posts without a
 * per-row stage context, so a field any stage removes from the editable set
 * is never offered.
 */
function stageLimitedFields(form: FormSpec): ReadonlySet<string> {
  const limited = new Set<string>();
  for (const spec of form.stageFields ?? []) {
    for (const rules of Object.values(spec.stages ?? {})) {
      for (const name of rules.hidden ?? []) limited.add(name);
      for (const name of rules.readonly ?? []) limited.add(name);
      if (!Array.isArray(rules.visible) && !Array.isArray(rules.updatable)) continue;
      for (const field of form.fields) {
        if (rules.visible?.includes(field.name) === false) limited.add(field.name);
        if (rules.updatable?.includes(field.name) === false) limited.add(field.name);
      }
    }
  }
  return limited;
}

/** Bulk-edit candidates: generated scalar controls that are shown and writable at every stage. */
function bulkEditableFields(form: FormSpec | undefined): FormSpec['fields'] {
  if (!form) return [];
  const limited = stageLimitedFields(form);
  return form.fields.filter((field) => field.generated && field.visibility !== false && !field.readonly && !limited.has(field.name) && BULK_WIDGETS.has(field.widget));
}

/** A non-list view stays visibly pending until its renderer is implemented. */
function ViewStub({ report }: { report: ReportSpec }) {
  const custom = useCustomization();
  const own = custom.reports?.[report.name];
  return (
    <section className="c2c-card" data-report={report.name} data-view={report.view}>
      <h1>{report.label}</h1>
      <Slot>{own?.slots?.before}</Slot>
      <div data-view-stub={report.view}>
        <EmptyState title="View not available" description={`${report.label} is a ${report.view} view, which this app does not draw yet.`} />
      </div>
      {report.todo ? <p className="todo">{report.todo}</p> : null}
      <Slot>{own?.slots?.after}</Slot>
    </section>
  );
}

function ReportList({ report }: { report: ReportSpec }) {
  const { api, spec } = useEnv();
  const custom = useCustomization();
  const own = custom.reports?.[report.name];
  const [page, setPage] = useState(0);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(new Set());
  const [bulkField, setBulkField] = useState('');
  const [bulkValue, setBulkValue] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkForm = report.form ? spec.forms[report.form] : undefined;
  const bulkFields = bulkEditableFields(bulkForm);
  const deny = useAccessDenied();

  const body = useMemo(() => buildQuery(report, { page, q, filter, sort }), [report, page, q, filter, sort]);
  const bodyText = JSON.stringify(body);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    api.post<{ rows?: Row[]; notice?: string }>(report.queryEndpoint, JSON.parse(bodyText) as Record<string, unknown>).then(
      (reply) => {
        if (!live) return;
        if ([404, 405, 501].includes(reply.status)) setLoad({ state: 'ready', rows: [] });
        else if (reply.status === 403) deny();
        else if (!reply.ok) setLoad({ state: 'error', status: reply.status });
        else {
          const rows = Array.isArray(reply.body?.rows) ? reply.body!.rows! : [];
          const notice = typeof reply.body?.notice === 'string' && reply.body.notice ? reply.body.notice : undefined;
          setLoad({ state: 'ready', rows, ...(notice ? { notice } : {}) });
        }
      },
      () => live && setLoad({ state: 'error', status: 0 }),
    );
    return () => {
      live = false;
    };
  }, [api, deny, report.queryEndpoint, bodyText, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const search = useCallback(
    (event: { preventDefault(): void }) => {
      event.preventDefault();
      setQ(query);
      setPage(0);
    },
    [query],
  );
  const pickFilter = useCallback((value: string) => {
    setFilter(value);
    setPage(0);
  }, []);
  const changeSort = useCallback((next: SortState) => {
    setSort(next);
    setPage(0);
  }, []);

  const live = load.state === 'ready' ? load.rows.filter((row) => row.ROWID === undefined || !gone.has(String(row.ROWID))) : [];
  const needle = query.trim().toLowerCase();
  // The endpoint answers `q` itself; the local pass keeps lookup display
  // values and a harness fake (which answers every query alike) searchable.
  const shown = needle ? live.filter((row) => report.columns.some((c) => formatValue(row[c.field]).toLowerCase().includes(needle))) : live;

  const runAction = useCallback(
    (name: string, endpoint: string, recordId?: string) => {
      setActionNote(null);
      api.post<{ dryRun?: boolean }>(endpoint, recordId === undefined ? {} : { ROWID: recordId }).then(
        (reply) => {
          if (reply.status === 403) {
            deny();
            return;
          }
          if (!reply.ok) {
            setActionNote(actionFailure(reply.status, `The action "${name}" did not run.`));
            return;
          }
          if (reply.body?.dryRun === false) setActionNote(`${name} ran.`);
          else setActionNote(`${name} ran. Preview: nothing was saved yet.`);
        },
        () => setActionNote(`The action "${name}" did not run.`),
      );
    },
    [api, deny],
  );

  const removeRow = useCallback(
    (rowId: string) => {
      const endpoint = report.deleteEndpoint;
      if (!endpoint) return;
      api.post(endpoint, { ROWID: rowId }).then(
        (reply) => {
          if (reply.status === 403) {
            deny();
            return;
          }
          if (!reply.ok) {
            setActionNote(actionFailure(reply.status, 'The record was not deleted.'));
            return;
          }
          setGone((prev) => new Set(prev).add(rowId));
          setActionNote(reply.body && (reply.body as { dryRun?: boolean }).dryRun === false ? 'Record deleted.' : 'Record deleted. Preview: nothing was removed yet.');
        },
        () => setActionNote('The record was not deleted.'),
      );
    },
    [api, deny, report],
  );

  const initialSort: SortState | undefined = report.sort[0]
    ? { key: report.sort[0].field, direction: /desc/i.test(report.sort[0].order ?? '') ? 'desc' : 'asc' }
    : undefined;
  const actionNameFor = (endpoint: string, fallback: string) => report.customActions.find((a) => a.endpoint === endpoint)?.name ?? fallback;
  const recordCustomActions = report.customActions.filter(
    (action) => !action.header && !report.columns.some((c) => c.action === action.endpoint),
  );
  const columns: DataColumn<Row>[] = report.columns.map((column, index) => ({
    key: column.field,
    label: column.label,
    phone: column.phone,
    // An action cell posts per record; it is not a query column, so the header offers no sort.
    ...(column.action ? { sortable: false as const } : column.numeric ? { numeric: true } : {}),
    render: (value: unknown, row: Row): ReactNode => {
      if (column.action) {
        const actionName = actionNameFor(column.action, column.label);
        const actionLabel = actionName.toLowerCase().includes(column.label.toLowerCase())
          ? actionName
          : `${column.label}: ${actionName}`;
        return (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            data-action={column.action}
            aria-label={actionLabel}
            onClick={() => runAction(column.label, column.action!, row.ROWID === undefined ? undefined : String(row.ROWID))}
          >
            {column.label}
          </Button>
        );
      }
      const paint = rowStyles(report, row).get(index);
      const text = own?.cells?.[column.field]?.(value, row) ?? formatValue(value);
      if (report.detail && index === 0 && row.ROWID !== undefined && row.ROWID !== '') {
        return (
          <a href={hrefFor('report', report.name, 'row', String(row.ROWID))} data-row-link="">
            {paint ? <span style={paint}>{text}</span> : text}
          </a>
        );
      }
      return paint ? <span style={paint}>{text}</span> : text;
    },
  }));
  const canBulkEdit = !!bulkForm && report.rowActions.edit && bulkFields.length > 0;
  if (canBulkEdit) columns.unshift({
    key: '__bulkSelect', label: 'Select', sortable: false, phone: true,
    render: (_value: unknown, row: Row): ReactNode => {
      const id = row.ROWID === undefined || row.ROWID === '' ? '' : String(row.ROWID);
      if (!id) return null;
      const checked = selectedRows.has(id);
      return <input type="checkbox" aria-label={`Select record ${id}`} checked={checked} disabled={bulkBusy || (!checked && selectedRows.size >= 25)} onChange={(event) => setSelectedRows((prev) => {
        const next = new Set(prev);
        if (event.currentTarget.checked && next.size < 25) next.add(id); else next.delete(id);
        return next;
      })} />;
    },
  });
  const applyBulk = async () => {
    if (!bulkForm || !bulkField || !selectedRows.size || bulkBusy) return;
    setBulkBusy(true);
    setActionNote(null);
    const endpoint = bulkForm.editSubmitEndpoint || bulkForm.submitEndpoint;
    const failures: string[] = [];
    let updated = 0;
    for (const rowId of selectedRows) {
      try {
        const reply = await api.post<{ error?: string }>(endpoint, { ROWID: rowId, record: { [bulkField]: bulkValue } });
        if (!reply.ok) failures.push(`${rowId} (${actionFailure(reply.status, reply.body?.error || 'not updated')})`);
        else updated += 1;
      } catch {
        failures.push(`${rowId} (request failed)`);
      }
    }
    setBulkBusy(false);
    setSelectedRows(new Set());
    setActionNote(failures.length ? `Updated ${updated} of ${updated + failures.length} rows. Failed rows: ${failures.join('; ')}` : `Updated ${updated} rows.`);
    setAttempt((n) => n + 1);
  };
  const hasForm = !!report.form;
  const editable = hasForm && report.rowActions.edit;
  const deletable = hasForm && report.rowActions.delete && report.deleteEndpoint;
      const showRowActions = hasForm || recordCustomActions.length > 0 || own?.rowActions;
  if (showRowActions) {
    columns.push({
      key: '__actions',
      label: 'Actions',
      sortable: false,
      phone: true,
      render: (_value: unknown, row: Row): ReactNode => {
        const id = row.ROWID !== undefined && row.ROWID !== '' ? String(row.ROWID) : '';
        return (
          <span className="c2c-row-actions">
            {id && (editable || report.detail) ? (
              <a
                className="c2c-row-open"
                href={editable ? hrefFor('form', report.form!, 'edit', id) : hrefFor('report', report.name, 'row', id)}
                aria-label={`${editable ? 'Edit' : 'Open'} record ${id}`}
              >
                {editable ? 'Edit' : 'Open'}
              </a>
            ) : null}
            {deletable && id ? (
              <Button type="button" variant="secondary" size="sm" data-row-delete="" onClick={() => removeRow(id)}>
                Delete
              </Button>
            ) : null}
            {recordCustomActions.map((action) => (
              <Button
                key={action.name}
                type="button"
                variant="secondary"
                size="sm"
                data-action={action.endpoint}
                onClick={() => runAction(action.name, action.endpoint, id || undefined)}
              >
                {action.name}
              </Button>
            ))}
            {own?.rowActions?.(row)}
          </span>
        );
      },
    });
  }
  const Table = custom.components?.ReportTable;
  const Empty = custom.components?.EmptyState;
  const named = report.filters.map((f) => f.label).filter((label): label is string => !!label);
  // A field-only filter has no criteria to offer; name it instead of dropping it silently.
  const unoffered = report.filters.filter((f) => !f.label).map((f) => f.field).filter((field): field is string => !!field);
  const unmigrated = report.conditionalFormats.some((f) => criteriaTodo(f.criteria));
  const groupField = report.groupBy[0]?.field;
  const groups = groupField ? groupRows(shown, groupField) : null;
  const showPages = load.state === 'ready' && (page > 0 || live.length >= report.pageSize);
  const headerActions = report.customActions.filter((a) => a.header === true);

  const table = (rows: Row[], caption: string) =>
    Table ? (
      <Table report={report} rows={rows} />
    ) : (
      // The table remounts while a query loads; it re-seeds from the chosen sort, not the report's.
      <SortableDataTable rows={rows} columns={columns} rowKey={(row) => String(row.ROWID ?? JSON.stringify(row))} caption={caption} defaultSort={sort ?? initialSort} onSortChange={changeSort} />
    );

  return (
    <section className="c2c-card" data-report={report.name} data-view={report.view}>
      <h1>{report.label}</h1>
      <Slot>{own?.slots?.before}</Slot>
      <div className="c2c-report-tools">
        <form className="c2c-search-form" onSubmit={search} role="search">
          <label className="c2c-search">
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
            <input type="search" aria-label={`Search ${report.label}`} placeholder="Search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
        </form>
        {named.length ? (
          <FilterToolbar
            filters={filter ? [{ id: 'filter', label: 'Filter', value: filter }] : []}
            onRemove={() => pickFilter('')}
            onClearAll={() => pickFilter('')}
            addFilter={{
              fields: [{ id: 'filter', label: 'Filter', options: named }],
              onAdd: (chip) => pickFilter(chip.value ?? ''),
              label: 'Filter',
            }}
          />
        ) : null}
        {headerActions.map((action) => (
          <Button key={action.name} type="button" variant="secondary" size="sm" data-action={action.endpoint} onClick={() => runAction(action.name, action.endpoint)}>
            {action.name}
          </Button>
        ))}
        <Slot>{own?.slots?.toolbar}</Slot>
      </div>
      {canBulkEdit ? (
        <div className="c2c-report-tools" data-bulk-edit>
          <label>
            Field to edit
            <select aria-label="Field to edit" value={bulkField} onChange={(event) => { setBulkField(event.currentTarget.value); setBulkValue(''); }}>
              <option value="">Choose a field</option>
              {bulkFields.map((field) => <option key={field.name} value={field.name}>{field.label}</option>)}
            </select>
          </label>
          <label>
            New value
            {(() => {
              const field = bulkFields.find((item) => item.name === bulkField);
              if (field && ['select', 'radio', 'decision'].includes(field.widget)) {
                const choices = field.widget === 'decision' ? ['true', 'false'] : field.choices ?? [];
                return <select aria-label="New value" value={bulkValue} onChange={(event) => setBulkValue(event.currentTarget.value)}><option value="">Choose a value</option>{choices.map((value) => <option key={value} value={value}>{value}</option>)}</select>;
              }
              return <input aria-label="New value" type={field?.widget === 'number' ? 'number' : 'text'} value={bulkValue} onChange={(event) => setBulkValue(event.currentTarget.value)} disabled={!field} />;
            })()}
          </label>
          <Button type="button" variant="secondary" size="sm" disabled={!selectedRows.size || !bulkField || bulkBusy} onClick={() => void applyBulk()}>
            {bulkBusy ? 'Updating…' : `Edit ${selectedRows.size} selected`}
          </Button>
          <span aria-live="polite">Maximum 25 rows per batch.</span>
        </div>
      ) : null}
      {actionNote ? (
        <p className="c2c-notice" role="status">
          {actionNote}
        </p>
      ) : null}
      {unmigrated ? <p className="todo">A conditional formatting rule was not migrated; its highlighting is off.</p> : null}
      {report.note ? <p className="todo" data-report-note>{report.note}</p> : null}
      {report.todo ? <p className="todo">{report.todo}</p> : null}
      {unoffered.length ? (
        <p className="todo">
          {unoffered.length === 1 ? `A field filter without criteria is not offered: ${unoffered[0]}.` : `Field filters without criteria are not offered: ${unoffered.join(', ')}.`}
        </p>
      ) : null}
      {load.state === 'loading' ? (
        <p className="c2c-loading" data-state="loading" role="status">
          Loading records…
        </p>
      ) : load.state === 'error' ? (
        <LoadError status={load.status} what="records" onRetry={retry} />
      ) : shown.length === 0 ? (
        <div data-state="empty">
          {Empty ? <Empty report={report} /> : <EmptyState title="No records found" description={needle || filter ? 'No record matches.' : 'Records added through the form appear here.'} />}
        </div>
      ) : (
        <div className="table-wrap">
          {groups ? (
            groups.map((group) => (
              <div key={group.key} data-group={group.key}>
                <h3 className="c2c-group">
                  {groupLabel(group.key)} ({group.rows.length})
                </h3>
                {table(group.rows, `${report.label}: ${groupLabel(group.key)}`)}
              </div>
            ))
          ) : (
            <>{table(shown, report.label)}</>
          )}
        </div>
      )}
      {load.state === 'ready' && load.notice ? (
        <p className="todo" data-notice="">
          {load.notice}
        </p>
      ) : null}
      {showPages ? (
        <nav className="c2c-pages" aria-label={`${report.label} pages`}>
          <span className="c2c-sr-only" data-page-label="">
            Page {page + 1}
          </span>
          <Pagination page={page + 1} pageCount={live.length >= report.pageSize ? page + 2 : page + 1} onPageChange={(next) => setPage(next - 1)} label={`${report.label} pages`} />
        </nav>
      ) : null}
      <Slot>{own?.slots?.after}</Slot>
    </section>
  );
}

/** Display text of a group key; the empty group reads as none. */
function groupLabel(key: string): string {
  return key === '' ? '(none)' : key;
}

/** One record through the form's record endpoint: labelled values, the edit opener, and the way back. */
function RecordDetail({ report, rowId }: { report: ReportSpec; rowId: string }) {
  const { api } = useEnv();
  const custom = useCustomization();
  const own = custom.reports?.[report.name];
  const [detail, setDetail] = useState<{ state: 'loading' } | { state: 'error'; status: number } | { state: 'ready'; record: Row }>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const deny = useAccessDenied();

  useEffect(() => {
    let live = true;
    setDetail({ state: 'loading' });
    if (!report.recordEndpoint) {
      setDetail({ state: 'error', status: 404 });
      return;
    }
    api.post<{ record?: Row }>(report.recordEndpoint, { ROWID: rowId, REPORT: report.name }).then(
      (reply) => {
        if (!live) return;
        if (reply.ok && reply.body?.record && typeof reply.body.record === 'object') setDetail({ state: 'ready', record: reply.body.record });
        else if (reply.status === 403) deny();
        else setDetail({ state: 'error', status: reply.status === 404 || reply.ok ? 404 : reply.status });
      },
      () => live && setDetail({ state: 'error', status: 0 }),
    );
    return () => {
      live = false;
    };
  }, [api, deny, report.recordEndpoint, rowId, attempt]);

  const firstValue = report.columns.find((c) => !c.action)?.field ?? 'ROWID';
  const title = detail.state === 'ready' ? formatValue(detail.record[report.titleField ?? firstValue]) : rowId;
  return (
    <section className="c2c-card" data-report={report.name} data-view={report.view} data-row={rowId}>
      <h1>{report.label}</h1>
      <Slot>{own?.slots?.before}</Slot>
      <p className="c2c-back">
        <a href={hrefFor('report', report.name)}>Back to {report.label}</a>
      </p>
      {detail.state === 'loading' ? (
        <p className="c2c-loading" data-state="loading" role="status">
          Loading record…
        </p>
      ) : detail.state === 'error' ? (
        <LoadError status={detail.status} what="record" onRetry={() => setAttempt((n) => n + 1)} />
      ) : (
        <article className="c2c-record" aria-label={title === '–' ? `Record ${rowId}` : title}>
          <h2>{title === '–' ? `Record ${rowId}` : title}</h2>
          {report.detailBlocks?.length ? report.detailBlocks.map((block, index) => {
            const related = block.relatedField ? detail.record[block.relatedField] : undefined;
            return (
              <section key={`${block.title}:${index}`} data-detail-block={block.title}>
                <h3>{block.title}</h3>
                {Array.isArray(related) ? (
                  <div className="table-wrap">
                    <table>
                      <thead><tr>{block.fields.map((field) => <th scope="col" key={field.field}>{field.label}</th>)}</tr></thead>
                      <tbody>{related.map((item, rowIndex) => {
                        const child = item && typeof item === 'object' ? item as Row : {};
                        return <tr key={String(child.ROWID ?? rowIndex)}>{block.fields.map((field) => <td key={field.field}>{formatValue(child[field.field])}</td>)}</tr>;
                      })}</tbody>
                    </table>
                  </div>
                ) : (
                  <dl>
                    {block.fields.map((field) => (
                      <div key={field.field}>
                        <dt>{field.label}</dt>
                        <dd>{own?.cells?.[field.field]?.(detail.record[field.field], detail.record) ?? formatValue(detail.record[field.field])}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            );
          }) : (
            <dl>
              {report.columns
                .filter((c) => !c.action)
                .map((column) => (
                  <div key={column.field}>
                    <dt>{column.label}</dt>
                    <dd>{own?.cells?.[column.field]?.(detail.record[column.field], detail.record) ?? formatValue(detail.record[column.field])}</dd>
                  </div>
                ))}
            </dl>
          )}
          {report.form && report.rowActions.edit ? (
            <p>
              <a className="c2c-row-open" href={hrefFor('form', report.form, 'edit', rowId)} aria-label={`Edit record ${rowId}`}>
                Edit
              </a>
            </p>
          ) : null}
        </article>
      )}
      <Slot>{own?.slots?.after}</Slot>
    </section>
  );
}
