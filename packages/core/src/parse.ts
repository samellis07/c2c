import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
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

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * True when `path` reads as a directory. The directory read is the check, so
 * no stat can be raced by a swap. A missing path, or a path under a file
 * (ENOENT/ENOTDIR), is false; any other error is thrown.
 */
export function isDirectoryPath(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

/** True when `path` opens as a regular file. One O_NONBLOCK open, then fstat on that descriptor. */
function isFilePath(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
  try {
    return fstatSync(fd).isFile();
  } finally {
    closeSync(fd);
  }
}

/** Directory entries sorted by name (code-unit order, as `Array#sort` on names). */
function sortedEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** A directory entry that is, or links to, a directory. A dangling link is not. */
function entryIsDirectory(entry: Dirent, path: string): boolean {
  if (entry.isDirectory()) return true;
  return entry.isSymbolicLink() && isDirectoryPath(path);
}

/** All `.ds` files under a directory, sorted, as absolute paths. A symlink is classified by its target. */
export function listDsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const ent of sortedEntries(d)) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = join(d, ent.name);
      if (entryIsDirectory(ent, p)) {
        walk(p);
        continue;
      }
      const lower = ent.name.toLowerCase();
      if (!lower.endsWith('.ds') || lower.endsWith('.exported.ds')) continue;
      if (ent.isFile() || (ent.isSymbolicLink() && isFilePath(p))) out.push(p);
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
    let entries: Dirent[];
    try {
      entries = sortedEntries(d);
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const p = join(d, ent.name);
      if (entryIsDirectory(ent, p)) {
        walk(p);
        continue;
      }
      if (!ent.isFile() && !ent.isSymbolicLink()) continue;
      const lower = ent.name.toLowerCase();
      const isHtml = lower.endsWith('.html') || lower.endsWith('.htm');
      const isJson = lower.endsWith('.json');
      if (!isHtml && !isJson) continue;
      // The entry kind already says regular file, and html needs no read.
      if (isHtml && ent.isFile()) {
        html = true;
        continue;
      }
      // One descriptor: its fstat decides regular-file and size, and the
      // same descriptor is read, so a swap of the path cannot redirect it.
      let fd: number;
      try {
        fd = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        throw err;
      }
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) continue;
        if (isHtml) html = true;
        if (!isJson) continue;
        json = true;
        if (st.size > WIDGET_JSON_CAP) continue;
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
 * `sidecars/widgets/<name>/`. A package is not a `.ds` file, so `listDsFiles`
 * does not return it. The directory name is always kept. A manifest name is
 * kept as well when it differs.
 */
export function listWidgetSidecars(dir: string): WidgetSidecar[] {
  const out: WidgetSidecar[] = [];
  const walk = (d: string, rel: string[]) => {
    let entries: Dirent[];
    try {
      entries = sortedEntries(d);
    } catch {
      return;
    }
    if (rel.length >= 2 && rel[rel.length - 2] === 'sidecars' && rel[rel.length - 1] === 'widgets') {
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const p = join(d, ent.name);
        if (!entryIsDirectory(ent, p)) continue;
        const flags = packageFlags(p);
        const path = [...rel, ent.name].join('/');
        for (const widgetName of [...new Set([ent.name, ...flags.names])].sort(compareEnUs)) {
          out.push({ name: widgetName, path, html: flags.html, json: flags.json });
        }
      }
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.')) continue;
      const p = join(d, ent.name);
      if (!entryIsDirectory(ent, p)) continue;
      walk(p, [...rel, ent.name]);
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
