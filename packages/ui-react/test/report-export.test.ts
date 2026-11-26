/**
 * Report export: the CSV and XLSX a report offers carry the columns and rows
 * on screen, neutralise spreadsheet formulas, name the file safely and stay
 * bounded. Pure functions; no DOM.
 */
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { MAX_EXPORT_ROWS, boundRows, buildCsv, buildXlsx, csvCell, exportFilename } from '../template/lib/c2c-ui/report/export.js';

const columns = [
  { key: 'Title', label: 'Title' },
  { key: 'Total', label: 'Total' },
];

test('csvCell neutralises a leading formula character', () => {
  for (const lead of ['=', '+', '-', '@', '\t', '\r', '\n', '\f', '\v', String.fromCharCode(0)]) {
    const out = csvCell(`${lead}SUM(A1)`);
    assert.ok(out.replace(/^"/, '').startsWith("'"), `${JSON.stringify(lead)} is prefixed`);
  }
  assert.equal(csvCell('plain'), 'plain');
});

test('csvCell keeps a plain negative or grouped number as is', () => {
  assert.equal(csvCell('-12.50'), '-12.50');
  assert.equal(csvCell('"1,200.00"'.slice(1, -1)), '"1,200.00"');
});

test('csvCell quotes commas, quotes and line breaks', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('l1\nl2'), '"l1\nl2"');
});

test('buildCsv keeps column and row order, a BOM and CRLF, and the shown text', () => {
  const csv = buildCsv(columns, [['=cmd|x', '1,200.50'], ['café', '-3']]);
  assert.equal(csv, '﻿Title,Total\r\n\'=cmd|x,"1,200.50"\r\ncafé,-3\r\n');
});

test('a header that starts with a formula character is neutralised too', () => {
  assert.ok(buildCsv([{ key: 'a', label: '=HYPERLINK("x")' }], []).includes("\"'=HYPERLINK"));
});

test('exportFilename is a safe basename', () => {
  assert.equal(exportFilename('Open Orders', 'csv'), 'Open-Orders.csv');
  assert.equal(exportFilename('../../etc/passwd', 'csv'), 'etc-passwd.csv');
  assert.equal(exportFilename('a\\b:c*?"<>|', 'xlsx'), 'a-b-c.xlsx');
  assert.equal(exportFilename('...', 'csv'), 'report.csv');
  assert.equal(exportFilename('x'.repeat(300), 'csv').length, 64 + 4);
});

test('boundRows caps the export and says so', () => {
  const rows = Array.from({ length: MAX_EXPORT_ROWS + 5 }, (_, i) => [String(i)]);
  const out = boundRows(rows);
  assert.equal(out.rows.length, MAX_EXPORT_ROWS);
  assert.equal(out.truncated, 5);
  assert.equal(boundRows(rows.slice(0, 3)).truncated, 0);
});

function unzip(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const files = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const size = view.getUint32(at + 18, true);
    const nameLen = view.getUint16(at + 26, true);
    const extraLen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const start = at + 30 + nameLen + extraLen;
    const data = zip.subarray(start, start + size);
    files.set(name, new TextDecoder().decode(method === 8 ? inflateRawSync(data) : data));
    at = start + size;
  }
  return files;
}

test('buildXlsx writes the same header, rows and order as text cells, never formulas', () => {
  const files = unzip(buildXlsx('Orders', columns, [['=1+1', '1,200.50'], ['b & <c>', '2']]));
  const sheet = files.get('xl/worksheets/sheet1.xml') ?? '';
  assert.ok(files.has('[Content_Types].xml') && files.has('xl/workbook.xml'));
  assert.ok(!sheet.includes('<f>'));
  assert.ok(sheet.includes('t="inlineStr"'));
  const texts = [...sheet.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]);
  assert.deepEqual(texts, ['Title', 'Total', '=1+1', '1,200.50', 'b &amp; &lt;c&gt;', '2']);
});

test('buildXlsx sheet name is valid and a control character is dropped', () => {
  const files = unzip(buildXlsx('A/B:[x]?*' + 'y'.repeat(40), columns, [['a\u0001b', '1']]));
  const name = /<sheet name="([^"]*)"/.exec(files.get('xl/workbook.xml') ?? '')?.[1] ?? '';
  assert.ok(name.length > 0 && name.length <= 31 && !/[\\/?*[\]:]/.test(name));
  assert.ok(!(files.get('xl/worksheets/sheet1.xml') ?? '').includes('\u0001'));
});
