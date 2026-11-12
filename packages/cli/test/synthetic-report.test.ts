import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  countRows,
  formatSyntheticReport,
  listSyntheticApps,
  runSyntheticApp,
  summarizeManual,
  verdictOf,
  type SyntheticRow,
} from '../src/synthetic-report.js';

const MINI = 'application "Mini_App"\n{\n}\n';

const WIDGET_DS = `application "Dispatch"
{
\ttime zone = "UTC"
\tsection Board
\t{
\t\tform Job
\t\t{
\t\t\tTitle
\t\t\t(
\t\t\ttype = text
\t\t\t)
\t\t}
\t}
}
`;

const WIDGET_MANIFEST = `{
  "service": "CREATOR",
  "modules": {
    "widgets": [
      { "location": "app", "name": "Route_Map", "url": "/app/widget.html" }
    ]
  }
}
`;

const WIDGET_HTML = '<!DOCTYPE html><html><head><title>Route map</title></head><body><p>Route map</p></body></html>\n';

const RESIDUAL_DS = `application "Residual_App"
{
	functions
	{
		Deluge
		{
			void helpers.logNote()
			{
				note = "hello".toFile("note.txt");
			}
		}
	}
}
`;

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-synthetic-list-'));
  const put = (rel: string, body: string = MINI) => {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  };
  put('s01/L1/app.ds');
  put('s01/L1/app.exported.ds');
  put('s01/L2/app.ds');
  put(join('s01/L2/sidecars/custom-apis', 'Helper.ds'));
  put(join('_run', 'bisect.ds'));
  put('s99/app.ds');
  return dir;
}

function row(over: Partial<SyntheticRow> = {}): SyntheticRow {
  return {
    n: 1,
    compiles: 'yes',
    manual: [],
    todoCount: 0,
    todoKinds: [],
    planErrors: [],
    deterministic: true,
    planOk: true,
    deployOk: true,
    uiOk: true,
    ...over,
  };
}

test('listSyntheticApps keeps one canonical export per app, numbered in path order', () => {
  const dir = tree();
  try {
    const apps = listSyntheticApps(dir);
    assert.deepEqual(
      apps.map((a) => a.rel),
      [join('s01', 'L1', 'app.ds'), join('s01', 'L2', 'app.ds'), join('s99', 'app.ds')],
    );
    assert.deepEqual(apps.map((a) => a.n), [1, 2, 3]);
    for (const app of apps) assert.equal(app.file, join(dir, app.rel));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verdictOf: a clean migration is migrates, listed items are manual-items, silence is FAIL', () => {
  assert.equal(verdictOf(row()), 'migrates');
  assert.equal(
    verdictOf(row({ deterministic: false, todoCount: 2, todoKinds: [{ construct: 'openurl', count: 2 }] })),
    'manual-items',
  );
  assert.equal(
    verdictOf(row({ deterministic: true, compiles: 'no', manual: [{ severity: 'warning', check: 'link-name', count: 1 }] })),
    'manual-items',
  );
  assert.equal(verdictOf(row({ deterministic: false })), 'FAIL');
  assert.equal(
    verdictOf(row({ manual: [{ severity: 'blocker', check: 'void-assign', count: 1 }] })),
    'manual-items',
  );
  assert.equal(
    verdictOf(row({ manual: [{ severity: 'warning', check: 'link-name', count: 1 }] })),
    'migrates',
  );
  assert.equal(verdictOf(row({ deterministic: true, planOk: false, planErrors: ['plan: boom'] })), 'FAIL');
  assert.equal(
    verdictOf(row({ deterministic: true, deployOk: false, planErrors: ['deploy: boom'], todoCount: 1, todoKinds: [{ construct: 'openurl', count: 1 }] })),
    'manual-items',
  );
});

test('runSyntheticApp lists a widget sidecar as a manual blocker, never migrates', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-synthetic-widget-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'app.ds'), WIDGET_DS);
  const widget = join(dir, 'sidecars', 'widgets', 'Route_Map');
  mkdirSync(join(widget, 'app'), { recursive: true });
  writeFileSync(join(widget, 'app', 'widget.html'), WIDGET_HTML);
  writeFileSync(join(widget, 'plugin-manifest.json'), WIDGET_MANIFEST);
  const appRow = await runSyntheticApp({ n: 1, rel: 'app.ds', file: join(dir, 'app.ds') }, { root: dir, dc: 'us' });
  assert.deepEqual(appRow.manual, [{ severity: 'blocker', check: 'widget Route_Map', count: 1 }]);
  assert.equal(verdictOf(appRow), 'manual-items');
});

test('runSyntheticApp lists a non-widget analyze blocker as a manual item, never migrates', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-synthetic-residual-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'app.ds'), RESIDUAL_DS);
  const appRow = await runSyntheticApp({ n: 1, rel: 'app.ds', file: join(dir, 'app.ds') }, { root: dir, dc: 'us' });
  assert.ok(appRow.manual.some((item) => item.severity === 'blocker' && item.check.includes('helpers.logNote')));
  assert.equal(verdictOf(appRow), 'manual-items');
});

test('summarizeManual groups by severity and check with blockers first', () => {
  assert.deepEqual(
    summarizeManual([
      { severity: 'warning', check: 'link-name' },
      { severity: 'blocker', check: 'field-type' },
      { severity: 'warning', check: 'link-name' },
    ]),
    [
      { severity: 'blocker', check: 'field-type', count: 1 },
      { severity: 'warning', check: 'link-name', count: 2 },
    ],
  );
  assert.deepEqual(summarizeManual([]), []);
});

test('formatSyntheticReport numbers rows, marks FAIL, and names no app', () => {
  const rows = [
    row({ n: 1 }),
    row({
      n: 2,
      compiles: 'no',
      deterministic: false,
      manual: [{ severity: 'blocker', check: 'field-type', count: 1 }],
      todoCount: 1,
      todoKinds: [{ construct: 'openurl', count: 1 }],
      planErrors: [],
    }),
    row({ n: 3, deterministic: false, planOk: false, planErrors: ['plan: no data centre'] }),
  ];
  const md = formatSyntheticReport(rows, { label: 'synthetic', dc: 'us' });
  assert.match(md, /\| 1 \|/);
  assert.match(md, /\| 2 \|/);
  assert.match(md, /\| 3 \|/);
  assert.match(md, /FAIL/);
  assert.match(md, /field-type/);
  assert.match(md, /apps 3/);
  assert.doesNotMatch(md, /Mini_App/);
  assert.doesNotMatch(md, /\.ds/);
  const counts = countRows(rows);
  assert.deepEqual(counts, { total: 3, migrates: 1, manualItems: 1, fail: 1, compilesYes: 2, todoTotal: 1 });
});

test('a quality outcome with prefetch non-reads fails the row and names the count', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-synthetic-prefetch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'app.ds'), MINI);
  const r = await runSyntheticApp(
    { n: 1, rel: 'app.ds', file: join(dir, 'app.ds') },
    { root: dir, dc: 'in', quality: async () => ({ ok: false, prefetchNonReads: 3 }) },
  );
  assert.equal(r.compiles, 'no');
  assert.deepEqual(r.planErrors.filter((e) => e.startsWith('quality:')), ['quality: prefetch-non-reads=3']);
  assert.equal(verdictOf(r), 'FAIL');
});
