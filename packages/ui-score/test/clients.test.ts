/**
 * The clients check is non-vacuous: on the two repo fixtures each criterion
 * reports what the current bundle does, a GAP never rolls up to PASS, and
 * breaking the bundle for one criterion turns that criterion FAIL.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFileOrProject, type App } from '../../core/src/index.js';
import { buildUi, type OutFile } from '../../ui/src/index.js';
import {
  accessibility,
  browserMatrix,
  checkClients,
  clientsMarkdown,
  creatorDate,
  localeFormats,
  mobileWeb,
  offlineMessage,
  rollup,
  type ClientCheck,
  type ClientsReport,
} from '../src/clients.js';
import { bundleFromFiles, scoreUi, type UiScore } from '../src/score.js';
import { checkUiStates, type StateVerdict } from '../src/states.js';

const LIBRARY = 'fixtures/redistributable/library-application-system';
const KITCHEN = 'fixtures/synthetic/kitchen-sink';

interface Built {
  app: App;
  files: OutFile[];
}
const cache = new Map<string, Built>();
function built(target: string): Built {
  let hit = cache.get(target);
  if (!hit) {
    const app = parseFileOrProject(target).ir;
    hit = { app, files: buildUi(app).files };
    cache.set(target, hit);
  }
  return hit;
}

const text = (f: OutFile): string => (typeof f.data === 'string' ? f.data : f.data.toString('utf8'));

/** A copy of `files` with the first file whose slate path matches `re` rewritten (or dropped when `edit` returns undefined). */
function mutate(files: OutFile[], re: RegExp, edit: (body: string) => string | undefined): OutFile[] {
  const at = files.findIndex((f) => f.path.startsWith('slate/') && re.test(f.path.slice(6)));
  assert.ok(at >= 0, `no slate file matches ${re}`);
  const body = edit(text(files[at]!));
  const out = files.slice();
  if (body === undefined) out.splice(at, 1);
  else out[at] = { path: files[at]!.path, data: body };
  return out;
}

const byId = (checks: ClientCheck[], id: string): ClientCheck => {
  const hit = checks.find((c) => c.id === id);
  assert.ok(hit, `no check ${id}`);
  return hit;
};

const statuses = (r: ClientsReport): Record<string, string> => Object.fromEntries(r.criteria.map((c) => [c.id, c.status]));

let libraryReport: ClientsReport | undefined;
async function library(): Promise<ClientsReport> {
  libraryReport ??= await checkClients(built(LIBRARY).app, built(LIBRARY).files);
  return libraryReport;
}

test('rollup: FAIL beats GAP beats PASS beats NA, and a GAP is never a PASS', () => {
  assert.equal(rollup(['PASS', 'GAP', 'PASS']), 'GAP');
  assert.equal(rollup(['PASS', 'GAP', 'FAIL']), 'FAIL');
  assert.equal(rollup(['NA', 'PASS']), 'PASS');
  assert.equal(rollup(['NA', 'NA']), 'NA');
  assert.equal(rollup([]), 'NA');
});

test('library: each criterion reports what the current bundle does', async () => {
  const r = await library();
  assert.equal(r.schema, 'c2c-clients/1');
  assert.deepEqual(statuses(r), {
    'browser-matrix': 'GAP',
    'mobile-web': 'PASS',
    'offline-message': 'FAIL',
    accessibility: 'FAIL',
    'locale-formats': 'FAIL',
  });
  assert.equal(r.status, 'FAIL');
  for (const c of r.criteria) for (const k of c.checks) assert.ok(k.evidence.length > 20, `${c.id}/${k.id} has no evidence`);
  const all = r.criteria.flatMap((c) => c.checks);
  // The measured gaps: shipped dates paint as stored, the time format is not read.
  assert.equal(byId(all, 'report-date-display').status, 'FAIL');
  assert.match(byId(all, 'report-date-display').evidence, /17-Oct-2026/);
  assert.equal(byId(all, 'time-format').status, 'GAP');
  assert.equal(byId(all, 'time-zone').status, 'PASS');
  assert.equal(byId(all, 'date-format').status, 'PASS');
  // States-gate rows carry the issue that owns them.
  assert.match(byId(all, 'offline-state').evidence, /tracked: ux-offline-session/);
  assert.equal(byId(all, 'offline-banner-markup').status, 'PASS');
  assert.equal(byId(all, 'phone-keyboards').status, 'PASS');
});

test('kitchen-sink: currency fields keep their Creator code, and the run is deterministic', async () => {
  const { app, files } = built(KITCHEN);
  const a = await checkClients(app, files);
  const b = await checkClients(app, files);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(clientsMarkdown([a]), clientsMarkdown([b]));
  const all = a.criteria.flatMap((c) => c.checks);
  assert.equal(byId(all, 'currency-code').status, 'PASS');
  assert.match(byId(all, 'currency-code').evidence, /currency fields keep/);
});

test('browser matrix: each broken basic fails its check', () => {
  const { files } = built(LIBRARY);
  const run = (fs: OutFile[]): ClientCheck[] => browserMatrix(fs, bundleFromFiles(fs));
  const base = run(files);
  for (const id of ['html-standards-mode', 'no-chromium-only-api', 'css-webkit-pairs', 'install-button-feature-detected', 'service-worker-guarded']) assert.equal(byId(base, id).status, 'PASS', id);
  assert.equal(byId(base, 'engines-rendered').status, 'GAP');
  assert.equal(byId(base, 'js-syntax-baseline').status, 'GAP');

  assert.equal(byId(run(mutate(files, /^index\.html$/, (h) => h.replace(/<!doctype html>/i, ''))), 'html-standards-mode').status, 'FAIL');
  assert.equal(byId(run(mutate(files, /^index\.html$/, (h) => h.replace(/<html lang="[^"]*"/, '<html'))), 'html-standards-mode').status, 'FAIL');
  const uad = run(mutate(files, /^pwa-register\.[^/]+\.js$/, (s) => `${s}\nconst brands = window.navigator.userAgentData;\n`));
  assert.equal(byId(uad, 'no-chromium-only-api').status, 'FAIL');
  assert.match(byId(uad, 'no-chromium-only-api').evidence, /navigator\.userAgentData/);
  assert.equal(byId(run(mutate(files, /\.css$/, (c) => `${c}\n.c2c-probe { user-select: none; }\n`)), 'css-webkit-pairs').status, 'FAIL');
  assert.equal(byId(run(mutate(files, /\.css$/, (c) => `${c}\n.c2c-probe { -webkit-user-select: none; user-select: none; }\n`)), 'css-webkit-pairs').status, 'PASS');
  assert.equal(byId(run(mutate(files, /^index\.html$/, (h) => h.replace(/(<button id="install") hidden/, '$1'))), 'install-button-feature-detected').status, 'FAIL');
  assert.equal(byId(run(mutate(files, /^pwa-register\.[^/]+\.js$/, (s) => s.replace(/"serviceWorker" in window\.navigator/, 'true'))), 'service-worker-guarded').status, 'FAIL');
});

test('mobile web: a missing viewport or PWA icon fails, end to end through checkClients', async () => {
  const { app, files } = built(LIBRARY);
  const base = await library();
  assert.equal(statuses(base)['mobile-web'], 'PASS');
  const noViewport = mutate(files, /^index\.html$/, (h) => h.replace(/<meta name="viewport"[^>]*>/, ''));
  const r = await checkClients(app, noViewport);
  assert.equal(statuses(r)['mobile-web'], 'FAIL');
  assert.equal(byId(r.criteria.flatMap((c) => c.checks), 'viewport-meta').status, 'FAIL');

  const score: UiScore = await scoreUi(app, bundleFromFiles(files), { ui: 'vanilla' });
  const noIcon = files.filter((f) => !/^slate\/icons\/icon-512\./.test(f.path));
  const checks = await mobileWeb(app, noIcon, bundleFromFiles(noIcon), score);
  assert.equal(byId(checks, 'pwa-manifest').status, 'FAIL');
  assert.match(byId(checks, 'pwa-manifest').evidence, /512px icon/);
});

test('offline message: no banner or no service worker fails', async () => {
  const { app, files } = built(LIBRARY);
  const verdicts: StateVerdict[] = await checkUiStates(app, bundleFromFiles(files), { ui: 'vanilla', only: new Set(['offline']) });
  const noBanner = mutate(files, /^index\.html$/, (h) => h.replace(/<p id="offline"[^>]*>[^<]*<\/p>/, ''));
  assert.equal(byId(offlineMessage(noBanner, bundleFromFiles(noBanner), verdicts), 'offline-banner-markup').status, 'FAIL');
  const shownBanner = mutate(files, /^index\.html$/, (h) => h.replace(/<p id="offline" hidden>/, '<p id="offline">'));
  assert.equal(byId(offlineMessage(shownBanner, bundleFromFiles(shownBanner), verdicts), 'offline-banner-markup').status, 'FAIL');
  const noSw = mutate(files, /^sw\.js$/, () => undefined);
  assert.equal(byId(offlineMessage(noSw, bundleFromFiles(noSw), verdicts), 'service-worker-shell').status, 'FAIL');
  // A passing states row passes the check; a missing row fails it.
  const passing = verdicts.map((v) => ({ ...v, status: 'pass' as const }));
  assert.equal(byId(offlineMessage(files, bundleFromFiles(files), passing), 'offline-state').status, 'PASS');
  assert.equal(byId(offlineMessage(files, bundleFromFiles(files), []), 'offline-state').status, 'FAIL');
});

test('accessibility: blocking zoom fails; the WCAG engine stays a GAP', async () => {
  const { app, files } = built(LIBRARY);
  const bundle = bundleFromFiles(files);
  const score = await scoreUi(app, bundle, { ui: 'vanilla' });
  const base = accessibility(bundle, score, []);
  assert.equal(byId(base, 'zoom-allowed').status, 'PASS');
  assert.equal(byId(base, 'a11y-basics-desktop').status, 'PASS');
  assert.equal(byId(base, 'wcag-engine').status, 'GAP');
  for (const content of ['width=device-width, initial-scale=1, user-scalable=no', 'width=device-width, initial-scale=1, maximum-scale=1']) {
    const locked = mutate(files, /^index\.html$/, (h) => h.replace(/(<meta name="viewport" content=")[^"]*"/, `$1${content}"`));
    assert.equal(byId(accessibility(bundleFromFiles(locked), score, []), 'zoom-allowed').status, 'FAIL', content);
  }
  const broken: UiScore = { ...score, phone: { ...score.phone, criteria: score.phone.criteria.map((c) => (c.id === 'accessibility' ? { ...c, passed: c.total - 1 } : c)) } };
  assert.equal(byId(accessibility(bundle, broken, []), 'a11y-basics-phone').status, 'FAIL');
});

test('locale formats: a wrong date format, time zone or currency code fails', async () => {
  const lib = built(LIBRARY);
  const kit = built(KITCHEN);
  const run = (b: Built, fs: OutFile[]): Promise<ClientCheck[]> => localeFormats(b.app, fs, bundleFromFiles(fs));

  const zone = await run(lib, mutate(lib.files, /^c2c-config\.js$/, (s) => s.replace(/C2C_APP_TIMEZONE = "[^"]*"/, 'C2C_APP_TIMEZONE = "UTC"')));
  assert.equal(byId(zone, 'time-zone').status, 'FAIL');
  const date = await run(lib, mutate(lib.files, /^assets\/model\.[^/]+\.js$/, (s) => s.replace('"dateFormat":"dd-MMM-yyyy"', '"dateFormat":"MM/dd/yyyy"')));
  assert.equal(byId(date, 'date-format').status, 'FAIL');
  const money = await run(kit, mutate(kit.files, /^assets\/model\.[^/]+\.js$/, (s) => s.replace('"currencyCode":"USD"', '"currencyCode":"EUR"')));
  assert.equal(byId(money, 'currency-code').status, 'FAIL');
  assert.match(byId(money, 'currency-code').evidence, /Creator USD, shipped EUR/);
  // A shipped time format that matches turns the GAP into a measured PASS.
  const timed = await run(lib, mutate(lib.files, /^assets\/model\.[^/]+\.js$/, (s) => s.replace('"dateFormat":', '"timeFormat":"24-hr","dateFormat":')));
  assert.equal(byId(timed, 'time-format').status, 'PASS');

  // No app time zone: Creator uses the account zone, which the export does not carry.
  const noZone: App = { ...lib.app, settings: lib.app.settings.filter((s) => s.key.toLowerCase() !== 'time zone' && s.key.toLowerCase() !== 'time format') };
  const unset = await localeFormats(noZone, lib.files, bundleFromFiles(lib.files));
  assert.equal(byId(unset, 'time-zone').status, 'GAP');
  assert.equal(byId(unset, 'time-format').status, 'NA');
});

test('creatorDate applies Creator date patterns', () => {
  assert.equal(creatorDate('dd-MMM-yyyy', 2026, 10, 7), '07-Oct-2026');
  assert.equal(creatorDate('MM/dd/yyyy', 2026, 1, 17), '01/17/2026');
  assert.equal(creatorDate('dd-MMMM-yy', 2026, 3, 5), '05-March-26');
});

test('markdown: one row per app, pipes in evidence escaped', () => {
  const r: ClientsReport = {
    schema: 'c2c-clients/1',
    app: 'Probe',
    ui: 'vanilla',
    status: 'GAP',
    criteria: [{ id: 'browser-matrix', title: 'B', status: 'GAP', checks: [{ id: 'x', status: 'GAP', evidence: 'a | b \\| c\nd' }] }],
  };
  const md = clientsMarkdown([r]);
  assert.match(md, /\| Probe \| GAP \| GAP \|/);
  assert.ok(md.includes('| x | GAP | a \\| b \\\\\\| c d |'), md);
});
