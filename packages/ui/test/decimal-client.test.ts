import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decimal } from '../../shims/src/decimal.js';

test('browser decimal matches the server exact decimal and does not use binary64', async () => {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    clientDecimal: () => {
      from: (v: unknown) => string;
      add: (a: unknown, b: unknown) => string;
      sub: (a: unknown, b: unknown) => string;
      mul: (a: unknown, b: unknown) => string;
      div: (a: unknown, b: unknown) => string;
      cmp: (a: unknown, b: unknown, op: string) => boolean;
    };
    browserShim: () => { decimal: { cmp: (a: unknown, b: unknown, op: string) => boolean; mul: (a: unknown, b: unknown) => string } };
  };
  const client = mod.clientDecimal();
  const pairs: [unknown, unknown][] = [
    ['0.1', '0.2'],
    ['10', '25.50'],
    [10, 25.5],
    ['-0.005', '2'],
    ['12345678901234.56', '0.01'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(client.add(a, b), decimal.add(a as string | number, b as string | number).toString());
    assert.equal(client.sub(a, b), decimal.sub(a as string | number, b as string | number).toString());
    assert.equal(client.mul(a, b), decimal.mul(a as string | number, b as string | number).toString());
    assert.equal(client.div(a, b), decimal.div(a as string | number, b as string | number).toString());
    for (const op of ['<', '>', '<=', '>=', '==', '!=']) {
      assert.equal(client.cmp(a, b, op), decimal.cmp(a as string | number, b as string | number, op), `${String(a)} ${op} ${String(b)}`);
    }
  }
  assert.equal(client.mul('10', '25.50'), '255.00');
  assert.equal(client.mul(10, 25.5), '255.0');
  assert.equal(client.add('0.1', '0.2'), '0.3');
  assert.notEqual(client.add('0.1', '0.2'), String(0.1 + 0.2));
  assert.equal(client.cmp('', '1000', '>='), false);
  assert.equal(client.cmp('25.50', '0', '<'), false);
  assert.equal(client.cmp('-10', '0', '<'), true);
  const shim = mod.browserShim();
  assert.equal(shim.decimal.cmp('25.50', 0, '<'), false);
  assert.equal(shim.decimal.mul('10', '25.50'), '255.00');
  assert.equal(typeof shim.decimal.mul('10', '25.50'), 'string');
});
