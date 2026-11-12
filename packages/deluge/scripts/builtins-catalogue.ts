/**
 * Write docs/deluge-builtins.json.
 * Status comes from spot-translating each docs entry (see src/catalogue.ts).
 *
 * Run after `npm run build`:
 *   node dist/deluge/scripts/builtins-catalogue.js
 */
import { writeCatalogue } from '../src/catalogue.js';

const cat = writeCatalogue();
process.stderr.write(
  `catalogue total=${cat.counts.total} supported=${cat.counts.supported} shimmed=${cat.counts.shimmed} todo=${cat.counts.todo}\n`,
);
