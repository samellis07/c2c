import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listDsFiles, parseFile, parseProject, type App } from '../../core/src/index.js';
import { compareEnUs } from '../../core/src/order.js';
import { generateSchema, type FieldOutcome, type SchemaPlan } from './generator.js';

export interface CorpusApp {
  /** Folder or file name. This is the app link used in the report, not a display name. */
  link: string;
  ir: App;
}

/** Sub-folders that contain a .ds, plus loose .ds files. Names only; file bodies stay out of the report. */
export function loadCorpusApps(dir: string): CorpusApp[] {
  const apps: CorpusApp[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(dir, name);
    const st = statSync(path, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) {
      if (!listDsFiles(path).length) continue;
      apps.push({ link: name, ir: parseProject(path).ir });
    } else if (st.isFile() && name.toLowerCase().endsWith('.ds')) {
      apps.push({ link: name.slice(0, -'.ds'.length), ir: parseFile(path).ir });
    }
  }
  return apps;
}

export interface CorpusNumbers {
  apps: number;
  failed: string[];
  tables: number;
  nosqlCollections: number;
  columns: number;
  fields: number;
  supported: number;
  partial: number;
  unsupported: number;
  mappedPct: number | null;
  /** Unsupported creator type tokens, most common first. */
  unmapped: { type: string; count: number }[];
  perApp: { link: string; tables: number; columns: number; fields: number; supported: number; partial: number; unsupported: number }[];
}

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return `${(Math.round((n * 1000) / d) / 10).toFixed(1)}%`;
}

export function corpusNumbers(apps: CorpusApp[]): CorpusNumbers {
  const failed: string[] = [];
  const perApp: CorpusNumbers['perApp'] = [];
  const unmapped = new Map<string, number>();
  const totals = { tables: 0, nosqlCollections: 0, columns: 0, fields: 0, supported: 0, partial: 0, unsupported: 0 };
  for (const app of apps) {
    let plan: SchemaPlan;
    try {
      plan = generateSchema(app.ir);
    } catch (err) {
      failed.push(app.link);
      continue;
    }
    const s = plan.summary;
    totals.tables += s.tables;
    totals.nosqlCollections += s.nosqlCollections;
    totals.columns += s.columns;
    totals.fields += s.fields;
    totals.supported += s.supported;
    totals.partial += s.partial;
    totals.unsupported += s.unsupported;
    perApp.push({
      link: app.link,
      tables: s.tables,
      columns: s.columns,
      fields: s.fields,
      supported: s.supported,
      partial: s.partial,
      unsupported: s.unsupported,
    });
    for (const field of plan.fields) addUnmapped(unmapped, field);
  }
  perApp.sort((a, b) => compareEnUs(a.link, b.link));
  const kinds = [...unmapped.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || compareEnUs(a.type, b.type));
  return {
    apps: perApp.length,
    failed,
    ...totals,
    mappedPct: totals.fields === 0 ? null : Math.round(((totals.supported + totals.partial) * 1000) / totals.fields) / 10,
    unmapped: kinds,
    perApp,
  };
}

function addUnmapped(unmapped: Map<string, number>, field: FieldOutcome): void {
  if (field.status !== 'unsupported') return;
  unmapped.set(field.creatorType, (unmapped.get(field.creatorType) ?? 0) + 1);
}

export function formatCorpusReport(numbers: CorpusNumbers, opts?: { label?: string; date?: string }): string {
  const label = opts?.label ?? 'corpus';
  const date = opts?.date ?? '';
  const lines: string[] = [];
  lines.push(`# Schema report: ${label}`);
  lines.push('');
  if (date) lines.push(`Generated ${date}. Counts come from the schema generator. No field values are included.`);
  else lines.push('Counts come from the schema generator. No field values are included.');
  lines.push('');
  lines.push('## Counting');
  lines.push('');
  lines.push('- One app is one sub-folder (or one loose .ds file). The link is that name.');
  lines.push('- A field is a form field, plus each inline-subform subfield. Composite name/address parts are columns of the parent field, not extra fields.');
  lines.push('- Supported, partial, and unsupported are the mapping status. Mapped = supported + partial.');
  lines.push('- Unmapped kinds are unsupported creator type tokens, including types with no mapping row.');
  lines.push('- A form with two or more inline subforms (`type = grid`) is a NoSQL collection. Other forms are Data Store tables. Child tables and junction tables count as tables.');
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- Apps measured: ${numbers.apps}`);
  lines.push(`- Apps failed to plan: ${numbers.failed.length}${numbers.failed.length ? ` (${numbers.failed.join(', ')})` : ''}`);
  lines.push(`- Tables: ${numbers.tables}`);
  lines.push(`- NoSQL collections: ${numbers.nosqlCollections}`);
  lines.push(`- Columns: ${numbers.columns}`);
  lines.push(`- Fields: ${numbers.fields}`);
  lines.push(`- Supported: ${numbers.supported} (${pct(numbers.supported, numbers.fields)})`);
  lines.push(`- Partial: ${numbers.partial} (${pct(numbers.partial, numbers.fields)})`);
  lines.push(`- Unsupported: ${numbers.unsupported} (${pct(numbers.unsupported, numbers.fields)})`);
  lines.push(`- Mapped: ${numbers.mappedPct === null ? 'n/a' : `${numbers.mappedPct.toFixed(1)}%`}`);
  lines.push('');
  lines.push('## Top unmapped field kinds');
  lines.push('');
  if (!numbers.unmapped.length) lines.push('- none');
  else for (const kind of numbers.unmapped.slice(0, 20)) lines.push(`- \`${kind.type}\`: ${kind.count}`);
  lines.push('');
  lines.push('## Per app (counts only)');
  lines.push('');
  lines.push('| App | Tables | Columns | Fields | Supported | Partial | Unsupported |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const app of numbers.perApp) {
    lines.push(`| ${app.link} | ${app.tables} | ${app.columns} | ${app.fields} | ${app.supported} | ${app.partial} | ${app.unsupported} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function schemaCorpusMarkdown(dir: string, opts?: { label?: string; date?: string }): string {
  return formatCorpusReport(corpusNumbers(loadCorpusApps(dir)), opts);
}
