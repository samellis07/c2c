/**
 * Report export: CSV and XLSX of the rows a report shows, in the columns and
 * order on screen, with the cell text the table draws. Cells are text; an
 * XLSX cell is an inline string, never a formula. A CSV cell that starts with
 * a formula character is prefixed with an apostrophe so a spreadsheet reads it
 * as text. The file name is a safe basename, and the export is bounded.
 */

/** The most data rows one export carries; the report says when it stops short. */
export const MAX_EXPORT_ROWS = 10000;

export interface ExportColumn {
  key: string;
  label: string;
}

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NEGATIVE = /^-\d[\d,]*(\.\d+)?$/;

/** One CSV cell: formula-neutralised, then quoted when it holds a comma, quote or line break. */
export function csvCell(text: string): string {
  const safe = FORMULA_LEAD.test(text) && !PLAIN_NEGATIVE.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** UTF-8 BOM, a header row and the rows, CRLF-terminated. */
export function buildCsv(columns: readonly ExportColumn[], rows: readonly (readonly string[])[]): string {
  const lines = [columns.map((c) => csvCell(c.label)), ...rows.map((r) => columns.map((_, i) => csvCell(r[i] ?? '')))];
  return `﻿${lines.map((l) => l.join(',')).join('\r\n')}\r\n`;
}

/** A download name made of letters, digits, dot, underscore and dash only; at most 64 characters before the extension. */
export function exportFilename(label: string, ext: 'csv' | 'xlsx'): string {
  const base = label
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64)
    .replace(/[-.]+$/g, '');
  return `${base || 'report'}.${ext}`;
}

/** The first MAX_EXPORT_ROWS rows and how many were left out. */
export function boundRows<T>(rows: readonly T[]): { rows: T[]; truncated: number } {
  return { rows: rows.slice(0, MAX_EXPORT_ROWS), truncated: Math.max(0, rows.length - MAX_EXPORT_ROWS) };
}

const xmlText = (text: string): string =>
  text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function columnRef(index: number): string {
  let ref = '';
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) ref = String.fromCharCode(65 + (n % 26)) + ref;
  return ref;
}

let crcTable: Uint32Array | undefined;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A ZIP of stored (uncompressed) entries. */
function zip(entries: readonly [string, string][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const head = new Uint8Array(46 + nameBytes.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x02014b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 20, true);
    hv.setUint16(8, 0x0800, true);
    hv.setUint32(16, crc, true);
    hv.setUint32(20, data.length, true);
    hv.setUint32(24, data.length, true);
    hv.setUint16(28, nameBytes.length, true);
    hv.setUint32(42, offset, true);
    head.set(nameBytes, 46);
    parts.push(local, data);
    central.push(head);
    offset += local.length + data.length;
  }
  const dirSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A one-sheet workbook; every cell is an inline string, so no cell is ever evaluated. */
export function buildXlsx(sheetName: string, columns: readonly ExportColumn[], rows: readonly (readonly string[])[]): Uint8Array {
  const name = sheetName.replace(/[\\/?*[\]:]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Report';
  const cell = (text: string, col: number, row: number) => `<c r="${columnRef(col)}${row}" t="inlineStr"><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
  const line = (cells: readonly string[], row: number) => `<row r="${row}">${cells.map((t, i) => cell(t, i, row)).join('')}</row>`;
  const body = [line(columns.map((c) => c.label), 1), ...rows.map((r, i) => line(columns.map((_, c) => r[c] ?? ''), i + 2))].join('');
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  return zip([
    ['[Content_Types].xml', `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${xml}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `${xml}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`],
  ]);
}

/** The parts of a window a download needs. */
export interface DownloadWindow {
  document: Document;
  URL: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
  Blob: new (parts: unknown[], init?: { type?: string }) => unknown;
  setTimeout(handler: () => void, ms: number): unknown;
}

/** Hand a file to the browser as a download through a short-lived object URL. */
export function downloadFile(win: DownloadWindow, name: string, mime: string, data: string | Uint8Array): void {
  const url = win.URL.createObjectURL(new win.Blob([data], { type: mime }));
  const link = win.document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  win.document.body.appendChild(link);
  link.click();
  link.remove();
  win.setTimeout(() => win.URL.revokeObjectURL(url), 0);
}
