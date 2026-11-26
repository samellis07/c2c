#!/usr/bin/env node
/**
 * Offline upgrade rehearsal for one app: generate the plan folder and the
 * React app, pretend an older c2c wrote them (older version, one older
 * generated file, one older platform file, a customised file, a customer
 * environment file), then run the upgrade and check what it kept. Needs
 * `npm run build` first. No network, no Catalyst CLI.
 *
 *   node tools/upgrade-rehearsal.mjs --out <dir> --ds <file.ds|dir>
 *
 * Writes <out>/upgrade-rehearsal.json. Exit 1 when a check fails, 2 on usage errors.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildOfflinePlan, loadApp, writePlanTree } from '../dist/deploy/src/index.js';
import { generateReactApp, writeReactApp } from '../dist/ui-react/src/index.js';
import { applyUpgrade, planUpgrade } from '../dist/cli/src/upgrade.js';

function flag(args, name) {
  const i = args.indexOf(name);
  return i < 0 || args[i + 1] === undefined || args[i + 1].startsWith('--') ? undefined : args[i + 1];
}
const sha = (data) => createHash('sha256').update(data).digest('hex');

const args = process.argv.slice(2);
const out = flag(args, '--out');
const ds = flag(args, '--ds');
if (!out || !ds) {
  process.stderr.write('usage: node tools/upgrade-rehearsal.mjs --out <dir> --ds <file.ds|dir>\n');
  process.exit(2);
}
const root = resolve(out);
rmSync(root, { recursive: true, force: true });
const planDir = join(root, 'plan');
const uiDir = join(root, 'ui');
const app = loadApp(resolve(ds));
const base = { app, dc: 'in', dcSource: '--dc', auth: true };
const checks = [];
const check = (id, ok, detail) => checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail });

const { files } = buildOfflinePlan(app, { dc: 'in', dcSource: '--dc', mail: false, newProject: true });
writePlanTree(planDir, files);
const manifestPath = join(planDir, 'c2c-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.c2c = '0.0.1';
manifest.files['plan.json'] = `sha256:${sha('{"older":true}\n')}`;
writeFileSync(join(planDir, 'plan.json'), '{"older":true}\n');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(planDir, 'function-env.json'), '{"CUSTOMER_KEY":"kept"}\n');
const react = generateReactApp(app, { auth: true });
writeReactApp(uiDir, react);
const custom = react.find((file) => file.owner === 'custom');
const platform = react.find((file) => file.owner === 'platform');
if (custom) writeFileSync(join(uiDir, custom.path), 'customised\n');
if (platform) writeFileSync(join(uiDir, platform.path), 'older platform file\n');

const input = { ...base, planDir, uiDir };
const result = planUpgrade(input);
const r = result.report;
check('compare', r.direction === 'upgrade' && r.plan.regenerated.includes('plan.json'), `from ${r.from} to ${r.to}; regenerated ${r.plan?.regenerated.join(',')}`);
check('no-blocker', r.blocked.length === 0, r.blocked.join('; ') || 'nothing blocks the upgrade');
check('dry-run-writes-nothing', readFileSync(join(planDir, 'plan.json'), 'utf8') === '{"older":true}\n', 'plan.json unchanged before --apply');
applyUpgrade(input, result);
check('regenerated', readFileSync(join(planDir, 'plan.json'), 'utf8') !== '{"older":true}\n', 'plan.json rewritten');
check('customer-env-kept', readFileSync(join(planDir, 'function-env.json'), 'utf8') === '{"CUSTOMER_KEY":"kept"}\n', 'function-env.json unchanged');
if (custom) check('custom-kept', readFileSync(join(uiDir, custom.path), 'utf8') === 'customised\n', `${custom.path} unchanged`);
if (platform) check('platform-upgraded', readFileSync(join(uiDir, platform.path), 'utf8') !== 'older platform file\n', `${platform.path} replaced`);
const again = planUpgrade(input).report;
check('idempotent', again.direction === 'same' && again.plan.regenerated.length === 0 && again.ui.changes.replaced.length === 0, 'a second upgrade finds nothing to change');
const status = checks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL';
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'upgrade-rehearsal.json'), `${JSON.stringify({ schema: 'c2c-upgrade-rehearsal/1', app: app.name ?? 'app', status, checks }, null, 2)}\n`);
process.stdout.write(`upgrade-rehearsal: ${status} (${checks.filter((c) => c.status === 'PASS').length}/${checks.length})\n`);
process.exit(status === 'PASS' ? 0 : 1);
