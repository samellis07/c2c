/**
 * connect-src names the app's Advanced I/O origin and refuses every other host.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { applyFunctionConnectSrc, functionOriginFromApiBase, SHELL_CONTENT_SECURITY_POLICY, shellContentSecurityPolicy } from '../src/csp.js';
import { generateUi } from '../src/generate.js';

const ORIGIN = 'https://c2c-widget-1001.development.catalystserverless.in';
const BASE = `${ORIGIN}/server/c2c_api`;

function shell(apiBase?: string): string {
  const app = deriveIr(parse('application "Demo"\n{\n}\n'));
  return String(generateUi(app, apiBase ? { apiBase } : {}).files.find((file) => file.path === 'slate/index.html')?.data);
}

test('a function URL adds that origin and nothing wider', () => {
  assert.equal(functionOriginFromApiBase(BASE), ORIGIN);
  assert.equal(functionOriginFromApiBase('https://c2c-sample-app-1.catalystserverless.com.au/server/c2c_api'), 'https://c2c-sample-app-1.catalystserverless.com.au');
  assert.equal(functionOriginFromApiBase('https://c2c-sample-app-10000000000.development.catalystserverless.in/server/c2c_api/'), 'https://c2c-sample-app-10000000000.development.catalystserverless.in');
  const html = shell(BASE);
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
  assert.equal(csp, shellContentSecurityPolicy(ORIGIN));
  assert.match(csp, new RegExp(`connect-src 'self' ${ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(csp, /\*/);
  assert.doesNotMatch(html, /\*\.catalystserverless/);
  assert.equal(applyFunctionConnectSrc(shell(), BASE), html);
});

test('relative, foreign, wildcard and non-https bases leave connect-src at self', () => {
  const plain = shell();
  assert.match(plain, new RegExp(`content="${SHELL_CONTENT_SECURITY_POLICY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  for (const apiBase of [
    '/server/c2c_api',
    'https://evil.example/server/c2c_api',
    'https://*.catalystserverless.com/server/c2c_api',
    'https://a.b.catalystserverless.com/server/c2c_api',
    'http://c2c-widget-1001.development.catalystserverless.in/server/c2c_api',
    'https://user:pass@c2c-widget-1001.development.catalystserverless.in/server/c2c_api',
    'https://c2c-widget-1001.development.catalystserverless.in:8443/server/c2c_api',
    'https://c2c-widget-1001.development.catalystserverless.in/not-server/c2c_api',
    'https://c2c-widget-1001.development.catalystserverless.example/server/c2c_api',
  ]) {
    assert.equal(functionOriginFromApiBase(apiBase), undefined, apiBase);
    assert.equal(shell(apiBase), plain, apiBase);
    assert.equal(applyFunctionConnectSrc(plain, apiBase), plain, apiBase);
  }
  assert.equal(applyFunctionConnectSrc('<!doctype html><title>x</title>', BASE), '<!doctype html><title>x</title>');
});
