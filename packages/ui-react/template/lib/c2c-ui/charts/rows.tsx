/**
 * Report rows for charts and metrics. Rows come from POST <queryEndpoint>
 * { op: "query", page, pageSize } like a list report; pages are read until a
 * short page or MAX_PAGES. A static host with no data function (404/405/501)
 * has no rows. Within one screen, every chart and metric on the same report
 * shares one read.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ChartSpec, ReportSpec } from '../types';
import type { Api } from '../runtime/api';
import { useEnv } from '../runtime/env';
import { chartSeries, todayIn, type Day, type Row, type Series } from './data';

/** At most this many pages per report (300 rows each by default). */
export const MAX_PAGES = 10;

export interface Rows {
  rows: Row[];
  /** More rows exist than were read. */
  truncated: boolean;
}
export type RowsLoad = { state: 'loading' } | { state: 'error' } | ({ state: 'ready' } & Rows);

export async function readRows(api: Api, report: ReportSpec): Promise<Rows> {
  const rows: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const reply = await api.post<{ rows?: Row[] }>(report.queryEndpoint, { op: 'query', page, pageSize: report.pageSize });
    if ([404, 405, 501].includes(reply.status)) return { rows, truncated: false };
    if (!reply.ok) throw new Error(`query ${reply.status}`);
    const batch = Array.isArray(reply.body?.rows) ? reply.body!.rows! : [];
    rows.push(...batch);
    if (batch.length < report.pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** The server-side aggregate reply (`op: "aggregate"`) of a report endpoint. */
export interface AggregateBody {
  buckets?: { key: string; values: number[] }[];
  dated?: boolean;
  truncated?: boolean;
  scanned?: number;
}

/** Chart rows: the folded series plus how much data was read. */
export interface ChartRows {
  series: Series;
  truncated: boolean;
  /** Rows the fold read (server `scanned`, else the rows fetched). */
  scanned: number;
}

/** Server buckets → the Series the chart components draw. */
export function bucketsToSeries(body: AggregateBody, chart: ChartSpec): Series {
  const buckets = Array.isArray(body.buckets) ? body.buckets : [];
  return {
    categories: buckets.map((b) => ({ key: b.key, label: b.key || '(blank)' })),
    values: chart.measures.map((_, m) => buckets.map((b) => (Array.isArray(b.values) ? Number(b.values[m]) || 0 : 0))),
    dated: !!body.dated,
  };
}

/**
 * Chart data for one report: the `aggregate` op folds server-side when the
 * chart has no extra criteria of its own; otherwise (or when the endpoint
 * does not answer it) the row query runs and the fold happens here.
 */
export async function readChartRows(api: Api, report: ReportSpec, chart: ChartSpec, today: Day): Promise<ChartRows> {
  if (!chart.filter.length && chart.x) {
    const reply = await api.post<AggregateBody>(report.queryEndpoint, {
      op: 'aggregate',
      group: chart.x,
      measures: chart.measures.map((m) => ({ fn: m.fn, field: m.field })),
      order: chart.kind === 'donut' ? 'value' : 'key',
    });
    if (reply.ok && reply.body && Array.isArray(reply.body.buckets)) {
      return { series: bucketsToSeries(reply.body, chart), truncated: !!reply.body.truncated, scanned: Number(reply.body.scanned) || 0 };
    }
    // Any other answer — an endpoint without the op, a refused group field, a
    // server error — falls back to the row query, which folds here.
  }
  const { rows, truncated } = await readRows(api, report);
  return { series: chartSeries(rows, chart, today), truncated, scanned: rows.length };
}

type Cache = Map<string, Promise<Rows | ChartRows>>;
const RowsCache = createContext<Cache | null>(null);

/** One shared read per report for everything rendered inside. */
export function RowsScope({ children }: { children: ReactNode }) {
  const cache = useMemo<Cache>(() => new Map(), []);
  return <RowsCache.Provider value={cache}>{children}</RowsCache.Provider>;
}

/** The rows of a report; `retry` reads them again. No report: ready with no rows. */
export function useRows(report: ReportSpec | undefined): { load: RowsLoad; retry: () => void } {
  const { api } = useEnv();
  const shared = useContext(RowsCache);
  const [load, setLoad] = useState<RowsLoad>(report ? { state: 'loading' } : { state: 'ready', rows: [], truncated: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!report) return;
    let live = true;
    setLoad({ state: 'loading' });
    const key = report.queryEndpoint;
    let pending = (attempt === 0 ? shared?.get(key) : undefined) as Promise<Rows> | undefined;
    if (!pending) {
      pending = readRows(api, report);
      shared?.set(key, pending);
    }
    pending.then(
      (rows) => live && setLoad({ state: 'ready', ...rows }),
      () => {
        shared?.delete(key);
        if (live) setLoad({ state: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [api, shared, report, attempt]);
  return { load, retry: () => setAttempt((n) => n + 1) };
}

export type ChartRowsLoad = { state: 'loading' } | { state: 'error' } | ({ state: 'ready' } & ChartRows);

/** The folded series for one chart; `retry` reads it again. No report: ready and empty. */
export function useChartRows(report: ReportSpec | undefined, chart: ChartSpec): { load: ChartRowsLoad; retry: () => void } {
  const { api, view } = useEnv();
  const shared = useContext(RowsCache);
  const [load, setLoad] = useState<ChartRowsLoad>(report ? { state: 'loading' } : { state: 'ready', series: { categories: [], values: [], dated: false }, truncated: false, scanned: 0 });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!report) return;
    let live = true;
    setLoad({ state: 'loading' });
    const zone = (view as { C2C_APP_TIMEZONE?: unknown }).C2C_APP_TIMEZONE;
    const today = todayIn(typeof zone === 'string' ? zone : undefined, new Date());
    const key = `chart:${report.queryEndpoint}:${JSON.stringify([chart.x, chart.measures.map((m) => [m.fn, m.field]), chart.kind, chart.filter])}`;
    let pending = (attempt === 0 ? shared?.get(key) : undefined) as Promise<ChartRows> | undefined;
    if (!pending) {
      pending = readChartRows(api, report, chart, today);
      shared?.set(key, pending);
    }
    pending.then(
      (data) => live && setLoad({ state: 'ready', ...data }),
      () => {
        shared?.delete(key);
        if (live) setLoad({ state: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [api, shared, report, chart, attempt, view]);
  return { load, retry: () => setAttempt((n) => n + 1) };
}
