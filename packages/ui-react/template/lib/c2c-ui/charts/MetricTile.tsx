/**
 * A dashboard value (a Creator `form data` text: the count or sum of a
 * report's rows that pass its criteria) drawn as an Arc metric card. Further
 * values of the same Creator panel form the card's context line.
 */
import type { ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { Alert } from '../arc/components/alert/alert';
import { Button } from '../arc/components/button/button';
import { MetricCard } from '../arc/components/metric-card/metric-card';
import type { MetricSpec } from '../types';
import { useEnv } from '../runtime/env';
import { metricValue, todayIn } from './data';
import { useRows } from './rows';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function useMetric(metric: MetricSpec): { value?: number; error: boolean; retry: () => void } {
  const { spec, view } = useEnv();
  const { load, retry } = useRows(metric.report ? spec.reports[metric.report] : undefined);
  if (load.state !== 'ready') return { error: load.state === 'error', retry };
  const zone = (view as { C2C_APP_TIMEZONE?: unknown }).C2C_APP_TIMEZONE;
  return { value: metricValue(load.rows, metric, todayIn(typeof zone === 'string' ? zone : undefined, new Date())), error: false, retry };
}

function Extra({ metric, onValue }: { metric: MetricSpec; onValue: (text: string) => string }) {
  const { value } = useMetric(metric);
  const text = value === undefined ? '…' : `${number.format(value)}${metric.suffix ? ` ${metric.suffix}` : ''}`;
  return <>{onValue(metric.label ? `${metric.label}: ${text}` : text)}</>;
}

export function MetricTile({ label, value: main, extra = [], icon }: { label: string; value: MetricSpec; extra?: MetricSpec[]; icon?: ReactNode }) {
  const { value, error, retry } = useMetric(main);
  const todos = [main, ...extra].flatMap((m) => m.todos);
  // The card mounts once its value is known, so its text never swaps while loading.
  const context = !main.report ? 'No report to read' : main.filter.length ? 'Matching records' : 'All records';
  const loading = value === undefined && !error && !!main.report;
  return (
    <div className="c2c-metric" data-metric={main.fn} data-value={value ?? ''}>
      {icon}
      {error ? (
        <div data-state="error">
          <Alert tone="danger" title={`${label}: the value could not be loaded.`}>
            <Button type="button" variant="secondary" size="sm" onClick={retry}>
              <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" /> Retry
            </Button>
          </Alert>
        </div>
      ) : loading ? (
        <p className="c2c-loading" data-state="loading" role="status">Loading {label}…</p>
      ) : (
        <MetricCard label={label} value={value ?? 0} decimals={value !== undefined && !Number.isInteger(value) ? 2 : 0} {...(main.suffix ? { suffix: ` ${main.suffix}` } : {})} context={context} />
      )}
      {extra.length ? (
        <p className="c2c-metric-extra">
          {extra.map((m, i) => (
            <Extra key={i} metric={m} onValue={(text) => (i ? ` · ${text}` : text)} />
          ))}
        </p>
      ) : null}
      {todos.map((todo) => (
        <p key={todo} className="todo">{todo}</p>
      ))}
    </div>
  );
}
