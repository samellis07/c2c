/**
 * Record print sheet. A report whose export picks a print layout draws a
 * Print action on its record view; the sheet renders that layout over the
 * loaded record. The reader's own print dialog is where "Save as PDF"
 * happens — the function serves no PDF.
 */

const printRuntime = (() => {
let printModel = null;
const printDocs = new WeakSet();

function reportOf(name) {
  const reports = printModel && printModel.reports;
  if (!reports) return null;
  for (let i = 0; i < reports.length; i++) if (reports[i].name === name) return reports[i];
  return null;
}

function formOf(name) {
  const forms = printModel && printModel.forms;
  if (!forms || !name) return null;
  for (let i = 0; i < forms.length; i++) if (forms[i].name === name) return forms[i];
  return null;
}

/** A cell's printable text; `${A.B}` placeholder refs read nested values. */
function printCell(row, field) {
  if (!row || field == null || field === '') return '';
  const value = typeof lookupRefValue === 'function' ? lookupRefValue(row, field) : row[field];
  if (value == null || typeof value === 'object') return '';
  return String(value);
}

/** A layout style keeps its safe declarations; refused ones are named in `data-style-dropped`. */
function styleAttr(value) {
  if (!value) return '';
  const style = typeof cleanStyle === 'function' ? cleanStyle(value) : { style: String(value), dropped: [] };
  return (
    (style.style ? ' style="' + escapeHtml(style.style) + '"' : '') +
    (style.dropped.length ? ' data-style-dropped="' + escapeHtml(style.dropped.join(' ')) + '"' : '')
  );
}

function elementHtml(el, row, doc) {
  if (!el || typeof el !== 'object') return '';
  switch (el.type) {
    case 'columns': {
      const split = String(el.split || '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '');
      const cols = (el.columns || []).map((col, index) => {
        const width = /^[0-9]+(?:\.[0-9]+)?$/.test(split[index] || '') ? 'flex:0 0 ' + split[index] + '%' : '';
        return '<div data-print-col' + styleAttr(width) + '>' + (col || []).map((item) => elementHtml(item, row, doc)).join('') + '</div>';
      });
      return '<div data-print-columns>' + cols.join('') + '</div>';
    }
    case 'text': {
      // Placeholders are filled before the sanitizer runs, so a record value
      // that lands in an attribute (href, src, style) gets the same URL and
      // style checks as the template's own markup. Values are escaped first
      // and filled in one pass, so a value cannot add a placeholder of its own.
      // The sanitizer drops `class`, so icon-font classes (`fa fa-user`) do not
      // survive: the app ships no icon font, and the class would print nothing.
      const fill = (html) => String(html).replace(/\$\{([^}]+)\}/g, (_match, name) => escapeHtml(printCell(row, String(name).trim())));
      const clean = typeof sanitizeSnippet === 'function' ? sanitizeSnippet(fill(el.html || ''), doc) : fill(escapeHtml(el.html || ''));
      return '<div data-print-text>' + clean + '</div>';
    }
    case 'field':
      return (
        '<div data-print-field' +
        styleAttr(el.wrapperStyle) +
        '><span data-print-label' +
        styleAttr(el.labelStyle || el.labelTextStyle) +
        '>' +
        escapeHtml(el.label || el.field || '') +
        '</span><span data-print-value' +
        styleAttr(el.valueStyle || el.valueTextStyle) +
        '>' +
        escapeHtml(printCell(row, el.field)) +
        '</span></div>'
      );
    case 'lookup': {
      const fields = el.fields || [];
      const related = row && Array.isArray(row[el.field]) ? row[el.field] : [];
      const head = fields.map((item) => '<th scope="col"' + styleAttr(item.labelStyle) + '>' + escapeHtml(item.label || item.field) + '</th>').join('');
      const body = related
        .map((item) => '<tr>' + fields.map((col) => '<td' + styleAttr(col.valueStyle) + '>' + escapeHtml(printCell(item, col.field)) + '</td>').join('') + '</tr>')
        .join('');
      const label = el.label ? '<h3 data-print-lookup-label>' + escapeHtml(el.label) + '</h3>' : '';
      return '<div data-print-lookup>' + label + '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }
    case 'image': {
      const src = el.field ? printCell(row, el.field) : el.src;
      if (!src || (typeof safeUrl === 'function' && !safeUrl(src))) return '';
      return '<img data-print-image src="' + escapeHtml(src) + '" alt="' + escapeHtml(el.alt || el.label || '') + '"' + styleAttr(el.style) + '>';
    }
    case 'spacer': {
      const height = /^[0-9]+(?:\.[0-9]+)?$/.test(String(el.height || '')) ? 'height:' + el.height + 'px' : '';
      return '<div data-print-spacer' + styleAttr(height) + '></div>';
    }
    default:
      return '<p class="todo" data-print-todo>' + escapeHtml(el.note || 'Print element is not generated.') + '</p>';
  }
}

function sheetHtml(template, row, doc) {
  const elements = (template && template.elements) || [];
  const body = elements.map((el) => elementHtml(el, row, doc)).join('');
  const style = template && template.style ? styleAttr(template.style) : '';
  const font = template && template.font ? ' data-print-font="' + escapeHtml(template.font) + '"' : '';
  return '<div data-print-page' + style + font + '>' + body + '</div>';
}

async function openSheet(doc, button) {
  const section = button.closest('section[data-report]');
  const name = section ? section.getAttribute('data-report') : '';
  const report = name ? reportOf(name) : null;
  if (!report || !report.printTemplate) return;
  const id = button.getAttribute('data-print-record') || '';
  let row = typeof reportViewRow === 'function' ? reportViewRow(name, id) : null;
  // The record endpoint returns every field; the captured report row may
  // carry only the list columns. Merge so a layout can print either set.
  const view = doc.defaultView || globalThis;
  const call = (view && view.fetch) || globalThis.fetch;
  const form = formOf(report.form);
  if (id && form && form.recordEndpoint && typeof call === 'function' && typeof apiCall === 'function') {
    const res = await apiCall(call, view, form.recordEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ROWID: id }),
    }).catch(() => null);
    if (res && res.ok && typeof readJson === 'function') {
      const body = await readJson(res).catch(() => null);
      const record = body && body.record;
      if (record && typeof record === 'object' && !Array.isArray(record)) row = Object.assign({}, row || {}, record);
    }
  }
  if (!row) row = { ROWID: id };
  const stale = doc.querySelector('[data-print-sheet]');
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  const sheet = doc.createElement('div');
  sheet.setAttribute('data-print-sheet', report.name);
  sheet.innerHTML =
    '<div data-print-bar>' +
    '<button type="button" data-print-close>Close</button>' +
    '<button type="button" data-print-now>Print</button>' +
    '<p data-print-hint>Use the print dialog to save a PDF.</p>' +
    '</div>' +
    sheetHtml(report.printTemplate, row, doc);
  (doc.body || doc.documentElement).appendChild(sheet);
}

function onPrintClick(doc, event) {
  const target = event.target && event.target.closest ? event.target : null;
  if (!target) return;
  const open = target.closest('[data-print-record]');
  if (open) {
    event.preventDefault();
    openSheet(doc, open).catch(() => {});
    return;
  }
  if (target.closest('[data-print-now]')) {
    const view = doc.defaultView;
    if (view && typeof view.print === 'function') view.print();
    return;
  }
  const close = target.closest('[data-print-close]');
  if (close) {
    const sheet = close.closest('[data-print-sheet]');
    if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
  }
}

function install(appModel, doc) {
  if (appModel) printModel = appModel;
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  if (!documentRef || printDocs.has(documentRef)) return;
  printDocs.add(documentRef);
  documentRef.addEventListener('click', (event) => onPrintClick(documentRef, event));
}

return { install: install, sheetHtml: sheetHtml, openSheet: openSheet };
})();

export function installPrint(model, doc) {
  printRuntime.install(model, doc);
}

export function printSheetHtml(template, row, doc) {
  return printRuntime.sheetHtml(template, row, doc);
}

export function openPrintSheet(doc, button) {
  return printRuntime.openSheet(doc, button);
}

if (typeof model !== 'undefined' && model && typeof document !== 'undefined' && document) {
  installPrint(model, document);
}
