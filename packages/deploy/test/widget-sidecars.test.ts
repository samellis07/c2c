/**
 * A widget package under sidecars/widgets is html + json, not a .ds.
 * The plan and the analyze report name it. A package missing html or json
 * is still named, and the plan does not exit 0.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { analyze, analyzeAsText } from '../../cli/src/analyze.js';
import { parseFile, parseFileWithSidecars, parseProject } from '../../core/src/index.js';
import { planCli, buildOfflinePlan } from '../src/offline-plan.js';
import { deployFiles } from '../src/plan.js';
import { type Io } from '../src/cli.js';
import { ALLOWED_ENV, type GuardOk } from '../src/guards.js';
import { emptyRegistry } from '../src/registry.js';

const DS = `application "Dispatch"
{
\ttime zone = "UTC"
\tsection Board
\t{
\t\tform Job
\t\t{
\t\t\tTitle
\t\t\t(
\t\t\t\ttype = text
\t\t\t)
\t\t}
\t}
}
`;

const MANIFEST = `{
  "service": "CREATOR",
  "modules": {
    "widgets": [
      { "location": "app", "name": "Route_Map", "url": "/app/widget.html" }
    ]
  }
}
`;

const HTML = '<!DOCTYPE html><html><head><title>Route map</title></head><body><p>Route map</p></body></html>\n';

function offlineIo(): Io {
  return {
    stdout: () => {},
    stderr: () => {},
    env: {},
    spawn: async () => {
      throw new Error('plan test does not spawn');
    },
    fetch: async () => {
      throw new Error('plan test does not fetch');
    },
  };
}

function writeApp(opts: { html: boolean; json: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-widget-sidecar-'));
  writeFileSync(join(dir, 'app.ds'), DS);
  const widget = join(dir, 'sidecars', 'widgets', 'Route_Map');
  mkdirSync(join(widget, 'app'), { recursive: true });
  if (opts.html) writeFileSync(join(widget, 'app', 'widget.html'), HTML);
  if (opts.json) writeFileSync(join(widget, 'plugin-manifest.json'), MANIFEST);
  else writeFileSync(join(widget, 'page-element.zml.txt'), "<widgets linkName='Route_Map' />\n");
  return dir;
}

test('a widget sidecar with html and json is named on the plan and in analyze', async (t) => {
  const dir = writeApp({ html: true, json: true });
  const out = mkdtempSync(join(tmpdir(), 'c2c-widget-plan-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  const app = parseProject(dir).ir;
  assert.deepEqual(
    (app.widgets ?? []).map((widget) => widget.name),
    ['Route_Map'],
  );
  assert.equal(app.widgets?.[0]?.html, true);
  assert.equal(app.widgets?.[0]?.json, true);
  assert.equal(app.files?.some((file) => file.toLowerCase().endsWith('.ds') && file.includes('Route_Map')), false);

  const code = await planCli([dir, '--out', out, '--dc', 'eu'], offlineIo());
  const planMd = readFileSync(join(out, 'plan.md'), 'utf8');
  const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')) as { manual?: { name: string }[] };
  assert.equal(code, 0);
  assert.match(planMd, /Route_Map/);
  assert.ok(plan.manual?.some((item) => item.name === 'Route_Map'));

  assert.match(analyzeAsText(analyze(app)), /Route_Map/);

  const guard: GuardOk = {
    org: '1',
    projectId: '1001',
    environment: ALLOWED_ENV,
    projectName: 'dispatch',
    dc: 'eu',
    registry: emptyRegistry(),
  };
  const deployed = deployFiles(app, guard, false, { mode: 'dry-run' }).files.map((file) => file.data).join('\n');
  assert.match(deployed, /Route_Map/);
  const built = buildOfflinePlan(app, { dc: 'eu', dcSource: '--dc', mail: false });
  assert.match(built.files.map((file) => file.data).join('\n'), /Route_Map/);
});

test('a single .ds file next to widget sidecars names the widget in analyze and on the plan', async (t) => {
  const dir = writeApp({ html: true, json: true });
  const file = join(dir, 'app.ds');
  const out = mkdtempSync(join(tmpdir(), 'c2c-widget-file-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  // A bare single-file parse cannot see the html + json package next to it.
  assert.equal(parseFile(file).ir.widgets, undefined);
  const app = parseFileWithSidecars(file).ir;
  assert.deepEqual(
    (app.widgets ?? []).map((widget) => widget.name),
    ['Route_Map'],
  );
  const report = analyze(app);
  assert.ok(report.blockers.some((blocker) => blocker.label === 'widget Route_Map'));
  assert.match(analyzeAsText(report), /Route_Map/);

  const code = await planCli([file, '--out', out, '--dc', 'eu'], offlineIo());
  const planMd = readFileSync(join(out, 'plan.md'), 'utf8');
  const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')) as { manual?: { name: string }[] };
  assert.equal(code, 0);
  assert.match(planMd, /Route_Map/);
  assert.ok(plan.manual?.some((item) => item.name === 'Route_Map'));
});

test('a widget sidecar missing html or json is named and the plan does not exit 0', async (t) => {
  const dir = writeApp({ html: true, json: false });
  const out = mkdtempSync(join(tmpdir(), 'c2c-widget-missing-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  const code = await planCli([dir, '--out', out, '--dc', 'eu'], offlineIo());
  const planMd = readFileSync(join(out, 'plan.md'), 'utf8');
  const plan = JSON.parse(readFileSync(join(out, 'plan.json'), 'utf8')) as { manual?: unknown[] };
  assert.match(planMd, /Route_Map/);
  assert.ok(Array.isArray(plan.manual) && plan.manual.length > 0);
  assert.notEqual(code, 0);
});
