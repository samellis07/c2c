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
  'ux-pagination-overflow',
]);

/** The issue owning each state row. */
export const OWNER: Record<string, string> = {
  loading: 'ux-loading-empty-not-found',
  empty: 'ux-loading-empty-not-found',
  'empty-filtered': 'ux-loading-empty-not-found',
  error: '',
  // The field-level invalid state (marker text, aria-invalid, focus moved to
  // the first invalid control on submit) shipped; only the toast/
  // server-field-error part of this issue remains open.
  invalid: '',
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
  pagination: 'ux-pagination-overflow',
  disabled: 'ux-pagination-overflow',
  'long-text': 'ux-pagination-overflow',
};

/** Where focus belongs in a field: a control a user can tab to, not a hidden mirror. */
const FOCUS_TARGET = 'input:not([type="hidden"]):not([hidden]):not([aria-hidden="true"]), textarea, select, button:not([disabled]), [role="radio"][tabindex="0"]';

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

/**
 * Set a control's value the way a user's edit does: through the prototype's
 * setter, so a framework that tracks the last value it rendered (React) sees
 * the change on the next input event.
 */
function setValue(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  const proto = Object.getPrototypeOf(control) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(control, value);
  else control.value = value;
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

/** A value the control's own type accepts, so a client format check does not refuse the fill. */
function sampleValue(control: HTMLInputElement | HTMLTextAreaElement): string {
  const widget = (control.closest('[data-widget]')?.getAttribute('data-widget') ?? '').toLowerCase();
  if (/^(number|decimal|percentage|percent|currency|money)$/.test(widget)) return '12';
  if (widget === 'email') return 'gate@example.com';
  if (widget === 'url') return 'https://example.com';
  const type = (control.getAttribute('type') ?? 'text').toLowerCase();
  const mode = (control.getAttribute('inputmode') ?? '').toLowerCase();
  if (type === 'email') return 'gate@example.com';
  if (type === 'number' || mode === 'numeric' || mode === 'decimal') return '12';
  if (type === 'date') return '2024-01-15';
  if (type === 'datetime-local') return '2024-01-15T10:30';
  if (type === 'time') return '10:30';
  if (type === 'tel') return '5551234567';
  if (type === 'url') return 'https://example.com';
  if (type === 'month') return '2024-01';
  return 'gate';
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
        // A click, as a user's tick: it flips the box and fires the click and
        // change events a framework's onChange listens for.
        cb.click();
      }
      continue;
    }
    for (const control of Array.from(box.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea')) as HTMLInputElement[]) {
      setValue(control, sampleValue(control));
      fire(s.win, control, 'input');
      fire(s.win, control, 'change');
    }
    const radio = box.querySelector('input[type="radio"]') as HTMLInputElement | null;
    if (radio && !box.querySelector('input[type="radio"]:checked')) radio.click();
    const select = box.querySelector('select') as HTMLSelectElement | null;
    if (select) {
      const option = Array.from(select.options).find((o) => o.value !== '');
      if (option && !select.value) {
        setValue(select, option.value);
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
 * The full 20-row run against one built bundle. `exp` is the scorer's
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

      // Re-navigating to the hash the session already shows is a no-op, so a
      // form left dirty by an earlier row would be judged instead of a fresh
      // render; hop away first.
      const goFresh = async (hash: string): Promise<void> => {
        if (s.win.location.hash === hash) await s.go('#/');
        await s.go(hash);
      };

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
            setValue(input, 'zzz-no-such-row');
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
                // A dialog may animate out before it unmounts; give it a moment, not a tick count.
                await waitGone(s, dialog, 1500);
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
          await goFresh(`#/form/${encodeURIComponent(form.name)}`);
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
        if (!form || !form.fields.filter((x) => x.required).every((x) => FILLABLE.has(x.kind))) run.skip('submitting', 'app', 'no form whose mandatory fields a script can fill (every form needs a file, subform or composite)');
        else {
          await goFresh(`#/form/${encodeURIComponent(form.name)}`);
          const el = s.doc.querySelector('#main form') as HTMLFormElement | null;
          if (!el) run.add('submitting', form.name, false, 'no form rendered');
          else {
            const postsBefore = api.matching('/submit').length;
            api.lane.submit = 'slow';
            fillForm(s, form);
            fire(s.win, el, 'submit');
            fire(s.win, el, 'submit');
            await settle(s.win, 4);
            const submit = el.querySelector('button[type="submit"], input[type="submit"]');
            const busy = !!submit && (submit.getAttribute('aria-busy') === 'true' || submit.hasAttribute('disabled') || submit.getAttribute('aria-disabled') === 'true');
            api.release('submit');
            await settle(s.win);
            const posts = api.matching('/submit').length - postsBefore;
            api.lane.submit = 'ok';
            const refused = Array.from(el.querySelectorAll('[data-error-for]')).find((m) => text(m) !== '');
            if (posts === 0) run.skip('submitting', form.name, `the filled form never posted${refused ? ` (${refused.getAttribute('data-error-for')} "${text(refused).slice(0, 40)}" refused client-side)` : ''}: this script cannot synthesize values it accepts`);
            else run.add('submitting', form.name, busy && posts === 1, `busy ${busy ? 'marked' : 'unmarked'}; two rapid submits → ${posts} POST(s)${posts === 0 && refused ? `; the filled form was refused client-side: ${refused.getAttribute('data-error-for')} "${text(refused).slice(0, 40)}"` : ''}`);
          }
        }
      }

      // invalid (client): required field → error, aria-invalid, focus.
      if (run.wants('invalid')) {
        const form = pickForm(exp);
        if (!form || !form.fields.some((f) => f.required)) run.skip('invalid', 'app', 'no form with a mandatory field');
        else {
          await goFresh(`#/form/${encodeURIComponent(form.name)}`);
          const el = s.doc.querySelector('#main form');
          if (!el) run.add('invalid', form.name, false, 'no form rendered');
          else {
            fire(s.win, el, 'submit');
            await settle(s.win);
            const first = form.fields.find((f) => f.required)!;
            // querySelector returns the first match in document order, which
            // can be an earlier field's empty slot; prefer the submitted
            // field's own slot, else any slot with text.
            // The first invalid field in page order is where focus belongs.
            const firstBox = Array.from(el.querySelectorAll('[data-field]')).find((b) => text(b.querySelector('[data-error-for]')) !== '');
            const firstName = firstBox?.getAttribute('data-field') ?? first.name;
            const own = el.querySelector(`[data-error-for="${firstName}"]`);
            const marker = own && text(own) !== '' ? own : Array.from(el.querySelectorAll('[data-error-for], .error, [role="alert"]')).find((m) => text(m) !== '') ?? own;
            const box = el.querySelector(`[data-field="${firstName}"]`);
            const invalid = (box?.querySelector('[aria-invalid="true"]') ?? el.querySelector('[aria-invalid="true"]')) !== null;
            const control = (box ?? el).querySelector(FOCUS_TARGET) as HTMLElement | null;
            const focused = s.doc.activeElement === control || (control ? control.contains(s.doc.activeElement) : false);
            run.add('invalid', form.name, !!marker && text(marker) !== '' && invalid && focused, `marker ${marker ? `"${text(marker).slice(0, 40)}"` : 'missing'}, aria-invalid ${invalid ? 'set' : 'missing'}, focus ${focused ? 'on the field' : `not moved (on ${s.doc.activeElement?.outerHTML.slice(0, 120) ?? 'none'}, wanted <${control?.tagName.toLowerCase() ?? 'none'}>; field box ${box ? box.outerHTML.slice(0, 160) : 'missing'})`}`);
          }
        }
      }

      // server-field-error: a 400 {error, field} lands on that field with focus.
      if (run.wants('server-field-error')) {
        const form = pickForm(exp, { fillableOnly: true });
        if (!form || !form.fields.filter((x) => x.required).every((x) => FILLABLE.has(x.kind))) run.skip('server-field-error', 'app', 'no form whose mandatory fields a script can fill (every form needs a file, subform or composite)');
        else {
          api.lane.submit = 'field';
          await goFresh(`#/form/${encodeURIComponent(form.name)}`);
          const el = s.doc.querySelector('#main form');
          // A field that draws a control: a section heading or a computed field has no slot for a message.
          const drawn = (name: string): boolean => !!el?.querySelector(`[data-field="${name}"] input:not([type="hidden"]), [data-field="${name}"] select, [data-field="${name}"] textarea`);
          const target = form.fields.find((f) => !f.required && drawn(f.name)) ?? form.fields.find((f) => drawn(f.name));
          api.fieldError = { field: target?.name ?? '', message: 'Server says no' };
          if (!el || !target) run.add('server-field-error', form.name, false, 'no form or field to drive');
          else {
            const postsBefore = api.matching('/submit').length;
            fillForm(s, form);
            fire(s.win, el, 'submit');
            await settle(s.win);
            api.lane.submit = 'ok';
            const reached = api.matching('/submit').length > postsBefore;
            const marker = el.querySelector(`[data-error-for="${target.name}"]`);
            const box = el.querySelector(`[data-field="${target.name}"]`);
            const control = box?.querySelector(FOCUS_TARGET) as HTMLElement | null;
            const focused = !!control && (s.doc.activeElement === control || control.contains(s.doc.activeElement));
            if (!reached) run.skip('server-field-error', form.name, 'the filled form was refused client-side before it posted: this script cannot synthesize a value for it');
            else run.add('server-field-error', `${form.name}.${target.name}`, !!marker && text(marker) !== '' && focused, `400 {field:${target.name}} → marker ${marker ? `"${text(marker).slice(0, 40)}"` : 'missing'}, focus ${focused ? 'on the field' : 'not moved'}`);
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
            await goFresh(`#/form/${encodeURIComponent(form.name)}`);
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
      // The route table is the module with the most dynamic imports: a screen's own
      // chunk is demanded when its route opens, a field widget's only on some forms.
      const importCount = (source: string): number => (source.match(/import\(\s*(["'`])\.[^"'`]+\1\s*\)/g) ?? []).length;
      const [key, source] = Object.entries(bundle.modules).sort((x, y) => importCount(y[1]) - importCount(x[1]))[0] ?? ['', ''];
      const m = /import\(\s*(["'`])(\.[^"'`]+)\1\s*\)/.exec(source);
      if (m && bundle.modules[key] !== undefined) {
        // Every screen chunk of the route table fails, so whichever screen opens first demands one.
        patched = { ...bundle, modules: { ...bundle.modules, [key]: source.replace(/import\(\s*(["'`])(\.[^"'`]+)\1\s*\)/g, `Promise.reject(new Error("c2c-states: simulated chunk failure"))`) } };
        which = `${key} → ${m[2]}`;
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

  // ---- session H: pagination + disabled — a report with more than a page of rows
  if (run.wants('pagination') || run.wants('disabled')) {
    const base = createFakeApi(sample, allRows);
    const pageRows = (report: string, size: number, page: number): Record<string, string>[] => {
      const template = sample.get(report) ?? allRows[0] ?? { ROWID: '1' };
      const total = size * 2 + 3;
      return Array.from({ length: total }, (_, i) => ({ ...template, ROWID: String(2000 + i) })).slice(page * size, (page + 1) * size);
    };
    const queries: { report: string; page: number; size: number }[] = [];
    const paged = async (url: unknown, init: { method?: string; body?: unknown } = {}): Promise<unknown> => {
      const answer = await base.fetch(url, init);
      const path = String(url);
      const named = /\/reports\/([^/?]+)/.exec(path);
      if (!named || path.includes('/actions/') || path.includes('/delete')) return answer;
      let body: { page?: unknown; pageSize?: unknown; offset?: unknown; limit?: unknown } = {};
      try {
        body = typeof init.body === 'string' ? JSON.parse(init.body) : ((init.body as typeof body) ?? {});
      } catch {
        body = {};
      }
      const size = Number(body.pageSize ?? body.limit) || 25;
      const page = body.page !== undefined ? Number(body.page) || 0 : Math.floor((Number(body.offset) || 0) / size);
      const report = decodeURIComponent(named[1] ?? '');
      queries.push({ report, page, size });
      const data = { rows: pageRows(report, size, page) };
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(data), json: async () => data };
    };
    const s = await openSession(bundle, loaded, paged, sample, widthCss);
    try {
      const report = await firstQueryingReport(s, base, tableReports);
      if (!report) {
        if (run.wants('pagination')) run.skip('pagination', 'app', 'no report that queries');
        if (run.wants('disabled')) run.skip('disabled', 'app', 'no report that queries');
      } else {
        await s.go('#/report/__reset__');
        await driveReport(s, report);
        const control = (re: RegExp): HTMLElement | null =>
          (Array.from(mainOf(s.doc).querySelectorAll('button, a[role="button"], a[href]')).find((b) => re.test(`${b.getAttribute('aria-label') ?? ''} ${text(b)}`)) as HTMLElement | undefined) ?? null;
        const stopped = (el: HTMLElement | null): boolean => !!el && (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true');
        const next1 = control(/\bnext\b/i);
        const prev1 = control(/\b(prev|previous)\b/i);
        const prev1Stopped = stopped(prev1);
        const firstSize = queries.at(-1)?.size ?? 25;
        const q0 = queries.length;
        let advanced = false;
        let wentBack = false;
        let lastStop = false;
        if (next1 && !stopped(next1)) {
          click(s.win, next1);
          await settle(s.win);
          advanced = queries.length > q0 && queries.at(-1)!.page === 1;
          const prev2 = control(/\b(prev|previous)\b/i);
          const next2 = control(/\bnext\b/i);
          if (next2 && !stopped(next2)) {
            click(s.win, next2);
            await settle(s.win);
          }
          const lastRows = mainOf(s.doc).querySelectorAll('tbody tr, [data-row], [data-row-link]').length;
          const next3 = control(/\bnext\b/i);
          lastStop = queries.at(-1)?.page === 2 && (!next3 || stopped(next3)) && lastRows > 0 && lastRows < firstSize;
          const back = control(/\b(prev|previous)\b/i);
          if (prev2 && back && !stopped(back)) {
            click(s.win, back);
            await settle(s.win);
            wentBack = queries.at(-1)?.page === 1;
          }
        }
        if (run.wants('pagination')) {
          run.add('pagination', report.name, !!next1 && advanced && lastStop && wentBack, !next1 ? `${firstSize} rows of ${firstSize * 2 + 3} returned and no Next control` : `Next ${advanced ? 'asks page 1' : 'does not ask page 1'}; last page ${lastStop ? 'stops Next on a short page' : 'still offers Next or shows no short page'}; Previous ${wentBack ? 'goes back' : 'does not go back'}`);
        }
        if (run.wants('disabled')) {
          // End stops are disabled, not just inert; a disabled control says why (title/aria-label) when it is not a pager step.
          const firstStop = !!prev1 && prev1Stopped;
          const unexplained = Array.from(mainOf(s.doc).querySelectorAll('button[disabled], button[aria-disabled="true"]')).filter((b) => !/\b(next|prev|previous)\b/i.test(`${b.getAttribute('aria-label') ?? ''} ${text(b)}`) && !b.getAttribute('title') && !b.getAttribute('aria-describedby') && !text(b));
          run.add('disabled', report.name, firstStop && !unexplained.length, `Previous ${!prev1 ? 'missing' : firstStop ? 'disabled on the first page' : `<${prev1.tagName.toLowerCase()} "${(prev1.getAttribute('aria-label') ?? text(prev1)).slice(0, 30)}"> still enabled on the first page`}; ${unexplained.length} unlabelled disabled control(s)`);
        }
      }
    } finally {
      s.close();
    }
  }

  // ---- session I: long text — a very long cell must wrap or scroll, never push the page wider
  if (run.wants('long-text')) {
    const long = 'LongValue' + 'x'.repeat(240) + ' ' + 'word '.repeat(60).trim();
    const fields = tableReports.flatMap((r) => r.columns.map((c) => ({ r, c }))).find(({ r }) => r.columns.length > 0);
    const wide = new Map(sample);
    if (fields) wide.set(fields.r.name, { ...(sample.get(fields.r.name) ?? { ROWID: '1001' }), [fields.c.field]: long });
    const api = createFakeApi(wide, [...wide.values()]);
    const s = await openSession(bundle, loaded, api.fetch, wide, widthCss);
    try {
      const report = fields ? await firstQueryingReport(s, api, [fields.r]) : undefined;
      if (!report || !fields) run.skip('long-text', 'app', 'no report that queries');
      else {
        await s.go('#/report/__reset__');
        const main = await driveReport(s, report);
        const cell = Array.from(main.querySelectorAll('td, [data-th], .c2c-cell, [data-cell]')).find((el) => text(el).startsWith('LongValue'));
        if (!cell) run.add('long-text', report.name, false, 'the long value is not drawn in any cell');
        else {
          const kept = text(cell).includes(long.slice(0, 200)) && text(cell).replace(/\s+/g, '').includes('xxxxxxxxxxxxxxxxxxxx') && text(cell).endsWith('word');
          const verdicts: string[] = [];
          let ok = kept;
          for (const vp of ['desktop', 'phone'] as const) {
            const rules = parseCss(widthCss[vp]);
            const props = new Map<string, string>();
            const wrapped = new Map<string, string>();
            for (let el: Element | null = cell; el && el !== s.doc.body; el = el.parentElement) {
              for (const rule of rules) {
                let hit = false;
                try {
                  hit = rule.selectors.some((sel) => el!.matches(sel));
                } catch {
                  hit = false;
                }
                if (!hit) continue;
                for (const [k, v] of rule.decls) (el === cell ? props : wrapped).set(k, v.replace(/\s*!important/i, '').trim());
              }
            }
            const breaks = /^(anywhere|break-word)$/.test(props.get('overflow-wrap') ?? props.get('word-wrap') ?? '') || /^(break-all|break-word)$/.test(props.get('word-break') ?? '') || props.get('text-overflow') === 'ellipsis' || /^(hidden|auto|scroll)$/.test(props.get('overflow') ?? props.get('overflow-x') ?? '');
            // Inline children (a link, a span) carry the text in some cells.
            const inner = Array.from(cell.querySelectorAll('*')).some((child) => rules.some((rule) => rule.selectors.some((sel) => { try { return child.matches(sel) && /^(anywhere|break-word)$/.test(rule.decls.get('overflow-wrap') ?? rule.decls.get('word-break') ?? ''); } catch { return false; } })));
            const scrolls = [...wrapped.entries()].some(([k, v]) => /^overflow(-x)?$/.test(k) && /^(auto|scroll)$/.test(v));
            const fine = breaks || inner || scrolls;
            ok = ok && fine;
            verdicts.push(`${vp}: ${fine ? (breaks || inner ? 'cell wraps' : 'container scrolls') : 'no wrap and no scroll'}`);
          }
          run.add('long-text', report.name, ok, `${verdicts.join('; ')}; full text ${kept ? 'kept' : 'cut or dropped'}`);
        }
      }
    } finally {
      s.close();
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
        // An element that is not painted (visibility hidden, display none, fully transparent) is parked, not moving.
        if (/visibility\s*:\s*hidden|display\s*:\s*none|(^|;)\s*opacity\s*:\s*0\s*(;|$)/.test(style)) return false;
        return /transform\s*:\s*(?!\s|none\b)/.test(style) || /animation\s*:/.test(style);
      });
      // The stylesheet must carry a reduce rule that kills animation AND transition.
      const reduceBlocks = [...bundle.css.matchAll(/@media[^{]*prefers-reduced-motion\s*:\s*reduce[^}]*\{([\s\S]*?)\}\s*\}/g)].map((m) => m[1] ?? '');
      const kills = reduceBlocks.some((block) => /animation\s*:\s*none/.test(block) && /transition\s*:\s*none/.test(block)) || reduceBlocks.some((block) => /(animation|transition)\s*:\s*none[^}]*(animation|transition)\s*:\s*none/.test(block));
      run.add('reduced-motion', 'app', moved.length === 0 && kills, `${moved.length} element(s) carry inline transform/animation under reduce${moved[0] ? ` (first: <${moved[0].tagName.toLowerCase()} class="${(moved[0].getAttribute('class') ?? '').slice(0, 40)}" style="${(moved[0].getAttribute('style') ?? '').slice(0, 80)}">)` : ''}; stylesheet reduce rule ${kills ? 'kills animation and transition' : 'does NOT kill both'}`);
    } finally {
      s.close();
    }
  }

  return run.verdicts;
}
