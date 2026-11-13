/**
 * A record's print layout: a `print template` resolved on the report model,
 * drawn over one loaded record and opened from a Print button on the record
 * view. The reader's own print dialog ("Save as PDF") is where printing
 * happens; this renders no PDF of its own (see docs/print-templates.md).
 *
 * Static layout text and every record value are untrusted: a `text`
 * element's HTML goes through the same sanitizer the generated page uses for
 * any other snippet (`${Field}` placeholders are escaped and filled before
 * that pass runs, so a record value can never add markup of its own), and
 * every inline style declaration is checked against the same allowlist
 * report conditional formatting uses.
 */
import { type CSSProperties, type ReactNode } from 'react';
import type { PrintElementSpec, PrintTemplateSpec } from '../types';
import { sanitizeSnippet } from '../pages/sanitize';
import { isSafeStyleProperty, isSafeStyleValue } from '../style-allowlist';
import './print.css';

type Row = Record<string, unknown>;

/** `Name.prefix` reads `row["Name.prefix"]` first, then `row.Name.prefix` — same rule as the record view. */
function refValue(row: unknown, ref: string | undefined): unknown {
  if (!row || typeof row !== 'object' || typeof ref !== 'string' || ref === '') return undefined;
  const record = row as Row;
  if (Object.prototype.hasOwnProperty.call(record, ref)) return record[ref];
  let value: unknown = record;
  for (const part of ref.split('.')) {
    if (value == null || typeof value !== 'object') return undefined;
    value = (value as Row)[part];
  }
  return value;
}

/** A cell's printable text; composite and list values are not printed as `[object Object]`. */
function printCell(row: unknown, field: string | undefined): string {
  const value = refValue(row, field);
  if (value == null || typeof value === 'object') return '';
  return String(value);
}

const CAMEL = /-([a-z])/g;

/** `href`/`src` safety: the same check the page sanitizer and the record view's print sheet apply. */
function safeUrl(value: string): boolean {
  const flat = value.replace(/[\u0000- ]+/g, '').toLowerCase();
  return !flat || (!flat.startsWith('javascript:') && !flat.startsWith('data:') && !flat.startsWith('vbscript:'));
}

/** An inline style string, kept to the declarations the sanitizer's allowlist passes, as a React style object. */
function printStyle(value: string | undefined): CSSProperties | undefined {
  if (!value) return undefined;
  const style: Record<string, string> = {};
  for (const part of String(value).split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const rawName = part.slice(0, at).trim().toLowerCase();
    const propValue = part.slice(at + 1).trim().replace(/!\s*important\s*$/i, '').trim();
    if (!isSafeStyleProperty(rawName) || !isSafeStyleValue(propValue, rawName)) continue;
    style[rawName.replace(CAMEL, (_, ch: string) => ch.toUpperCase())] = propValue;
  }
  return Object.keys(style).length ? (style as CSSProperties) : undefined;
}

/** A `${Field}` placeholder in layout HTML, filled with the record's escaped value before the sanitizer runs. */
function fillPlaceholders(html: string, row: Row): string {
  return html.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const text = printCell(row, name.trim());
    return text.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
  });
}

function Element({ el, row, doc }: { el: PrintElementSpec; row: Row; doc: Document }): ReactNode {
  switch (el.type) {
    case 'columns': {
      const split = String(el.split || '').split(',').map((part) => part.trim()).filter((part) => part !== '');
      return (
        <div data-print-columns>
          {(el.columns || []).map((col, index) => {
            const width = /^[0-9]+(?:\.[0-9]+)?$/.test(split[index] || '') ? { flex: `0 0 ${split[index]}%` } : undefined;
            return (
              <div data-print-col key={index} style={width}>
                {col.map((item, itemIndex) => (
                  <Element key={itemIndex} el={item} row={row} doc={doc} />
                ))}
              </div>
            );
          })}
        </div>
      );
    }
    case 'text': {
      const filled = fillPlaceholders(el.html || '', row);
      const clean = sanitizeSnippet(filled, doc);
      return <div data-print-text dangerouslySetInnerHTML={{ __html: clean }} />;
    }
    case 'field':
      return (
        <div data-print-field style={printStyle(el.wrapperStyle)}>
          <span data-print-label style={printStyle(el.labelStyle || el.labelTextStyle)}>{el.label || el.field || ''}</span>
          <span data-print-value style={printStyle(el.valueStyle || el.valueTextStyle)}>{printCell(row, el.field)}</span>
        </div>
      );
    case 'lookup': {
      const fields = el.fields || [];
      const related = Array.isArray((row as Row | undefined)?.[el.field ?? '']) ? ((row as Row)[el.field ?? ''] as unknown[]) : [];
      return (
        <div data-print-lookup>
          {el.label ? <h3 data-print-lookup-label>{el.label}</h3> : null}
          <table>
            <thead>
              <tr>
                {fields.map((f) => (
                  <th scope="col" key={f.field} style={printStyle(f.labelStyle)}>{f.label || f.field}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {related.map((item, index) => (
                <tr key={index}>
                  {fields.map((f) => (
                    <td key={f.field} style={printStyle(f.valueStyle)}>{printCell(item, f.field)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'image': {
      const src = el.field ? printCell(row, el.field) : el.src;
      if (!src || !safeUrl(src)) return null;
      return <img data-print-image src={src} alt={el.alt || el.label || ''} style={printStyle(el.style)} />;
    }
    case 'spacer': {
      const height = /^[0-9]+(?:\.[0-9]+)?$/.test(String(el.height || '')) ? { height: `${el.height}px` } : undefined;
      return <div data-print-spacer style={height} />;
    }
    default:
      return <p className="todo" data-print-todo>{el.note || 'Print element is not generated.'}</p>;
  }
}

/** One record print layout over a record, with its print/close bar. `onClose` removes the sheet. */
export function PrintSheet({ template, row, onClose }: { template: PrintTemplateSpec; row: Row; onClose: () => void }) {
  const doc = typeof document !== 'undefined' ? document : undefined;
  if (!doc) return null;
  return (
    <div data-print-sheet={template.name}>
      <div data-print-bar>
        <button type="button" data-print-close onClick={onClose}>
          Close
        </button>
        <button type="button" data-print-now onClick={() => window.print()}>
          Print
        </button>
        <p data-print-hint>Use the print dialog to save a PDF.</p>
      </div>
      <div data-print-page style={printStyle(template.style)} data-print-font={template.font || undefined}>
        {template.header?.length ? (
          <div data-print-header>
            {template.header.map((el, index) => (
              <Element key={index} el={el} row={row} doc={doc} />
            ))}
          </div>
        ) : null}
        {template.elements.map((el, index) => (
          <Element key={index} el={el} row={row} doc={doc} />
        ))}
        {template.footer?.length ? (
          <div data-print-footer>
            {template.footer.map((el, index) => (
              <Element key={index} el={el} row={row} doc={doc} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
