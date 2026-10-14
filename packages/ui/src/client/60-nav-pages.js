/**
 * The exported menu (icons, rail or list style), theme tokens on <html>, and
 * dashboard KPI cells. Loaded beside the base runtime. applyNavPages runs
 * after every paint; a missing token leaves the default shell in place.
 */

function navEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function navGlyph(name) {
  return typeof c2cIconGlyph === 'function' ? c2cIconGlyph(name) : '';
}

function navMenuStyle(appModel) {
  const menu = appModel && appModel.theme && appModel.theme.menu;
  return menu === 'rail' ? 'rail' : 'list';
}

function navHtml(appModel) {
  const rail = navMenuStyle(appModel) === 'rail';
  const tile = `<div class="apptile" aria-hidden="true">${navGlyph('zc-app')}</div>`;
  const parts = [
    rail || !appModel.name ? tile : `<div class="navhead">${tile}<strong class="navapp">${navEscape(appModel.name)}</strong></div>`,
  ];
  for (const section of appModel.nav || []) {
    // Hidden and all-system sections keep their routes but not a menu slot.
    if (section.hidden || section.system) continue;
    const items = (section.items || []).filter((item) => !item.system && item.href);
    if (!items.length) continue;
    const links = items
      .map(
        (item) =>
          `<a class="navitem" href="${navEscape(item.href)}" data-icon="${navEscape(item.icon || '')}"><span class="zicon" aria-hidden="true">${navGlyph(item.icon)}</span><span class="navlbl">${navEscape(item.label || item.name || '')}</span></a>`,
      )
      .join('');
    // A section whose only child repeats its name is a single flat entry, not a group.
    if (items.length === 1 && (items[0].label || items[0].name || '') === section.name) {
      parts.push(links);
      continue;
    }
    parts.push(
      `<details class="navsec" data-section="${navEscape(section.name)}">` +
        `<summary data-icon="${navEscape(section.icon || '')}"><span class="zicon" aria-hidden="true">${navGlyph(section.icon)}</span><span class="navlbl">${navEscape(section.name)}</span></summary>` +
        `<div class="navitems">${links}</div>` +
        `</details>`,
    );
  }
  return parts.join('');
}

/** `Purchased_Date is today` (or tomorrow/yesterday) against the app-zone day. */
function kpiMatch(row, criteria, view) {
  if (!criteria || !String(criteria).trim()) return true;
  const match = /^([A-Za-z_]\w*)\s+is\s+(today|tomorrow|yesterday)/i.exec(String(criteria).trim());
  if (!match) return true;
  const parts = parseClientDate(row && row[match[1]]);
  if (!parts) return false;
  const zone =
    (view && typeof view.C2C_APP_TIMEZONE === 'string' && view.C2C_APP_TIMEZONE) ||
    (typeof globalThis.C2C_APP_TIMEZONE === 'string' ? globalThis.C2C_APP_TIMEZONE : '');
  let today = null;
  if (zone) {
    try {
      today = clientNow({ appTimeZone: zone });
    } catch {
      today = null;
    }
  }
  if (!today) {
    const now = new Date(); // determinism-allow: browser-side clock for `is today` criteria; not evaluated while generating files
    today = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  }
  const day = 86400000;
  const word = match[2].toLowerCase();
  const offset = word === 'tomorrow' ? day : word === 'yesterday' ? -day : 0;
  return Date.UTC(parts.y, parts.m - 1, parts.d) === Date.UTC(today.y, today.m - 1, today.d) + offset;
}

function kpiValue(out, rows) {
  const field = out.getAttribute('data-kpi-field') || '';
  const fn = (out.getAttribute('data-kpi-fn') || '').toLowerCase();
  if (fn === 'count') return String(rows.length);
  let sum = 0;
  for (const row of rows) {
    const raw = row && field ? row[field] : null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n)) sum += n;
  }
  return Number.isInteger(sum) ? String(sum) : String(Math.round(sum * 100) / 100);
}

/**
 * Each `output[data-kpi-fn]` reads its report's query endpoint and folds the
 * rows the `criteria` keeps. A missing endpoint leaves the 0 in place.
 */
function fillKpis(doc, appModel) {
  if (!doc || typeof doc.querySelectorAll !== 'function' || !appModel) return;
  const view = doc.defaultView || globalThis;
  const call = (view && view.fetch) || globalThis.fetch;
  for (const out of doc.querySelectorAll('output[data-kpi-fn]')) {
    const name = out.getAttribute('data-kpi-report') || '';
    const report = (appModel.reports || []).find((item) => item && item.name === name);
    if (!report || !report.queryEndpoint || typeof call !== 'function') continue;
    apiCall(call, view, report.queryEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'query', page: 0, pageSize: report.pageSize || 300 }),
    })
      .then((res) => (res && res.ok ? responseJson(res) : null))
      .then((body) => {
        if (!body) return;
        const rows = Array.isArray(body.rows) ? body.rows : [];
        const criteria = out.getAttribute('data-kpi-criteria') || '';
        out.textContent = kpiValue(out, rows.filter((row) => kpiMatch(row, criteria, view)));
      })
      .catch(() => {});
  }
}

function markCurrentNav(nav, doc) {
  const hash = (doc && doc.location && doc.location.hash) || '';
  for (const link of nav.querySelectorAll('a[href^="#"]')) {
    const on = link.getAttribute('href') === hash;
    if (on) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
    const sec = link.closest && link.closest('details');
    if (sec) {
      if (on) sec.setAttribute('data-active', 'true');
      else sec.removeAttribute('data-active');
      if (on && navMenuStyle(modelFromNav(nav)) === 'list') sec.open = true;
    }
  }
}

function modelFromNav() {
  return typeof model !== 'undefined' ? model : null;
}

export function applyNavPages(model, doc) {
  if (!doc || !model) return;
  const root = doc.documentElement;
  const theme = model.theme || {};
  if (root) {
    if (theme.theme) root.setAttribute('data-theme', String(theme.theme));
    root.setAttribute('data-menu', theme.menu === 'rail' ? 'rail' : 'list');
    if (theme.font) root.setAttribute('data-font', String(theme.font));
    if (theme.iconColor) root.setAttribute('data-icon-color', String(theme.iconColor));
  }
  const nav = doc.getElementById('nav');
  if (nav) {
    nav.innerHTML = navHtml(model);
    markCurrentNav(nav, doc);
  }
  const article = doc.querySelector('article[data-page]');
  if (article) {
    const page = (model.pages || []).find((item) => item.name === article.getAttribute('data-page'));
    if (page) {
      const heading = article.querySelector('h2');
      const title = heading && heading.textContent ? heading.textContent : page.label || page.name;
      article.innerHTML = `<h2>${navEscape(title)}</h2>${(page.elements || [])
        .map((el) => renderElement(el, doc, undefined, model))
        .join('')}`;
      hydrateCharts(article, model, doc.defaultView || globalThis);
      // paint already fired this page's popup triggers; the re-rendered markers must not query again.
    }
  }
  fillKpis(doc, model);
}
