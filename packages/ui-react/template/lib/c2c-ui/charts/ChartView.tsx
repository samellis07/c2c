/**
 * Charts: a Creator chart report or a chart element on a page, drawn with the
 * vendored Arc bar, line and donut charts from the report rows (see data.ts).
 * Notes say how a chart was drawn when the export does not record it; TODOs
 * (a criteria clause that did not translate, a setting not drawn) stay
 * visible next to the chart.
 */
import { RotateCw } from 'lucide-react';
import { Alert } from '../arc/components/alert/alert';
import { Button } from '../arc/components/button/button';
import { EmptyState } from '../arc/components/empty-state/empty-state';
import { BarChart } from '../arc/components/bar-chart/bar-chart';
import { DonutChart } from '../arc/components/donut-chart/donut-chart';
import { LineChart } from '../arc/components/line-chart/line-chart';
import type { ChartSpec, ReportSpec } from '../types';
import { useEnv } from '../runtime/env';
import { chartSeries, todayIn, type Series } from './data';
import { RowsScope, useRows } from './rows';
import './charts.css';

/** Bars beyond this many categories are the smallest ones; they are left out and the chart says so. */
export const MAX_BARS = 24;

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const format = (value: number) => number.format(value);
const short = (label: string) => (label.length > 10 ? `${label.slice(0, 9)}…` : label);

function Drawing({ chart, series }: { chart: ChartSpec; series: Series }) {
  const kind = chart.kind === 'auto' ? (series.dated ? 'line' : 'bar') : chart.kind;
  const { categories, values } = series;
  if (kind === 'donut') {
    return (
      <DonutChart
        label={chart.title}
        totalLabel={chart.measures[0]!.label}
        formatValue={format}
        data={categories.map((c, i) => ({ key: c.key, label: c.label, value: values[0]![i]! }))}
      />
    );
  }
  if (kind === 'line') {
    return (
      <LineChart
        label={chart.title}
        categoryLabel={chart.xLabel}
        formatValue={(value) => format(value)}
        series={chart.measures.map((m, i) => ({ key: `m${i}`, label: m.label }))}
        data={categories.map((c, i) => ({ key: c.key, label: c.label, axisLabel: short(c.label), values: Object.fromEntries(chart.measures.map((_, m) => [`m${m}`, values[m]![i]!])) }))}
      />
    );
  }
  // Bars: one chart per measure, the largest categories when there are many.
  const order = categories.map((_, i) => i);
  const shown = order.length > MAX_BARS ? order.sort((a, b) => values[0]![b]! - values[0]![a]!).slice(0, MAX_BARS).sort((a, b) => a - b) : order;
  return (
    <>
      {shown.length < categories.length ? <p className="c2c-chart-note">The {MAX_BARS} largest of {categories.length} categories are shown.</p> : null}
      {chart.measures.map((measure, m) => (
        <BarChart
          key={`m${m}`}
          label={measure.label}
          period={`${measure.label} by ${chart.xLabel}`}
          averageLabel="Average"
          valueLabel={measure.label}
          categoryLabel={chart.xLabel}
          formatValue={format}
          data={shown.map((i) => ({ key: categories[i]!.key, label: categories[i]!.label, ...(shown.length <= 12 ? { axisLabel: short(categories[i]!.label) } : {}), value: values[m]![i]! }))}
        />
      ))}
    </>
  );
}

/** The chart body: notes, TODOs, the three data states, the drawing. */
export function ChartBody({ chart }: { chart: ChartSpec }) {
  const { spec, view } = useEnv();
  const report: ReportSpec | undefined = chart.report ? spec.reports[chart.report] : undefined;
  const { load, retry } = useRows(report);
  const zone = (view as { C2C_APP_TIMEZONE?: unknown }).C2C_APP_TIMEZONE;
  const series = load.state === 'ready' ? chartSeries(load.rows, chart, todayIn(typeof zone === 'string' ? zone : undefined, new Date())) : undefined;
  return (
    <div className="c2c-chart" data-chart={chart.kind} data-chart-type={chart.creatorType}>
      {chart.notes.map((note) => (
        <p key={note} className="c2c-chart-note">{note}</p>
      ))}
      {chart.todos.map((todo) => (
        <p key={todo} className="todo">{todo}</p>
      ))}
      {load.state === 'loading' ? (
        <p className="c2c-loading" data-state="loading" role="status">Loading chart…</p>
      ) : load.state === 'error' ? (
        <div data-state="error">
          <Alert tone="danger" title="The chart data could not be loaded.">
            <Button type="button" variant="secondary" size="sm" onClick={retry}>
              <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" /> Retry
            </Button>
          </Alert>
        </div>
      ) : !series || series.categories.length === 0 ? (
        <div data-state="empty">
          <EmptyState title="No data to chart" description={report ? 'Records added through the form appear here.' : 'This chart has no report to read records from.'} />
        </div>
      ) : (
        <>
          {load.truncated ? <p className="c2c-chart-note">Drawn from the first {load.rows.length} records.</p> : null}
          <Drawing chart={chart} series={series} />
        </>
      )}
    </div>
  );
}

/** A chart element on a page, headed by its title. */
export function ChartPanel({ chart }: { chart: ChartSpec }) {
  return (
    <section className="c2c-chart-panel" aria-label={chart.title}>
      <h2>{chart.title}</h2>
      <ChartBody chart={chart} />
    </section>
  );
}

/** A Creator chart report screen. */
export function ChartReport({ report }: { report: ReportSpec }) {
  return (
    <section className="c2c-card" data-report={report.name} data-view="chart">
      <h1>{report.label}</h1>
      <RowsScope>
        {report.chart ? <ChartBody chart={report.chart} /> : <p className="todo">The chart settings of this report are not generated.</p>}
      </RowsScope>
    </section>
  );
}
