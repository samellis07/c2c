/**
 * Normalised DOM snapshot. One line per node, byte-stable across runs:
 * attributes sorted, volatile values removed, whitespace collapsed.
 *
 * Normalisation rules (the "strip ids/timestamps" contract):
 * - `id` attributes are dropped everywhere. Every token in id-referencing
 *   attributes (for, aria-describedby, aria-labelledby, aria-controls,
 *   headers, list) becomes `#ref`, so reference arity stays visible without
 *   carrying generator-assigned values (React useId, radix). Unmatched
 *   tokens must be masked too: radix `aria-controls` points at a listbox
 *   that is unmounted while closed, so "only mask collected ids" leaks the
 *   non-deterministic generated id.
 * - `style` attributes are dropped: motion sets inline animation state that
 *   differs between settled and mid-transition renders; the snapshot covers
 *   DOM structure plus the final class attributes, not animation frames.
 * - svg geometry (path `d`, circle coords) is dropped to the tag plus class:
 *   icon identity rides on the parent control's classes and labels.
 * - comments, script/style/link elements and empty text nodes are skipped;
 *   remaining text is whitespace-collapsed.
 * - `value` attributes on inputs are kept (they are rendered record state),
 *   except password fields, which render as `value="·"`.
 */

const KEEP_ATTRS = new Set([
  'class', 'role', 'type', 'href', 'aria-label', 'aria-current', 'aria-invalid',
  'aria-sort', 'aria-busy', 'aria-checked', 'aria-selected', 'aria-expanded',
  'aria-haspopup', 'aria-modal', 'aria-hidden', 'aria-disabled', 'aria-live',
  'aria-pressed', 'aria-valuenow', 'aria-valuemin', 'aria-valuemax',
  'data-action', 'data-error-for', 'data-field', 'data-form', 'data-form-card',
  'data-group', 'data-layout', 'data-mode', 'data-more', 'data-page-label',
  'data-report', 'data-report-note', 'data-row', 'data-state', 'data-th',
  'data-key', 'data-view', 'data-view-pending', 'data-page', 'data-notice',
  'data-required', 'data-widget', 'data-subform', 'data-phone', 'data-layout-section',
  'name', 'placeholder', 'disabled', 'checked', 'selected', 'open', 'hidden',
  'for', 'aria-describedby', 'aria-labelledby', 'aria-controls', 'headers', 'list',
  'value', 'alt', 'title', 'scope', 'colspan', 'rowspan', 'tabindex', 'lang',
]);

const IDREF_ATTRS = new Set(['for', 'aria-describedby', 'aria-labelledby', 'aria-controls', 'headers', 'list']);

const SVG_SHAPE_ATTRS = new Set(['d', 'cx', 'cy', 'r', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'transform']);

function attrText(el) {
  const parts = [];
  for (const name of el.getAttributeNames().sort()) {
    const lower = name.toLowerCase();
    if (lower === 'id' || lower === 'style') continue;
    if (lower === 'd' || (isSvg(el) && SVG_SHAPE_ATTRS.has(lower))) continue;
    if (!KEEP_ATTRS.has(lower)) continue;
    let value = el.getAttribute(name) ?? '';
    if (IDREF_ATTRS.has(lower)) {
      value = value.split(/\s+/).filter(Boolean).map(() => '#ref').join(' ');
    }
    if (lower === 'value' && (el.getAttribute('type') ?? '').toLowerCase() === 'password') value = '·';
    if (lower === 'href' && value.startsWith('#')) value = value; // route hashes are stable screen keys
    parts.push(value === '' && (lower === 'disabled' || lower === 'checked' || lower === 'selected' || lower === 'open' || lower === 'hidden') ? lower : `${lower}="${value}"`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function isSvg(el) {
  const tag = (el.tagName ?? '').toLowerCase();
  return tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'line' || tag === 'polyline' || tag === 'polygon' || tag === 'rect' || tag === 'g';
}

function textOf(node) {
  return (node.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Serialise the app root (<div id="root"> content) to snapshot lines.
 * The first lines are the envelope; the rest is the DOM tree.
 */
export function serialise(root, envelope) {
  const lines = [
    `app: ${envelope.app}`,
    `route: ${envelope.route}`,
    `state: ${envelope.state}`,
    `viewport: ${envelope.viewport} ${envelope.width}`,
    '---',
  ];
  const walk = (node, depth) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 8) continue; // comment
      if (child.nodeType === 3) {
        const text = textOf(child);
        if (text) lines.push(`${'  '.repeat(depth)}"${text}"`);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = (child.tagName ?? 'unknown').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'link') continue;
      lines.push(`${'  '.repeat(depth)}${tag}${attrText(child)}`);
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  lines.push('');
  return lines.join('\n');
}

/**
 * Compare two snapshot texts. Returns null when identical, otherwise a short
 * human-readable report: the changed hunk with line numbers plus counts.
 */
export function diffSnapshots(name, want, got, context = 3) {
  if (want === got) return null;
  const a = want.split('\n');
  const b = got.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const from = Math.max(0, head - context);
  const toA = Math.min(a.length, a.length - tail + context);
  const toB = Math.min(b.length, b.length - tail + context);
  const out = [`--- ${name}: differs (${a.length} baseline lines, ${b.length} rendered lines)`];
  out.push(`baseline ${from + 1}..${toA}:`);
  for (let i = from; i < toA; i++) out.push(`  - ${i + 1}: ${a[i]}`);
  out.push(`rendered ${from + 1}..${toB}:`);
  for (let i = from; i < toB; i++) out.push(`  + ${i + 1}: ${b[i]}`);
  const extra = Math.max(a.length, b.length) - Math.min(a.length, b.length);
  if (extra > 0) out.push(`(line-count delta: ${extra})`);
  return out.join('\n');
}
