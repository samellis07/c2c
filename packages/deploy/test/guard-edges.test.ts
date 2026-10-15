/**
 * Edge cases of the deploy guards that the end-to-end suites do not reach:
 * Catalyst created_time parsing, the Catalyst CLI config-store readers, the
 * c2c-deploy.json lookup, project-details env maps, zip local-header checks
 * and the project registry choice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { deployMailRecipients, findDeployConfig, readCliActiveDc, readCliActiveOrg } from '../src/dc.js';
import { GuardError } from '../src/guards.js';
import { emptyRegistry } from '../src/registry.js';
import { assertProjectDetails } from '../src/scope.js';
import {
  catalystCreatedMs,
  importingAgeState,
  isStuckImporting,
  projectDataRecord,
  stuckImportGuidedStep,
  unknownImportAgeGuidedStep,
  STUCK_IMPORT_MAX_AGE_MS,
} from '../src/stuck-import.js';
import { resolveProjectChoice } from '../src/target.js';
import { readZip } from '../src/zipfile.js';

const ORG = '10000000000';

test('catalystCreatedMs reads epoch seconds, millis, digit strings and the console shape', () => {
  assert.equal(catalystCreatedMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(catalystCreatedMs(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(catalystCreatedMs(' 1700000000 '), 1_700_000_000_000);
  assert.equal(catalystCreatedMs('Oct 08, 2026 05:00 AM'), new Date(2026, 9, 8, 5, 0, 0).getTime());
  assert.equal(catalystCreatedMs('Oct 08, 2026 12:30 AM'), new Date(2026, 9, 8, 0, 30, 0).getTime());
  assert.equal(catalystCreatedMs('Oct 08, 2026 12:30 PM'), new Date(2026, 9, 8, 12, 30, 0).getTime());
  assert.equal(catalystCreatedMs('september 8, 2026 01:15:09 pm'), new Date(2026, 8, 8, 13, 15, 9).getTime());
  assert.equal(catalystCreatedMs('2026-10-08T05:00:00Z'), Date.parse('2026-10-08T05:00:00Z'));
});

test('catalystCreatedMs never guesses an unreadable created_time', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '', '   ', null, undefined, {}, 'not a date']) {
    assert.equal(catalystCreatedMs(value), undefined, `value ${String(value)}`);
  }
  // The console shape with a month name that is not a month is refused, not handed to Date.parse.
  assert.equal(catalystCreatedMs('Foo 08, 2026 05:00 AM'), undefined);
  assert.equal(catalystCreatedMs('Mayday 08, 2026 05:00 AM'), new Date(2026, 4, 8, 5, 0, 0).getTime());
});

test('an Importing project is stuck from the age bound on, and unknown age is not stuck', () => {
  const created = Date.parse('2026-10-08T00:00:00Z');
  const createdTime = String(created);
  const importing = { projectType: 'Importing', createdTime };
  assert.equal(importingAgeState({ projectType: 'Live', createdTime }, created + STUCK_IMPORT_MAX_AGE_MS), 'not-importing');
  assert.equal(importingAgeState(importing, created + STUCK_IMPORT_MAX_AGE_MS - 1), 'young');
  assert.equal(importingAgeState(importing, created + STUCK_IMPORT_MAX_AGE_MS), 'stuck');
  assert.equal(isStuckImporting(importing, created + STUCK_IMPORT_MAX_AGE_MS - 1), false);
  assert.equal(isStuckImporting(importing, created + STUCK_IMPORT_MAX_AGE_MS), true);
  assert.equal(isStuckImporting({ projectType: 'Live', createdTime }, created + 10 * STUCK_IMPORT_MAX_AGE_MS), false);
  assert.equal(importingAgeState({ projectType: 'Importing' }), 'unknown');
  assert.equal(importingAgeState({ projectType: 'Importing', createdTime: 'whenever' }), 'unknown');
  assert.equal(isStuckImporting({ projectType: 'Importing', createdTime: 'whenever' }), false);
});

test('projectDataRecord unwraps data and ignores non-record bodies', () => {
  assert.deepEqual(projectDataRecord(null), {});
  assert.deepEqual(projectDataRecord('Importing'), {});
  assert.deepEqual(projectDataRecord([{ project_type: 'Importing' }]), {});
  assert.deepEqual(projectDataRecord({ data: { project_type: 'Importing' } }), { project_type: 'Importing' });
  assert.deepEqual(projectDataRecord({ data: [1], project_type: 'Live' }), { data: [1], project_type: 'Live' });
});

test('import guided steps name the project by id when the name is missing', () => {
  assert.match(stuckImportGuidedStep({ id: '1001' }), /^project 1001 is still "Importing"/);
  assert.match(stuckImportGuidedStep({ name: 'widget' }), /^project "widget" \(\?\) is still/);
  assert.match(unknownImportAgeGuidedStep({}), /^project \? is still importing; check its status/);
  assert.match(unknownImportAgeGuidedStep({ name: 'widget', id: '1001' }), /^project "widget" \(1001\) is still importing/);
});

/** A fake zcatalyst-cli install: bin/catalyst on PATH and a config store answering from FAKE_STORE. */
function fakeCli(): { env: NodeJS.ProcessEnv; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'c2c-fake-cli-'));
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'internal'));
  mkdirSync(join(root, 'util_modules'));
  writeFileSync(join(root, 'bin', 'catalyst'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'bin', 'catalyst'), 0o755);
  writeFileSync(
    join(root, 'util_modules', 'config-store.js'),
    [
      'exports.default = { get(key) {',
      "  if (process.env.FAKE_STORE_THROW) throw new Error('store unreadable');",
      '  // A selector that survived the env scrub would win here.',
      '  if (process.env.CATALYST_ACTIVE_OVERRIDE) return process.env.CATALYST_ACTIVE_OVERRIDE;',
      "  return JSON.parse(process.env.FAKE_STORE || '{}')[key];",
      '} };',
      '',
    ].join('\n'),
  );
  return { root, env: { PATH: join(root, 'bin') } };
}

test('readCliActiveOrg returns only a decimal active_org from the CLI store', () => {
  const { env } = fakeCli();
  const org = (store: unknown, extra: NodeJS.ProcessEnv = {}) => readCliActiveOrg({ ...env, ...extra, FAKE_STORE: JSON.stringify(store) });
  assert.equal(org({ active_org: ORG }), ORG);
  assert.equal(org({ active_org: ` ${ORG} ` }), ORG);
  assert.equal(org({ active_org: 42 }), '42');
  for (const bad of [{}, { active_org: 'acme' }, { active_org: `${ORG}x` }, { active_org: -1 }, { active_org: 1.5 }, { active_org: true }]) {
    assert.equal(org(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(org({ active_org: ORG }, { FAKE_STORE_THROW: '1' }), undefined);
  // CATALYST_* selectors are scrubbed from the child: the store answer is used.
  assert.equal(org({ active_org: ORG }, { CATALYST_ACTIVE_OVERRIDE: '999' }), ORG);
});

test('readCliActiveDc returns the stored active_dc string and nothing else', () => {
  const { env } = fakeCli();
  const dc = (store: unknown, extra: NodeJS.ProcessEnv = {}) => readCliActiveDc({ ...env, ...extra, FAKE_STORE: JSON.stringify(store) });
  assert.equal(dc({ active_dc: 'in' }), 'in');
  assert.equal(dc({ active_dc: ' eu ' }), 'eu');
  assert.equal(dc({}), undefined);
  assert.equal(dc({ active_dc: 7 }), undefined);
  assert.equal(dc({ active_dc: '' }), undefined);
  assert.equal(dc({ active_dc: 'in' }, { FAKE_STORE_THROW: '1' }), undefined);
  assert.equal(dc({ active_dc: 'in' }, { CATALYST_ACTIVE_OVERRIDE: 'us' }), 'in');
});

test('the CLI store readers answer undefined when the catalyst CLI or its library is missing', () => {
  const empty = mkdtempSync(join(tmpdir(), 'c2c-no-cli-'));
  assert.equal(readCliActiveOrg({ PATH: empty }), undefined);
  assert.equal(readCliActiveDc({ PATH: empty }), undefined);
  const bare = mkdtempSync(join(tmpdir(), 'c2c-bare-cli-'));
  writeFileSync(join(bare, 'catalyst'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bare, 'catalyst'), 0o755);
  assert.equal(readCliActiveOrg({ PATH: bare, FAKE_STORE: JSON.stringify({ active_org: ORG }) }), undefined);
  assert.equal(readCliActiveDc({ PATH: bare, FAKE_STORE: JSON.stringify({ active_dc: 'in' }) }), undefined);
});

test('findDeployConfig: --config must exist; else beside the export; else the cwd; else none', () => {
  const root = mkdtempSync(join(tmpdir(), 'c2c-find-config-'));
  const exportDir = join(root, 'export');
  const cwd = join(root, 'cwd');
  mkdirSync(exportDir);
  mkdirSync(cwd);
  const ds = join(exportDir, 'app.ds');
  writeFileSync(ds, '');
  assert.throws(() => findDeployConfig(ds, join(root, 'missing.json'), cwd), /--config .*missing\.json does not exist/);
  assert.equal(findDeployConfig(ds, ds, cwd), ds);
  assert.equal(findDeployConfig(ds, undefined, cwd), undefined);
  writeFileSync(join(cwd, 'c2c-deploy.json'), '{}');
  assert.equal(findDeployConfig(ds, undefined, cwd), join(cwd, 'c2c-deploy.json'));
  writeFileSync(join(exportDir, 'c2c-deploy.json'), '{}');
  assert.equal(findDeployConfig(ds, undefined, cwd), join(exportDir, 'c2c-deploy.json'));
  assert.equal(findDeployConfig(exportDir, undefined, cwd), join(exportDir, 'c2c-deploy.json'));
  assert.equal(findDeployConfig(join(root, 'gone.ds'), undefined, cwd), join(cwd, 'c2c-deploy.json'));
});

test('deployMailRecipients sends to nobody when the config is not valid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2c-mail-bad-'));
  const config = join(dir, 'c2c-deploy.json');
  writeFileSync(config, '{ "mail": { "testRecipients": ["owner@example.com"] ');
  assert.deepEqual(deployMailRecipients(config), []);
  assert.deepEqual(deployMailRecipients(join(dir, 'absent.json')), []);
});

test('assertProjectDetails reads env_details keyed by environment name', () => {
  const details = (env_details: unknown) => ({ data: { id: '1001', env_details } });
  assertProjectDetails(details({ Development: { env_zgid: ORG } }), ORG, '1001');
  assertProjectDetails(details({ Production: { env_zgid: '42' }, Development: { id: ORG } }), ORG, '1001');
  assertProjectDetails(details([null, 'x', { env_name: 'Development', id: ORG }]), ORG, '1001');
  // An explicit env_name wins over the map key.
  assert.throws(() => assertProjectDetails(details({ Development: { env_name: 'Production', env_zgid: ORG } }), ORG, '1001'), /did not report/);
  // A non-object entry names the environment but reports no org.
  assert.throws(() => assertProjectDetails(details({ Development: ORG }), ORG, '1001'), /did not report/);
  assert.throws(() => assertProjectDetails(details('Development'), ORG, '1001'), /did not report/);
  assert.throws(() => assertProjectDetails(details({ Production: { env_zgid: ORG } }), ORG, '1001'), /did not report/);
  // env_details present but empty does not fall back to a top-level org_id.
  assert.throws(() => assertProjectDetails({ data: { id: '1001', org_id: ORG, environments: [] } }, ORG, '1001'), /did not report/);
});

test('assertProjectDetails refuses non-object bodies and non-decimal ids', () => {
  for (const body of [null, undefined, 'ok', 1001]) {
    assert.throws(() => assertProjectDetails(body, ORG, '1001'), /did not report/, String(body));
  }
  const good = { data: { id: '1001', org_id: ORG } };
  assertProjectDetails(good, ORG, '1001');
  assert.throws(() => assertProjectDetails(good, 'acme', '1001'), /did not report/);
  assert.throws(() => assertProjectDetails(good, ORG, 'widget-1001'), /did not report/);
  assert.throws(() => assertProjectDetails({ data: { id: 1001.5, org_id: ORG } }, ORG, '1001'), /did not report/);
  assertProjectDetails({ data: { project_id: 1001, org_id: Number(ORG) } }, ORG, '1001');
});

interface StoredMember {
  name: string;
  data: Buffer;
  /** Local header overrides. */
  local?: { crc?: number; compressed?: number; size?: number };
  /** Both headers declare this uncompressed size instead of data.length. */
  size?: number;
  flags?: number;
  /** Central-directory offset override. */
  offset?: number;
}

/** Stored (method 0) members only, local headers then central directory then EOCD. */
function storedZip(members: StoredMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let at = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const crc = crc32(member.data);
    const size = member.size ?? member.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.flags ?? 0, 6);
    local.writeUInt32LE(member.local?.crc ?? crc, 14);
    local.writeUInt32LE(member.local?.compressed ?? member.data.length, 18);
    local.writeUInt32LE(member.local?.size ?? size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(member.flags ?? 0, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(member.data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(member.offset ?? at, 42);
    locals.push(local, name, member.data);
    centrals.push(central, name);
    at += 30 + name.length + member.data.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

test('a well-formed stored zip reads back, including a data-descriptor member', () => {
  const entries = readZip(storedZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'b.txt', data: Buffer.from('world'), flags: 0x8, local: { crc: 0, compressed: 0, size: 0 } },
  ]));
  assert.deepEqual(entries.map((entry) => [entry.name, entry.data.toString()]), [['a.txt', 'hello'], ['b.txt', 'world']]);
});

test('a central entry whose offset holds no local header is refused', () => {
  const zip = storedZip([{ name: 'a.txt', data: Buffer.from('hello'), offset: 3 }]);
  assert.throws(() => readZip(zip), /"a\.txt" has no local header at its offset/);
  const far = storedZip([{ name: 'a.txt', data: Buffer.from('hello'), offset: 40 }]);
  assert.throws(() => readZip(far), /has no local header at its offset/);
});

test('a local header that disagrees with the central directory is refused unless a data descriptor follows', () => {
  for (const local of [{ crc: 1 }, { compressed: 4 }, { size: 6 }]) {
    const zip = storedZip([{ name: 'a.txt', data: Buffer.from('hello'), local }]);
    assert.throws(() => readZip(zip), /local header that disagrees with the central directory/, JSON.stringify(local));
  }
  const described = storedZip([{ name: 'a.txt', data: Buffer.from('hello'), flags: 0x8, local: { crc: 1 } }]);
  assert.equal(readZip(described)[0]!.data.toString(), 'hello');
});

test('a stored member whose declared size differs from its bytes is refused', () => {
  const zip = storedZip([{ name: 'a.txt', data: Buffer.from('hello'), size: 6 }]);
  assert.throws(() => readZip(zip), /"a\.txt" declared 6 bytes but holds 5/);
});

test('resolveProjectChoice: flag, then config, then the registry map; an unmapped app is refused', () => {
  const registry = { ...emptyRegistry(), projects: { 'c2c-widget': '1001 # main', 'c2c-other': 'acme' }, aliases: { Gadget: 'c2c-widget' } };
  assert.deepEqual(resolveProjectChoice({ flag: ' 2002 ', configProject: '3003', appLink: 'widget', registry }), { raw: '2002', origin: '--project', fromMap: false });
  assert.deepEqual(resolveProjectChoice({ flag: '  ', configProject: ' 3003 ', configPath: 'cfg.json', appLink: 'widget', registry }), {
    raw: '3003',
    origin: 'cfg.json',
    fromMap: false,
  });
  assert.deepEqual(resolveProjectChoice({ configProject: '', appLink: 'Widget', registry, registryPath: 'projects.json' }), {
    raw: '1001',
    origin: 'projects.json',
    fromMap: true,
  });
  assert.equal(resolveProjectChoice({ appLink: 'Gadget', registry }).raw, '1001');
  assert.throws(
    () => resolveProjectChoice({ appLink: 'unmapped', registry }),
    (err: unknown) => err instanceof GuardError && err.code === 'configuration' && /project is not configured/.test(err.message),
  );
  assert.throws(() => resolveProjectChoice({ appLink: 'other', registry }), /project registry project id is not a decimal id/);
});
