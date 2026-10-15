/**
 * Count forms and queries that hit an unverified Catalyst limit.
 * Fixture bodies stay on disk. This module returns counts and link names only.
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { entryKind, parseFile } from '../../core/src/index.js';
import { loadCorpusApps, type CorpusApp } from './corpus.js';
import { generateSchema } from './generator.js';
import { addHits, emptyHits, measureApp, type LimitHitCounts } from './limits.js';

export interface CorpusHitReport {
  name: string;
  apps: number;
  failed: string[];
  counts: LimitHitCounts;
}

export interface FixtureHitReport {
  corpora: CorpusHitReport[];
  total: LimitHitCounts;
}

function measureApps(name: string, apps: readonly CorpusApp[]): CorpusHitReport {
  const counts = emptyHits();
  const failed: string[] = [];
  for (const app of apps) {
    try {
      const plan = generateSchema(app.ir);
      const hit = measureApp(
        plan,
        app.ir.reports.map((report) => ({
          form: report.form,
          criteria: report.criteria,
          columns: report.columns.map((column) => ({
            field: column.field,
            ...(column.subcolumns.length ? { subcolumns: column.subcolumns.map((sub) => ({ field: sub.field })) } : {}),
          })),
          filters: report.filters.map((filter) => ({ criteria: filter.criteria })),
        })),
      );
      addHits(counts, hit.counts);
    } catch {
      failed.push(app.link);
    }
  }
  return { name, apps: apps.length, failed, counts };
}

/** Scenario apps only. Sidecars, Creator re-exports, and the _run scratch dir are not apps. */
export function loadSyntheticApps(root: string): CorpusApp[] {
  const dir = join(root, 'synthetic');
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const ent of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const name = ent.name;
      if (name.startsWith('.') || name === '_run' || name === 'sidecars') continue;
      const path = join(current, name);
      // The entry kind comes from the directory read; a symlink is skipped.
      if (ent.isSymbolicLink()) continue;
      if (entryKind(ent) === 'directory') walk(path);
      else if (name.toLowerCase().endsWith('.ds') && !name.includes('exported')) files.push(path);
    }
  };
  walk(dir);
  return files.map((path) => ({ link: relative(dir, path), ir: parseFile(path).ir }));
}

/** Gallery (one app per folder), public-corpus/ds, and the 34 synthetic scenario apps. */
export function measureFixtures(root: string): FixtureHitReport {
  const corpora = [
    measureApps('gallery', loadCorpusApps(join(root, 'gallery'))),
    measureApps('public-corpus', loadCorpusApps(join(root, 'public-corpus', 'ds'))),
    measureApps('synthetic', loadSyntheticApps(root)),
  ];
  const total = emptyHits();
  for (const corpus of corpora) addHits(total, corpus.counts);
  return { corpora, total };
}
