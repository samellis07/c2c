import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slateHost } from '../src/slate-host.js';

test('slateHost accepts a bare host or an https URL that is only a host', () => {
  for (const [input, want] of [
    ['app.example.test', 'app.example.test'],
    ['c2c-widget-xyz.onslate.in', 'c2c-widget-xyz.onslate.in'],
    // Every Slate data-centre host and a custom domain accept the same way.
    ['x-y.onslate.com', 'x-y.onslate.com'],
    ['x-y.onslate.eu', 'x-y.onslate.eu'],
    ['x-y.onslate.in', 'x-y.onslate.in'],
    ['x-y.onslate.com.au', 'x-y.onslate.com.au'],
    ['x-y.onslate.jp', 'x-y.onslate.jp'],
    ['x-y.onslate.ca', 'x-y.onslate.ca'],
    ['x-y.onslate.sa', 'x-y.onslate.sa'],
    ['x-y.onslate.ae', 'x-y.onslate.ae'],
    ['portal.example.co.uk', 'portal.example.co.uk'],
    // Mixed case lowercases; a punycode last label is a real TLD.
    ['APP.Example.TEST', 'app.example.test'],
    ['app.example.xn--p1ai', 'app.example.xn--p1ai'],
    ['https://app.example.test', 'app.example.test'],
    ['https://app.example.test/', 'app.example.test'],
    ['  app.example.test  ', 'app.example.test'],
  ] as const) {
    assert.equal(slateHost(input), want, input);
  }
});

test('slateHost refuses wildcards, userinfo, ports, paths, queries and other schemes', () => {
  for (const input of [
    '*.onslate.in',
    ['app.example.test', 'evil.example'].join('@'),
    'evil.example/x?a=',
    'evil.example/x',
    'evil.example?q=1',
    'app.example.test:8443',
    'http://app.example.test',
    '//app.example.test',
    'https://app.example.test/x',
    'https://app.example.test/?x=1',
    'app.example.test","iframe":false,"x":"',
    '',
    '   ',
    undefined,
  ] as const) {
    assert.equal(slateHost(input), undefined, JSON.stringify(input));
  }
});

test('slateHost refuses malformed labels, a trailing dot and host lookalikes', () => {
  for (const input of [
    // A trailing dot is a different origin string than the real Slate host,
    // so a frame allowlist entry would never match it.
    'app.example.test.',
    'app.example.test.  ',
    'app.example.test..',
    // Empty labels and labels that start or end on a hyphen are not hosts.
    'a..b.test',
    'a-.test',
    '-a.test',
    'a.-b.test',
    // A bare address, a hex address and a single label are not Slate hosts.
    '0x7f.1',
    '127.0.0.1',
    'localhost',
    'app',
    // A last label with digits is a number to a URL parser — 127.0.0.0x1 is
    // 127.0.0.1 — so the last label is letters only (or an xn-- TLD).
    '127.0.0.0x1',
    '1.0x7f',
    '0x7f.0x1',
    '10.0.0.0xa',
    '192.168.0.0xff',
    'evil.0x1',
    // No label may read as a number to a URL parser, wherever it sits:
    // hex, octal-looking and all-digit labels all refuse.
    '0177.0.0.1',
    '0x7f.evil.com',
    'a.0177.com',
    'a.0x1.com',
  ] as const) {
    assert.equal(slateHost(input), undefined, JSON.stringify(input));
  }
});
