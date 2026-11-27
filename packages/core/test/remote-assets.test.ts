import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAssetUrl, extensionForContentType, isDeniedAddress, parseAssetLock, readPlainFile, sniffImage } from '../src/remote-assets.js';

test('checkAssetUrl accepts a plain https host and refuses everything else', () => {
  assert.equal(checkAssetUrl('https://img.example.com/a/b.png?x=1').ok, true);
  const refused: Array<[string, RegExp]> = [
    ['http://img.example.com/a.png', /only https/],
    ['ftp://img.example.com/a.png', /only https/],
    ['//img.example.com/a.png', /does not parse/],
    ['data:image/png;base64,AAAA', /only https/],
    ['https://user:pw@img.example.com/a.png', /credentials/],
    ['https://img.example.com:8443/a.png', /port/],
    ['https://localhost/a.png', /single-label|local/],
    ['https://app.localhost/a.png', /local or internal/],
    ['https://printer.local/a.png', /local or internal/],
    ['https://metadata.google.internal/a.png', /local or internal/],
    ['https://intranet/a.png', /single-label/],
    ['https://127.0.0.1/a.png', /ip address/],
    ['https://169.254.169.254/latest/meta-data', /ip address/],
    ['https://[::1]/a.png', /ip address/],
    ['https://2130706433/a.png', /ip address/],
    ['https://0x7f.0.0.1/a.png', /ip address/],
    ['https://10.0.0.1/a.png', /ip address/],
  ];
  for (const [url, why] of refused) {
    const result = checkAssetUrl(url);
    assert.equal(result.ok, false, url);
    if (!result.ok) assert.match(result.reason, why, url);
  }
});

test('isDeniedAddress covers private, loopback, link-local, metadata and mapped forms', () => {
  const denied = [
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '2002:c0a8:101::1', '2001:db8::1', 'not an address',
  ];
  for (const address of denied) assert.equal(isDeniedAddress(address), true, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(isDeniedAddress(address), false, address);
});

test('sniffImage reads the signature and knows no svg', () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a')), 'gif');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), undefined);
  assert.equal(sniffImage(Buffer.from('<html></html>')), undefined);
  assert.equal(sniffImage(Buffer.alloc(0)), undefined);
});

test('extensionForContentType allows four image types and not svg', () => {
  assert.equal(extensionForContentType('image/png'), 'png');
  assert.equal(extensionForContentType('IMAGE/JPEG; charset=binary'), 'jpg');
  assert.equal(extensionForContentType('image/gif'), 'gif');
  assert.equal(extensionForContentType('image/webp'), 'webp');
  for (const type of ['image/svg+xml', 'text/html', 'application/octet-stream', '', undefined]) assert.equal(extensionForContentType(type), undefined, String(type));
});

test('parseAssetLock keeps well-formed entries once and ignores a wrong version or junk', () => {
  assert.deepEqual(parseAssetLock('not json'), []);
  assert.deepEqual(parseAssetLock(JSON.stringify({ version: 2, entries: [] })), []);
  const entries = parseAssetLock(
    JSON.stringify({
      version: 1,
      entries: [{ url: 'https://a.example.com/x.png', status: 'refused', reason: 'r' }, { url: 'https://a.example.com/x.png', status: 'failed' }, { url: 5, status: 'failed' }, { url: 'https://b.example.com/', status: 'weird' }, 'x'],
    }),
  );
  assert.deepEqual(entries, [{ url: 'https://a.example.com/x.png', status: 'refused', reason: 'r' }]);
});

test('readPlainFile reads a plain file and refuses a link, a directory, a FIFO, an oversize file and a missing path without blocking', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-plain-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plain = join(dir, 'plain.json');
  writeFileSync(plain, 'hello');
  assert.equal(readPlainFile(plain, 100)?.toString('utf8'), 'hello');
  assert.equal(readPlainFile(plain, 3), undefined, 'over the size cap');
  symlinkSync(plain, join(dir, 'link.json'));
  assert.equal(readPlainFile(join(dir, 'link.json'), 100), undefined, 'a symbolic link is not followed');
  assert.equal(readPlainFile(dir, 100), undefined, 'a directory');
  assert.equal(readPlainFile(join(dir, 'missing.json'), 100), undefined, 'a missing path');
  const fifo = join(dir, 'pipe');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    return; // no mkfifo on this platform
  }
  // An open of a FIFO without O_NONBLOCK waits for a writer for ever; this returns at once.
  assert.equal(readPlainFile(fifo, 100), undefined, 'a FIFO');
});
