/**
 * Catalyst store errors map to correct statuses and caller-safe
 * field-level messages. Shapes below are the documented Data Store
 * error shapes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyStoreError,
  replyStoreError,
  storeErrorMessage,
  storeErrorStatus,
} from '../src/store-errors.js';
import { WriteRuleError } from '../src/write-rules.js';

function sdkError(message: string, statusCode: number, code: string): Error {
  return Object.assign(new Error(message), { statusCode, code });
}

test('duplicate maps 409 and names the field', () => {
  const err = sdkError('Duplicate value for SKU. Please give a different value', 409, 'DUPLICATE_VALUE');
  assert.deepEqual(classifyStoreError(err), { code: 'DUPLICATE_VALUE', field: 'SKU' });
  assert.equal(storeErrorStatus('DUPLICATE_VALUE'), 409);
  const message = storeErrorMessage('DUPLICATE_VALUE', 'SKU', 'Product');
  assert.match(message, /SKU/, 'the caller message names the field');
  assert.doesNotMatch(message, /Please give a different value/, 'Catalyst text never reaches the caller');
});

test('missing mandatory maps 422 (store 403) and names the field', () => {
  const err = sdkError('Column Vendor is mandatory and cannot be empty', 403, 'MANDATORY_MISSING');
  assert.deepEqual(classifyStoreError(err), { code: 'MANDATORY_MISSING', field: 'Vendor' });
  assert.equal(storeErrorStatus('MANDATORY_MISSING'), 422);
  assert.match(storeErrorMessage('MANDATORY_MISSING', 'Vendor', 'Purchase_Order'), /Vendor/);
});

test('invalid input maps 400 and names the field', () => {
  const err = sdkError('Invalid input value for Order_Date. date value expected', 400, 'INVALID_INPUT');
  assert.deepEqual(classifyStoreError(err), { code: 'INVALID_INPUT', field: 'Order_Date' });
  assert.equal(storeErrorStatus('INVALID_INPUT'), 400);
});

test('REST envelope shape classifies too', () => {
  const err = Object.assign(new Error('request failed'), {
    statusCode: 403,
    data: { error_code: 'MANDATORY_MISSING', message: 'Column c2c_source_id is mandatory and cannot be empty' },
  });
  assert.deepEqual(classifyStoreError(err), { code: 'MANDATORY_MISSING', field: 'c2c_source_id' });
});

test('a bare message without a code still classifies', () => {
  const err = Object.assign(new Error('Invalid input value for Amount. number value expected'), { statusCode: 400 });
  assert.deepEqual(classifyStoreError(err), { code: 'INVALID_INPUT', field: 'Amount' });
});

test('non-store errors do not classify', () => {
  assert.equal(classifyStoreError(new Error('boom')), null);
  assert.equal(classifyStoreError(Object.assign(new Error('x'), { code: 'RECORD_ACCESS_DENIED' })), null);
  assert.equal(classifyStoreError(null), null);
});

test('reply sends the mapped status with dryRun of the real mode and logs structurally', () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    const sent: { status: number; body: Record<string, unknown> }[] = [];
    const res = {
      writeHead(status: number) {
        sent.push({ status, body: {} });
      },
      end(raw: string) {
        sent[0]!.body = JSON.parse(raw) as Record<string, unknown>;
      },
    };
    const err = sdkError('Duplicate value for SKU. Please give a different value', 409, 'DUPLICATE_VALUE');
    assert.equal(replyStoreError(res, err, { live: true, table: 'Product', wrote: false }), true);
    assert.equal(sent[0]!.status, 409);
    assert.equal(sent[0]!.body.code, 'DUPLICATE_VALUE');
    assert.equal(sent[0]!.body.dryRun, false, 'dryRun reflects the live mode');
    assert.equal(sent[0]!.body.field, 'SKU');
    assert.match(String(sent[0]!.body.message), /SKU/);
    assert.doesNotMatch(String(sent[0]!.body.message), /Please give/);
    assert.ok(typeof sent[0]!.body.requestId === 'string' && sent[0]!.body.requestId.length > 0);
    assert.equal(logged.length, 1, 'one structured log line');
    const line = JSON.parse(logged[0]!) as Record<string, unknown>;
    assert.equal(line.code, 'DUPLICATE_VALUE');
    assert.equal(line.table, 'Product');
    assert.equal(line.field, 'SKU');
    assert.equal(typeof line.requestId, 'string');
    assert.doesNotMatch(logged[0]!, /SKU 01/, 'no record values in the log');
    assert.doesNotMatch(logged[0]!, /Please give a different value/, 'no Catalyst text needed in the log');
  } finally {
    console.error = original;
  }
});

test('reply returns false for non-store errors and sends nothing', () => {
  let calls = 0;
  const res = {
    writeHead() {
      calls += 1;
    },
    end() {},
  };
  assert.equal(replyStoreError(res, new Error('boom'), { live: true, table: 'Product', wrote: false }), false);
  assert.equal(calls, 0);
});

// Runtime errors and user text never classify as store errors.
test('c2c errors never classify, even with a store-shaped message', () => {
  const shaped = 'Duplicate value for Admin. Please give a different value';
  for (const code of ['DELUGE_RUNTIME', 'DELUGE_CONVERSION', 'RECORD_ACCESS_DENIED', 'DELETE_REFUSED', 'ZOHO_CONNECTION_REFUSED']) {
    assert.equal(classifyStoreError(Object.assign(new Error(shaped), { code })), null, code);
  }
  for (const name of ['DelugeConversionError', 'RecordAccessError']) {
    const err = new Error('Column Secret_Field is mandatory and cannot be empty');
    err.name = name;
    assert.equal(classifyStoreError(err), null, name);
  }
});

test('store-like text inside another message does not classify', () => {
  assert.equal(classifyStoreError(new Error('Deluge runtime: value "Column Secret_Field is mandatory" rejected')), null);
  assert.equal(classifyStoreError(new Error('Duplicate value for Admin. x')), null);
  assert.equal(classifyStoreError(new Error('note DUPLICATE_VALUE from the user')), null, 'a code token counts only as a code');
  assert.equal(classifyStoreError('user wrote Invalid input value for Qty. bigint value expected'), null);
});

test('a JSON-string REST body classifies by its error_code', () => {
  const err = new Error(
    JSON.stringify({ status: 'failure', data: { message: 'Duplicate value for SKU. Please give a different value', error_code: 'DUPLICATE_VALUE' } }),
  );
  assert.deepEqual(classifyStoreError(err), { code: 'DUPLICATE_VALUE', field: 'SKU' });
});

test('a thrown bare string in the recorded shape classifies', () => {
  assert.deepEqual(classifyStoreError('Invalid input value for Qty. bigint value expected'), { code: 'INVALID_INPUT', field: 'Qty' });
});

// A refused write carries its code and field on the error object; the reply
// names the column without a Catalyst message to parse.
test('WriteRuleError classifies by its code and names its field', () => {
  const missing = new WriteRuleError('Order', [{ column: 'Name', rule: 'mandatory-missing' }]);
  assert.deepEqual(classifyStoreError(missing), { code: 'MANDATORY_MISSING', field: 'Name' });
  const invalid = new WriteRuleError('Order', [{ column: 'When', rule: 'date-format' }]);
  assert.deepEqual(classifyStoreError(invalid), { code: 'INVALID_INPUT', field: 'When' });
  const sent: { status: number; body: Record<string, unknown> }[] = [];
  const res = {
    writeHead(status: number) {
      sent.push({ status, body: {} });
    },
    end(raw: string) {
      sent[0]!.body = JSON.parse(raw) as Record<string, unknown>;
    },
  };
  assert.equal(replyStoreError(res, missing, { live: true, table: 'Order' }), true);
  assert.equal(sent[0]!.status, 422);
  assert.equal(sent[0]!.body.code, 'MANDATORY_MISSING');
  assert.equal(sent[0]!.body.field, 'Name');
  assert.match(String(sent[0]!.body.message), /Name/);
  assert.doesNotMatch(String(sent[0]!.body.message), /write refused/, 'c2c internals never reach the caller');
});
