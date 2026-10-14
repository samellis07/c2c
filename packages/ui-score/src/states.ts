/**
 * The UX-states gate: drive a built bundle through the
 * loading/empty/error/confirm/pending/toast/offline/session/denied/not-found/
 * crash/focus/motion states in jsdom — the same session machinery the scorer
 * uses — and return one verdict per state row.
 *
 * A verdict is `pass`, `fail`, `skip` (the state does not apply to this app,
 * e.g. no deletable report) or `waived` (a named waiver — the vanilla runtime
 * carries no unmount-all failure mode, so `crash` never applies to it). A
 * failing row names the tracked issue that owns it, so a run on the current
 * code reports expected-fails instead of hard failures; the CLI turns an
 * unowned failure red.
 */

import type { App } from '../../core/src/index.js';
import {
  VIEWPORTS,
  createFakeApi,
  cssAtWidth,
  expectedFromIr,
  loadRuntime,
  norm,
  openSession,
  parseCss,
  settle,
  type Expected,
  type FakeApi,
  type Session,
  type UiBundle,
  type Viewport,
} from './score.js';

export type StateStatus = 'pass' | 'fail' | 'skip' | 'waived' | 'error';

export interface StateVerdict {
  /** The state row id. */
  state: string;
  /** What it was exercised on (a screen, a viewport, 'app'). */
  scope: string;
  status: StateStatus;
  /** The tracked issue that owns a `fail` (expected-fail), or the waiver name. */
  issue?: string;
  evidence: string;
}

export interface StatesOptions {
  ui: 'react' | 'vanilla';
  /** States to run (default: all). */
  only?: Set<string>;
}

/**
 * The issue ids a state row may be owned by. An OWNER value outside this set
 * is a phantom name — the gate would report an expected-fail under an issue
 * that does not exist, so the unit test fails on it.
 */
export const STATE_OWNER_ISSUES: ReadonlySet<string> = new Set([
  'ux-loading-empty-not-found',
  'ux-toasts-field-errors',
  'ux-confirm-pending',
  'ux-offline-session',
  'ux-focus-motion',
  'react-error-boundary',
]);

/** The issue owning each state row. */
export const OWNER: Record<string, string> = {
  loading: 'ux-loading-empty-not-found',
  empty: 'ux-loading-empty-not-found',
  'empty-filtered': 'ux-loading-empty-not-found',
  error: '',
  invalid: 'ux-toasts-field-errors',
  'server-field-error': 'ux-toasts-field-errors',
  submitting: 'ux-confirm-pending',
  'confirm-open': 'ux-confirm-pending',
  'row-rollback': 'ux-confirm-pending',
  toast: 'ux-toasts-field-errors',
  offline: 'ux-offline-session',
  'session-expired': 'ux-offline-session',
  denied: 'ux-offline-session',
  'not-found': 'ux-loading-empty-not-found',
  crash: 'react-error-boundary',
  'route-focus': 'ux-focus-motion',
  'reduced-motion': 'ux-focus-motion',
};

const mainOf = (doc: Document): Element => doc.getElementById('main') ?? doc.body;

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function homeLink(root: Element | null | undefined): Element | null {
  if (!root) return null;
  return (
    Array.from(root.querySelectorAll('a[href]')).find((a) => /^#\/(form|report|page)\//.test(a.getAttribute('href') ?? '') || ['#', '#/'].includes(a.getAttribute('href') ?? '')) ?? null
  );
}

function click(win: Session['win'], el: Element): void {
  (el as HTMLElement).click();
}

function fire(win: Session['win'], el: Element, type: string): void {
  el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
}

interface Run {
  verdicts: StateVerdict[];
  add(state: string, scope: string, ok: boolean, evidence: string, issue?: string): void;
  skip(state: string, scope: string, evidence: string): void;
  wants(state: string): boolean;
}

function runner(opts: StatesOptions): Run {
  const verdicts: StateVerdict[] = [];
  return {
    verdicts,
    wants: (state) => !opts.only || opts.only.has(state),
    add(state, scope, ok, evidence, issue) {
      verdicts.push({ state, scope, status: ok ? 'pass' : 'fail', ...(ok ? {} : { issue: issue ?? (OWNER[state] || undefined) }), evidence });
    },
    skip(state, scope, evidence) {
      verdicts.push({ state, scope, status: 'skip', evidence });
    },
  };
}

/** Fill every fillable required control so a submit passes client validation. */
function fillForm(s: Session, form: Expected['forms'][number]): void {
  for (const field of form.fields) {
    if (!field.required) continue;
    let box: Element | null = mainOf(s.doc).querySelector(`[data-field="${field.name}"]`);
    if (!box) {
      const named = mainOf(s.doc).querySelector(`[name="${field.name}"]`);
      box = named?.closest('[data-field], .field, fieldset, div') ?? named ?? null;
    }
    if (!box) continue;
    if (field.kind === 'decision') {
      const cb = box.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
      if (cb && !cb.checked) {
        cb.checked = true;
        fire(s.win, cb, 'change');
      }
      continue;
    }
    for (const control of Array.from(box.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea')) as HTMLInputElement[]) {
      control.value = 'gate';
      fire(s.win, control, 'input');
      fire(s.win, control, 'change');
    }
    const select = box.querySelector('select') as HTMLSelectElement | null;
    if (select) {
      const option = Array.from(select.options).find((o) => o.value !== '');
      if (option && !select.value) {
        select.value = option.value;
        fire(s.win, select, 'change');
      }
    }
  }
}

const FILLABLE = new Set(['text', 'longtext', 'decision', 'choice']);

function pickForm(exp: Expected, opts: { fillableOnly?: boolean } = {}): Expected['forms'][number] | undefined {
  const withRequired = exp.forms.filter((f) => f.fields.some((x) => x.required));
  if (!opts.fillableOnly) return withRequired[0] ?? exp.forms[0];
  return withRequired.find((f) => f.fields.filter((x) => x.required).every((x) => FILLABLE.has(x.kind))) ?? withRequired[0];
}

/** The toast candidates a write result may surface. */
function toastOf(doc: Document): Element | undefined {
  return Array.from(doc.querySelectorAll('#toasts > *, .toast, [data-toast], [role="status"][data-kind]')).find((el) => text(el) !== '');
}

async function waitGone(s: Session, el: Element, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (el.isConnected && Date.now() < deadline) await new Promise((resolve) => s.win.setTimeout(resolve, 200));
  return !el.isConnected;
}

async function driveReport(s: Session, report: Expected['reports'][number]): Promise<Element> {
  await s.go(`#/report/${encodeURIComponent(report.name)}`);
  return mainOf(s.doc);
}

/**
 * The first candidate whose route actually calls its query endpoint. Chart,
 * calendar and board stubs paint a "view not available" card and never fetch,
 * so they cannot carry the loading/empty/error states — the row skips on apps
 * that have only stubs.
 */
async function firstQueryingReport(s: Session, api: FakeApi, reports: Expected['reports']): Promise<Expected['reports'][number] | undefined> {
  for (const report of reports) {
    const before = api.matching('/reports/').length;
    await s.go(`#/report/${encodeURIComponent(report.name)}`);
    await settle(s.win);
    if (api.matching('/reports/').length > before) return report;
  }
  return undefined;
}

/**
 * The full 17-row run against one built bundle. `exp` is the scorer's
 * Creator-side expectation; `ui` picks the named waivers.
 */
export async function checkUiStates(app: App, bundle: UiBundle, opts: StatesOptions): Promise<StateVerdict[]> {
  const exp = expectedFromIr(app);
  const run = runner(opts);
  const rules = parseCss(bundle.css);
  const widthCss = { desktop: cssAtWidth(rules, 1440), phone: cssAtWidth(rules, 390) };
  const sample = new Map<string, Record<string, string>>();
  for (const r of app.reports) {
    const row: Record<string, string> = { ROWID: '1001' };
    for (const f of app.forms.find((x) => x.name === r.form)?.fields ?? []) row[f.name] = `Sample ${f.name.replace(/_+/g, ' ')}`;
    for (const c of r.columns) if (c.field) row[c.field] = `Sample ${c.field.replace(/_+/g, ' ')}`;
    sample.set(r.name, row);
  }
  const allRows = [...sample.values()];
  const tableReports = exp.reports.filter((r) => !r.chart);
  const loaded = loadRuntime(bundle);
  const both = (s: Session, el: Element | null | undefined): boolean => !!el && VIEWPORTS.every((vp) => s.shown(el, vp));

  // ---- session A: rows — interactions on a working report and form
  {
    const api = createFakeApi(sample, allRows);
    const s = await openSession(bundle, loaded, api.fetch, sample, widthCss);
    try {
      const firstItem = exp.sections.flatMap((sec) => sec.items)[0];

      // route-focus: heading focused + document retitled after navigation.
      if (run.wants('route-focus')) {
        if (!firstItem) run.skip('route-focus', 'app', 'no menu destinations');
        else {
          const titleBefore = s.doc.title;
          await s.go(`#/${firstItem.kind}/${encodeURIComponent(firstItem.name)}`);
          const heading = mainOf(s.doc).querySelector('h1, h2');
          const focused = !!heading && s.doc.activeElement === heading;
          const titled = norm(s.doc.title) !== norm(titleBefore) && norm(s.doc.title).includes(norm(firstItem.label));
          run.add('route-focus', `${firstItem.kind}/${firstItem.name}`, focused && titled, `focus ${focused ? 'on the heading' : `on <${s.doc.activeElement?.tagName.toLowerCase() ?? 'none'}>`}, title "${s.doc.title}"`);
        }
      }

      // not-found: unknown hash → heading + way home + focus moved.
      if (run.wants('not-found')) {
        await s.go('#/report/__no_such_screen__');
        const main = mainOf(s.doc);
        const heading = main.querySelector('h1, h2') ?? main.querySelector('[data-state="not-found"]');
        const home = homeLink(main);
        const movedFocus = !!heading && (s.doc.activeElement === heading || heading.contains(s.doc.activeElement));
        run.add('not-found', '#/report/__no_such_screen__', !!heading && both(s, heading) && !!home && movedFocus, `${!heading ? 'no not-found heading' : `heading "${text(heading).slice(0, 60)}"`}${home ? '' : ', no way home'}${movedFocus ? '' : ', focus not moved'}`);
      }

      // empty-filtered: search to no match → a clear control restores rows.
      if (run.wants('empty-filtered')) {
        const report = await firstQueryingReport(s, api, tableReports.filter((r) => r.columns.length > 0));
        if (!report) run.skip('empty-filtered', 'app', 'no report that queries to filter');
        else {
          const main = await driveReport(s, report);
          const input = main.querySelector('input[type="search"], [data-report-search] input, .c2c-search input') as HTMLInputElement | null;
          if (!input) run.add('empty-filtered', report.name, false, 'no search control on the report');
          else {
            input.value = 'zzz-no-such-row';
            fire(s.win, input, 'input');
            const form = input.closest('form');
            if (form) fire(s.win, form, 'submit');
            else fire(s.win, input, 'change');
            await settle(s.win);
            const emptyEl = mainOf(s.doc).querySelector('[data-state="empty"]');
            const clear = emptyEl ? Array.from(emptyEl.querySelectorAll('button, a')).find((b) => /clear|reset/i.test(text(b))) : undefined;
            let restored = false;
            if (clear) {
              click(s.win, clear);
              await settle(s.win);
              restored = !!mainOf(s.doc).querySelector('tbody tr, [data-row], [data-row-link]') && !mainOf(s.doc).querySelector('[data-state="empty"]');
            }
            run.add('empty-filtered', report.name, !!emptyEl && !!clear && restored, `${!emptyEl ? 'no filtered empty state' : !clear ? 'no clear control' : restored ? 'clear restores the rows' : 'clear does not restore'}`);
          }
        }
      }

      // confirm-open + row-rollback: the row delete flow.
      if (run.wants('confirm-open') || run.wants('row-rollback')) {
        let deletable: { report: Expected['reports'][number]; button: Element } | undefined;
        for (const report of tableReports) {
          const main = await driveReport(s, report);
          const button = main.querySelector('[data-row-delete]');
          if (button) {
            deletable = { report, button };
            break;
          }
        }
        if (!deletable) {
          if (run.wants('confirm-open')) run.skip('confirm-open', 'app', 'no deletable report');
          if (run.wants('row-rollback')) run.skip('row-rollback', 'app', 'no deletable report');
        } else {
          if (run.wants('confirm-open')) {
            click(s.win, deletable.button);
            await settle(s.win);
            const dialog = s.doc.querySelector('[role="alertdialog"], dialog[open]');
            const postsBefore = api.matching('/delete').length;
            let cancelled = false;
            let confirmedOnce = false;
            let focusBack = false;
            if (dialog) {
              const cancel = Array.from(dialog.querySelectorAll('button')).find((b) => /cancel|keep|close/i.test(text(b)));
              if (cancel) {
                click(s.win, cancel);
                await settle(s.win);
                cancelled = api.matching('/delete').length === postsBefore && !s.doc.querySelector('[role="alertdialog"]');
                focusBack = s.doc.activeElement === deletable.button;
              }
              click(s.win, deletable.button);
              await settle(s.win);
              const again = s.doc.querySelector('[role="alertdialog"], dialog[open]');
              const ok = again && Array.from(again.querySelectorAll('button')).find((b) => /delete|confirm|yes|remove|clear/i.test(text(b)));
              if (ok) {
                click(s.win, ok);
                await settle(s.win);
                confirmedOnce = api.matching('/delete').length === postsBefore + 1;
              }
            }
            run.add('confirm-open', deletable.report.name, !!dialog && cancelled && confirmedOnce && focusBack, dialog ? `dialog opens; cancel ${cancelled ? 'posts nothing' : 'posted'}${focusBack ? '' : ', focus not returned'}; confirm ${confirmedOnce ? 'posts once' : 'miscounted'}` : `delete posted ${api.matching('/delete').length} time(s) with no dialog`);
          }
          if (run.wants('row-rollback')) {
            // Fresh session state: leave the route and come back so the report
            // repaints the row the confirm check deleted (a same-hash go() is a no-op).
            await s.go('#/report/__reset__');
            await driveReport(s, deletable.report);
            const row = mainOf(s.doc).querySelector('tbody tr, [data-row]');
            const del = mainOf(s.doc).querySelector('[data-row-delete]') as HTMLElement | null;
            if (!row || !del) run.skip('row-rollback', deletable.report.name, 'no row to delete');
            else {
              api.lane.remove = 'error';
              click(s.win, del);
              await settle(s.win);
              const dialog = s.doc.querySelector('[role="alertdialog"], dialog[open]');
              const ok = dialog && Array.from(dialog.querySelectorAll('button')).find((b) => /delete|confirm|yes|remove/i.test(text(b)));
              if (ok) click(s.win, ok);
              await settle(s.win);
              api.lane.remove = 'ok';
              const rowBack = !!mainOf(s.doc).querySelector('tbody tr, [data-row]');
              const failureToast = toastOf(s.doc);
              run.add('row-rollback', deletable.report.name, rowBack && !!failureToast, `500 on delete: row ${rowBack ? 'restored' : 'gone'}, failure toast ${failureToast ? `"${text(failureToast).slice(0, 50)}"` : 'missing'}`);
            }
          }
        }
      }

      // toast: a write result surfaces in a status region and dismisses ≤6s.
      if (run.wants('toast')) {
        // Prefer a custom action (header or row), else a delete confirm, else a submit.
        let toasted = false;
        let how = '';
        const report = tableReports[0];
        if (report) await driveReport(s, report);
        const action = mainOf(s.doc).querySelector('[data-action]') as HTMLElement | null;
        if (action) {
          click(s.win, action);
          await settle(s.win);
          toasted = true;
          how = 'custom action';
        } else if (pickForm(exp)) {
          const form = pickForm(exp)!;
          await s.go(`#/form/${encodeURIComponent(form.name)}`);
          const el = s.doc.querySelector('#main form');
          if (el) {
            fillForm(s, form);
            fire(s.win, el, 'submit');
            await settle(s.win);
            toasted = true;
            how = 'submit';
          }
        }
        if (!toasted) run.skip('toast', 'app', 'no write action to toast');
        else {
          const toast = toastOf(s.doc);
          if (!toast) run.add('toast', how, false, 'no toast in a status region after the write');
          else {
            const closeable = !!toast.querySelector('button, [data-close], [aria-label*="ismiss" i]');
            const gone = closeable ? true : await waitGone(s, toast, 6300);
            run.add('toast', how, gone, `toast in a ${toast.getAttribute('role') ?? 'plain'} element ${closeable ? 'has a close' : gone ? 'auto-dismissed' : 'still shown after 6s'}`);
          }
        }
      }

      // submitting: slow submit marks the button busy; two submits post once.
      if (run.wants('submitting')) {
        const form = pickForm(exp, { fillableOnly: true });
        if (!form) run.skip('submitting', 'app', 'no fillable form');
        else {
          await s.go(`#/form/${encodeURIComponent(form.name)}`);
          const el = s.doc.querySelector('#main form') as HTMLFormElement | null;
          if (!el) run.add('submitting', form.name, false, 'no form rendered');
          else {
            api.lane.submit = 'slow';
            fillForm(s, form);
            fire(s.win, el, 'submit');
            fire(s.win, el, 'submit');
            await settle(s.win, 4);
            const submit = el.querySelector('button[type="submit"], input[type="submit"]');
            const busy = !!submit && (submit.getAttribute('aria-busy') === 'true' || submit.hasAttribute('disabled') || submit.getAttribute('aria-disabled') === 'true');
            api.release('submit');
            await settle(s.win);
            const posts = api.matching('/submit').length;
            api.lane.submit = 'ok';
            run.add('submitting', form.name, busy && posts === 1, `busy ${busy ? 'marked' : 'unmarked'}; two rapid submits → ${posts} POST(s)`);
          }
        }
      }

      // invalid (client): required field → error, aria-invalid, focus.
      if (run.wants('invalid')) {
        const form = pickForm(exp);
        if (!form || !form.fields.some((f) => f.required)) run.skip('invalid', 'app', 'no form with a mandatory field');
        else {
          await s.go(`#/form/${encodeURIComponent(form.name)}`);
          const el = s.doc.querySelector('#main form');
          if (!el) run.add('invalid', form.name, false, 'no form rendered');
          else {
            fire(s.win, el, 'submit');
            await settle(s.win);
            const first = form.fields.find((f) => f.required)!;
            const marker = el.querySelector(`[data-error-for="${first.name}"], [data-error-for], .error, [role="alert"]`);
            const box = el.querySelector(`[data-field="${first.name}"]`);
            const invalid = (box?.querySelector('[aria-invalid="true"]') ?? el.querySelector('[aria-invalid="true"]')) !== null;
            const control = (box ?? el).querySelector('input, textarea, select') as HTMLElement | null;
            const focused = s.doc.activeElement === control || (control ? control.contains(s.doc.activeElement) : false);
            run.add('invalid', form.name, !!marker && text(marker) !== '' && invalid && focused, `marker ${marker ? `"${text(marker).slice(0, 40)}"` : 'missing'}, aria-invalid ${invalid ? 'set' : 'missing'}, focus ${focused ? 'on the field' : 'not moved'}`);
          }
        }
      }

      // server-field-error: a 400 {error, field} lands on that field with focus.
      if (run.wants('server-field-error')) {
        const form = pickForm(exp, { fillableOnly: true });
        if (!form) run.skip('server-field-error', 'app', 'no fillable form');
        else {
          const target = form.fields.find((f) => !f.required) ?? form.fields[0];
          api.fieldError = { field: target?.name ?? '', message: 'Server says no' };
          api.lane.submit = 'field';
          await s.go(`#/form/${encodeURIComponent(form.name)}`);
          const el = s.doc.querySelector('#main form');
          if (!el || !target) run.add('server-field-error', form.name, false, 'no form or field to drive');
          else {
            fillForm(s, form);
            fire(s.win, el, 'submit');
            await settle(s.win);
            api.lane.submit = 'ok';
            const marker = el.querySelector(`[data-error-for="${target.name}"]`);
            const box = el.querySelector(`[data-field="${target.name}"]`);
            const control = box?.querySelector('input, textarea, select') as HTMLElement | null;
            const focused = !!control && (s.doc.activeElement === control || control.contains(s.doc.activeElement));
            run.add('server-field-error', `${form.name}.${target.name}`, !!marker && text(marker) !== '' && focused, `400 {field:${target.name}} → marker ${marker ? `"${text(marker).slice(0, 40)}"` : 'missing'}, focus ${focused ? 'on the field' : 'not moved'}`);
          }
        }
      }

      // offline: the banner shows, submit is blocked, online re-fetches once.
      if (run.wants('offline')) {
        const report = await firstQueryingReport(s, api, tableReports);
        const form = pickForm(exp);
        if (!report && !form) run.skip('offline', 'app', 'no report or form');
        else {
          api.lane.query = 'error';
          if (report) await driveReport(s, report);
          const nav = s.win.navigator;
          Object.defineProperty(nav ?? {}, 'onLine', { value: false, configurable: true });
          s.win.dispatchEvent(new s.win.Event('offline'));
          await settle(s.win);
          const banner = Array.from(s.doc.querySelectorAll('#offline, .c2c-offline, [data-offline], [role="status"]')).find((el) => /offline/i.test(text(el)) && both(s, el));
          let blocked = false;
          if (form) {
            await s.go(`#/form/${encodeURIComponent(form.name)}`);
            const submit = s.doc.querySelector('#main form button[type="submit"], #main form input[type="submit"]');
            blocked = !!submit && (submit.hasAttribute('disabled') || submit.getAttribute('aria-disabled') === 'true' || submit.getAttribute('aria-busy') === 'true');
            if (!blocked) {
              fillForm(s, form);
              const el = s.doc.querySelector('#main form');
              const before = api.matching('/submit').length;
              if (el) fire(s.win, el, 'submit');
              await settle(s.win);
              blocked = api.matching('/submit').length === before;
            }
          }
          let refetched = true;
          if (report) {
            await driveReport(s, report);
            const before = api.matching(`/reports/${report.name}`).length;
            api.lane.query = 'ok';
            Object.defineProperty(nav ?? {}, 'onLine', { value: true, configurable: true });
            s.win.dispatchEvent(new s.win.Event('online'));
            await settle(s.win);
            const calls = api.matching(`/reports/${report.name}`).length;
            refetched = calls === before + 1 && !Array.from(s.doc.querySelectorAll('#offline, .c2c-offline')).some((el) => /offline/i.test(text(el)) && !el.hasAttribute('hidden'));
          }
          run.add('offline', report?.name ?? form!.name, !!banner && blocked && refetched, `banner ${banner ? 'shown' : 'missing'}, submit ${blocked ? 'blocked' : 'still live'}, back-online ${refetched ? 're-fetched once' : 'no single re-fetch'}`);
        }
      }
    } finally {
      s.close();
    }
  }

  // ---- session B: slow query — the loading state at both widths
  if (run.wants('loading')) {
    const api = createFakeApi(sample, allRows);
    api.lane.query = 'slow';
    const s = await openSession(bundle, loaded, api.fetch, sample, widthCss);
    try {
      const report = await firstQueryingReport(s, api, tableReports);
      if (!report) run.skip('loading', 'app', 'no report that queries');
      else {
        const state = mainOf(s.doc).querySelector('[data-state="loading"]');
        const marked = !!state && (state.getAttribute('role') === 'status' || state.getAttribute('aria-busy') === 'true' || !!state.closest('[aria-busy="true"]'));
        const skeleton = !!mainOf(s.doc).querySelector('[data-skeleton], .skeleton, [class*="skeleton" i]');
        const ok = !!state && both(s, state) && marked && skeleton;
        run.add('loading', report.name, ok, `${!state ? 'no loading state' : `state shown${marked ? ' marked busy' : ' NOT marked busy'}${skeleton ? ' with a skeleton' : ', no skeleton'}`}`);
        api.release('query');
        await settle(s.win);
      }
    } finally {
      s.close();
    }
  }

  // ---- session C: empty query — the empty state and its action
  if (run.wants('empty')) {
    const api = createFakeApi(sample, allRows);
    api.lane.query = 'empty';
    const s = await openSession(bundle, loaded, api.fetch, sample, widthCss);
    try {
      const report = await firstQueryingReport(s, api, tableReports);
      if (!report) run.skip('empty', 'app', 'no report that queries');
      else {
        const state = mainOf(s.doc).querySelector('[data-state="empty"]');
        const heading = state?.querySelector('h1, h2, h3, h4, [role="heading"], p');
        const action = report.form ? state?.querySelector(`a[href="#/form/${encodeURIComponent(report.form)}"], a[href*="form"]`) : undefined;
        const needAction = !!report.form;
        const ok = !!state && both(s, state) && !!heading && (!needAction || !!action);
        run.add('empty', report.name, ok, `${!state ? 'no empty state' : `${heading ? `heading "${text(heading).slice(0, 50)}"` : 'no heading'}${needAction ? (action ? ', action to the form' : ', NO action to the form') : ''}`}`);
      }
    } finally {
      s.close();
    }
  }

  // ---- session D: error query — alert + retry, one retry re-fetches once
  if (run.wants('error')) {
    const api = createFakeApi(sample, allRows);
    api.lane.query = 'error';
    const s = await openSession(bundle, loaded, api.fetch, sample, widthCss);
    try {
      const report = await firstQueryingReport(s, api, tableReports);
      if (!report) run.skip('error', 'app', 'no report that queries');
      else {
        const alert = mainOf(s.doc).querySelector('[role="alert"], [data-state="error"]');
        const retry = alert ? Array.from(alert.querySelectorAll('button, a')).find((b) => /retry|try again/i.test(text(b))) : undefined;
        let oneMore = false;
        if (retry) {
          api.lane.query = 'ok';
          const before = api.matching(`/reports/${report.name}`).length;
          click(s.win, retry);
          await settle(s.win);
          oneMore = api.matching(`/reports/${report.name}`).length === before + 1;
        }
        run.add('error', report.name, !!alert && both(s, alert) && !!retry && oneMore, `${!alert ? 'no error alert' : `${retry ? 'retry offered' : 'no retry'}${retry ? (oneMore ? ', one re-fetch' : `, ${api.matching(`/reports/${report.name}`).length} calls after retry`) : ''}`}`);
      }
    } finally {
      s.close();
    }
  }

  // ---- session E: 401 — the session-expired prompt (tracked separately)
  if (run.wants('session-expired')) {
    const api = createFakeApi(sample, allRows);
    api.lane.query = 'unauth';
    api.lane.submit = 'unauth';
    api.lane.record = 'unauth';
    const s = await openSession(bundle, loaded, api.fetch, sample, widthCss);
    try {
      const report = await firstQueryingReport(s, api, tableReports);
      if (report) await driveReport(s, report);
      const main = mainOf(s.doc);
      const prompt = Array.from(main.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-state], .c2c-card, p')).find((el) => /sign in|session|log ?in/i.test(text(el)));
      const raw = /unauthorized|401/i.test(s.doc.body.textContent ?? '');
      // A draft offer counts only if the page offers to keep entries.
      const keep = /kept|draft|restore|unsent/i.test(s.doc.body.textContent ?? '');
      run.add('session-expired', report?.name ?? 'app', !!prompt && !raw, `${prompt ? `prompt "${text(prompt).slice(0, 60)}"` : 'no re-auth prompt'}${raw ? ', raw 401 text leaks' : ''}${keep ? ', entries kept' : ', no draft saved'} — owned by c2c-sec-client-auth-react + ux-offline-session`, 'ux-offline-session');
    } finally {
      s.close();
    }
  }

  // ---- session F: 403 — the denied screen (heading + way home, no dead retry)
  if (run.wants('denied')) {
    const api = createFakeApi(sample, allRows);
    api.lane.query = 'denied';
    const s = await openSession(bundle, loaded, api.fetch, sample, widthCss);
    try {
      const report = await firstQueryingReport(s, api, tableReports);
      if (!report) run.skip('denied', 'app', 'no report that queries');
      else {
        const main = mainOf(s.doc);
        const heading = main.querySelector('h1, h2') ?? main.querySelector('[data-access-status], [data-state="denied"]');
        const retry = Array.from(main.querySelectorAll('button')).find((b) => /retry|try again/i.test(text(b)));
        const home = homeLink(main);
        const generic = /could not be loaded|unavailable/i.test(s.doc.body.textContent ?? '');
        run.add('denied', report.name, !!heading && !!home && !retry && !generic, `${!heading ? 'no denied screen' : `screen "${text(heading).slice(0, 50)}"`}${home ? '' : ', no way home'}${retry ? ', dead Retry offered' : ''}${generic ? ', shows a generic error' : ''}`);
      }
    } finally {
      s.close();
    }
  }

  // ---- session G: crash (React only) — a rejected lazy chunk inside the boundary
  if (run.wants('crash')) {
    if (opts.ui !== 'react') {
      run.verdicts.push({ state: 'crash', scope: 'app', status: 'waived', issue: 'n/a: the string-render runtime has no unmount-all failure mode', evidence: 'a thrown handler leaves the previous DOM' });
    } else {
      // Rewrite one dynamic import in the module table into a rejection, as a
      // redeploy-purged chunk would fail in the browser.
      let patched: UiBundle | undefined;
      let which = '';
      for (const [key, source] of Object.entries(bundle.modules)) {
        const m = /import\(\s*(["'`])(\.[^"'`]+)\1\s*\)/.exec(source);
        if (m && bundle.modules[key] !== undefined) {
          patched = { ...bundle, modules: { ...bundle.modules, [key]: source.replace(m[0], `Promise.reject(new Error("c2c-states: simulated chunk failure"))`) } };
          which = `${key} → ${m[2]}`;
          break;
        }
      }
      if (!patched) run.skip('crash', 'app', 'no lazy chunk to reject');
      else {
        const api = createFakeApi(sample, allRows);
        const s = await openSession(bundle, loadRuntime(patched), api.fetch, sample, widthCss);
        try {
          // Visit every screen until the lazy chunk is demanded.
          let card: Element | null = null;
          for (const item of exp.sections.flatMap((sec) => sec.items)) {
            await s.go(`#/${item.kind}/${encodeURIComponent(item.name)}`);
            await settle(s.win, 4);
            card = s.doc.querySelector('[data-screen-error], .c2c-render-error') ?? Array.from(s.doc.querySelectorAll('[role="alert"]')).find((el) => /could not be shown|failed to load|went wrong/i.test(text(el))) ?? null;
            if (card) break;
          }
          const nav = s.doc.getElementById('nav') ?? s.doc.querySelector('nav, #tabbar');
          run.add('crash', which, !!card && !!nav, card ? `recovery card "${text(card).slice(0, 60)}", nav ${nav ? 'still mounted' : 'LOST'}` : 'no screen demanded the rejected chunk, or no recovery card');
        } finally {
          s.close();
        }
      }
    }
  }

  // ---- reduced motion: the media query stubbed to reduce kills motion
  if (run.wants('reduced-motion')) {
    const api = createFakeApi(sample, allRows);
    const s = await openSession(bundle, loaded, api.fetch, sample, widthCss, (win) => {
      win.matchMedia = (query: string) => ({
        matches: /reduce/.test(query),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      });
    });
    try {
      const firstItem = exp.sections.flatMap((sec) => sec.items)[0];
      if (firstItem) await s.go(`#/${firstItem.kind}/${encodeURIComponent(firstItem.name)}`);
      const moved = Array.from(s.doc.querySelectorAll('[style]')).filter((el) => {
        const style = el.getAttribute('style') ?? '';
        return /transform\s*:\s*(?!none\b)/.test(style) || /animation\s*:/.test(style);
      });
      // The stylesheet must carry a reduce rule that kills animation AND transition.
      const reduceBlocks = [...bundle.css.matchAll(/@media[^{]*prefers-reduced-motion\s*:\s*reduce[^}]*\{([\s\S]*?)\}\s*\}/g)].map((m) => m[1] ?? '');
      const kills = reduceBlocks.some((block) => /animation\s*:\s*none/.test(block) && /transition\s*:\s*none/.test(block)) || reduceBlocks.some((block) => /(animation|transition)\s*:\s*none[^}]*(animation|transition)\s*:\s*none/.test(block));
      run.add('reduced-motion', 'app', moved.length === 0 && kills, `${moved.length} element(s) carry inline transform/animation under reduce; stylesheet reduce rule ${kills ? 'kills animation and transition' : 'does NOT kill both'}`);
    } finally {
      s.close();
    }
  }

  return run.verdicts;
}
