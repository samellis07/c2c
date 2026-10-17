#!/usr/bin/env node
/**
 * The clients check: one offline run per app over what `c2c ui` writes,
 * covering the four client areas a business runs the converted app on —
 * desktop browsers, mobile web and the installed PWA, the offline message,
 * and accessibility — plus the Creator date, time zone and currency formats.
 *
 * Each criterion is a list of checks with a status:
 *   PASS  measured and matches.
 *   FAIL  measured and wrong (a generator bug).
 *   GAP   c2c does not measure or produce this yet; `evidence` names exactly
 *         what is missing. A GAP is never a PASS.
 *   NA    does not apply to this app (e.g. no currency field).
 * A criterion is FAIL if any check fails, else GAP if any check is a gap,
 * else PASS if any check passed, else NA. The app result rolls up the same way.
 *
 * It reuses the scorer (score.ts) and the UX-states gate (states.ts) in jsdom;
 * it starts no browser and makes no network call.
 *
 *   node dist/ui-score/src/clients.js [<app dir or .ds> ...] [--json <file>] [--md <file>]
 *
 * With no target it runs the two repo fixtures (library, kitchen-sink).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFileOrProject, type App, type Field } from '../../core/src/index.js';
import { buildUi, type OutFile } from '../../ui/src/index.js';
import { bundleFromFiles, createFakeApi, cssAtWidth, loadRuntime, openSession, parseCss, scoreUi, type UiBundle, type UiScore } from './score.js';
import { checkUiStates, type StateVerdict } from './states.js';

export type ClientStatus = 'PASS' | 'FAIL' | 'GAP' | 'NA';

export interface ClientCheck {
  id: string;
  status: ClientStatus;
  evidence: string;
}

export interface ClientCriterion {
  id: ClientCriterionId;
  title: string;
  status: ClientStatus;
  checks: ClientCheck[];
}

export type ClientCriterionId = 'browser-matrix' | 'mobile-web' | 'offline-message' | 'accessibility' | 'locale-formats';

export interface ClientsReport {
  schema: 'c2c-clients/1';
  app: string;
  ui: 'vanilla';
  status: ClientStatus;
  criteria: ClientCriterion[];
}

export const CRITERIA: Record<ClientCriterionId, string> = {
  'browser-matrix': 'Desktop browsers (Chrome, Safari, Edge, Firefox) basics',
  'mobile-web': 'Mobile web layout and installable PWA',
  'offline-message': 'Offline message',
  accessibility: 'Accessibility smoke',
  'locale-formats': 'Date, time zone and currency formats as Creator',
};

/** FAIL beats GAP beats PASS beats NA. */
export function rollup(statuses: ClientStatus[]): ClientStatus {
  if (statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('GAP')) return 'GAP';
  if (statuses.includes('PASS')) return 'PASS';
  return 'NA';
}

/**
 * Web APIs that only Chromium ships (no Safari and no Firefox release), so a
 * page that calls them breaks on two of the four desktop browsers.
 */
export const CHROMIUM_ONLY_APIS: readonly string[] = [
  'navigator.userAgentData',
  'showOpenFilePicker',
  'showSaveFilePicker',
  'showDirectoryPicker',
  'EyeDropper',
  'navigator.serial',
  'navigator.usb',
  'navigator.hid',
  'navigator.bluetooth',
];

/** Standard properties Safari still needs the -webkit- form of beside the unprefixed one. */
export const WEBKIT_PAIRED_PROPS: readonly string[] = ['user-select', 'backdrop-filter'];

const check = (id: string, ok: boolean, evidence: string): ClientCheck => ({ id, status: ok ? 'PASS' : 'FAIL', evidence });
const gap = (id: string, evidence: string): ClientCheck => ({ id, status: 'GAP', evidence });
const na = (id: string, evidence: string): ClientCheck => ({ id, status: 'NA', evidence });

function fileText(files: OutFile[], rel: string): string | undefined {
  const file = files.find((f) => f.path === `slate/${rel}`);
  if (!file) return undefined;
  return typeof file.data === 'string' ? file.data : Buffer.from(file.data).toString('utf8');
}

function slateFiles(files: OutFile[], re: RegExp): OutFile[] {
  return files.filter((f) => f.path.startsWith('slate/') && re.test(f.path.slice(6)));
}

function setting(app: App, key: string): string | undefined {
  const raw = app.settings.find((item) => item.key.toLowerCase() === key)?.value;
  return raw === undefined ? undefined : raw.trim().replace(/^"(.*)"$/, '$1');
}

function viewportMeta(html: string): string | undefined {
  return /<meta[^>]+name="viewport"[^>]+content="([^"]*)"/i.exec(html)?.[1];
}

// ---------------------------------------------------------------------------
// Criteria

export function browserMatrix(files: OutFile[], bundle: UiBundle): ClientCheck[] {
  const html = bundle.html;
  const out: ClientCheck[] = [];
  const missing = [
    /^<!doctype html>/i.test(html.trimStart()) ? '' : 'doctype',
    /<meta\s+charset="utf-8"/i.test(html) ? '' : 'charset utf-8',
    /<html[^>]*\slang="[^"]+"/i.test(html) ? '' : 'html lang',
  ].filter(Boolean);
  out.push(check('html-standards-mode', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'doctype (standards mode), utf-8 charset and html lang present'));

  const js = slateFiles(files, /\.js$/);
  const hits: string[] = [];
  for (const file of js) {
    const text = typeof file.data === 'string' ? file.data : Buffer.from(file.data).toString('utf8');
    for (const api of CHROMIUM_ONLY_APIS) if (text.includes(api)) hits.push(`${api} in ${file.path.slice(6)}`);
  }
  out.push(check('no-chromium-only-api', hits.length === 0, hits.length ? hits.join('; ') : `${js.length} scripts use none of ${CHROMIUM_ONLY_APIS.length} Chromium-only APIs`));

  const unpaired: string[] = [];
  for (const block of bundle.css.split('}')) {
    for (const prop of WEBKIT_PAIRED_PROPS) {
      const plain = new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(block);
      if (plain && !block.includes(`-webkit-${prop}`)) unpaired.push(`${prop} in "${block.slice(block.lastIndexOf('{') - 40 < 0 ? 0 : block.lastIndexOf('{') - 40, block.lastIndexOf('{')).trim()}"`);
    }
  }
  out.push(check('css-webkit-pairs', unpaired.length === 0, unpaired.length ? `no -webkit- pair for Safari: ${unpaired.join('; ')}` : `${WEBKIT_PAIRED_PROPS.join(', ')} carry their -webkit- pair wherever used`));

  // beforeinstallprompt fires only in Chromium: the install control must start hidden.
  const usesInstall = js.some((f) => String(typeof f.data === 'string' ? f.data : Buffer.from(f.data).toString('utf8')).includes('beforeinstallprompt'));
  const installTag = /<button[^>]*id="install"[^>]*>/i.exec(html)?.[0];
  if (!usesInstall && !installTag) out.push(na('install-button-feature-detected', 'no install control'));
  else out.push(check('install-button-feature-detected', !!installTag && /\shidden(\s|>|=)/.test(installTag), installTag ? `install control ${/\shidden(\s|>|=)/.test(installTag) ? 'starts hidden until beforeinstallprompt' : 'is visible before beforeinstallprompt (Safari and Firefox never fire it)'}` : 'beforeinstallprompt handled but no #install control'));

  const register = slateFiles(files, /^pwa-register\.[^/]+\.js$/)[0];
  const regText = register ? (typeof register.data === 'string' ? register.data : Buffer.from(register.data).toString('utf8')) : '';
  if (!/serviceWorker\.register\(/.test(regText)) out.push(check('service-worker-guarded', false, 'no pwa-register script registers a service worker'));
  else out.push(check('service-worker-guarded', /["']serviceWorker["']\s+in\s+/.test(regText), /["']serviceWorker["']\s+in\s+/.test(regText) ? 'register() runs only when "serviceWorker" in navigator' : 'register() called without a "serviceWorker" in navigator guard'));

  out.push(gap('js-syntax-baseline', 'c2c does not parse the shipped scripts against a browser baseline (no ECMAScript parser such as acorn in the dependency set), so syntax newer than the oldest supported Safari/Firefox is not caught'));
  out.push(gap('engines-rendered', 'c2c renders only in jsdom; it does not load the app in Chrome, Safari, Edge or Firefox engines (no browser automation by design), so engine-specific layout or script faults are not measured'));
  return out;
}

const CRITERION_FULL = (score: UiScore, vp: 'desktop' | 'phone', id: string): { ok: boolean; evidence: string } => {
  const c = score[vp].criteria.find((x) => x.id === id);
  if (!c) return { ok: false, evidence: `${vp}: no "${id}" criterion in the scorer result` };
  return { ok: c.passed === c.total && c.total > 0, evidence: `${vp} ${c.title.toLowerCase()} ${c.passed}/${c.total}${c.failures.length ? `: ${c.failures.slice(0, 3).join('; ')}` : ''}` };
};

export async function mobileWeb(app: App, files: OutFile[], bundle: UiBundle, score: UiScore): Promise<ClientCheck[]> {
  const out: ClientCheck[] = [];
  const vp = viewportMeta(bundle.html);
  out.push(check('viewport-meta', !!vp && /width\s*=\s*device-width/.test(vp) && /initial-scale\s*=\s*1(\.0)?\b/.test(vp), vp ? `viewport "${vp}"` : 'no viewport meta: phones render the desktop width zoomed out'));
  out.push(check('phone-score', score.phone.pass, `scorer phone ${score.phone.score}/10 (bar ${score.phone.pass ? 'met' : 'missed'})`));
  for (const id of ['responsive', 'navigation']) {
    const r = CRITERION_FULL(score, 'phone', id);
    out.push(check(`phone-${id}`, r.ok, r.evidence));
  }
  out.push(await mobileKeyboards(app, bundle));

  const manifestRel = /<link[^>]+rel="manifest"[^>]+href="\.\/([^"]+)"/i.exec(bundle.html)?.[1];
  const manifestText = manifestRel ? fileText(files, manifestRel) : undefined;
  if (!manifestText) out.push(check('pwa-manifest', false, manifestRel ? `manifest ${manifestRel} linked but not written` : 'no <link rel="manifest">'));
  else {
    let m: { name?: string; start_url?: string; display?: string; icons?: { src?: string; sizes?: string }[] } = {};
    try {
      m = JSON.parse(manifestText) as typeof m;
    } catch {
      m = {};
    }
    const icons = m.icons ?? [];
    const iconOk = (size: string): boolean => icons.some((i) => i.sizes === size && !!i.src && !!fileText(files, i.src.replace(/^\.\//, '')));
    const problems = [
      m.name ? '' : 'name',
      m.start_url ? '' : 'start_url',
      ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display ?? '') ? '' : `display "${m.display ?? ''}"`,
      iconOk('192x192') ? '' : '192px icon',
      iconOk('512x512') ? '' : '512px icon',
    ].filter(Boolean);
    out.push(check('pwa-manifest', problems.length === 0, problems.length ? `manifest missing or wrong: ${problems.join(', ')}` : `manifest: name, start_url, display ${m.display}, 192 and 512 icons written`));
  }
  return out;
}

const KEYBOARD: Record<string, (el: Element) => boolean> = {
  email: (el) => el.getAttribute('type') === 'email',
  phone: (el) => el.getAttribute('type') === 'tel',
  number: (el) => el.getAttribute('type') === 'number' || /^(numeric|decimal)$/.test(el.getAttribute('inputmode') ?? ''),
  decimal: (el) => el.getAttribute('type') === 'number' || /^(numeric|decimal)$/.test(el.getAttribute('inputmode') ?? ''),
  percent: (el) => el.getAttribute('type') === 'number' || /^(numeric|decimal)$/.test(el.getAttribute('inputmode') ?? ''),
  currency: (el) => el.getAttribute('type') === 'number' || /^(numeric|decimal)$/.test(el.getAttribute('inputmode') ?? ''),
};

interface ModelField {
  name: string;
  widget?: string;
  status?: string;
  currencyCode?: string;
  subfields?: ModelField[];
}
interface ModelForm {
  name: string;
  fields: ModelField[];
}
interface ShippedModel {
  forms?: ModelForm[];
  dateFormat?: string;
  timeFormat?: string;
}

function shippedModel(bundle: UiBundle): ShippedModel | undefined {
  const at = bundle.model.indexOf('=');
  if (at < 0) return undefined;
  try {
    return JSON.parse(bundle.model.slice(at + 1).trim().replace(/;\s*$/, '')) as ShippedModel;
  } catch {
    return undefined;
  }
}

/** Phone keyboards: email, phone and numeric fields render the input type or inputmode that opens the right on-screen keyboard. */
async function mobileKeyboards(app: App, bundle: UiBundle): Promise<ClientCheck> {
  const model = shippedModel(bundle);
  const wanted = (model?.forms ?? []).flatMap((form) => form.fields.filter((f) => f.status !== 'todo' && f.widget && KEYBOARD[f.widget]).map((f) => ({ form: form.name, field: f })));
  if (wanted.length === 0) return na('phone-keyboards', 'no email, phone or numeric field');
  const rules = parseCss(bundle.css);
  const s = await openSession(bundle, loadRuntime(bundle), createFakeApi(new Map(), []).fetch, new Map(), { desktop: cssAtWidth(rules, 1440), phone: cssAtWidth(rules, 390) });
  const wrong: string[] = [];
  let seen = 0;
  try {
    for (const { form, field } of wanted) {
      await s.go(`#/form/${encodeURIComponent(form)}`);
      const el = s.doc.querySelector(`#main [name="${field.name}"]`);
      if (!el) continue;
      seen++;
      if (!KEYBOARD[field.widget!]!(el)) wrong.push(`${form}.${field.name} (${field.widget}: type "${el.getAttribute('type') ?? ''}", inputmode "${el.getAttribute('inputmode') ?? ''}")`);
    }
  } finally {
    s.close();
  }
  if (seen === 0) return check('phone-keyboards', false, `${wanted.length} email/phone/numeric fields, none rendered on their form`);
  return check('phone-keyboards', wrong.length === 0, wrong.length ? `wrong keyboard: ${wrong.slice(0, 5).join('; ')}` : `${seen} email/phone/numeric controls open the matching phone keyboard`);
}

function stateCheck(verdicts: StateVerdict[], state: string, id: string): ClientCheck {
  const rows = verdicts.filter((v) => v.state === state);
  if (rows.length === 0) return check(id, false, `UX-states gate returned no "${state}" row`);
  if (rows.every((v) => v.status === 'skip')) return na(id, rows.map((v) => v.evidence).join('; '));
  const bad = rows.filter((v) => v.status !== 'pass' && v.status !== 'skip');
  return check(id, bad.length === 0, rows.map((v) => `${v.scope}: ${v.evidence}${v.issue ? ` (tracked: ${v.issue})` : ''}`).join('; '));
}

export function offlineMessage(files: OutFile[], bundle: UiBundle, verdicts: StateVerdict[]): ClientCheck[] {
  const out: ClientCheck[] = [];
  const tag = /<([a-z]+)[^>]*\sid="offline"[^>]*>([^<]*)</i.exec(bundle.html);
  out.push(check('offline-banner-markup', !!tag && /\shidden(\s|>|=)/.test(tag[0]) && /offline/i.test(tag[2] ?? ''), tag ? `#offline "${(tag[2] ?? '').trim().slice(0, 80)}"${/\shidden(\s|>|=)/.test(tag[0]) ? ', hidden while online' : ', shown while online'}` : 'no #offline element in index.html'));
  out.push(stateCheck(verdicts, 'offline', 'offline-state'));
  const sw = fileText(files, 'sw.js');
  out.push(check('service-worker-shell', !!sw && /addEventListener\(\s*["']fetch["']/.test(sw) && /addEventListener\(\s*["']install["']/.test(sw), sw ? 'sw.js precaches on install and answers fetch, so the shell and its offline message load with no network' : 'no sw.js: an offline reload shows the browser error page, not the app message'));
  return out;
}

export function accessibility(bundle: UiBundle, score: UiScore, verdicts: StateVerdict[]): ClientCheck[] {
  const out: ClientCheck[] = [];
  for (const vp of ['desktop', 'phone'] as const) {
    const r = CRITERION_FULL(score, vp, 'accessibility');
    out.push(check(`a11y-basics-${vp}`, r.ok, r.evidence));
  }
  out.push(stateCheck(verdicts, 'route-focus', 'route-focus'));
  out.push(stateCheck(verdicts, 'reduced-motion', 'reduced-motion'));
  const vp = viewportMeta(bundle.html) ?? '';
  const max = /maximum-scale\s*=\s*([\d.]+)/.exec(vp)?.[1];
  const blocked = /user-scalable\s*=\s*(no|0)/i.test(vp) || (max !== undefined && Number(max) < 2);
  out.push(check('zoom-allowed', !blocked, blocked ? `viewport "${vp}" blocks pinch zoom (WCAG 1.4.4)` : 'viewport does not block pinch zoom'));
  out.push(gap('wcag-engine', 'c2c runs no automated WCAG rule engine and measures no colour contrast offline (axe-core is MPL-2.0, outside the MIT/Apache/BSD set; jsdom computes no layout or colours), so contrast, target size and reading order are not checked'));
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A Creator date pattern (dd-MMM-yyyy, MM/dd/yyyy, ...) applied to a calendar date. */
export function creatorDate(pattern: string, y: number, m: number, d: number): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const tokens: Record<string, string> = { yyyy: String(y), yy: pad(y % 100), MMMM: MONTHS_LONG[m - 1]!, MMM: MONTHS[m - 1]!, MM: pad(m), dd: pad(d) };
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|dd/g, (t) => tokens[t]!);
}

const DATE_TYPES = new Set(['date']);
const fieldType = (f: Field): string => (f.type ?? '').toLowerCase();

async function reportDateDisplay(app: App, bundle: UiBundle, pattern: string): Promise<ClientCheck> {
  const id = 'report-date-display';
  const target = app.reports
    .map((r) => {
      const form = app.forms.find((x) => x.name === r.form);
      const col = r.columns.find((c) => c.field && form?.fields.some((f) => f.name === c.field && DATE_TYPES.has(fieldType(f))));
      return col?.field ? { report: r, field: col.field, form } : undefined;
    })
    .find(Boolean);
  if (!target) return na(id, 'no report shows a date column');
  const iso = '2026-10-17';
  const expected = creatorDate(pattern, 2026, 10, 17);
  const row: Record<string, string> = { ROWID: '1001' };
  for (const f of target.form?.fields ?? []) row[f.name] = `Sample ${f.name}`;
  row[target.field] = iso;
  const sample = new Map([[target.report.name, row]]);
  const rules = parseCss(bundle.css);
  const s = await openSession(bundle, loadRuntime(bundle), createFakeApi(sample, [row]).fetch, sample, { desktop: cssAtWidth(rules, 1440), phone: cssAtWidth(rules, 390) });
  try {
    await s.go(`#/report/${encodeURIComponent(target.report.name)}`);
    const body = s.doc.querySelector('#main tbody, #main [data-row]')?.closest('table, [data-rows], #main') ?? s.doc.getElementById('main');
    const text = (body?.textContent ?? '').replace(/\s+/g, ' ');
    if (!text.includes(iso) && !text.includes(expected)) return check(id, false, `report ${target.report.name}: the ${target.field} value did not render`);
    return check(id, text.includes(expected) && !text.includes(iso), `report ${target.report.name}.${target.field}: stored ${iso} renders as "${text.includes(expected) ? expected : iso}"; Creator shows "${expected}" (date format ${pattern})`);
  } finally {
    s.close();
  }
}

export async function localeFormats(app: App, files: OutFile[], bundle: UiBundle): Promise<ClientCheck[]> {
  const out: ClientCheck[] = [];
  const model = shippedModel(bundle);
  const dateSetting = setting(app, 'date format');
  const pattern = dateSetting ?? 'dd-MMM-yyyy';
  const shipped = model?.dateFormat ?? 'dd-MMM-yyyy';
  out.push(check('date-format', shipped === pattern, `app date format ${dateSetting ? `"${dateSetting}"` : 'unset (Creator default dd-MMM-yyyy)'}; shipped model "${model?.dateFormat ?? '(none, runtime default dd-MMM-yyyy)'}"`));
  out.push(await reportDateDisplay(app, bundle, pattern));

  const zone = setting(app, 'time zone');
  const config = fileText(files, 'c2c-config.js') ?? '';
  const shippedZone = /C2C_APP_TIMEZONE\s*=\s*"([^"]*)"/.exec(config)?.[1];
  if (!zone) out.push(gap('time-zone', `the .ds sets no app time zone; Creator then uses the account zone, which the export does not carry, so c2c cannot reproduce it${shippedZone ? ` (shipped "${shippedZone}")` : ''}`));
  else out.push(check('time-zone', shippedZone === zone, `app time zone "${zone}"; slate/c2c-config.js C2C_APP_TIMEZONE ${shippedZone === undefined ? 'unset' : `"${shippedZone}"`}`));

  const timeFormat = setting(app, 'time format');
  if (!timeFormat) out.push(na('time-format', 'the .ds sets no time format'));
  else if (model && 'timeFormat' in model) out.push(check('time-format', model.timeFormat === timeFormat, `app time format "${timeFormat}"; shipped "${model.timeFormat ?? ''}"`));
  else out.push(gap('time-format', `the app time format "${timeFormat}" is not carried into the client model; time and date-time values show in the browser locale's clock, not Creator's`));

  const currencyFields: { form: string; field: Field }[] = [];
  const appCurrency = setting(app, 'currency')?.toUpperCase();
  const walk = (form: string, fields: Field[]): void => {
    for (const f of fields) {
      const t = (f.type ?? '').trim();
      if (/^[A-Z]{3}$/.test(t) || t.toLowerCase() === 'currency') currencyFields.push({ form, field: f });
      walk(form, f.subfields);
    }
  };
  for (const form of app.forms) walk(form.name, form.fields);
  if (currencyFields.length === 0) out.push(na('currency-code', 'no currency field'));
  else {
    const byName = new Map<string, ModelField>();
    const index = (form: string, fields: ModelField[]): void => {
      for (const f of fields) {
        byName.set(`${form}.${f.name}`, f);
        if (f.subfields) index(form, f.subfields);
      }
    };
    for (const form of model?.forms ?? []) index(form.name, form.fields);
    const wrong: string[] = [];
    for (const { form, field } of currencyFields) {
      const t = (field.type ?? '').trim();
      const want = /^[A-Z]{3}$/.test(t) ? t : appCurrency;
      const got = byName.get(`${form}.${field.name}`);
      if (!got) continue;
      if (got.currencyCode !== want) wrong.push(`${form}.${field.name}: Creator ${want ?? '(no code)'}, shipped ${got.currencyCode ?? '(none)'}`);
    }
    out.push(check('currency-code', wrong.length === 0, wrong.length ? wrong.join('; ') : `${currencyFields.length} currency fields keep their Creator currency code`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run

export async function checkClients(app: App, files: OutFile[]): Promise<ClientsReport> {
  const bundle = bundleFromFiles(files);
  const score = await scoreUi(app, bundle, { ui: 'vanilla' });
  const verdicts = await checkUiStates(app, bundle, { ui: 'vanilla', only: new Set(['offline', 'route-focus', 'reduced-motion']) });
  const lists: Record<ClientCriterionId, ClientCheck[]> = {
    'browser-matrix': browserMatrix(files, bundle),
    'mobile-web': await mobileWeb(app, files, bundle, score),
    'offline-message': offlineMessage(files, bundle, verdicts),
    accessibility: accessibility(bundle, score, verdicts),
    'locale-formats': await localeFormats(app, files, bundle),
  };
  const criteria = (Object.keys(CRITERIA) as ClientCriterionId[]).map((id) => ({ id, title: CRITERIA[id], status: rollup(lists[id].map((c) => c.status)), checks: lists[id] }));
  return { schema: 'c2c-clients/1', app: app.name ?? '', ui: 'vanilla', status: rollup(criteria.map((c) => c.status)), criteria };
}

export async function checkClientsTarget(target: string): Promise<ClientsReport> {
  const ir = parseFileOrProject(target).ir;
  return checkClients(ir, buildUi(ir).files);
}

/** A markdown table cell: backslashes, then pipes escaped; line breaks folded to spaces. */
const cell = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export function clientsMarkdown(reports: ClientsReport[]): string {
  const lines: string[] = ['# Clients check', '', `| app | ${(Object.keys(CRITERIA) as ClientCriterionId[]).join(' | ')} | result |`, `| --- | ${Object.keys(CRITERIA).map(() => '---').join(' | ')} | --- |`];
  for (const r of reports) lines.push(`| ${r.app} | ${r.criteria.map((c) => c.status).join(' | ')} | ${r.status} |`);
  for (const r of reports) {
    lines.push('', `## ${r.app}: ${r.status}`);
    for (const c of r.criteria) {
      lines.push('', `### ${c.title}: ${c.status}`, '', '| check | status | evidence |', '| --- | --- | --- |');
      for (const k of c.checks) lines.push(`| ${k.id} | ${k.status} | ${cell(k.evidence)} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export const DEFAULT_TARGETS: readonly string[] = ['fixtures/redistributable/library-application-system', 'fixtures/synthetic/kitchen-sink'];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const targets = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
  const reports: ClientsReport[] = [];
  for (const target of targets.length ? targets : DEFAULT_TARGETS) reports.push(await checkClientsTarget(target));
  const write = (path: string | undefined, body: string): void => {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  write(flag('--json'), `${JSON.stringify({ schema: 'c2c-clients-run/1', reports }, null, 2)}\n`);
  const md = clientsMarkdown(reports);
  write(flag('--md'), md);
  process.stdout.write(md.split('\n').slice(0, reports.length + 4).join('\n') + '\n');
  process.exitCode = reports.some((r) => r.status === 'FAIL') ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    process.stderr.write(`clients: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
  });
}
