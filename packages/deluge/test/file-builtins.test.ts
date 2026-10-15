import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRuntime } from '../../shims/src/runtime.js';
import { actualname, getFileName } from '../../shims/src/file-values.js';
import { repoRoot } from '../src/catalogue.js';
import { translate } from '../src/translate.js';

const HASH = 'a'.repeat(64);
const KEY = `uploads/Order/Photo/${HASH}/a.png`;
const CREATOR = '/api/v2.1/owner/app/report/All_Orders/1/Photo/download?filepath=cat%20pic.jpg';

function server(src: string): string {
  return translate(src).server.replace(/^\s*\/\/ Deluge: .*\n?/gm, '');
}

test('file name builtins translate to shim.file and do not emit shim.todo', () => {
  const name = server('x = input.File_upload.getFileName();');
  assert.match(name, /shim\.file\.getFileName\(shim\.input\.get\(ctx, "File_upload"\)\)/);
  assert.doesNotMatch(name, /shim\.todo/);

  const alias = server('x = input.File_upload.GETFILENAME();');
  assert.match(alias, /shim\.file\.getFileName\(shim\.input\.get\(ctx, "File_upload"\)\)/);

  const uploaded = server('x = input.File_upload.actualname();');
  assert.match(uploaded, /shim\.file\.actualname\(shim\.input\.get\(ctx, "File_upload"\)\)/);
  assert.doesNotMatch(uploaded, /shim\.todo/);
});

test('file tasks with no stored bytes, type, charset, or password stay named manual items', () => {
  const cases: [string, string][] = [
    ['x = input.File_upload.getFileSize();', 'file:getFileSize'],
    ['x = input.File_upload.getFileType();', 'file:getFileType'],
    ['x = input.File_upload.getFileContent();', 'file:getFileContent'],
    ['x = input.File_upload.content();', 'file:content'],
    ['x = input.File_upload.setFileName("x");', 'file:setFileName'],
    ['input.File_upload.setFileName("x");', 'file:setFileName'],
    ['x = input.File_upload.setFileType("x");', 'file:setFileType'],
    ['x = input.File_upload.setCharSet("x");', 'file:setCharSet'],
    ['x = input.File_upload.setFilePassword("x");', 'file:setFilePassword'],
  ];
  for (const [src, construct] of cases) {
    const result = translate(src);
    assert.match(server(src), new RegExp(`await shim\\.todo\\(ctx, ${JSON.stringify(construct).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
    assert.ok(result.todos.some((item) => item.construct === construct), `${construct} missing from todos`);
    assert.doesNotMatch(server(src), /shim\.file\./);
  }
});

test('file-content TODOs pin the Creator upload-field source and its adapter limit', () => {
  const dispatch = readFileSync(join(repoRoot(), 'packages/deluge/src/dispatch.ts'), 'utf8');
  assert.match(dispatch, /Creator upload fields/);
  assert.match(dispatch, /`content` is the documented attribute/);
  assert.match(dispatch, /https:\/\/www\.zoho\.com\/deluge\/help\/file-attributes\/content\.html/);
  assert.match(dispatch, /Stratus object key/);
  assert.match(dispatch, /no head or metadata read/);
  assert.match(dispatch, /never retained on the stored value/);

  const docs = JSON.parse(readFileSync(join(repoRoot(), 'packages/deluge/data/builtin-docs.json'), 'utf8')) as {
    entries: { name: string; docUrl: string }[];
  };
  const urls = new Map(docs.entries.map((entry) => [entry.name, entry.docUrl]));
  assert.equal(urls.get('content'), 'https://www.zoho.com/deluge/help/file-attributes/content.html');

  // The adapter really cannot read size/type: FileStore only signs GET/PUT.
  const files = readFileSync(join(repoRoot(), 'packages/shims/src/files.ts'), 'utf8');
  const store = files.match(/export interface FileStore \{([^}]*)\}/);
  assert.ok(store, 'FileStore interface not found');
  assert.match(store[1], /signedUrl/);
  assert.doesNotMatch(store[1], /\b(head|metadata|stat|size|type)\b/i);
});

test('file-content TODOs pin the invokeUrl FILE source and its body-only adapter', () => {
  const dispatch = readFileSync(join(repoRoot(), 'packages/deluge/src/dispatch.ts'), 'utf8');
  assert.match(dispatch, /invokeUrl FILE responses/);
  assert.match(dispatch, /getFileContent\/getFileSize\/getFileType/);
  assert.match(dispatch, /documented for the FILE value invokeUrl returns/);
  for (const slug of ['get-file-content', 'get-file-size', 'get-file-type']) {
    assert.match(dispatch, new RegExp(`https:\\/\\/www\\.zoho\\.com\\/deluge\\/help\\/file\\/${slug}\\.html|${slug}\\.html`));
  }
  assert.match(dispatch, /returns only the parsed HTTP body/);
  assert.match(dispatch, /guessing from a filename would not implement the documented/);

  const docs = JSON.parse(readFileSync(join(repoRoot(), 'packages/deluge/data/builtin-docs.json'), 'utf8')) as {
    entries: { name: string; docUrl: string }[];
  };
  const urls = new Map(docs.entries.map((entry) => [entry.name, entry.docUrl]));
  assert.equal(urls.get('getFileContent'), 'https://www.zoho.com/deluge/help/file/get-file-content.html');
  assert.equal(urls.get('getFileSize'), 'https://www.zoho.com/deluge/help/file/get-file-size.html');
  assert.equal(urls.get('getFileType'), 'https://www.zoho.com/deluge/help/file/get-file-type.html');

  // The adapter really returns only the body: no FILE value is produced.
  const adapters = readFileSync(join(repoRoot(), 'packages/shims/src/zoho-adapters.ts'), 'utf8');
  const response = adapters.match(/export function invokeurlResponse\(reply: RestReply\): unknown \{([\s\S]*?)\}/);
  assert.ok(response, 'invokeurlResponse not found');
  assert.match(response[1], /plain\(reply\.body\)/);
});

test('a shimmed file builtin body does not call shim.todo', () => {
  const src = readFileSync(join(repoRoot(), 'packages/shims/src/file-values.ts'), 'utf8');
  assert.doesNotMatch(src, /shim\.todo/);
  const shim = createRuntime({ dryRun: true, appTimeZone: 'UTC' }).shim;
  for (const name of ['getFileName', 'actualname'] as const) {
    assert.equal(typeof shim.file[name], 'function');
    assert.doesNotMatch(Function.prototype.toString.call(shim.file[name]), /todo/);
  }
  assert.equal('setFileName' in shim.file, false);
});

test('getFileName and actualname evaluate on file keys, blanks, and non-files', () => {
  assert.equal(getFileName(KEY), 'a.png');
  assert.equal(getFileName({ key: KEY }), 'a.png');
  assert.equal(getFileName(`migrated/Order/Photo/12/scan.pdf`), 'scan.pdf');
  assert.equal(getFileName(CREATOR), 'cat pic.jpg');
  assert.equal(getFileName('/api/v2.1/owner/app/report/R/1/Photo/download'), null);
  assert.equal(getFileName(null), null);
  assert.equal(getFileName(''), null);
  assert.equal(getFileName('   '), null);
  assert.equal(getFileName(-1), null);
  assert.equal(getFileName(0), null);
  assert.equal(getFileName({ key: KEY, Status: 'Open' }), null);

  assert.equal(actualname(KEY), 'a.png');
  assert.equal(actualname(CREATOR), 'cat pic.jpg');
  assert.equal(actualname(null), null);
  assert.equal(actualname(''), null);
  assert.equal(actualname(-1), null);

  const held = { key: KEY, name: 'keep.txt' };
  assert.equal(getFileName(held), 'keep.txt');
  assert.equal(actualname(held), 'a.png');
});
