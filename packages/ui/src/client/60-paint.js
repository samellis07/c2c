/**
 * After each paint, apply wording to the open form and lookup text to report
 * cells. Form layout wraps the field markup. Report views install on boot.
 */
const decoratePaintBoot = boot;
const decoratePaintRows = new Map();

boot = function (appModel, doc) {
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  const view = (documentRef && documentRef.defaultView) || globalThis;
  if (typeof installReportViews === 'function') installReportViews(appModel, documentRef);
  watchLookupFetch(view, documentRef, appModel);
  const pending = decoratePaintBoot(appModel, doc);
  if (view && view.addEventListener && documentRef && !documentRef.__c2cNavHook) {
    documentRef.__c2cNavHook = true;
    view.addEventListener('hashchange', () => {
      if (typeof applyNavPages === 'function') applyNavPages(appModel, documentRef);
      paintDecorations(documentRef, appModel);
    });
  }
  const apply = () => {
    if (typeof applyNavPages === 'function') applyNavPages(appModel, documentRef);
    paintDecorations(documentRef, appModel);
  };
  if (pending && typeof pending.then === 'function') return pending.then(apply, apply);
  apply();
  return pending;
};

function watchLookupFetch(view, doc, appModel) {
  if (!view || view.__c2cLookupFetch || typeof view.fetch !== 'function') return;
  view.__c2cLookupFetch = true;
  const orig = view.fetch.bind(view);
  view.fetch = function (url, init) {
    return Promise.resolve(orig(url, init)).then((res) => rememberLookupRows(url, init, res, doc, appModel));
  };
}

function rememberLookupRows(url, init, res, doc, appModel) {
  let body = null;
  try {
    body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
  } catch {
    body = null;
  }
  if (!body || body.op !== 'query' || !res) return res;
  const name = lookupReportName(url);
  const store = (data) => {
    if (name) decoratePaintRows.set(name, Array.isArray(data && data.rows) ? data.rows : []);
    const timer = (doc && doc.defaultView && doc.defaultView.setTimeout) || setTimeout;
    timer(() => paintDecorations(doc, appModel), 0);
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
        store(data);
        return { ok: res.ok, status: res.status, text: async () => text, json: async () => data };
      },
      () => res,
    );
  }
  if (typeof res.json !== 'function') return res;
  return Promise.resolve(res.json()).then(
    (data) => {
      store(data);
      const text = JSON.stringify(data == null ? {} : data);
      return { ok: res.ok, status: res.status, text: async () => text, json: async () => data };
    },
    () => res,
  );
}

function lookupReportName(url) {
  const match = /\/reports\/([^/?#]+)/.exec(String(url || ''));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function paintDecorations(doc, appModel) {
  if (!doc || !appModel || doc.__c2cPainting) return;
  const main = doc.getElementById ? doc.getElementById('main') : null;
  if (!main || !main.querySelector) return;
  doc.__c2cPainting = true;
  try {
    const formEl = main.querySelector('form[data-form]');
    if (formEl && typeof applyFormLabels === 'function') {
      const form = (appModel.forms || []).find((item) => item && item.name === formEl.getAttribute('data-form'));
      if (form) applyFormLabels(formEl, form, { doc: doc });
    }
    if (typeof applyLookupDisplays !== 'function') return;
    const sections = main.querySelectorAll('section[data-report]');
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const name = section.getAttribute('data-report');
      const report = (appModel.reports || []).find((item) => item && item.name === name);
      const rows = decoratePaintRows.get(name);
      if (!report || !rows) continue;
      const bodies = section.querySelectorAll('tbody');
      for (let b = 0; b < bodies.length; b++) {
        applyLookupDisplays(report, bodies[b], rowsForBody(bodies[b], rows));
      }
    }
  } finally {
    doc.__c2cPainting = false;
  }
}

function rowsForBody(tbody, rows) {
  if (!tbody.querySelectorAll) return rows;
  const trs = Array.from(tbody.querySelectorAll('tr'));
  const matched = [];
  for (let i = 0; i < trs.length; i++) {
    const id = trs[i].getAttribute('data-row-id') || trs[i].getAttribute('data-row') || '';
    if (!id) {
      matched.push(rows[i]);
      continue;
    }
    let found = null;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (rowIdOf(row) === id) {
        found = row;
        break;
      }
    }
    matched.push(found || rows[i]);
  }
  return matched;
}

function rowIdOf(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.ROWID != null && row.ROWID !== '') return String(row.ROWID);
  if (row.ID != null && row.ID !== '') return String(row.ID);
  if (row.id != null && row.id !== '') return String(row.id);
  return '';
}
