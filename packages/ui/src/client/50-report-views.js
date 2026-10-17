/**
 * Quick view list, detail blocks, group headings, and the sort control.
 * Loaded beside the browser runtime. List columns come from the model.
 * A row opens #/report/<name>/row/<id> and draws each detail block.
 */

const rowsByReport = new Map();

function rowId(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.ROWID != null && row.ROWID !== '') return String(row.ROWID);
  if (row.ID != null && row.ID !== '') return String(row.ID);
  if (row.id != null && row.id !== '') return String(row.id);
  return '';
}

/** The captured report row for `#/report/<name>/row/<id>`, or null. */
export function reportViewRow(name, id) {
  const rows = rowsByReport.get(name) || [];
  for (let i = 0; i < rows.length; i++) {
    if (rowId(rows[i]) === String(id)) return rows[i];
  }
  return null;
}

const reportViewsRuntime = (() => {
let viewsModel = null;
const wrappedWindows = new WeakSet();
const watchedDocs = new WeakSet();
let enhancing = false;

function reportOf(name) {
  const reports = viewsModel && viewsModel.reports;
  if (!reports) return null;
  for (let i = 0; i < reports.length; i++) if (reports[i].name === name) return reports[i];
  return null;
}

function viewCell(row, field) {
  if (!row || field == null) return '';
  const value = row[field];
  if (value == null || typeof value === 'object') return '';
  return String(value);
}

function columnLabel(report, field) {
  const columns = report.columns || [];
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].field === field) return columns[i].label || columns[i].field;
  }
  return field;
}

function sortText(report, sort) {
  const name = columnLabel(report, sort.field);
  return sort.order ? name + ' ' + sort.order : name;
}

function hashRoute(doc) {
  const view = doc.defaultView;
  const hash = view && view.location ? view.location.hash : '';
  const parts = String(hash || '')
    .replace(/^#/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (parts[0] === 'report' && parts[1]) return { id: parts[1], row: parts[2] === 'row' ? parts[3] : undefined };
  return { id: '', row: undefined };
}

function reportNameFromUrl(url) {
  const match = /\/reports\/([^/?#]+)/.exec(String(url || ''));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function schedule(doc) {
  const view = doc.defaultView || globalThis;
  const timer = view.setTimeout || setTimeout;
  timer(() => enhance(doc), 0);
}

function wrapFetch(view) {
  if (!view || wrappedWindows.has(view) || typeof view.fetch !== 'function') return;
  const orig = view.fetch.bind(view);
  wrappedWindows.add(view);
  view.fetch = function (url, init) {
    return Promise.resolve(orig(url, init)).then((res) => captureQuery(url, init, res, view));
  };
}

function captureQuery(url, init, res, view) {
  let body = null;
  try {
    body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  } catch {
    body = null;
  }
  if (!body || body.op !== 'query' || !res) return res;
  const remember = (data) => {
    // A failed answer is not "zero rows": caching [] here would empty the
    // painted table and leave the error state's Retry nothing to reload.
    if (res.ok === false) return;
    const name = reportNameFromUrl(url);
    if (name) rowsByReport.set(name, Array.isArray(data && data.rows) ? data.rows : []);
    const doc = view.document;
    if (doc) schedule(doc);
  };
  if (typeof res.text === 'function') {
    return Promise.resolve(res.text()).then(
      (text) => {
        let data = {};
        try {
          data = JSON.parse(text);
        } catch {
          data = {};
        }
        remember(data);
        return { ok: res.ok, status: res.status, text: async () => text, json: async () => data };
      },
      () => res,
    );
  }
  if (typeof res.json !== 'function') return res;
  return Promise.resolve(res.json()).then(
    (data) => {
      remember(data);
      const text = JSON.stringify(data == null ? {} : data);
      return { ok: res.ok, status: res.status, text: async () => text, json: async () => data };
    },
    () => res,
  );
}

function groupRows(rows, field) {
  if (!field) return [{ key: '', rows: rows }];
  const order = [];
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const key = viewCell(rows[i], field);
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key: key, rows: [] };
      map.set(key, bucket);
      order.push(bucket);
    }
    bucket.rows.push(rows[i]);
  }
  return order;
}

/** A phone card footer: the record's actions (cardActions), hidden on a wide screen. */
function cardFooter(doc, report, id, row) {
  const actions = cardActions(report, id, row);
  if (!actions.length) return null;
  const td = doc.createElement('td');
  td.setAttribute('data-card-actions', '');
  const group = doc.createElement('div');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Record actions');
  for (let i = 0; i < actions.length; i++) {
    const item = actions[i];
    const el = doc.createElement(item.href ? 'a' : 'button');
    if (item.href) el.setAttribute('href', item.href);
    else {
      el.type = 'button';
      if (item.action) el.setAttribute('data-action', item.action);
      else el.setAttribute(item.op, '');
    }
    el.textContent = item.label;
    group.appendChild(el);
  }
  td.appendChild(group);
  return td;
}

/**
 * A table of rows. A report list passes its cells (reportCells) and the report
 * so each row is a phone card with an actions footer. A detail block's related
 * rows pass only their columns.
 */
function tableFor(doc, columns, rows, cardCells, report) {
  const cells = cardCells || columns.map((column) => ({ column, phone: -1, label: column.label || column.field, extra: false }));
  const table = doc.createElement('table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].extra) continue;
    const th = doc.createElement('th');
    th.textContent = cells[i].column.label || cells[i].column.field;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = doc.createElement('tbody');
  for (let r = 0; r < rows.length; r++) {
    const tr = doc.createElement('tr');
    if (cardCells) tr.setAttribute('data-card', '');
    const id = rowId(rows[r]);
    if (id) {
      tr.setAttribute('data-row-id', id);
      tr.tabIndex = 0;
    }
    for (let c = 0; c < cells.length; c++) {
      const td = doc.createElement('td');
      const cell = cells[c];
      const column = cell.column;
      // The phone card layout names each value from this label.
      td.setAttribute('data-th', cell.label);
      if (cell.phone >= 0) td.setAttribute('data-phone', String(cell.phone));
      if (cell.order != null) td.style.order = String(cell.order);
      if (cell.extra) td.setAttribute('data-phone-only', '');
      const nav = column.action && report ? (report.customActions || []).find((action) => action && action.endpoint === column.action && action.navigate) : undefined;
      if (nav) {
        // A navigation action opens its target screen for this record.
        const link = doc.createElement('a');
        link.setAttribute('href', actionNavHref(nav.navigate, rows[r]));
        link.setAttribute('data-action-nav', '');
        link.textContent = column.label || column.field;
        td.appendChild(link);
      } else if (column.action) {
        // `column header` custom action: a per-record button, not a value.
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-action', column.action);
        btn.textContent = column.label || column.field;
        td.appendChild(btn);
      } else {
        td.textContent = viewCell(rows[r], column.field);
      }
      tr.appendChild(td);
    }
    if (cardCells && report) {
      const footer = cardFooter(doc, report, id, rows[r]);
      if (footer) tr.appendChild(footer);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

function ensureSort(doc, section, report) {
  if (section.querySelector('select[data-sort]')) return;
  const sorts = report.sort || [];
  if (!sorts.length) return;
  const select = doc.createElement('select');
  select.setAttribute('data-sort', '');
  select.setAttribute('aria-label', 'Sort');
  const seen = new Set();
  const add = (field, order, text) => {
    const key = field + '\n' + (order || '');
    if (seen.has(key)) return;
    seen.add(key);
    const option = doc.createElement('option');
    option.value = field;
    option.textContent = text;
    if (order) option.setAttribute('data-order', order);
    select.appendChild(option);
  };
  for (let i = 0; i < sorts.length; i++) add(sorts[i].field, sorts[i].order, sortText(report, sorts[i]));
  const columns = report.columns || [];
  for (let i = 0; i < columns.length; i++) {
    if (columns[i].field === sorts[0].field) continue;
    add(columns[i].field, 'ascending', (columns[i].label || columns[i].field) + ' ascending');
  }
  const host = section.querySelector('[data-rows]');
  if (host && host.parentNode) host.parentNode.insertBefore(select, host);
  else section.appendChild(select);
}

function rowsSignature(rows) {
  try {
    return JSON.stringify(rows);
  } catch {
    return String(rows.length);
  }
}

function drawList(doc, section, report) {
  if (report.view === 'todo' || report.view === 'kanban' || report.view === 'calendar' || report.view === 'timeline') return;
  const host = section.querySelector('[data-rows]');
  if (!host) return;
  const rows = rowsByReport.get(report.name);
  // The export's chrome — sort select, group caption, the grouped grid —
  // belongs to a populated report. An empty load draws none of it, and clears
  // any left by a previous populated paint of this report.
  if (!rows || !rows.length) {
    const stale = section.querySelector('select[data-sort]');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    const caption = section.querySelector('[data-group-by]');
    if (caption && caption.parentNode) caption.parentNode.removeChild(caption);
    if (rows) {
      host.removeAttribute('data-grouped');
      host.removeAttribute('data-rows-sig');
      host.textContent = '';
    }
    return;
  }
  const signature = rowsSignature(rows);
  if (host.getAttribute('data-grouped') === '1' && host.getAttribute('data-rows-sig') === signature) return;
  ensureSort(doc, section, report);
  const groupField = report.groupBy && report.groupBy[0] && report.groupBy[0].field;
  host.setAttribute('data-grouped', '1');
  host.setAttribute('data-rows-sig', signature);
  host.textContent = '';
  if (groupField) {
    let note = section.querySelector('[data-group-by]');
    if (!note) {
      note = doc.createElement('p');
      note.setAttribute('data-group-by', groupField);
      if (host.parentNode) host.parentNode.insertBefore(note, host);
      else section.appendChild(note);
    }
    const label = 'Grouped by ' + columnLabel(report, groupField);
    if (note.textContent !== label) note.textContent = label;
  }
  const groups = groupRows(rows, groupField);
  const cells = reportCells(report);
  for (let i = 0; i < groups.length; i++) {
    if (groupField) {
      const head = doc.createElement('h3');
      head.setAttribute('data-group', groups[i].key);
      head.textContent = groups[i].key || '(none)';
      host.appendChild(head);
    }
    host.appendChild(tableFor(doc, report.columns || [], groups[i].rows, cells, report));
  }
}

function drawDetail(doc, section, report, id, row) {
  const blocks = report.detailBlocks || [];
  if (section.getAttribute('data-detail') === id && section.getAttribute('data-detail-ready') === '1') return;
  if (section.getAttribute('data-detail') === id && section.hasAttribute('data-detail-error')) return;
  if (!row) {
    if (section.getAttribute('data-detail') === id && section.getAttribute('data-detail-loading') === '1') return;
    section.setAttribute('data-detail', id);
    section.setAttribute('data-detail-loading', '1');
    const pending = doc.createElement('p');
    pending.setAttribute('data-detail-loading', '');
    pending.textContent = 'Loading record…';
    const oldHost = section.querySelector('[data-rows]') || section;
    oldHost.textContent = '';
    oldHost.appendChild(pending);
    const form = (viewsModel.forms || []).find((item) => item && item.name === report.form);
    const view = doc.defaultView || globalThis;
    const call = (view && view.fetch) || globalThis.fetch;
    const endpoint = form && form.recordEndpoint;
    if (!endpoint || typeof call !== 'function' || typeof apiCall !== 'function') {
      pending.textContent = 'Record detail is unavailable.';
      section.removeAttribute('data-detail-loading');
      return;
    }
    apiCall(call, view, endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ROWID: id }),
    }).then(async (res) => ({ res, body: res && res.ok && typeof readJson === 'function' ? await readJson(res) : null }))
      .then(({ res, body }) => {
        const route = hashRoute(doc);
        const record = body && body.record;
        if (route.row !== id || route.id !== report.name) return;
        if (!res || !res.ok || !record || typeof record !== 'object' || Array.isArray(record)) {
          pending.textContent = res && (res.status === 403 || res.status === 404) ? "You can't open this record." : 'Unable to load this record. Try again.';
          pending.setAttribute('data-detail-error', '');
          pending.setAttribute('role', 'alert');
          pending.setAttribute('data-detail-retry', '');
          section.setAttribute('data-detail-error', '');
          section.removeAttribute('data-detail-loading');
          return;
        }
        section.removeAttribute('data-detail-loading');
        drawDetail(doc, section, report, id, record);
      })
      .catch(() => {
        const route = hashRoute(doc);
        if (section.getAttribute('data-detail') === id && route.row === id && route.id === report.name) {
          pending.textContent = 'Unable to load this record. Try again.';
          pending.setAttribute('data-detail-error', '');
          pending.setAttribute('role', 'alert');
          pending.setAttribute('data-detail-retry', '');
          section.setAttribute('data-detail-error', '');
          section.removeAttribute('data-detail-loading');
        }
      });
    return;
  }
  const host = section.querySelector('[data-rows]') || section;
  host.removeAttribute('data-grouped');
  host.textContent = '';
  section.setAttribute('data-detail', id);
  section.setAttribute('data-detail-ready', '1');
  section.removeAttribute('data-detail-loading');
  section.setAttribute('data-view', 'detail');
  if (report.printTemplate) {
    const tools = doc.createElement('div');
    tools.className = 'report-tools';
    tools.setAttribute('data-print-tools', '');
    const button = doc.createElement('button');
    button.type = 'button';
    button.setAttribute('data-print-record', id);
    button.textContent = 'Print';
    tools.appendChild(button);
    host.appendChild(tools);
  }
  if (!blocks.length) {
    // No detail view in the export: the record view lists the report columns.
    const list = doc.createElement('dl');
    list.setAttribute('data-detail-list', '');
    const columns = report.columns || [];
    for (let f = 0; f < columns.length; f++) {
      const term = doc.createElement('dt');
      term.textContent = columns[f].label || columns[f].field;
      const value = doc.createElement('dd');
      value.textContent = viewCell(row, columns[f].field);
      list.appendChild(term);
      list.appendChild(value);
    }
    host.appendChild(list);
    return;
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const box = doc.createElement('section');
    box.setAttribute('data-block', block.title || '');
    const title = doc.createElement('h3');
    title.textContent = block.title || '';
    box.appendChild(title);
    const related = block.relatedField && row ? row[block.relatedField] : null;
    if (Array.isArray(related)) box.appendChild(tableFor(doc, block.fields || [], related));
    else {
      const list = doc.createElement('dl');
      const fields = block.fields || [];
      for (let f = 0; f < fields.length; f++) {
        const term = doc.createElement('dt');
        term.textContent = fields[f].label || fields[f].field;
        const value = doc.createElement('dd');
        value.textContent = viewCell(row, fields[f].field);
        list.appendChild(term);
        list.appendChild(value);
      }
      box.appendChild(list);
    }
    host.appendChild(box);
  }
}

function retryDetail(doc, section, report, id) {
  section.removeAttribute('data-detail-ready');
  section.removeAttribute('data-detail-error');
  section.removeAttribute('data-detail-loading');
  section.removeAttribute('data-detail');
  drawDetail(doc, section, report, id, null);
}

function enhance(doc) {
  if (enhancing || !viewsModel || !doc) return;
  enhancing = true;
  try {
    const main = doc.getElementById('main');
    if (!main) return;
    const section = main.querySelector('section[data-report]');
    if (!section) return;
    const name = section.getAttribute('data-report') || '';
    const report = reportOf(name);
    if (!report) return;
    const route = hashRoute(doc);
    const blocks = report.detailBlocks || [];
    if (route.row && route.id === name && (blocks.length || report.printTemplate)) {
      drawDetail(doc, section, report, route.row, null);
      return;
    }
    drawList(doc, section, report);
  } finally {
    enhancing = false;
  }
}

function onActivate(doc, event) {
  const target = event.target;
  if (!target || !target.closest) return;
  const retry = target.closest('[data-detail-retry]');
  if (retry) {
    const section = retry.closest('section[data-report]');
    const name = section && section.getAttribute('data-report');
    const report = name ? reportOf(name) : null;
    const route = hashRoute(doc);
    if (section && report && route.id === name && route.row) retryDetail(doc, section, report, route.row);
    return;
  }
  if (target.closest('a, button, input, select, textarea, label')) return;
  const tr = target.closest('tr[data-row-id]');
  if (!tr) return;
  const section = tr.closest('section[data-report]');
  if (!section) return;
  const name = section.getAttribute('data-report');
  const id = tr.getAttribute('data-row-id');
  const report = name ? reportOf(name) : null;
  if (!name || !id || !report || !((report.detailBlocks || []).length || report.printTemplate)) return;
  const view = doc.defaultView;
  if (!view || !view.location) return;
  view.location.hash = '#/report/' + encodeURIComponent(name) + '/row/' + encodeURIComponent(id);
  enhance(doc);
  schedule(doc);
}

function watch(doc) {
  if (watchedDocs.has(doc)) return;
  watchedDocs.add(doc);
  const view = doc.defaultView || globalThis;
  const Observer = view.MutationObserver || globalThis.MutationObserver;
  if (typeof Observer === 'function') {
    const root = doc.documentElement || doc.body;
    if (root) {
      const obs = new Observer(() => enhance(doc));
      obs.observe(root, { childList: true, subtree: true });
    }
  }
  if (view && view.addEventListener) view.addEventListener('hashchange', () => enhance(doc));
  doc.addEventListener('click', (event) => onActivate(doc, event));
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onActivate(doc, event);
  });
}

function install(appModel, doc) {
  if (appModel) viewsModel = appModel;
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  if (!documentRef || !viewsModel) return;
  const view = documentRef.defaultView || globalThis;
  wrapFetch(view);
  watch(documentRef);
  enhance(documentRef);
  // The print part is appended after this one in the page script, so its
  // install can only run once the whole script has been evaluated. Defer it
  // a turn; the part also installs itself at load when the page model exists.
  const timer = view.setTimeout || setTimeout;
  timer(() => {
    if (typeof installPrint === 'function') installPrint(viewsModel, documentRef);
  }, 0);
}

return install;
})();

export function installReportViews(appModel, doc) {
  reportViewsRuntime(appModel, doc);
}

if (typeof model !== 'undefined' && model && typeof document !== 'undefined' && document) {
  installReportViews(model, document);
}
