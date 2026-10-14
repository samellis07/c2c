import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse, type Workflow } from '../../core/src/index.js';
import { generate } from '../src/generate.js';
import { translate } from '../src/translate.js';

function stripComments(s: string) { return (s || '').replace(/^\s*\/\/ Deluge: .*\n?/gm, ''); }

const Z = { start: 0, end: 0 };

test('decimal field arithmetic, unary minus, and comparisons do not use JS numbers', () => {
  const fields = ['Amount', 'Tax'];
  const t = translate(
    [
      'total = input.Amount + input.Tax;',
      'neg = -input.Amount;',
      'wide = input.Amount > 12345678901234.50;',
      'same = input.Amount == input.Tax;',
      'blank = input.Amount == null;',
    ].join('\n'),
    { decimalFields: fields },
  );
  assert.match(stripComments(t.server), /shim\.decimal\.add\(shim\.input\.get\(ctx, "Amount"\), shim\.input\.get\(ctx, "Tax"\)\)/);
  assert.match(stripComments(t.server), /shim\.decimal\.sub\("0", shim\.input\.get\(ctx, "Amount"\)\)/);
  assert.match(stripComments(t.server), /shim\.decimal\.cmp\(shim\.input\.get\(ctx, "Amount"\), shim\.decimal\.from\("12345678901234\.50"\), ">"\)/);
  assert.match(stripComments(t.server), /shim\.decimal\.cmp\(shim\.input\.get\(ctx, "Amount"\), shim\.input\.get\(ctx, "Tax"\), "=="\)/);
  assert.match(stripComments(t.server), /shim\.input\.get\(ctx, "Amount"\) == null/);
  assert.doesNotMatch(stripComments(t.server), /shim\.input\.get\(ctx, "Amount"\) \+/);
  assert.doesNotMatch(stripComments(t.server), /\(-shim\.input\.get/);
});

test('generate passes decimal link names into every handler translation', () => {
  const app = deriveIr(parse(`application "Demo"\n{\n\tform Item\n\t{\n\t\tAmount\n\t\t(\n\t\t\ttype = decimal\n\t\t)\n\t\tTax\n\t\t(\n\t\t\ttype = currency\n\t\t)\n\t}\n}\n`));
  const workflow: Workflow = {
    name: 'On add',
    form: 'Item',
    event: 'on success',
    deluge: { text: 'total = input.Amount + input.Tax;\nneg = -input.Amount;', span: Z },
    properties: [],
    span: Z,
  };
  app.workflows.push(workflow);
  const generated = generate(app);
  const server = generated.files.find((file) => file.path === 'functions/aio/item/on-success.mjs');
  assert.ok(server);
  assert.match(stripComments(server.source), /shim\.decimal\.add\(shim\.input\.get\(ctx, "Amount"\), shim\.input\.get\(ctx, "Tax"\)\)/);
  assert.match(stripComments(server.source), /shim\.decimal\.sub\("0", shim\.input\.get\(ctx, "Amount"\)\)/);
  assert.doesNotMatch(stripComments(server.source), /shim\.input\.get\(ctx, "Amount"\) \+/);
});
