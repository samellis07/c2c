/**
 * Visual regression baseline for three apps at desktop (1440 px) and phone
 * (390 px) widths: home, first form and first report screens, with computed
 * styles of the key shell, form and report elements (see visual-snapshot.ts).
 *
 * The baseline lives in visual-baseline.json next to this file. A change that
 * moves any recorded style fails here with the screen, element and property
 * that moved. When a visual change is intended, regenerate the baseline with
 *   C2C_UPDATE_VISUAL_BASELINE=1 npm test
 * and review the JSON diff with the change.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { JSDOM } from 'jsdom';
import { flattenCss, snapshotApp, specificity, type Snapshot, type SnapshotOptions } from './visual-snapshot.js';

const FREIGHT = 'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds';
const LIBRARY = 'fixtures/redistributable/library-application-system/library_application.ds';
const GOLDEN = 'tests/golden/c2c-golden.ds';

/** Snapshot name -> source app and any <html> attributes forced on top of it. */
export const BASELINE_APPS: Record<string, { path: string; opts?: SnapshotOptions }> = {
  'freight-forwarding': { path: FREIGHT },
  'library-application-system': { path: LIBRARY },
  golden: { path: GOLDEN },
  // The same app re-skinned with a rail-menu theme palette.
  'library-application-system@theme-9': { path: LIBRARY, opts: { rootAttrs: { 'data-theme': '9', 'data-menu': 'rail' } } },
  // The dark colour scheme.
  'library-application-system@dark': { path: LIBRARY, opts: { rootAttrs: { 'data-color-scheme': 'dark' } } },
};

const BASELINE = join(process.cwd(), 'packages/ui/test/visual-baseline.json');

async function current(): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {};
  for (const [name, { path, opts }] of Object.entries(BASELINE_APPS)) {
    out[name] = await snapshotApp(deriveIr(parse(readFileSync(join(process.cwd(), path), 'utf8'))), opts);
  }
  return out;
}

function diff(want: unknown, got: unknown, path: string, out: string[]): void {
  if (out.length >= 25) return;
  if (typeof want !== 'object' || want === null || typeof got !== 'object' || got === null) {
    if (want !== got) out.push(`${path}: ${JSON.stringify(want)} -> ${JSON.stringify(got)}`);
    return;
  }
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  for (const key of [...keys].sort()) diff((want as Record<string, unknown>)[key], (got as Record<string, unknown>)[key], `${path}/${key}`, out);
}

test('visual baseline: three apps (plus themed and dark variants) x 1440/390 px match the recorded computed styles', async () => {
  const got = await current();
  if (process.env.C2C_UPDATE_VISUAL_BASELINE === '1') {
    writeFileSync(BASELINE, JSON.stringify(got, null, 1) + '\n');
    return;
  }
  const want = JSON.parse(readFileSync(BASELINE, 'utf8')) as unknown;
  const changes: string[] = [];
  diff(want, got, '', changes);
  assert.deepEqual(changes, [], `computed styles moved:\n${changes.join('\n')}`);
});

test('visual baseline: the snapshot covers every app at both widths with shell, form and report elements', () => {
  const want = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, Snapshot>;
  assert.deepEqual(Object.keys(want).sort(), Object.keys(BASELINE_APPS).sort());
  for (const [app, shots] of Object.entries(want)) {
    for (const width of [1440, 390]) {
      for (const screen of app === 'golden' ? ['home', 'form'] : ['home', 'form', 'report']) {
        const shot = shots[`${screen}@${width}`];
        assert.ok(shot, `${app}: no ${screen}@${width} snapshot`);
        assert.ok(shot['body'] && shot['.topbar'], `${app} ${screen}@${width}: shell not captured`);
      }
      assert.ok(shots[`form@${width}`]!['.field>label'], `${app}: form labels not captured at ${width}`);
    }
    assert.notEqual(shots['home@1440']!['#tabbar']?.display, 'flex', `${app}: phone tab bar shows on desktop`);
  }
});

test('visual baseline: snapshots are deterministic across runs', async () => {
  const path = LIBRARY;
  const app = () => deriveIr(parse(readFileSync(join(process.cwd(), path), 'utf8')));
  assert.deepEqual(await snapshotApp(app()), await snapshotApp(app()));
});

test('visual snapshot: rules cascade by specificity, not source order alone', () => {
  assert.ok(specificity('html[data-menu="rail"] #nav') > specificity('#nav'));
  assert.ok(specificity('#nav a[aria-current="page"]') > specificity('#nav a'));
  assert.equal(specificity('input:not([type="checkbox"]):not([type="radio"])'), specificity('input[a][b]'));
  assert.equal(specificity(':root'), specificity('.x'));
  const doc = new JSDOM('<html data-menu="rail"><body><nav id="nav"></nav></body></html>').window.document as unknown as {
    documentElement: { matches(s: string): boolean };
  };
  const css = 'html[data-menu="rail"] #nav{width:5rem}\n#nav{width:16rem}';
  assert.match(flattenCss(css, 1440, doc.documentElement), /#nav\{width:16rem\}\nhtml\[data-menu="rail"\] #nav\{width:5rem\}/);
});
