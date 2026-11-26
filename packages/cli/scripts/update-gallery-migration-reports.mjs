#!/usr/bin/env node
// Rewrite the private gallery migration-report goldens under
// $C2C_FIXTURES_DIR/golden/migration-reports/gallery from the current generator.
// They name apps, so they stay in the private fixtures directory, never in this repo.
// Run `npm run build` first, or use `npm run migration-reports:update-gallery`.
import path from 'node:path';
import { listGalleryFixtures, privateMigrationReportGoldenDir, writeGalleryMigrationReports } from '../../../dist/cli/src/fixture-migration-report.js';

const out = privateMigrationReportGoldenDir();
const gallery = process.env.C2C_GALLERY_DIR || (process.env.C2C_FIXTURES_DIR ? path.join(process.env.C2C_FIXTURES_DIR, 'gallery') : '');
if (!out || !gallery) {
  process.stderr.write('update-gallery-migration-reports: set C2C_FIXTURES_DIR (and optionally C2C_GALLERY_DIR)\n');
  process.exit(2);
}
const ids = await writeGalleryMigrationReports(gallery, out);
process.stdout.write(`wrote ${ids.length} of ${listGalleryFixtures(gallery).length} gallery migration reports under ${out}\n`);
