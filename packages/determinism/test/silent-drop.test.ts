import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyApp, parseFile, parseProject, type App, type Workflow } from '../../core/src/index.js';
import { repoRoot } from '../../core/src/toolchain.js';
import { analyze } from '../../cli/src/analyze.js';
import { listReportApps } from '../../cli/src/migration-report.js';
import { aioHandlerPath, generate } from '../../deluge/src/generate.js';
import { resolveStatusDir } from '../src/status.js';

/**
 * A source function, workflow, or schedule is accounted when its name is in
 * the generated tree, a readiness line names it, a TODO span covers it, or a
 * handler file exists for its form and event. Anything else was dropped.
 */
function slug(value: string): string {
  const slugText = value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return slugText || 'handler';
}

function mentioned(blob: string, name: string): boolean {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(blob);
}

function hasHandler(app: App, files: { path: string }[], workflow: Workflow): boolean {
  const form = slug(workflow.form || 'form');
  const event = slug(workflow.event || workflow.name || 'handler');
  // The aio leaf is the event group's shared label or `<kind>-handlers`, so
  // same-named siblings merge into one module; the client leaf stays per
  // workflow.
  const bases = [`functions/aio/${form}/${event}`, `client/handlers/${form}/${event}`];
  const aio = aioHandlerPath(app, workflow);
  if (aio) bases.push(aio);
  return files.some((file) => bases.some((base) => file.path === `${base}.mjs` || file.path.startsWith(`${base}-`)));
}

function spanListed(todos: { start: number; end: number }[], span: { start: number; end: number }): boolean {
  return todos.some((item) => item.start < span.end && item.end > span.start);
}

export function silentDrops(app: App): string[] {
  const generated = generate(app);
  const report = analyze(app);
  const blob = generated.files.map((file) => `${file.path}\n${file.source}`).join('\n');
  const listed = [
    ...report.blockers.map((blocker) => `${blocker.label} ${blocker.detail}`),
    ...report.deluge.todoLocations.map((item) => `${item.location} ${item.construct}`),
    ...report.determinism.todoKinds.map((kind) => kind.construct),
  ].join('\n');
  const drops: string[] = [];
  for (const fn of app.functions) {
    if (mentioned(blob, fn.name) || mentioned(listed, fn.name) || spanListed(generated.todos, fn.span)) continue;
    drops.push(`function ${fn.name}`);
  }
  for (const workflow of app.workflows) {
    if (!workflow.name) continue;
    if (mentioned(blob, workflow.name) || mentioned(listed, workflow.name) || spanListed(generated.todos, workflow.span)) continue;
    if (hasHandler(app, generated.files, workflow)) continue;
    const schedule = /schedule/i.test(`${workflow.container ?? ''} ${workflow.type ?? ''}`);
    drops.push(`${schedule ? 'schedule' : 'workflow'} ${workflow.name}`);
  }
  return drops;
}

function loadIr(target: string): App {
  return statSync(target).isDirectory() ? parseProject(target).ir : parseFile(target).ir;
}

test('two same-named workflows on one form are both accounted', () => {
  const mail = 'sendmail(from:"zoho.adminuserid" to:"zoho.adminuserid" subject:"s" message:"m")';
  const dup = (event: string, start: number): Workflow => ({
    name: 'Run_Scripts_On_Always',
    form: 'Orders',
    event,
    type: 'form',
    deluge: { text: mail, span: { start, end: start + mail.length } },
    properties: [],
    span: { start, end: start + mail.length },
  });
  const app: App = {
    ...emptyApp('deluge'),
    name: 'Demo_App',
    workflows: [dup('on user input of Price', 10), dup('on user input of Tax', 200)],
  };
  const generated = generate(app);
  const merged = generated.files.find((file) => file.path === 'functions/aio/orders/input-handlers.mjs');
  assert.ok(merged);
  assert.equal(merged.source.match(/shim\.mail\.send/g)?.length, 2);
  assert.deepEqual(silentDrops(app), []);
});

test('committed fixtures keep every function, workflow, and schedule', () => {
  const apps = listReportApps(join(repoRoot(), 'fixtures/redistributable'));
  assert.equal(apps.length, 2);
  for (const app of apps) assert.deepEqual(silentDrops(loadIr(app.target)), [], app.name);
});

function galleryDir(): string | undefined {
  const dir = resolveStatusDir(process.env);
  return dir && existsSync(dir) ? dir : undefined;
}

test('gallery fixtures keep every function, workflow, and schedule', { skip: !galleryDir() && 'needs C2C_FIXTURES_DIR or C2C_GALLERY_DIR' }, () => {
  const apps = listReportApps(galleryDir()!);
  assert.ok(apps.length > 0);
  const failures: string[] = [];
  for (const [index, app] of apps.entries()) {
    for (const drop of silentDrops(loadIr(app.target))) failures.push(`app #${index}: ${drop}`);
  }
  assert.deepEqual(failures, []);
});
