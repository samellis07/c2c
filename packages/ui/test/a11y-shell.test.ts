import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { deriveIr, parse } from '../../core/src/index.js';
import { buildUi, clientRuntimeSource } from '../src/index.js';

test('Others free-text controls have accessible names', async () => {
  const app = deriveIr(parse('application "A11y" { form Task { Priority ( type = picklist displayname = "Urgency" values = {"Low","High"} others option = true ) } }'));
  const { model } = buildUi(app);
  const runtime = await import(`data:text/javascript;base64,${Buffer.from(clientRuntimeSource()).toString('base64')}`);
  const doc = new JSDOM(`<!doctype html><body>${runtime.renderForm(model.forms[0])}</body>`).window.document;
  assert.equal(doc.querySelector('input[data-others-text]')?.getAttribute('aria-label'), 'Urgency (other)');
});
