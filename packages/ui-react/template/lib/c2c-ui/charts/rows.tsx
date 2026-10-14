/**
 * Report rows for charts and metrics. Rows come from POST <queryEndpoint>
 * { op: "query", page, pageSize } like a list report; pages are read until a
 * short page or MAX_PAGES. A static host with no data function (404/405/501)
 * has no rows. Within one screen, every chart and metric on the same report
 * shares one read.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ReportSpec } from '../types';
import type { Api } from '../runtime/api';
import { useEnv } from '../runtime/env';
import type { Row } from './data';

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

type Cache = Map<string, Promise<Rows>>;
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
    let pending = attempt === 0 ? shared?.get(key) : undefined;
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
