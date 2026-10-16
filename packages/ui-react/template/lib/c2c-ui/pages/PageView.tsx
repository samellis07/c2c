/**
 * A Creator page: the ZML panel layout (rows, columns, panels) with its
 * dashboard values as metric cards, charts, report embeds, links, buttons,
 * text and sanitized HTML snippets. Every construct the generator could not
 * turn into a component is listed at the top of the page and marked `.todo`
 * where it stood.
 */
import type { CSSProperties, ReactNode } from 'react';
import { BarChart3, Calendar, CheckSquare, Clock, Coins, FileText, Package, RefreshCw, ShoppingCart, Square, Truck, User, Users, Wallet } from 'lucide-react';
import type { PageElement, PageSpec } from '../types';
import { useEnv } from '../runtime/env';
import { ReportView } from '../report/ReportView';
import { ChartPanel } from '../charts/ChartView';
import { MetricTile } from '../charts/MetricTile';
import { RowsScope } from '../charts/rows';
import { sanitizeSnippet } from './sanitize';
import '../charts/charts.css';

/** Creator icon names → a decorative icon by keyword. */
const ICONS: [RegExp, typeof Square][] = [
  [/money|coin|dollar|cash|price|invoice/, Coins],
  [/wallet|bag|bank/, Wallet],
  [/loader|refresh|sync|repeat/, RefreshCw],
  [/check|done|approve|tick/, CheckSquare],
  [/time|clock|watch|alarm/, Clock],
  [/calendar|date|event/, Calendar],
  [/users|group|team|people/, Users],
  [/user|person|contact|avatar/, User],
  [/cart|shop|basket/, ShoppingCart],
  [/truck|delivery|shipping|transport/, Truck],
  [/box|package|product|stock/, Package],
  [/chart|graph|report|stat/, BarChart3],
  [/file|doc|copy|note|paper/, FileText],
];

function Icon({ name, style }: { name: string; style?: CSSProperties }) {
  const Glyph = ICONS.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? Square;
  return (
    <span className="c2c-zml-icon" data-icon={name} aria-hidden="true" style={style}>
      <Glyph size={22} strokeWidth={1.75} />
    </span>
  );
}

/** Export presentation values → React style. Creator's `fill` sizes are layout hints, not CSS. */
function cssOf(style: Record<string, string> | undefined): CSSProperties | undefined {
  if (!style) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(style)) {
    if (value === 'fill' || value === 'auto') continue;
    out[key.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())] = value;
  }
  return Object.keys(out).length ? (out as CSSProperties) : undefined;
}

function sizing(width: string | undefined): CSSProperties {
  if (width === 'fill') return { flex: '1 1 0' };
  if (width === 'auto') return { flex: '0 0 auto' };
  if (width && /^[0-9.]+%$/.test(width)) return { flex: `1 1 ${width}`, maxWidth: width };
  if (width && /^[0-9.]+px$/.test(width)) return { flex: `0 1 ${width}` };
  return {};
}

const ROWS = new Set(['row', 'pr', 'tr']);
const COLUMNS = new Set(['column', 'pc', 'td', 'th', 'cell']);

function Element({ el }: { el: PageElement }): ReactNode {
  const { doc, spec } = useEnv();
  switch (el.kind) {
    case 'box': {
      const role = ROWS.has(el.tag) ? 'row' : COLUMNS.has(el.tag) ? 'col' : el.tag === 'panel' ? 'panel' : 'box';
      const style = { ...(role === 'col' ? sizing(el.width) : {}), ...cssOf(el.style) };
      const inner = (
        <div className={`c2c-zml-${role}`} data-zml={el.tag} style={Object.keys(style).length ? style : undefined}>
          {el.children.map((child, i) => (
            <Element key={i} el={child} />
          ))}
        </div>
      );
      return el.href ? (
        <a className="c2c-zml-link" href={el.href}>
          {inner}
        </a>
      ) : (
        inner
      );
    }
    case 'text':
      return <p className="c2c-zml-text" style={cssOf(el.style)}>{el.text}</p>;
    case 'icon':
      return <Icon name={el.icon} style={cssOf(el.style)} />;
    case 'html':
      return (
        <div className="c2c-snippet">
          {el.html ? <div dangerouslySetInnerHTML={{ __html: sanitizeSnippet(el.html, doc) }} /> : null}
          {el.links.map((link) => (
            <a key={link.href} className="c2c-page-link" href={link.href}>{link.label}</a>
          ))}
        </div>
      );
    case 'metric':
      return <MetricTile label={el.label} value={el.value} extra={el.extra} {...(el.icon ? { icon: <Icon name={el.icon} /> } : {})} />;
    case 'chart':
      return <ChartPanel chart={el.chart} />;
    case 'report': {
      const report = spec.reports[el.report];
      return report ? (
        <div className="c2c-embed" data-embed="report">
          <ReportView report={report} />
        </div>
      ) : (
        <p className="todo">The {el.label} report is not part of the app.</p>
      );
    }
    case 'form':
      return (
        <a className="c2c-page-link" data-embed="form" href={`#/form/${encodeURIComponent(el.form)}`}>
          {el.label}
        </a>
      );
    case 'link':
      return (
        <a className="c2c-page-link" href={el.href} target="_blank" rel="noopener noreferrer">
          {el.label}
        </a>
      );
    case 'button':
      return (
        <a className="c2c-page-button" href={el.href} style={cssOf(el.style)} {...(el.href?.startsWith('#') ? {} : { target: '_blank', rel: 'noopener noreferrer' })}>
          {el.label}
        </a>
      );
    case 'todo':
      // A part the generator cannot draw is a migration note for the
      // developer, not app content: it is listed in `c2c analyze` and the
      // migration report, never on the page.
      return null;
  }
}

export function PageView({ page }: { page: PageSpec }) {
  return (
    <section className="c2c-card c2c-page" data-page={page.name}>
      {page.scopedCss ? <style>{page.scopedCss.replace(/</g, '')}</style> : null}
      <h1>{page.label}</h1>
      <RowsScope>
        <div className="c2c-page-body">
          {page.elements.map((el, i) => (
            <Element key={i} el={el} />
          ))}
        </div>
      </RowsScope>
    </section>
  );
}
