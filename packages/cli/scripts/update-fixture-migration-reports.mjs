#!/usr/bin/env node
// Rewrite packages/cli/test/golden/migration-reports from the current generator.
// Run `npm run build` first, or use `npm run migration-reports:update`.
import { writeFixtureMigrationReports } from '../../../dist/cli/src/fixture-migration-report.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ids = writeFixtureMigrationReports(repo);
process.stdout.write(`wrote ${ids.length} migration reports under packages/cli/test/golden/migration-reports\n`);
