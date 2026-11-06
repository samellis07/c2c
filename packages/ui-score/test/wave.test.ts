/**
 * Tests for the independent UI scorer per wave: verifies discovery, reference capture
 * loading from ui-reference v3 indices, side-by-side rubric verification against
 * the 8/10 bar on desktop and phone, and evidence artifact emission (score.json, ui-score.txt).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse, type App } from '../../core/src/index.js';
import { buildUi } from '../../ui/src/index.js';
import { bundleFromFiles, loadRubric, scoreUi, type UiScore } from '../src/score.js';
import {
  discoverWaveApps,
  findReferenceDir,
  loadAppReferenceCaptures,
  parseReferenceIndex,
  scoreWave,
  scoreWaveApp,
  verifyReferenceCaptures,
  waveReportMarkdown,
  type AppReferenceCaptures,
  type ReferenceCapture,
  type WaveAppTarget,
} from '../src/wave.js';

const MOCK_INDEX_MD = `# Mock App — Creator reference captures

Desktop: 1440x900 live web view. Mobile: Creator phone preview (390x844).

| viewport | kind | name | menu label | file |
|---|---|---|---|---|
| desktop | nav | menu | (app menu) | desktop/nav-menu.png |
| mobile | nav | home | (phone home + tab bar) | mobile/nav-home.png |
| desktop | form | Order | New Order | desktop/form-Order.png |
| desktop | report | All_Orders | All Orders | desktop/report-All_Orders.png |
| desktop | detail | All_Orders | no records yet | - |
| phone | form | Order | New Order | mobile/form-Order.png |
| phone | report | All_Orders | All Orders | mobile/report-All_Orders.png |
`;

const SOURCE_APP = `application "Order Desk"
{
\tsection Sales
\t{
\t\tform Order
\t\t{
\t\t\tdisplayname = "New Order"
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Title"
\t\t\t)
\t\t\tStatus
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Status"
\t\t\t\tvalues = {"Open", "Closed"}
\t\t\t)
\t\t}
\t\tlist All_Orders
\t\t{
\t\t\tdisplayname = "All Orders"
\t\t\tshow all rows from Order
\t\t\t(
\t\t\t\tTitle
\t\t\t\tStatus
\t\t\t)
\t\t}
\t}
}
`;

function makeTestApp(): App {
  return deriveIr(parse(SOURCE_APP));
}

test('parseReferenceIndex parses markdown table into structured captures', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-wave-ref-'));
  try {
    const indexPath = join(tmp, 'index.md');
    writeFileSync(indexPath, MOCK_INDEX_MD);
    const captures = parseReferenceIndex(indexPath);

    assert.equal(captures.length, 7);
    assert.deepEqual(captures[0], {
      viewport: 'desktop',
      kind: 'nav',
      name: 'menu',
      menuLabel: '(app menu)',
      file: 'desktop/nav-menu.png',
    });
    // Check mobile mapped to phone
    assert.deepEqual(captures[1], {
      viewport: 'phone',
      kind: 'nav',
      name: 'home',
      menuLabel: '(phone home + tab bar)',
      file: 'mobile/nav-home.png',
    });
    assert.deepEqual(captures[2], {
      viewport: 'desktop',
      kind: 'form',
      name: 'Order',
      menuLabel: 'New Order',
      file: 'desktop/form-Order.png',
    });
    assert.deepEqual(captures[3], {
      viewport: 'desktop',
      kind: 'report',
      name: 'All_Orders',
      menuLabel: 'All Orders',
      file: 'desktop/report-All_Orders.png',
    });
    assert.deepEqual(captures[4], {
      viewport: 'desktop',
      kind: 'detail',
      name: 'All_Orders',
      menuLabel: 'no records yet',
      file: '-',
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('parseReferenceIndex handles missing file gracefully', () => {
  const captures = parseReferenceIndex('/non/existent/path/index.md');
  assert.deepEqual(captures, []);
});

test('findReferenceDir and loadAppReferenceCaptures find app captures in custom or standard directories', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-ref-root-'));
  try {
    const appRefDir = join(tmp, 'v3', 'test-app');
    mkdirSync(appRefDir, { recursive: true });
    writeFileSync(join(appRefDir, 'index.md'), MOCK_INDEX_MD);

    const found = findReferenceDir('test-app', tmp);
    assert.equal(found, appRefDir);

    const loaded = loadAppReferenceCaptures('test-app', tmp);
    assert.ok(loaded);
    assert.equal(loaded?.app, 'test-app');
    assert.equal(loaded?.captures.length, 7);
    assert.equal(loaded?.byViewport.desktop.length, 4);
    assert.equal(loaded?.byViewport.phone.length, 3);
    assert.ok(loaded?.byKind['form']?.length === 2);
    assert.ok(loaded?.byKind['report']?.length === 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('verifyReferenceCaptures measures reference capture alignment against rendered UI', async () => {
  const app = makeTestApp();
  const bundle = buildUi(app);
  const rubric = loadRubric();
  const uiScore = await scoreUi(app, bundleFromFiles(bundle.files), { rubric });

  const refCaptures: AppReferenceCaptures = {
    app: 'order-desk',
    dir: '/mock/ref',
    captures: [
      { viewport: 'desktop', kind: 'nav', name: 'menu', menuLabel: '(app menu)', file: 'desktop/nav-menu.png' },
      { viewport: 'phone', kind: 'nav', name: 'home', menuLabel: '(phone home)', file: 'mobile/nav-home.png' },
      { viewport: 'desktop', kind: 'form', name: 'Order', menuLabel: 'New Order', file: 'desktop/form-Order.png' },
      { viewport: 'desktop', kind: 'report', name: 'All_Orders', menuLabel: 'All Orders', file: 'desktop/report-All_Orders.png' },
      { viewport: 'phone', kind: 'form', name: 'Order', menuLabel: 'New Order', file: 'mobile/form-Order.png' },
      { viewport: 'desktop', kind: 'form', name: 'Missing_Form', menuLabel: 'Missing', file: 'desktop/form-Missing.png' },
    ],
    byViewport: { desktop: [], phone: [] },
    byKind: {},
  };

  const coverage = verifyReferenceCaptures(app, uiScore, refCaptures);
  assert.equal(coverage.totalCaptures, 6);
  assert.equal(coverage.matchedCaptures, 5); // 5 match, Missing_Form does not
  assert.ok(coverage.coverageRatio >= 0.8, `coverage ratio ${coverage.coverageRatio} should be >= 0.8`);

  const missingDetail = coverage.details.find((d) => d.capture.name === 'Missing_Form');
  assert.ok(missingDetail);
  assert.equal(missingDetail?.matched, false);
});

test('discoverWaveApps locates apps from evidence directory and manifest', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-wave-run-'));
  try {
    const evidenceDir = join(tmp, 'evidence');
    mkdirSync(join(evidenceDir, 'app-one'), { recursive: true });
    mkdirSync(join(evidenceDir, 'app-two'), { recursive: true });

    const discovered = discoverWaveApps(tmp);
    assert.equal(discovered.length, 2);
    assert.deepEqual(discovered.map((d) => d.slug).sort(), ['app-one', 'app-two']);
    assert.equal(discovered[0]!.evidenceDir, join(evidenceDir, 'app-one'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('scoreWaveApp writes score.json and ui-score.txt into evidence directory when write is true', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-wave-score-'));
  try {
    const appDs = join(tmp, 'Order_Desk.ds');
    writeFileSync(appDs, SOURCE_APP);

    const evidenceDir = join(tmp, 'evidence', 'order-desk');
    mkdirSync(evidenceDir, { recursive: true });

    const refDir = join(tmp, 'ref', 'order-desk');
    mkdirSync(refDir, { recursive: true });
    writeFileSync(join(refDir, 'index.md'), MOCK_INDEX_MD);

    const target: WaveAppTarget = {
      slug: 'order-desk',
      source: appDs,
      evidenceDir,
    };

    const rubric = loadRubric();
    const result = await scoreWaveApp(target, rubric, {
      referenceDir: join(tmp, 'ref'),
      write: true,
      passBar: 8,
    });

    assert.equal(result.slug, 'order-desk');
    assert.ok(result.desktop.score >= 8, `desktop score ${result.desktop.score} >= 8`);
    assert.ok(result.phone.score >= 8, `phone score ${result.phone.score} >= 8`);
    assert.equal(result.pass, true);
    assert.ok(result.reference, 'reference report present');
    assert.ok(result.reference!.coverageRatio >= 0.8);

    // Verify score.json was written
    const scoreJsonFile = join(evidenceDir, 'score.json');
    assert.ok(readFileSync(scoreJsonFile, 'utf8'));
    const scoreObj = JSON.parse(readFileSync(scoreJsonFile, 'utf8')) as { score: number; pass: boolean; desktop: number; phone: number };
    assert.equal(typeof scoreObj.score, 'number');
    assert.ok(scoreObj.score >= 8);
    assert.equal(scoreObj.pass, true);
    assert.equal(scoreObj.desktop, result.desktop.score);
    assert.equal(scoreObj.phone, result.phone.score);

    // Verify ui-score.txt was written
    const uiScoreTxt = readFileSync(join(evidenceDir, 'ui-score.txt'), 'utf8');
    assert.ok(uiScoreTxt.includes('Order Desk (order-desk)'));
    assert.ok(uiScoreTxt.includes('Bar: 8/10 on desktop and phone -> PASS'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('scoreWave rolls up multi-app wave results and formats markdown report', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-wave-suite-'));
  try {
    const app1Ds = join(tmp, 'App1.ds');
    writeFileSync(app1Ds, SOURCE_APP);

    const app2Ds = join(tmp, 'App2.ds');
    writeFileSync(app2Ds, SOURCE_APP.replace('Order Desk', 'Catalog Desk'));

    const targets: WaveAppTarget[] = [
      { slug: 'app-one', source: app1Ds },
      { slug: 'app-two', source: app2Ds },
    ];

    const rubric = loadRubric();
    const reportPath = join(tmp, 'wave-report.md');
    const report = await scoreWave(targets, {
      rubric,
      passBar: 8,
      out: reportPath,
      waveName: 'test-wave-1',
    });

    assert.equal(report.schema, 'c2c-wave-score/1');
    assert.equal(report.wave, 'test-wave-1');
    assert.equal(report.totalApps, 2);
    assert.equal(report.scoredApps, 2);
    assert.equal(report.passedApps, 2);
    assert.equal(report.failedApps, 0);
    assert.equal(report.pass, true);
    assert.ok(report.desktopMean >= 8);
    assert.ok(report.phoneMean >= 8);

    // Check markdown file output
    const md = readFileSync(reportPath, 'utf8');
    assert.ok(md.includes('# Wave UI Scores — test-wave-1'));
    assert.ok(md.includes('**2 of 2 apps pass both viewports** (verdict: **PASS**)'));
    assert.ok(md.includes('Order Desk (app-one)'));
    assert.ok(md.includes('Catalog Desk (app-two)'));

    const directMd = waveReportMarkdown(report, rubric);
    assert.equal(md, directMd);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('scoreWave filters by --only when supplied', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'c2c-wave-only-'));
  try {
    const app1Ds = join(tmp, 'App1.ds');
    writeFileSync(app1Ds, SOURCE_APP);
    const app2Ds = join(tmp, 'App2.ds');
    writeFileSync(app2Ds, SOURCE_APP);

    const targets: WaveAppTarget[] = [
      { slug: 'keep-me', source: app1Ds },
      { slug: 'drop-me', source: app2Ds },
    ];

    const report = await scoreWave(targets, { only: ['keep-me'] });
    assert.equal(report.totalApps, 1);
    assert.equal(report.apps[0]?.slug, 'keep-me');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
