/**
 * Blank-to-null (client): the Slate form posts null, not "", for blank typed
 * columns. Text-family widgets keep "" (Creator empty text is "").
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

interface UiField {
  name: string;
  label: string;
  widget: string;
  required: boolean;
  unique: boolean;
  readonly: boolean;
  status: 'generated' | 'todo';
  scan: boolean;
}

function field(name: string, widget: string): UiField {
  return { name, label: name, widget, required: false, unique: false, readonly: false, status: 'generated', scan: false };
}

async function submitRecord(
  entries: [string, string][],
  fields: UiField[],
): Promise<Record<string, unknown>> {
  const mod = (await import(pathToFileURL(join(process.cwd(), 'packages/ui/src/client-runtime.js')).href)) as {
    submitRecord: (formEl: unknown, form: unknown, upload: unknown) => Promise<Record<string, unknown>>;
  };
  const view = {
    FormData: class {
      constructor() {}
      *entries(): Generator<[string, string]> {
        yield* entries;
      }
    },
    File: undefined,
  };
  const formEl = {
    ownerDocument: { defaultView: view },
    querySelectorAll: () => [],
  };
  return mod.submitRecord(formEl, { fields }, async () => {
    throw new Error('no uploads in this test');
  });
}

test('blank typed widgets post null, blank text widgets keep ""', async () => {
  const record = await submitRecord(
    [
      ['Order_Date', ''],
      ['Amount', ''],
      ['When_Time', ''],
      ['Notes', ''],
      ['PO_Title', ''],
      ['Email', ''],
    ],
    [
      field('Order_Date', 'date'),
      field('Amount', 'decimal'),
      field('When_Time', 'time'),
      field('Notes', 'textarea'),
      field('PO_Title', 'text'),
      field('Email', 'email'),
    ],
  );
  assert.equal(record.Order_Date, null, 'blank date posts null (Catalyst 400s on "")');
  assert.equal(record.Amount, null, 'blank decimal posts null');
  assert.equal(record.When_Time, null, 'blank time posts null');
  assert.equal(record.Notes, '', 'Creator empty text is ""');
  assert.equal(record.PO_Title, '', 'Creator empty text is ""');
  assert.equal(record.Email, '', 'Creator empty email is ""');
});

test('filled typed widgets are untouched', async () => {
  const record = await submitRecord(
    [
      ['Order_Date', '2026-10-20'],
      ['Amount', '12.50'],
    ],
    [field('Order_Date', 'date'), field('Amount', 'decimal')],
  );
  assert.equal(record.Order_Date, '2026-10-20');
  assert.equal(record.Amount, '12.50');
});

test('a whole number posts as a number, so a server script adds it instead of joining text', async () => {
  const record = await submitRecord(
    [
      ['Qty', ' 5 '],
      ['Big', '9007199254740993'],
      ['Odd', '5.5'],
      ['Amount', '12.50'],
    ],
    [field('Qty', 'number'), field('Big', 'number'), field('Odd', 'number'), field('Amount', 'currency')],
  );
  assert.equal(record.Qty, 5);
  assert.equal(100 + (record.Qty as number), 105);
  assert.equal(record.Big, '9007199254740993', 'past 2^53 the digits stay text');
  assert.equal(record.Odd, '5.5', 'not a whole number: left for the field check');
  assert.equal(record.Amount, '12.50', 'currency stays exact text');
});
