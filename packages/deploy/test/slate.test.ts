/**
 * The Slate URL read-back. `slate:link` can print only "Slate linked
 * successfully" and `deploy slate` can finish without an "App Url:" line;
 * the app list (`GET /slate/v1/project/<id>/app`, admin origin) and the
 * deployment read (`…/app/<appId>/deployment/<id>`, zgraphql origin) report
 * the served domain. Shapes mirror the zcatalyst-cli Slate client:
 * data[].{id,name,domain,deployment_type_config{id,domain,current_build}}
 * and deployment.{domain,origin_domain}.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSlateAppUrl, SLATE_LIST_WAITS_MS, slateAppName, slateApps, slateDeploymentDomain, slateNameProblem, slateUrlOf, waitForSlateApp } from '../src/slate.js';
import { slateUrlFrom } from '../src/auth.js';
import type { RestCall, RestFn } from '../src/tables.js';

const APP_ID = '3000000000000123';
const DOMAIN = 'c2c-widget-abc123.onslate.in';

const LIST_WITH_DOMAIN = {
  data: [
    { id: APP_ID, name: 'other-app', domain: 'other-abc123.onslate.in' },
    {
      id: APP_ID,
      name: 'c2c-widget',
      domain: DOMAIN,
      status: 'DEPLOYED',
      deployment_type_config: { id: '9001', domain: DOMAIN, current_build: { deployment_id: '9001', status: 'DEPLOYED' } },
    },
  ],
};

const LIST_DEPLOYMENT_ONLY = {
  data: [
    {
      id: APP_ID,
      name: 'c2c-widget',
      deployment_type_config: { id: '9001', current_build: { deployment_id: '9001' } },
    },
  ],
};

function fakeRest(bodies: Record<string, unknown>, statuses: Record<string, number> = {}): { rest: RestFn; calls: RestCall[] } {
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    const body = bodies[call.path];
    return { status: statuses[call.path] ?? (body === undefined ? 404 : 200), body: body ?? {} };
  };
  return { rest, calls };
}

test('slateApps reads id, name, domain and deployment id from the list body', () => {
  const apps = slateApps(LIST_WITH_DOMAIN);
  assert.equal(apps.length, 2);
  const widget = apps.find((app) => app.name === 'c2c-widget');
  assert.equal(widget?.id, APP_ID);
  assert.equal(widget?.domain, DOMAIN);
  assert.equal(widget?.deploymentId, '9001');
  assert.deepEqual(slateApps({ data: 'junk' }), []);
  assert.deepEqual(slateApps({}), []);
});

test('slateDeploymentDomain prefers domain and falls back to origin_domain', () => {
  assert.equal(slateDeploymentDomain({ data: { domain: DOMAIN, origin_domain: 'other' } }), DOMAIN);
  assert.equal(slateDeploymentDomain({ data: { origin_domain: 'c2c-widget-abc123.onslate.in' } }), 'c2c-widget-abc123.onslate.in');
  assert.equal(slateDeploymentDomain({ data: {} }), undefined);
});

test('slateUrlOf normalises a bare host to https and refuses non-URLs', () => {
  assert.equal(slateUrlOf(DOMAIN), `https://${DOMAIN}`);
  assert.equal(slateUrlOf(`https://${DOMAIN}/app`), `https://${DOMAIN}`);
  assert.equal(slateUrlOf('http://insecure.example'), undefined);
  assert.equal(slateUrlOf('not a url '), undefined);
  assert.equal(slateUrlOf(undefined), undefined);
  // The stored URL feeds the CORS authorised domain — keep it to plain hosts.
  assert.equal(slateUrlOf('*.evil.example'), undefined);
  assert.equal(slateUrlOf('host:8080'), undefined);
});

test('readSlateAppUrl picks the app by name and returns its domain', async () => {
  const base = '/slate/v1/project/1001';
  const { rest, calls } = fakeRest({ [`${base}/app`]: LIST_WITH_DOMAIN });
  const found = await readSlateAppUrl(rest, '1001', 'c2c-widget', { sleep: async () => {} });
  assert.equal(found.url, `https://${DOMAIN}`);
  assert.equal(found.apps.length, 1);
  // One GET, no deployment read needed: the list row already had the domain.
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [`GET ${base}/app`]);
});

test('readSlateAppUrl reads the deployment on the zgraphql origin when the row has no domain', async () => {
  const base = '/slate/v1/project/1001';
  const { rest, calls } = fakeRest({
    [`${base}/app`]: LIST_DEPLOYMENT_ONLY,
    [`${base}/app/${APP_ID}/deployment/9001`]: { data: { domain: DOMAIN, origin_domain: 'ignored' } },
  });
  const found = await readSlateAppUrl(rest, '1001', 'c2c-widget', { sleep: async () => {} });
  assert.equal(found.url, `https://${DOMAIN}`);
  const deployment = calls.at(-1)!;
  assert.equal(deployment.path, `${base}/app/${APP_ID}/deployment/9001`);
  assert.equal(deployment.origin, 'zgraphql');
});

test('readSlateAppUrl falls back to origin_domain and notes when nothing is served', async () => {
  const base = '/slate/v1/project/1001';
  const { rest } = fakeRest({
    [`${base}/app`]: LIST_DEPLOYMENT_ONLY,
    [`${base}/app/${APP_ID}/deployment/9001`]: { data: { origin_domain: DOMAIN } },
  });
  assert.equal((await readSlateAppUrl(rest, '1001', 'c2c-widget', { sleep: async () => {} })).url, `https://${DOMAIN}`);
  const none = fakeRest({ [`${base}/app`]: LIST_DEPLOYMENT_ONLY, [`${base}/app/${APP_ID}/deployment/9001`]: { data: {} } });
  const empty = await readSlateAppUrl(none.rest, '1001', 'c2c-widget', { sleep: async () => {} });
  assert.equal(empty.url, undefined);
  assert.match(empty.note ?? '', /no served domain/);
});

test('two same-name apps are reported with their candidates and no URL is picked', async () => {
  const base = '/slate/v1/project/1001';
  const { rest } = fakeRest({
    [`${base}/app`]: {
      data: [
        { id: APP_ID, name: 'c2c-widget', domain: DOMAIN },
        { id: '3000000000000456', name: 'c2c-widget', domain: 'other-zz99.onslate.in' },
      ],
    },
  });
  const found = await readSlateAppUrl(rest, '1001', 'c2c-widget', { sleep: async () => {} });
  assert.equal(found.url, undefined);
  assert.equal(found.listed, true);
  assert.equal(found.apps.length, 2);
  assert.match(found.note ?? '', /2 Slate apps named "c2c-widget"/);
  assert.match(found.note ?? '', /--slate-domain/);
});

test('a different name, a missing app and a refused list each carry a one-line note', async () => {
  const base = '/slate/v1/project/1001';
  const { rest } = fakeRest({ [`${base}/app`]: LIST_WITH_DOMAIN });
  const missing = await readSlateAppUrl(rest, '1001', 'c2c-other', { sleep: async () => {} });
  assert.equal(missing.url, undefined);
  assert.equal(missing.listed, true);
  assert.deepEqual(missing.apps, []);
  assert.match(missing.note ?? '', /no app named "c2c-other"/);
  const refused = fakeRest({ [`${base}/app`]: LIST_WITH_DOMAIN }, { [`${base}/app`]: 401 });
  const unreadable = await readSlateAppUrl(refused.rest, '1001', 'c2c-widget', { sleep: async () => {} });
  assert.equal(unreadable.url, undefined);
  assert.equal(unreadable.listed, false);
  assert.match(unreadable.note ?? '', /HTTP 401/);
});

test('the list call retries a transient 500 like every other read', async () => {
  const calls: RestCall[] = [];
  let n = 0;
  const rest: RestFn = async (call) => {
    calls.push(call);
    n += 1;
    return n === 1 ? { status: 500, body: {} } : { status: 200, body: LIST_WITH_DOMAIN };
  };
  const found = await readSlateAppUrl(rest, '1001', 'c2c-widget', { sleep: async () => {} });
  assert.equal(found.url, `https://${DOMAIN}`);
  assert.equal(calls.length, 2);
});

// Catalyst refused `c2c-library_system_application`: "App name must be
// alphanumeric and cannot contain consecutive hyphens or hyphens at the
// beginning or end."
test('the derived Slate app name satisfies the Slate name rule and is stable', () => {
  assert.equal(slateAppName('c2c-library_system_application'), 'c2c-library-system-application');
  assert.equal(slateAppName('c2c-a__b--c_'), 'c2c-a-b-c');
  assert.equal(slateAppName('_c2c-x'), 'c2c-x');
  assert.equal(slateAppName('___'), 'app');
  // An already valid name is unchanged, so existing deploys keep their app.
  for (const valid of ['c2c-widget', 'c2c-library-app', 'App1']) assert.equal(slateAppName(valid), valid);
  for (const raw of ['c2c-library_system_application', 'x__y', '-a-', 'a.b c']) {
    const name = slateAppName(raw);
    assert.equal(slateNameProblem(name), undefined, name);
    assert.equal(slateAppName(name), name);
  }
});

test('slateNameProblem refuses underscores, edge hyphens and doubled hyphens', () => {
  for (const bad of ['c2c-library_system_application', '-app', 'app-', 'a--b', '', 'a b', 'a.b']) {
    assert.match(slateNameProblem(bad) ?? '', /not a Slate app name/, bad);
  }
  for (const good of ['c2c-library-system-application', 'a', 'A1-b2']) assert.equal(slateNameProblem(good), undefined, good);
});

test('the App Url line is read in the "App Url(<name>):" form zcatalyst-cli prints', () => {
  assert.equal(
    slateUrlFrom('App Url(c2c-library-app): https://c2c-library-app-abc123.onslate.in\n'),
    'https://c2c-library-app-abc123.onslate.in',
  );
});

function listingRest(bodies: unknown[]): { rest: RestFn; calls: RestCall[] } {
  const calls: RestCall[] = [];
  const rest: RestFn = async (call) => {
    calls.push(call);
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return { status: 200, body };
  };
  return { rest, calls };
}

const PRINTED = 'https://c2c-widget-abc123.onslate.in';
const LISTED = { data: [{ id: '3000000000000123', name: 'c2c-widget', domain: 'c2c-widget-abc123.onslate.in' }] };

test('waitForSlateApp polls a lagging app list until the printed app appears', async () => {
  const waits: number[] = [];
  const { rest, calls } = listingRest([{ data: [] }, { data: [] }, LISTED]);
  assert.equal(await waitForSlateApp(rest, '1001', 'c2c-widget', PRINTED, { sleep: async (ms) => { waits.push(ms); } }), true);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [2000, 4000]);
});

test('waitForSlateApp is bounded and fail-closed when the app never appears', async () => {
  const waits: number[] = [];
  const { rest, calls } = listingRest([{ data: [] }]);
  assert.equal(await waitForSlateApp(rest, '1001', 'c2c-widget', PRINTED, { sleep: async (ms) => { waits.push(ms); } }), false);
  assert.equal(calls.length, SLATE_LIST_WAITS_MS.length + 1);
  assert.deepEqual(waits, [...SLATE_LIST_WAITS_MS]);
  assert.equal(waits.reduce((a, b) => a + b, 0), 14000);
});

test('waitForSlateApp refuses a listed app serving another domain, or two same-name apps', async () => {
  const other = listingRest([{ data: [{ id: '1', name: 'c2c-widget', domain: 'someone-else.onslate.in' }] }]);
  assert.equal(await waitForSlateApp(other.rest, '1001', 'c2c-widget', PRINTED, { sleep: async () => {} }), false);
  const twice = listingRest([{ data: [{ id: '1', name: 'c2c-widget' }, { id: '2', name: 'c2c-widget' }] }]);
  assert.equal(await waitForSlateApp(twice.rest, '1001', 'c2c-widget', PRINTED, { sleep: async () => {} }), false);
  // Listed without a domain yet still counts: the build printed the URL.
  const bare = listingRest([{ data: [{ id: '1', name: 'c2c-widget' }] }]);
  assert.equal(await waitForSlateApp(bare.rest, '1001', 'c2c-widget', PRINTED, { sleep: async () => {} }), true);
});
