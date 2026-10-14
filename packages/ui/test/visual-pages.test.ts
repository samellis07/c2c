/**
 * Visual regression baseline for the generated page surfaces of three apps:
 * the first list report with rows loaded, the first form, the first report,
 * and the first ZML page where the app has one — at desktop (1440 px) and
 * phone (390 px) widths, reading the computed styles of shell, list, form
 * and page elements (see visual-snapshot.ts).
 *
 * The baseline lives in visual-pages.json next to this file. Compared
 * values match exactly except for single lengths, which pass inside
 * TOLERANCE_PX of sub-unit movement. A change that moves any other recorded
 * style fails here with the screen, element and property that moved. When a
 * visual change is intended, regenerate the baseline with
 *   C2C_UPDATE_VISUAL_BASELINE=1 npm test
 * and review the JSON diff with the change.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { KEY_ELEMENTS, PAGE_ELEMENTS, snapshotApp, type Snapshot } from './visual-snapshot.js';

const FREIGHT = 'fixtures/redistributable/freight-forwarding/Creator_app_source_code.ds';
const LIBRARY = 'fixtures/redistributable/library-application-system/library_application.ds';
const GOLDEN = 'tests/golden/c2c-golden.ds';

/** Sample rows the fake data API answers every report query with. */
const SAMPLE_ROWS = 3;

/** Snapshot name -> source app and the screens it is expected to render. */
export const PAGE_APPS: Record<string, { path: string; screens: string[] }> = {
  'freight-forwarding': { path: FREIGHT, screens: ['list', 'form', 'report'] },
  'library-application-system': { path: LIBRARY, screens: ['list', 'form', 'report', 'page'] },
  golden: { path: GOLDEN, screens: ['form'] },
};

const SCREENS = ['list', 'form', 'report', 'page'];
const ELEMENTS = [...KEY_ELEMENTS, ...PAGE_ELEMENTS];
const BASELINE = join(process.cwd(), 'packages/ui/test/visual-pages.json');

/** A single length inside this many css px passes; every other value is exact. */
export const TOLERANCE_PX = 0.5;

const LENGTH = /^(-?\d*\.?\d+)(px|rem|em|pt|%)$/;

function toPx(value: number, unit: string): number {
  return value * (unit === 'rem' || unit === 'em' ? 16 : unit === 'pt' ? 4 / 3 : 1);
}

/** Leaf compare: exact strings, or one numeric length inside TOLERANCE_PX. */
export function sameValue(want: unknown, got: unknown): boolean {
  if (want === got) return true;
  if (typeof want !== 'string' || typeof got !== 'string') return false;
  const a = LENGTH.exec(want.trim());
  const b = LENGTH.exec(got.trim());
  if (!a || !b || a[2] !== b[2]) return false;
  return Math.abs(toPx(Number(a[1]), a[2]!) - toPx(Number(b[1]), b[2]!)) <= TOLERANCE_PX;
}

async function current(): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {};
  for (const [name, { path }] of Object.entries(PAGE_APPS)) {
    const app = deriveIr(parse(readFileSync(join(process.cwd(), path), 'utf8')));
    out[name] = await snapshotApp(app, { screens: SCREENS, elements: ELEMENTS, rows: SAMPLE_ROWS });
  }
  return out;
}

function diff(want: unknown, got: unknown, path: string, out: string[]): void {
  if (out.length >= 25) return;
  if (typeof want !== 'object' || want === null || typeof got !== 'object' || got === null) {
    if (!sameValue(want, got)) out.push(`${path}: ${JSON.stringify(want)} -> ${JSON.stringify(got)}`);
    return;
  }
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  for (const key of [...keys].sort()) diff((want as Record<string, unknown>)[key], (got as Record<string, unknown>)[key], `${path}/${key}`, out);
}

test('visual pages: list, form, report (and page) screens of three apps x 1440/390 px match the recorded computed styles', async () => {
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

test('visual pages: the snapshot covers every expected screen with shell, populated list and page elements', () => {
  const want = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, Snapshot>;
  assert.deepEqual(Object.keys(want).sort(), Object.keys(PAGE_APPS).sort());
  for (const [app, { screens }] of Object.entries(PAGE_APPS)) {
    const shots = want[app]!;
    for (const width of [1440, 390]) {
      for (const screen of screens) {
        const shot = shots[`${screen}@${width}`];
        assert.ok(shot, `${app}: no ${screen}@${width} snapshot`);
        assert.ok(shot['body'] && shot['.topbar'], `${app} ${screen}@${width}: shell not captured`);
      }
      if (screens.includes('list')) {
        const list = shots[`list@${width}`]!;
        assert.ok(list['tbody tr'] && list['td'], `${app}: populated list rows not captured at ${width}`);
        assert.ok(list['.report-tools'] && list['nav[data-pages]'], `${app}: list chrome not captured at ${width}`);
      }
      if (screens.includes('page')) {
        const page = shots[`page@${width}`]!;
        assert.ok(page['article[data-page]'], `${app}: page shell not captured at ${width}`);
        assert.ok(page['article[data-page] [data-zml]'], `${app}: page layout elements not captured at ${width}`);
        assert.ok(page['article[data-page] [data-zml="panel"]'], `${app}: page panels not captured at ${width}`);
        assert.ok(page['article[data-page] .kpi'], `${app}: page KPI tiles not captured at ${width}`);
      }
    }
  }
});

test('visual pages: populated snapshots are deterministic across runs', async () => {
  const app = () => deriveIr(parse(readFileSync(join(process.cwd(), LIBRARY), 'utf8')));
  const opts = { screens: SCREENS, elements: ELEMENTS, rows: SAMPLE_ROWS };
  assert.deepEqual(await snapshotApp(app(), opts), await snapshotApp(app(), opts));
});

test('visual pages: the length tolerance passes sub-unit moves and rejects the rest', () => {
  assert.ok(sameValue('12px', '12px'));
  assert.ok(sameValue('12px', '12.4px'));
  assert.ok(sameValue('1rem', '1.03rem'));
  assert.ok(!sameValue('12px', '12.6px'));
  assert.ok(!sameValue('12px', '12rem'));
  assert.ok(!sameValue('12px', 'none'));
  assert.ok(!sameValue('rgb(1,2,3)', 'rgb(1,2,4)'));
  assert.ok(!sameValue('flex', 'grid'));
  assert.ok(!sameValue('24%', '25%'));
});
