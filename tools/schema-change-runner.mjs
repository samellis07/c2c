#!/usr/bin/env node
/**
 * Offline schema-change runner: deploy an app to the in-process Catalyst
 * harness, seed rows, apply a sequence of Creator-side changes to a copy of
 * the .ds, re-plan and redeploy each one, and report rows kept, refusals and
 * gaps. Needs `npm run build` first. No network, no Catalyst CLI.
 *
 *   node tools/schema-change-runner.mjs --out <dir> [--ds <file.ds>]
 *
 * Writes <out>/schema-change-report.json and <out>/schema-change-report.md.
 * Exit 1 while any scenario FAILs (a value lost, or a destructive change not
 * gated on a verified backup), 2 on usage errors.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSchemaChangeReport, runSchemaChangeScenarios } from '../dist/deploy/src/schema-change-runner.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const args = process.argv.slice(2);
const out = flag(args, '--out');
if (!out || args.includes('--help')) {
  process.stderr.write('usage: node tools/schema-change-runner.mjs --out <dir> [--ds <file.ds>]\n');
  process.exit(2);
}
const ds = resolve(flag(args, '--ds') ?? join(root, 'fixtures/redistributable/library-application-system/library_application.ds'));
const report = await runSchemaChangeScenarios({
  ds,
  workDir: join(resolve(out), 'work'),
  sdkPath: join(root, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs'),
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'schema-change-report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(out, 'schema-change-report.md'), formatSchemaChangeReport(report));
const s = report.summary;
process.stdout.write(`schema-change: PASS ${s.pass}  FAIL ${s.fail}  gaps ${s.gaps}\nwrote ${join(out, 'schema-change-report.md')}\n`);
process.exit(s.fail > 0 ? 1 : 0);
