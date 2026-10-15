import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parseCst, print, type Document, type Statement } from './cst.js';
import type { Dialect } from './dialect.js';
import { deriveIr, emptyApp, linkDeviceViews, type App, type WidgetSidecar } from './ir.js';
import { compareEnUs } from './order.js';
import { decode, encode, isLockedExportSource, LockedExportError, type Encoding } from './source.js';

export interface ParsedFile {
  path: string;
  encoding: Encoding;
  bytes: number;
  cst: Document;
  ir: App;
  /** CST statements represented in the IR, with their role (see `coverage`). */
  roles: Map<Statement, string>;
}

/** Parse source text into the lossless CST. `print(parse(src)) === src`. */
export function parse(source: string): Document {
  return parseCst(source);
}

export { print };

export function parseFile(path: string, relName?: string): ParsedFile {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    if (!fstatSync(fd).isFile()) throw new NotFileError(path);
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  return parseBytes(path, bytes, relName);
}

export class NotFileError extends Error {
  constructor(path: string) {
    super(`${path} is not a file`);
    this.name = 'NotFileError';
  }
}

export function parseBytes(path: string, bytes: Uint8Array, relName?: string): ParsedFile {
  const { text, encoding } = decode(bytes);
  // A locked Marketplace install exports an HTML "Access denied" page, not a
  // .ds. Fail closed here so every ingestion point (precheck, analyze, plan,
  // deploy, schema) refuses it instead of scoring an empty app.
  if (isLockedExportSource(text)) throw new LockedExportError();
  const cst = parseCst(text);
  const roles = new Map<Statement, string>();
  return { path, encoding, bytes: bytes.length, cst, ir: deriveIr(cst, relName, roles), roles };
}

/** Parse a .ds file, or a project directory, classifying by the opened target. */
export function parseFileOrProjectWithSidecars(target: string): { files: ParsedFile[]; ir: App } {
  const fd = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK);
  let isDirectory: boolean;
  let bytes: Buffer | undefined;
  try {
    const stat = fstatSync(fd);
    isDirectory = stat.isDirectory();
    if (!isDirectory) {
      if (!stat.isFile()) throw new NotFileError(target);
      bytes = readFileSync(fd);
    }
  } finally {
    closeSync(fd);
  }
  if (isDirectory) return parseProject(target);
  const file = parseBytes(target, bytes!);
  const widgets = listWidgetSidecars(dirname(target));
  if (widgets.length) file.ir.widgets = widgets;
  return { files: [file], ir: file.ir };
}

/** True when printing the CST matches the file's bytes exactly. */
export function roundTrips(file: ParsedFile, original: Uint8Array = readFileSync(file.path)): boolean {
  return encode(print(file.cst), file.encoding).equals(Buffer.from(original));
}

/** All `.ds` files under a directory, sorted, as absolute paths. Symlinks are not followed. */
export function listDsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(d, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && name.toLowerCase().endsWith('.ds') && !name.toLowerCase().endsWith('.exported.ds')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/**
 * Parse a multi-file (shape C) export folder, or any folder of `.ds` files, into
 * one IR. Spans carry the file path relative to `dir`.
 */
/** A manifest larger than this is still a json file; its names are not read. */
const WIDGET_JSON_CAP = 1_000_000;

export interface WidgetManualItem {
  name: string;
  kind: 'widget';
  status: 'manual' | 'missing';
  path: string;
  detail: string;
}

/** Names declared as `modules.widgets[].name`. Invalid JSON yields none. */
function widgetNamesInJson(text: string): string[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const modules = (parsed as { modules?: unknown }).modules;
  if (!modules || typeof modules !== 'object') return [];
  const widgets = (modules as { widgets?: unknown }).widgets;
  if (!Array.isArray(widgets)) return [];
  const names: string[] = [];
  for (const item of widgets) {
    if (!item || typeof item !== 'object') continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) names.push(name.trim());
  }
  return names;
}

function packageFlags(dir: string): { html: boolean; json: boolean; names: string[] } {
  let html = false;
  let json = false;
  const names: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const p = join(d, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!st.isFile()) continue;
      const lower = name.toLowerCase();
      if (lower.endsWith('.html') || lower.endsWith('.htm')) html = true;
      if (!lower.endsWith('.json')) continue;
      json = true;
      // Read through one descriptor opened without following links, and check
      // the kind and size on that same descriptor, so the file that is read is
      // the file that was checked.
      let fd: number;
      try {
        fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (err) {
        // Gone since the listing, or replaced by a link: skip it, as the
        // lstat walk does. Any other failure is reported as before.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ELOOP') continue;
        throw err;
      }
      try {
        const fst = fstatSync(fd);
        if (!fst.isFile() || fst.size > WIDGET_JSON_CAP) continue;
        names.push(...widgetNamesInJson(readFileSync(fd, 'utf8')));
      } finally {
        closeSync(fd);
      }
    }
  };
  walk(dir);
  return { html, json, names };
}

/**
 * Widget packages next to the `.ds` export: each directory
 * `sidecars/widgets/<name>/`. Symlinks are not followed. A package is not a `.ds` file, so `listDsFiles`
 * does not return it. The directory name is always kept. A manifest name is
 * kept as well when it differs.
 */
export function listWidgetSidecars(dir: string): WidgetSidecar[] {
  const out: WidgetSidecar[] = [];
  const walk = (d: string, rel: string[]) => {
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    if (rel.length >= 2 && rel[rel.length - 2] === 'sidecars' && rel[rel.length - 1] === 'widgets') {
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const p = join(d, name);
        const st = lstatSync(p, { throwIfNoEntry: false });
        if (!st?.isDirectory()) continue;
        const flags = packageFlags(p);
        const path = [...rel, name].join('/');
        for (const widgetName of [...new Set([name, ...flags.names])].sort(compareEnUs)) {
          out.push({ name: widgetName, path, html: flags.html, json: flags.json });
        }
      }
      return;
    }
    for (const name of names) {
      if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
      const p = join(d, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st?.isDirectory()) continue;
      walk(p, [...rel, name]);
    }
  };
  walk(dir, []);
  out.sort((a, b) => compareEnUs(a.path, b.path) || compareEnUs(a.name, b.name));
  return out;
}

/** One manual row per widget package. A package without html or json is `missing`. */
export function widgetManualItems(widgets: readonly WidgetSidecar[] | undefined): WidgetManualItem[] {
  return (widgets ?? []).map((widget) => {
    const missing = [widget.html ? '' : 'html', widget.json ? '' : 'json'].filter((part) => part !== '');
    const status: WidgetManualItem['status'] = missing.length ? 'missing' : 'manual';
    const detail = missing.length
      ? `${widget.name}: widget package is missing ${missing.join(' and ')}`
      : `${widget.name}: widget package (html + json) is not generated; rebuild it by hand`;
    return { name: widget.name, kind: 'widget', status, path: widget.path, detail };
  });
}

/**
 * Exit status for a command that writes a plan. No widget packages → 0.
 * A package that is missing html or json, or a package list that produced
 * no manual row, → 1. A complete package stays 0 because the manual row names it.
 */
export function widgetCommandStatus(widgets: readonly WidgetSidecar[] | undefined): 0 | 1 {
  const list = widgets ?? [];
  if (!list.length) return 0;
  const manual = widgetManualItems(list);
  if (manual.length === 0 || manual.some((item) => item.status === 'missing')) return 1;
  return 0;
}

/**
 * Parse one `.ds` file and attach the widget packages stored next to it
 * (`sidecars/widgets/<name>/` under the file's directory). A bare
 * `parseFile` cannot see them: a widget package is html + json, not `.ds`,
 * so without this the package is neither generated nor listed.
 */
export function parseFileWithSidecars(path: string): ParsedFile {
  const file = parseFile(path);
  const widgets = listWidgetSidecars(dirname(path));
  if (widgets.length) file.ir.widgets = widgets;
  return file;
}

export function parseProject(dir: string): { files: ParsedFile[]; ir: App } {
  const files = listDsFiles(dir).map((p) => parseFile(p, relative(dir, p).split(sep).join('/')));
  const ir = mergeIr(files.map((f) => f.ir));
  ir.files = files.map((f) => relative(dir, f.path).split(sep).join('/'));
  const widgets = listWidgetSidecars(dir);
  if (widgets.length) ir.widgets = widgets;
  return { files, ir };
}

export function mergeIr(apps: App[]): App {
  const shapes = new Set(apps.map((a) => a.shape).filter((s) => s !== 'empty'));
  const merged = emptyApp(shapes.size === 1 ? [...shapes][0] : apps.length > 1 ? 'C' : 'empty'); // determinism-allow: the size check leaves one Set element, so iteration order cannot change the value
  const dialects = new Set(apps.map((a) => a.dialect).filter((d): d is Dialect => d !== undefined && d !== 'snippet'));
  if (dialects.size === 1) merged.dialect = [...dialects][0]; // determinism-allow: size is 1
  else if (dialects.size > 1) merged.dialect = 'ambiguous';
  else if (apps.some((a) => a.dialect === 'snippet')) merged.dialect = 'snippet';
  for (const a of apps) {
    merged.name ??= a.name;
    merged.header ??= a.header;
    merged.settings.push(...a.settings);
    merged.sections.push(...a.sections);
    for (const f of a.forms) {
      const existing = merged.forms.find((x) => x.name === f.name);
      if (existing && (f.fields.length === 0 || existing.fields.length === 0)) {
        const [primary, extra] = existing.fields.length ? [existing, f] : [f, existing];
        primary.properties.push(...extra.properties);
        primary.blocks.push(...extra.blocks);
        if (primary !== existing) merged.forms[merged.forms.indexOf(existing)] = primary;
      } else merged.forms.push(f);
    }
    for (const r of a.reports) {
      // A report re-declared in `reports/<R>/devices/<device>.ds` carries only its device layouts.
      const existing = merged.reports.find((x) => x.name === r.name);
      if (existing && (r.form === undefined || existing.form === undefined)) {
        const [primary, extra] = existing.form !== undefined ? [existing, r] : [r, existing];
        primary.views.push(...extra.views);
        primary.properties.push(...extra.properties);
        primary.blocks.push(...extra.blocks);
        if (primary !== existing) merged.reports[merged.reports.indexOf(existing)] = primary;
      } else merged.reports.push(r);
    }
    merged.pages.push(...a.pages);
    merged.workflows.push(...a.workflows);
    merged.functions.push(...a.functions);
    merged.permissions.push(...a.permissions);
    merged.profiles.push(...a.profiles);
    merged.roles.push(...a.roles);
    merged.shareSettings.push(...a.shareSettings);
    merged.translations.push(...a.translations);
    merged.configuration.push(...a.configuration);
    merged.apis.push(...a.apis);
    for (const d of a.devices) {
      const existing = merged.devices.find((x) => x.device === d.device);
      if (!existing) {
        merged.devices.push(d);
        continue;
      }
      existing.customize ??= d.customize;
      existing.menuPreference ??= d.menuPreference;
      existing.sections.push(...d.sections);
      existing.unused.push(...d.unused);
      existing.forms.push(...d.forms);
      existing.components.push(...d.components);
    }
    merged.unknown.push(...a.unknown);
    merged.unmodelled.push(...a.unmodelled);
    merged.statementCount += a.statementCount;
    if (a.widgets?.length) {
      merged.widgets ??= [];
      for (const widget of a.widgets) {
        if (!merged.widgets.some((row) => row.path === widget.path && row.name === widget.name)) merged.widgets.push(widget);
      }
    }
  }
  linkDeviceViews(merged);
  return merged;
}
