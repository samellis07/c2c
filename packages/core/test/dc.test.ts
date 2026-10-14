import test from 'node:test';
import assert from 'node:assert/strict';
import { DC_ENDPOINTS, DcNotConfiguredError, KNOWN_DCS, UnknownDcError, catalystBaseFor, creatorBaseFor, dcEndpoints, parseDc, resolveDc } from '../src/dc.js';
import { HostNotAllowedError, assertAllowedHost } from '../../data/src/migrate.js';

test('every known DC maps to its own Creator, Catalyst, accounts and console hosts', () => {
  assert.deepEqual(KNOWN_DCS, ['us', 'eu', 'in', 'au', 'jp', 'ca', 'sa', 'ae']);
  assert.equal(creatorBaseFor('us'), 'https://www.zohoapis.com');
  assert.equal(catalystBaseFor('us'), 'https://api.catalyst.zoho.com');
  assert.equal(dcEndpoints('us').accounts, 'https://accounts.zoho.com');
  assert.equal(dcEndpoints('us').console, 'https://console.catalyst.zoho.com');
  assert.equal(creatorBaseFor('eu'), 'https://www.zohoapis.eu');
  assert.equal(catalystBaseFor('eu'), 'https://api.catalyst.zoho.eu');
  assert.equal(catalystBaseFor('au'), 'https://api.catalyst.zoho.com.au');
  // zcatalyst-cli maps .zoho.com to .zohocloud.ca for Canada.
  assert.equal(catalystBaseFor('ca'), 'https://api.catalyst.zohocloud.ca');
  assert.equal(dcEndpoints('ca').accounts, 'https://accounts.zohocloud.ca');
  for (const dc of KNOWN_DCS) {
    const hosts = Object.values(DC_ENDPOINTS[dc]).filter((v): v is string => typeof v === 'string').map((url) => new URL(url).hostname);
    for (const host of hosts) assert.ok(DC_ENDPOINTS[dc].suffixes.some((s) => host === s || host.endsWith(`.${s}`)), `${dc} ${host}`);
    if (dc !== 'in') assert.equal(hosts.some((host) => host.endsWith('.in')), false, dc);
  }
});

test('domain-suffix and CLI spellings normalise; unknown DCs list the valid ones', () => {
  assert.equal(parseDc('com'), 'us');
  assert.equal(parseDc(' EU '), 'eu');
  assert.equal(parseDc('com.au'), 'au');
  assert.equal(parseDc('uae'), 'ae');
  assert.throws(() => parseDc('uk'), UnknownDcError);
  assert.throws(() => parseDc('xx'), /unknown data centre "xx"; valid values: us, eu, in, au, jp, ca, sa, ae/);
});

test('resolveDc takes the first configured source and never falls back to IN', () => {
  assert.deepEqual(
    resolveDc([
      { source: 'flag', origin: '--dc', value: undefined },
      { source: 'config', origin: 'c2c-deploy.json', value: 'eu' },
      { source: 'registry', origin: 'projects.json', value: 'in' },
    ]),
    { dc: 'eu', source: 'config', origin: 'c2c-deploy.json' },
  );
  assert.throws(() => resolveDc([]), DcNotConfiguredError);
  assert.throws(() => resolveDc([{ source: 'flag', origin: '--dc', value: '  ' }]), /data centre is not configured; pass --dc/);
  assert.throws(() => resolveDc([{ source: 'flag', origin: '--dc', value: 'zz' }, { source: 'registry', origin: 'projects.json', value: 'in' }]), UnknownDcError);
});

test('the mover host allow-list follows the same table', () => {
  assertAllowedHost('https://api.catalyst.zoho.com/baas/v1/project/1/table', 'us');
  assertAllowedHost('https://api.catalyst.zoho.com/baas/v1/project/1/table', 'com');
  assertAllowedHost('https://www.zohoapis.eu/creator/v2.1/data', 'eu');
  assertAllowedHost('https://api.catalyst.zohocloud.ca/baas', 'ca');
  assert.throws(() => assertAllowedHost('https://api.catalyst.zoho.in/baas', 'us'), HostNotAllowedError);
  assert.throws(() => assertAllowedHost('https://api.catalyst.zoho.com/baas', 'xx'), HostNotAllowedError);
});
