/**
 * An autonumber field is filled by the runtime's claim-table counters on a
 * live insert. The generator must plan the claim table and hand the runtime
 * the field and its start index; before, neither happened, so every insert
 * stored the autonumber blank.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { generateSchema } from '../../schema/src/generator.js';
import { schemaRuntimeOptions } from '../src/generate.js';

const tab = (n: number) => '\t'.repeat(n);

const source = (autonumber: boolean) => `application "Demo"
{
${tab(1)}form Quote
${tab(1)}{
${tab(2)}Title
${tab(2)}(
${tab(3)}type = text
${tab(2)})
${autonumber ? `${tab(2)}Number
${tab(2)}(
${tab(3)}type = autonumber
${tab(3)}start index = 7
${tab(2)})
` : ''}${tab(1)}}
}
`;

test('an autonumber form plans the claim table and passes its start index to the runtime', () => {
  const app = deriveIr(parse(source(true)));
  const claim = generateSchema(app).tables.find((table) => table.name === 'c2c_seq_claim');
  assert.ok(claim, 'claim table planned');
  assert.equal(claim.role, 'system');
  assert.deepEqual(
    claim.columns.filter((column) => column.creatorType === 'system' && column.matrixId.startsWith('c2c-seq-')).map((column) => column.name),
    ['claim_key', 'seq_name', 'n', 'value', 'owner'],
  );
  assert.ok(claim.columns.find((column) => column.name === 'claim_key')?.unique);
  assert.match(schemaRuntimeOptions(app), /, counters: \{"autonumber":\{"Quote":\{"Number":\{"start":7\}\}\}\}/);
});

test('an app without an autonumber field gets neither the claim table nor the counters option', () => {
  const app = deriveIr(parse(source(false)));
  assert.equal(generateSchema(app).tables.some((table) => table.name === 'c2c_seq_claim'), false);
  assert.doesNotMatch(schemaRuntimeOptions(app), /counters/);
});
