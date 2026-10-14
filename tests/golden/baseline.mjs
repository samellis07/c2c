/**
 * Rewrite tests/golden/parity-baseline.json from the current parity mismatches.
 *
 *   npm run golden:baseline
 *   npm run golden:baseline -- --allow-add
 *
 * Removals (a listed id that now matches) are applied. Additions are refused
 * unless --allow-add is passed. Prints the added and removed ids either way.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_FILE,
  BOOL_CAPTURE_ARTIFACTS,
  cases,
  failingParityIds,
  formatBaseline,
  formatVectorSources,
  loadBaselineIds,
  loadVectorBundle,
  planBaselineUpdate,
  vectorStatus,
  writeBaseline,
} from './parity.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function printChange(label, ids) {
  console.log(`${label}: ${ids.length}`);
  for (const id of ids) console.log(`  ${label.startsWith('added') ? '+' : '-'} ${id}`);
}

const args = process.argv.slice(2);
const allowAdd = args.includes('--allow-add');
const unknown = args.filter((arg) => arg !== '--allow-add');
if (unknown.length > 0) {
  console.error(`unknown argument: ${unknown.join(' ')}`);
  console.error('usage: npm run golden:baseline -- [--allow-add]');
  process.exit(2);
}

const bundle = loadVectorBundle();
console.log(formatVectorSources(bundle));
const { cases: vectors, pending } = vectorStatus(bundle.text, BOOL_CAPTURE_ARTIFACTS);
const failing = await failingParityIds(cases, vectors, pending);
const previous = loadBaselineIds();
const plan = planBaselineUpdate(previous, failing, allowAdd);

console.log(`parity baseline ${BASELINE_FILE}`);
console.log(`  previous: ${previous.length}`);
console.log(`  failing:  ${failing.length}`);
printChange('added', plan.added);
printChange('removed', plan.removed);

if (plan.refused) {
  console.error(`refusing to add ${plan.added.length} id${plan.added.length === 1 ? '' : 's'} without --allow-add`);
  process.exit(1);
}

const nextText = formatBaseline(plan.next);
const file = join(root, BASELINE_FILE);
const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
if (current === nextText) {
  console.log(`${BASELINE_FILE} unchanged (${plan.next.length} ids)`);
} else {
  writeBaseline(plan.next);
  console.log(`wrote ${BASELINE_FILE} (${plan.next.length} ids)`);
}
