import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createRuntime } from '../src/runtime.js';
import { parseJsonLossless } from '../src/ids.js';
import { TASK_ADAPTERS, ZohoConnectionRefused, adapterFor, classifyZohoWrite, connectionArg, retryAfterMs, serviceBase, urlEncode, type ZohoConnectionsConfig } from '../src/zoho-adapters.js';

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  orgId: string | undefined;
  body: string;
}

interface Route {
  method: string;
  path: string;
  status?: number;
  reply: unknown;
  /** Exact response bytes. Use this when a 19-digit id must not pass through JSON.stringify. */
  raw?: string;
  headers?: Record<string, string>;
  /** Drop the route after one match so a later route can answer the same path. */
  once?: boolean;
}

/** A fake Zoho REST host on 127.0.0.1. Each route answers once with the replayed upstream body. */
async function fakeZoho(routes: Route[]): Promise<{ origin: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, orgId: req.headers.orgid as string | undefined, body });
      const index = routes.findIndex((r) => r.method === req.method && r.path === req.url);
      const route = index >= 0 ? routes[index] : undefined;
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'NOT_FOUND', url: req.url }));
        return;
      }
      if (route.once) routes.splice(index, 1);
      const status = route.status ?? 200;
      const extra = route.headers ?? {};
      if (route.raw !== undefined) {
        res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
        res.end(route.raw);
        return;
      }
      if (route.reply === null) {
        res.writeHead(status, extra);
        res.end();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(route.reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, seen, server };
}

function liveConfig(origin: string, extra: Partial<ZohoConnectionsConfig> = {}): ZohoConnectionsConfig {
  return {
    dc: 'in',
    connections: { c2c_crm: 'c2c_crm', c2c_books: 'c2c_books', c2c_desk: 'c2c_desk', c2c_cliq: 'c2c_cliq', c2c_creator: 'c2c_creator' },
    credentials: async (name) => `fake-token-for-${name}`,
    originOverrides: { 'https://www.zohoapis.in': origin, 'https://desk.zoho.in': origin, 'https://cliq.zoho.in': origin },
    ...extra,
  };
}

function live(config: ZohoConnectionsConfig) {
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', zohoConnections: config });
  return { runtime, ctx: runtime.context({ record: {} }) };
}

const crmEnvelope = (details: unknown, message: string) => ({ data: [{ code: 'SUCCESS', details, message, status: 'success' }] });

test('synthetic replay (no fixtures needed): CRM createRecord returns the details map, Creator getRecords returns {code, data}', async () => {
  const details = { id: '111', Created_Time: '2026-10-06T00:00:00+05:30' };
  const { origin, seen, server } = await fakeZoho([
    { method: 'POST', path: '/crm/v7/Leads', reply: crmEnvelope(details, 'record added') },
    { method: 'GET', path: '/creator/v2.1/data/o/a/report/R?from=1&limit=10', reply: { code: 3000, data: [{ ID: '9', Code: 'x' }] } },
    { method: 'GET', path: '/crm/v7/Leads/search?criteria=x&page=1&per_page=1', status: 204, reply: null },
  ]);
  try {
    const { runtime, ctx } = live(liveConfig(origin));
    const made = await runtime.shim.zoho.task(ctx, ['crm', 'createRecord'], ['Leads', { Last_Name: 'n' }, { trigger: ['workflow'] }, 'c2c_crm']);
    assert.deepEqual(made, details);
    assert.equal(String(made), JSON.stringify(details));
    assert.deepEqual(JSON.parse(seen[0]!.body), { data: [{ Last_Name: 'n' }], trigger: ['workflow'] });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['creator', 'getRecords'], ['o', 'a', 'R', '', 1, 10, 'c2c_creator']), { code: 3000, data: [{ ID: '9', Code: 'x' }] });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'searchRecords'], ['Leads', 'x', 1, 1, {}, 'c2c_crm']), []);
    assert.ok(runtime.transcript.every((e) => !JSON.stringify(e).includes('fake-token')), 'a token reached the transcript');
  } finally {
    server.close();
  }
});

test('request() builds the DC-resolved REST call for in and com', () => {
  const crm = TASK_ADAPTERS['crm.createRecord']!;
  assert.equal(crm.request(['Leads', {}, {}, 'c'], 'in').url, 'https://www.zohoapis.in/crm/v7/Leads');
  assert.equal(crm.request(['Leads', {}, {}, 'c'], 'com').url, 'https://www.zohoapis.com/crm/v7/Leads');
  const desk = TASK_ADAPTERS['desk.create']!.request(['600', 'tickets', { subject: 's' }, 'c'], 'com');
  assert.equal(desk.url, 'https://desk.zoho.com/api/v1/tickets');
  assert.equal(desk.headers.orgId, '600');
  assert.equal(TASK_ADAPTERS['cliq.postToChannel']!.request(['chan', 'hi', 'c'], 'in').url, 'https://cliq.zoho.in/api/v2/channelsbyname/chan/message');
  assert.equal(TASK_ADAPTERS['books.getRecords']!.request(['Contacts', '1', 'contact_name=A B', 'c'], 'in').url, 'https://www.zohoapis.in/books/v3/contacts?organization_id=1&contact_name=A%20B');
  assert.equal(TASK_ADAPTERS['books.updateRecord']!.request(['Invoices', '1', '77', {}, 'c'], 'com').url, 'https://www.zohoapis.com/books/v3/invoices/77?organization_id=1');
  assert.equal(serviceBase('creator', 'eu'), 'https://www.zohoapis.eu/creator/v2.1');
  assert.throws(() => serviceBase('crm', 'xx'), ZohoConnectionRefused);
});

test('ca, sa and ae connection hosts follow the shared DC table', () => {
  assert.equal(serviceBase('crm', 'ca'), 'https://www.zohoapis.ca/crm/v7');
  assert.equal(serviceBase('books', 'ca'), 'https://www.zohoapis.ca/books/v3');
  assert.equal(serviceBase('creator', 'ca'), 'https://www.zohoapis.ca/creator/v2.1');
  assert.equal(serviceBase('desk', 'ca'), 'https://desk.zohocloud.ca/api/v1');
  assert.equal(serviceBase('cliq', 'ca'), 'https://cliq.zohocloud.ca/api/v2');
  assert.equal(serviceBase('books', 'sa'), 'https://www.zohoapis.sa/books/v3');
  assert.equal(serviceBase('desk', 'sa'), 'https://desk.zoho.sa/api/v1');
  assert.equal(serviceBase('cliq', 'ae'), 'https://cliq.zoho.ae/api/v2');
  assert.equal(serviceBase('crm', 'uae'), 'https://www.zohoapis.ae/crm/v7');
  assert.equal(serviceBase('creator', 'com'), 'https://www.zohoapis.com/creator/v2.1');
  assert.throws(() => serviceBase('crm', ''), ZohoConnectionRefused);
});

test('connectionIndex beats "last string argument": a two-argument call names no connection', () => {
  const hit = adapterFor(['cliq', 'postToChannel'])!;
  assert.equal(connectionArg(hit.adapter, ['chan', 'Hello']), null);
  assert.equal(connectionArg(hit.adapter, ['chan', 'Hello', 'c2c_cliq']), 'c2c_cliq');
  assert.equal(connectionArg(adapterFor(['crm', 'createRecord'])!.adapter, ['Leads', {}, {}, 'c2c_crm']), 'c2c_crm');
});

test('dry run is the default: the request is recorded DC-resolved, no fetch, no credentials', async () => {
  let fetched = 0;
  let asked = 0;
  const runtime = createRuntime({
    appTimeZone: 'Asia/Kolkata',
    zohoConnections: {
      dc: 'in',
      connections: { c2c_crm: 'c2c_crm' },
      credentials: async () => {
        asked++;
        return 't';
      },
      fetch: async () => {
        fetched++;
        return { status: 200, text: async () => '{}' };
      },
    },
  });
  const ctx = runtime.context({ record: {} });
  assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'createRecord'], ['Leads', { Last_Name: 'n' }, {}, 'c2c_crm']), { dryRun: true, path: ['crm', 'createRecord'] });
  assert.deepEqual(await runtime.shim.http.invokeurl(ctx, { url: 'https://www.zohoapis.com/crm/v7/Leads', type: 'GET', connection: 'c2c_crm' }), { dryRun: true, performed: false });
  assert.equal(fetched, 0);
  assert.equal(asked, 0);
  const task = runtime.transcript.find((e) => e.op === 'zoho.task') as unknown as { request: { method: string; url: string }; connection: string };
  assert.deepEqual([task.request.method, task.request.url, task.connection], ['POST', 'https://www.zohoapis.in/crm/v7/Leads', 'c2c_crm']);
  assert.ok(runtime.transcript.some((e) => e.op === 'warn' && e.code === 'ZOHO_DC_MISMATCH'), 'a .com URL under dc in is flagged');
  const noDc = createRuntime({ appTimeZone: 'Asia/Kolkata' });
  await noDc.shim.zoho.task(noDc.context({ record: {} }), ['desk', 'create'], ['1', 'tickets', {}, 'c2c_desk']);
  assert.ok(noDc.transcript.some((e) => e.op === 'warn' && e.code === 'ZOHO_DC_UNSET'));
});

test('live refuses, naming the missing piece, and sends nothing', async () => {
  let fetched = 0;
  const fetch = async () => {
    fetched++;
    return { status: 200, text: async () => '{}' };
  };
  const base: ZohoConnectionsConfig = { dc: 'in', connections: { c2c_crm: 'c2c_crm' }, credentials: async () => 't', fetch };
  const call = (config: ZohoConnectionsConfig, args: unknown[] = ['Leads', {}, {}, 'c2c_crm']) => {
    const { runtime, ctx } = live(config);
    return runtime.shim.zoho.task(ctx, ['crm', 'createRecord'], args);
  };
  await assert.rejects(call({ ...base, dc: null }), (err: ZohoConnectionRefused) => err.missing === 'zoho-dc');
  await assert.rejects(call({ ...base, dc: 'xx' }), (err: ZohoConnectionRefused) => err.missing === 'zoho-dc');
  await assert.rejects(call({ ...base, connections: {} }), (err: ZohoConnectionRefused) => err.missing === 'connections.c2c_crm');
  await assert.rejects(call({ ...base, credentials: undefined }), (err: ZohoConnectionRefused) => err.missing === 'credentials');
  await assert.rejects(call(base, ['Leads', {}, {}]), (err: ZohoConnectionRefused) => err.missing === 'connections.default:crm');
  const { runtime, ctx } = live({ ...base, connections: {} });
  await assert.rejects(runtime.shim.http.invokeurl(ctx, { url: 'https://www.zohoapis.in/crm/v7/Leads', type: 'GET', connection: 'c2c_crm' }), /live-refused/);
  assert.equal(fetched, 0);
  // A call that names no connection uses the per-service default when one is configured.
  const ok = await call({ ...base, connections: { 'default:crm': 'crm_default' }, fetch: async () => ({ status: 200, text: async () => JSON.stringify(crmEnvelope({ id: '1' }, 'record added')) }) }, ['Leads', {}, {}]);
  assert.deepEqual(ok, { id: '1' });
});

test('live refuses to send a dry-run placeholder argument (a thisapp call result)', async () => {
  let fetched = 0;
  const { runtime, ctx } = live({
    dc: 'in',
    connections: { c2c_desk: 'c2c_desk' },
    credentials: async () => 't',
    fetch: async () => {
      fetched++;
      return { status: 200, text: async () => '{}' };
    },
  });
  const orgId = await runtime.shim.thisapp.call(ctx, ['c2c_desk_org_id'], []);
  await assert.rejects(runtime.shim.zoho.task(ctx, ['desk', 'create'], [orgId, 'tickets', {}, 'c2c_desk']), (err: ZohoConnectionRefused) => err.missing === 'argument 0' && /orgId is a dry-run placeholder/.test(err.message));
  assert.equal(fetched, 0);
});

test('a live thisapp dispatch result feeds a zoho task instead of a placeholder', async () => {
  const { origin, seen, server } = await fakeZoho([{ method: 'POST', path: '/api/v1/tickets', reply: { id: '9' } }]);
  try {
    const runtime = createRuntime({
      dryRun: false,
      appTimeZone: 'Asia/Kolkata',
      zohoConnections: liveConfig(origin, { connections: { c2c_desk: 'c2c_desk' } }),
      functions: { 'Org.id': { call: async () => '778899' } },
    });
    const ctx = runtime.context({ record: {} });
    const orgId = await runtime.shim.thisapp.call(ctx, ['Org', 'id'], []);
    assert.equal(orgId, '778899');
    await runtime.shim.zoho.task(ctx, ['desk', 'create'], [orgId, 'tickets', { subject: 's' }, 'c2c_desk']);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.orgId, '778899', 'the dispatched value reached the Zoho Desk request');
  } finally {
    server.close();
  }
});

// Rule: nothing posts outside the app owner's org without approval. Live
// Cliq posts and mail go only to zohoConnections.orgInternal destinations,
// unless zohoConnections.ownerApprovalToken is set.
const ORG = { cliqChannels: ['c2c-ops'], mailRecipients: ['@org.example.test', 'owner@elsewhere.example.test'] };
const channelRoute = (name: string): Route => ({ method: 'POST', path: `/api/v2/channelsbyname/${name}/message`, status: 204, reply: null });
const refusedFor = (dest: RegExp) => (err: ZohoConnectionRefused) => err instanceof ZohoConnectionRefused && err.missing === 'owner-approval' && dest.test(err.message);

test('messaging guard: an allowlisted Cliq channel sends (127.0.0.1)', async () => {
  const { origin, seen, server } = await fakeZoho([channelRoute('c2c-ops')]);
  try {
    const { runtime, ctx } = live(liveConfig(origin, { orgInternal: ORG }));
    const out = await runtime.shim.zoho.task(ctx, ['cliq', 'postToChannel'], ['c2c-ops', 'hello', 'c2c_cliq']);
    assert.deepEqual(out, { code: 200, data: { success: true }, status: 'OK' });
    assert.equal(seen.length, 1);
    assert.ok(runtime.transcript.some((e) => e.op === 'messaging-guard' && e.approvedBy === 'allowlist'));
  } finally {
    server.close();
  }
});

test('messaging guard: a non-allowlisted channel is refused, naming it, with 0 fetches and no credentials', async () => {
  let fetched = 0;
  let asked = 0;
  const config: ZohoConnectionsConfig = {
    ...liveConfig('http://127.0.0.1:9'),
    orgInternal: ORG,
    credentials: async () => {
      asked++;
      return 't';
    },
    fetch: async () => {
      fetched++;
      return { status: 204, text: async () => '' };
    },
  };
  const { runtime, ctx } = live(config);
  await assert.rejects(runtime.shim.zoho.task(ctx, ['cliq', 'postToChannel'], ['public-forum', 'hello', 'c2c_cliq']), refusedFor(/cliq-channel "public-forum"/));
  // The same post through invokeurl, and a post to a bot, are refused too.
  await assert.rejects(
    runtime.shim.http.invokeurl(ctx, { url: 'https://cliq.zoho.in/api/v2/channelsbyname/public-forum/message', type: 'POST', body: '{"text":"x"}', connection: 'c2c_cliq' }),
    refusedFor(/public-forum/),
  );
  await assert.rejects(
    runtime.shim.http.invokeurl(ctx, { url: 'https://cliq.zoho.in/api/v2/bots/somebot/message', type: 'POST', body: '{"text":"x"}', connection: 'c2c_cliq' }),
    refusedFor(/bots\/somebot/),
  );
  // An empty or missing allowlist refuses every live message, even an otherwise internal one.
  for (const orgInternal of [undefined, {}, { cliqChannels: [] }]) {
    const rt = live({ ...config, orgInternal });
    await assert.rejects(rt.runtime.shim.zoho.task(rt.ctx, ['cliq', 'postToChannel'], ['c2c-ops', 'hello', 'c2c_cliq']), refusedFor(/no org-internal allowlist/));
  }
  // postToUser / postToBot have no adapter; the generic connection fallback is guarded the same way.
  let connected = 0;
  const generic = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', connection: async () => connected++ });
  await assert.rejects(generic.shim.zoho.task(generic.context({ record: {} }), ['cliq', 'postToUser'], ['someone@outside.example.test', 'hi', 'c2c_cliq']), refusedFor(/someone@outside.example.test/));
  assert.equal(connected, 0);
  assert.equal(fetched, 0);
  assert.equal(asked, 0);
  assert.ok(runtime.transcript.some((e) => e.op === 'live-refused' && e.reason === 'owner-approval'));
});

test('messaging guard: a non-allowlisted channel sends with the owner approval token, which never reaches the transcript', async () => {
  const { origin, seen, server } = await fakeZoho([channelRoute('public-forum')]);
  try {
    const { runtime, ctx } = live(liveConfig(origin, { orgInternal: ORG, ownerApprovalToken: 'owner-approved-secret' }));
    await runtime.shim.zoho.task(ctx, ['cliq', 'postToChannel'], ['public-forum', 'hello', 'c2c_cliq']);
    assert.equal(seen.length, 1);
    assert.ok(runtime.transcript.some((e) => e.op === 'messaging-guard' && e.approvedBy === 'owner-approval-token'));
    assert.ok(runtime.transcript.every((e) => !JSON.stringify(e).includes('owner-approved-secret')));
  } finally {
    server.close();
  }
});

test('messaging guard: live mail goes to internal recipients only; a mixed to/cc/bcc is refused as a whole', async () => {
  const { origin, seen, server } = await fakeZoho([
    { method: 'POST', path: '/mail', reply: { sent: true } },
    { method: 'POST', path: '/mail', reply: { sent: true } },
  ]);
  try {
    const mail = async (message: Record<string, unknown>) => {
      const res = await fetch(`${origin}/mail`, { method: 'POST', body: JSON.stringify(message) });
      return res.json();
    };
    const mk = (extra: Partial<ZohoConnectionsConfig>) => {
      const runtime = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', mail, zohoConnections: { orgInternal: ORG, ...extra } });
      return { runtime, ctx: runtime.context({ record: {} }) };
    };
    const a = mk({});
    assert.deepEqual(await a.runtime.shim.mail.send(a.ctx, { from: 'app@org.example.test', to: 'Ops <ops@org.example.test>', cc: ['owner@elsewhere.example.test'], subject: 's', message: 'm' }), { sent: true });
    assert.equal(seen.length, 1);
    const mixed = { from: 'app@org.example.test', to: 'ops@org.example.test, a@org.example.test', cc: 'team@org.example.test', bcc: ['leak@outside.example.test'], subject: 's', message: 'm' };
    await assert.rejects(a.runtime.shim.mail.send(a.ctx, mixed), refusedFor(/mail "leak@outside.example.test"/));
    await assert.rejects(a.runtime.shim.mail.send(a.ctx, { ...mixed, bcc: undefined, to: 'ops@org.example.test; x@other.example.test' }), refusedFor(/x@other.example.test/));
    assert.equal(seen.length, 1, 'nothing of a mixed mail was sent');
    const none = mk({ orgInternal: null });
    await assert.rejects(none.runtime.shim.mail.send(none.ctx, { to: 'ops@org.example.test', subject: 's', message: 'm' }), refusedFor(/no org-internal allowlist/));
    const approved = mk({ ownerApprovalToken: 'tok' });
    await approved.runtime.shim.mail.send(approved.ctx, mixed);
    assert.equal(seen.length, 2);
  } finally {
    server.close();
  }
});

// invokeurl / http writes are classified deny-by-default: a Zoho Mail send is
// messaging (recipients from toAddress/ccAddress/bccAddress), and any Zoho
// write c2c does not classify needs the owner's token.
const MAIL_SEND = 'https://mail.zoho.in/api/accounts/123/messages';
const mailBody = (fields: Record<string, string>) => JSON.stringify({ fromAddress: 'app@org.example.test', subject: 's', content: 'm', ...fields });

function countingConfig(extra: Partial<ZohoConnectionsConfig> = {}) {
  const counts = { fetched: 0, asked: 0 };
  const config: ZohoConnectionsConfig = {
    ...liveConfig('http://127.0.0.1:9'),
    connections: { ...liveConfig('').connections, c2c_mail: 'c2c_mail', c2c_other: 'c2c_other' },
    orgInternal: ORG,
    credentials: async () => {
      counts.asked++;
      return 't';
    },
    fetch: async () => {
      counts.fetched++;
      return { status: 200, text: async () => '{}' };
    },
    ...extra,
  };
  return { config, counts };
}

test('messaging guard: invokeurl to a Zoho Mail send endpoint is guarded by recipient, with 0 fetches on refusal', async () => {
  const { config, counts } = countingConfig();
  const { runtime, ctx } = live(config);
  const send = (url: string, body: string) => runtime.shim.http.invokeurl(ctx, { url, type: 'POST', body, connection: 'c2c_mail' });
  await assert.rejects(send(MAIL_SEND, mailBody({ toAddress: 'leak@outside.example.test' })), refusedFor(/mail "leak@outside.example.test"/));
  // Mixed recipients are refused as a whole.
  await assert.rejects(send(MAIL_SEND, mailBody({ toAddress: 'ops@org.example.test,a@org.example.test', ccAddress: 'owner@elsewhere.example.test', bccAddress: 'leak@outside.example.test' })), refusedFor(/leak@outside.example.test/));
  // A zohoapis mail path and a form-encoded body are read the same way.
  await assert.rejects(send('https://www.zohoapis.in/mail/api/accounts/123/messages', 'toAddress=leak%40outside.example.test'), refusedFor(/leak@outside.example.test/));
  // Unreadable recipients are refused without the token.
  await assert.rejects(send(MAIL_SEND, 'not a mail body'), refusedFor(/recipients .* could not be read.*mail\.zoho\.in\/api\/accounts\/123\/messages/));
  await assert.rejects(send(MAIL_SEND, mailBody({ ToAddress: 'leak@outside.example.test' })), refusedFor(/could not be read/));
  await assert.rejects(send(`${MAIL_SEND}?toAddress=leak@outside.example.test`, mailBody({ toAddress: 'ops@org.example.test' })), refusedFor(/could not be read/));
  assert.equal(counts.fetched, 0);
  assert.equal(counts.asked, 0);
});

test('messaging guard: invokeurl mail to allowlisted recipients sends (127.0.0.1)', async () => {
  const { origin, seen, server } = await fakeZoho([{ method: 'POST', path: '/api/accounts/123/messages', reply: { status: { code: 200 } } }]);
  try {
    const config = liveConfig(origin, { orgInternal: ORG });
    config.connections = { ...config.connections, c2c_mail: 'c2c_mail' };
    config.originOverrides = { ...config.originOverrides, 'https://mail.zoho.in': origin };
    const { runtime, ctx } = live(config);
    const body = mailBody({ toAddress: 'Ops <ops@org.example.test>', ccAddress: 'owner@elsewhere.example.test' });
    assert.deepEqual(await runtime.shim.http.invokeurl(ctx, { url: MAIL_SEND, type: 'POST', body, connection: 'c2c_mail' }), { status: { code: 200 } });
    assert.equal(seen.length, 1);
    assert.ok(runtime.transcript.some((e) => e.op === 'messaging-guard' && e.approvedBy === 'allowlist'));
  } finally {
    server.close();
  }
});

test('messaging guard: an unclassified Zoho write is refused without the token, naming host and path', async () => {
  const { config, counts } = countingConfig();
  const { runtime, ctx } = live(config);
  const post = (url: string) => runtime.shim.http.invokeurl(ctx, { url, type: 'POST', body: '{}', connection: 'c2c_other' });
  await assert.rejects(post('https://www.zohoapis.in/workdrive/api/v1/files'), refusedFor(/does not classify \(www\.zohoapis\.in\/workdrive\/api\/v1\/files\)/));
  await assert.rejects(post('https://people.zoho.in/api/v1/forms/x/insertRecord'), refusedFor(/people\.zoho\.in\/api\/v1\/forms/));
  // A sending segment of a known service is not a record write.
  await assert.rejects(post('https://www.zohoapis.in/crm/v7/Leads/1/actions/send_mail'), refusedFor(/crm endpoint that sends mail/));
  await assert.rejects(post('https://www.zohoapis.in/books/v3/invoices/1/email'), refusedFor(/books endpoint that sends mail/));
  await assert.rejects(post('https://desk.zoho.in/api/v1/tickets/1/sendReply'), refusedFor(/desk endpoint that sends mail/));
  assert.equal(counts.fetched, 0);
  assert.equal(counts.asked, 0);
  // A CRM record write is a known service and goes through; a read is never guarded.
  await runtime.shim.http.invokeurl(ctx, { url: 'https://www.zohoapis.in/crm/v7/Leads', type: 'POST', body: '{}', connection: 'c2c_crm' });
  await runtime.shim.http.invokeurl(ctx, { url: 'https://www.zohoapis.in/workdrive/api/v1/files', type: 'GET', connection: 'c2c_other' });
  assert.equal(counts.fetched, 2);
  // The token approves the unclassified write.
  const approved = countingConfig({ ownerApprovalToken: 'tok' });
  const a = live(approved.config);
  await a.runtime.shim.http.invokeurl(a.ctx, { url: 'https://www.zohoapis.in/workdrive/api/v1/files', type: 'POST', body: '{}', connection: 'c2c_other' });
  assert.equal(approved.counts.fetched, 1);
});

test('messaging guard: the options.http fallback (no connection link) gives the same results', async () => {
  let called = 0;
  const mk = (extra: Partial<ZohoConnectionsConfig> = {}) => {
    const runtime = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', http: async () => ({ ok: ++called }), zohoConnections: { orgInternal: ORG, ...extra } });
    return { runtime, ctx: runtime.context({ record: {} }) };
  };
  const { runtime, ctx } = mk();
  const send = (url: string, body: string) => runtime.shim.http.invokeurl(ctx, { url, type: 'POST', body });
  await assert.rejects(send(MAIL_SEND, mailBody({ toAddress: 'leak@outside.example.test' })), refusedFor(/mail "leak@outside.example.test"/));
  await assert.rejects(send(MAIL_SEND, mailBody({ toAddress: 'ops@org.example.test', bccAddress: 'leak@outside.example.test' })), refusedFor(/leak@outside.example.test/));
  await assert.rejects(send(MAIL_SEND, ''), refusedFor(/could not be read/));
  await assert.rejects(send('https://www.zohoapis.in/workdrive/api/v1/files', '{}'), refusedFor(/does not classify/));
  assert.equal(called, 0);
  assert.deepEqual(await send(MAIL_SEND, mailBody({ toAddress: 'ops@org.example.test' })), { ok: 1 });
  // A non-Zoho host is outside the messaging guard (the deployer's own http client).
  assert.deepEqual(await send('https://api.example.com/hook', '{}'), { ok: 2 });
  // No zohoConnections at all: every Zoho mail write is refused.
  const bare = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', http: async () => ({ ok: ++called }) });
  await assert.rejects(bare.shim.http.invokeurl(bare.context({ record: {} }), { url: MAIL_SEND, type: 'POST', body: mailBody({ toAddress: 'ops@org.example.test' }) }), refusedFor(/no org-internal allowlist/));
  assert.equal(called, 2);
});

test('messaging guard: a scoped owner token approves only the destinations it names', async () => {
  for (const token of ['partner@outside.example.test=tok-1, other-forum=tok-2', '{"partner@outside.example.test":"tok-1","other-forum":"tok-2"}']) {
    const { config, counts } = countingConfig({ ownerApprovalToken: token });
    const { runtime, ctx } = live(config);
    const send = (to: string) => runtime.shim.http.invokeurl(ctx, { url: MAIL_SEND, type: 'POST', body: mailBody({ toAddress: to }), connection: 'c2c_mail' });
    await send('Partner <partner@outside.example.test>');
    assert.equal(counts.fetched, 1);
    await assert.rejects(send('partner@outside.example.test, leak@outside.example.test'), refusedFor(/leak@outside.example.test/));
    await assert.rejects(runtime.shim.zoho.task(ctx, ['cliq', 'postToChannel'], ['public-forum', 'hello', 'c2c_cliq']), refusedFor(/public-forum/));
    await runtime.shim.zoho.task(ctx, ['cliq', 'postToChannel'], ['other-forum', 'hello', 'c2c_cliq']);
    assert.equal(counts.fetched, 2);
    assert.ok(runtime.transcript.every((e) => !JSON.stringify(e).includes('tok-1')));
  }
  // The plain form approves every destination on the deploy; base64 padding stays plain.
  for (const token of ['plain-token', 'YWJj==']) {
    const { config, counts } = countingConfig({ ownerApprovalToken: token });
    const { runtime, ctx } = live(config);
    await runtime.shim.http.invokeurl(ctx, { url: MAIL_SEND, type: 'POST', body: mailBody({ toAddress: 'leak@outside.example.test' }), connection: 'c2c_mail' });
    assert.equal(counts.fetched, 1);
  }
  // An unreadable JSON map approves nothing.
  const broken = countingConfig({ ownerApprovalToken: '{not json' });
  const b = live(broken.config);
  await assert.rejects(b.runtime.shim.http.invokeurl(b.ctx, { url: MAIL_SEND, type: 'POST', body: mailBody({ toAddress: 'leak@outside.example.test' }), connection: 'c2c_mail' }), refusedFor(/leak@outside.example.test/));
  assert.equal(broken.counts.fetched, 0);
});

test('messaging guard: dry run is unchanged (recorded, not sent, not refused)', async () => {
  let sent = 0;
  const runtime = createRuntime({ appTimeZone: 'Asia/Kolkata', mail: async () => sent++, zohoConnections: { dc: 'in', connections: { c2c_cliq: 'c2c_cliq' }, fetch: async () => ({ status: 204, text: async () => String(sent++) }) } });
  const ctx = runtime.context({ record: {} });
  assert.deepEqual(await runtime.shim.zoho.task(ctx, ['cliq', 'postToChannel'], ['public-forum', 'hello', 'c2c_cliq']), { dryRun: true, path: ['cliq', 'postToChannel'] });
  assert.deepEqual(await runtime.shim.mail.send(ctx, { to: 'leak@outside.example.test', subject: 's', message: 'm' }), { dryRun: true, performed: false });
  assert.equal(sent, 0);
  assert.ok(runtime.transcript.some((e) => e.op === 'zoho.task'));
  assert.ok(runtime.transcript.some((e) => e.op === 'sendmail'));
  assert.ok(!runtime.transcript.some((e) => e.op === 'live-refused'));
});

test('classifyZohoWrite: an ambiguous effective host is unknown (IP literal, localhost, single label, userinfo, Host header)', () => {
  const kind = (url: string, headers?: Record<string, string>) => classifyZohoWrite(url, 'POST', '{}', headers).kind;
  // An IP literal with a Zoho Host header is classified by the header: mail is messaging.
  assert.equal(kind('http://1.2.3.4/api/accounts/1/messages', { Host: 'mail.zoho.com' }), 'messaging');
  assert.equal(kind('http://1.2.3.4/api/accounts/1/messages', { host: 'MAIL.ZOHO.COM.:443' }), 'messaging');
  assert.equal(kind('http://[::1]/api/accounts/1/messages', { ':authority': 'mail.zoho.in' }), 'messaging');
  assert.equal(kind('https://api.example.com/x', { 'X-Forwarded-Host': 'cliq.zoho.in' }), 'messaging');
  // A Zoho Host header naming a record-write service is still not trusted as a service write.
  assert.equal(kind('http://1.2.3.4/crm/v7/Leads', { Host: 'www.zohoapis.in' }), 'unknown');
  // Ambiguous hosts with no header, or a header naming another non-Zoho host.
  for (const url of ['http://1.2.3.4/api/accounts/1/messages', 'http://0x01020304/x', 'http://[2001:db8::1]:8080/x', 'http://localhost:3000/x', 'http://app.localhost/x', 'http://intranet/x', 'http://mail.zoho.com@1.2.3.4/x', 'http://zoho:pw@evil.example.test/x']) {
    assert.equal(kind(url), 'unknown', url);
  }
  assert.equal(kind('https://api.example.com/x', { Host: 'other.example' }), 'unknown');
  assert.equal(kind('https://api.example.com/x', { Host: 'bad host/[' }), 'unknown');
  // Userinfo, port and trailing dots on a Zoho URL host still classify by that host.
  assert.equal(kind('https://u:p@mail.zoho.in.:443/api/accounts/1/messages'), 'messaging');
  assert.equal(kind('https://www.zohoapis.in../crm/v7/Leads'), 'service');
  // Controls: a placeable non-Zoho host (with or without a matching Host header) stays outside the guard; reads are never guarded.
  assert.equal(kind('https://api.example.com/hook'), 'not-guarded');
  assert.equal(kind('https://api.example.com/hook', { Host: 'API.example.com:443' }), 'not-guarded');
  assert.equal(classifyZohoWrite('http://1.2.3.4/x', 'GET', undefined, { Host: 'mail.zoho.com' }).kind, 'not-guarded');
});

test('classifyZohoWrite: sending segments with params, extensions, encodings and case are unknown', () => {
  const kind = (path: string) => classifyZohoWrite(`https://www.zohoapis.in${path}`, 'POST', '{}').kind;
  for (const path of [
    '/crm/v7/Leads/1/actions/send_mail;x=y',
    '/crm/v7/Leads/1/actions/send_mail.json',
    '/crm/v7/Leads/1/actions/send%5Fmail',
    '/crm/v7/Leads/1/actions/send%255Fmail',
    '/crm/v7/Leads/1/actions/SEND_MAIL',
    '/crm/v7/Leads/1/actions/Send-Mail',
    '/crm/v7/Leads/1/actions/%53end_mail',
    '/books/v3/invoices/1/Email.json',
    '/books/v3/invoices/1/e-mail',
    '/books/v3/invoices/1/paymentreminder;a=b',
    '/books/v3/invoices/1/auto_remind',
    '/crm/v7/Leads/1/actions/notify-owner',
    '/crm/v7/Leads/1/actions/x_sms',
  ]) {
    assert.equal(kind(path), 'unknown', path);
  }
  assert.equal(classifyZohoWrite('https://desk.zoho.in/api/v1/tickets/1/sendReply;v=1', 'POST', '{}').kind, 'unknown');
  // A segment that cannot be decoded is unknown.
  assert.equal(kind('/crm/v7/Leads/%E0%A4%A'), 'unknown');
  assert.equal(kind('/crm/v7/Leads/1/actions/%ZZsend'), 'unknown');
  // Negative control: a normal CRM record write stays a service write.
  assert.deepEqual(classifyZohoWrite('https://www.zohoapis.in/crm/v7/Leads/1000000000000123', 'PUT', '{}'), { kind: 'service', service: 'crm' });
  assert.deepEqual(classifyZohoWrite('https://www.zohoapis.in/crm/v7/Leads.json', 'POST', '{}'), { kind: 'service', service: 'crm' });
});

test('classifyZohoWrite: cliq destinations use the request host, never a hard-coded IN host', () => {
  const channel = { kind: 'messaging', destinations: [{ kind: 'cliq-channel', value: 'team' }] };
  assert.deepEqual(classifyZohoWrite('https://cliq.zoho.eu/api/v2/channelsbyname/team/message', 'POST', '{"text":"x"}'), channel);
  // The same path through zohoapis classifies identically (no synthesized IN host).
  assert.deepEqual(classifyZohoWrite('https://www.zohoapis.eu/cliq/api/v2/channelsbyname/team/message', 'POST', '{"text":"x"}'), channel);
  // An unclassified cliq path names the request's own URL, not cliq.zoho.in.
  const other = JSON.stringify(classifyZohoWrite('https://cliq.zoho.eu/api/v2/strange/thing', 'POST', '{}'));
  assert.ok(other.includes('cliq.zoho.eu'), other);
  assert.ok(!other.includes('zoho.in'), other);
});

test('messaging guard: invokeurl to an IP literal with a Zoho Mail Host header is refused (0 sends)', async () => {
  let called = 0;
  const runtime = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', http: async () => ({ ok: ++called }), zohoConnections: { orgInternal: ORG } });
  const ctx = runtime.context({ record: {} });
  const body = mailBody({ toAddress: 'leak@outside.example.test' });
  await assert.rejects(runtime.shim.http.invokeurl(ctx, { url: 'http://1.2.3.4/api/accounts/1/messages', type: 'POST', body, headers: { Host: 'mail.zoho.com' } }), refusedFor(/leak@outside.example.test/));
  await assert.rejects(runtime.shim.http.invokeurl(ctx, { url: 'http://1.2.3.4/x', type: 'POST', body: '{}' }), refusedFor(/cannot place/));
  await assert.rejects(runtime.shim.http.invokeurl(ctx, { url: 'https://www.zohoapis.in/crm/v7/Leads/1/actions/send_mail;x=y', type: 'POST', body: '{}' }), refusedFor(/sends mail/));
  assert.equal(called, 0);
});

/** Creator lookup example, 19 digits, past Number.MAX_SAFE_INTEGER. */
const ID19 = '1000000000000113058';

test('parseJsonLossless keeps a 19-digit id and does not change a safe integer', () => {
  const raw = `{"id":${ID19},"code":3000,"rate":1.5,"ok":true,"name":"Wills"}`;
  assert.notEqual(String((JSON.parse(raw) as { id: number }).id), ID19);
  const parsed = parseJsonLossless(raw) as { id: string; code: number; rate: number; ok: boolean; name: string };
  assert.equal(parsed.id, ID19);
  assert.equal(parsed.code, 3000);
  assert.equal(parsed.rate, 1.5);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.name, 'Wills');
  // 2^53+1 rounds onto a safe integer; the digit string is still kept.
  assert.equal((parseJsonLossless('{"n":9007199254740993}') as { n: string }).n, '9007199254740993');
});

test('urlEncode matches Deluge: space is %20, reserved characters are percent-encoded, non-text is null', async () => {
  // The help example's input. Its return comment writes http%3A (the s is missing); the function encodes the argument it was given.
  // https://www.zoho.com/deluge/help/functions/encryption/urlencode.html
  assert.equal(urlEncode('https://www.zoho.com/creator'), 'https%3A%2F%2Fwww.zoho.com%2Fcreator');
  // The page's note: a space is %20. encodeUrl would use +.
  assert.equal(urlEncode('John Doe'), 'John%20Doe');
  // encodeUrl's example, with a space so the two functions differ. https://www.zoho.com/deluge/help/functions/common/encodeurl.html
  assert.equal(
    urlEncode('http://www.zoho.com/zohotest?name=John Doe&country=Australia&age=101'),
    'http%3A%2F%2Fwww.zoho.com%2Fzohotest%3Fname%3DJohn%20Doe%26country%3DAustralia%26age%3D101',
  );
  assert.equal(urlEncode('a*b-c_d.e'), 'a*b-c_d.e');
  assert.equal(urlEncode('a+b'), 'a%2Bb');
  assert.equal(urlEncode('a~b'), 'a%7Eb');
  assert.equal(urlEncode(''), '');
  assert.equal(urlEncode(null), null);
  assert.equal(urlEncode(23), null);
  assert.equal(urlEncode({}), null);
  let fetched = 0;
  const runtime = createRuntime({
    appTimeZone: 'Asia/Kolkata',
    zohoConnections: { dc: 'in', fetch: async () => { fetched += 1; return { status: 200, text: async () => '{}' }; } },
  });
  const ctx = runtime.context({ record: {} });
  assert.equal(await runtime.shim.zoho.task(ctx, ['encryption', 'urlEncode'], ['a b']), 'a%20b');
  assert.equal(await runtime.shim.zoho.task(ctx, ['encryption', 'urlEncode'], [1]), null);
  assert.equal(fetched, 0);
  const noted = runtime.transcript.find((e) => e.op === 'zoho.task' && e.local === true);
  assert.equal(noted?.performed, true);
  assert.equal(noted?.service, 'encryption');
});

test('books.getRecordsByID is not books.getRecords, and the already-adapted CRM writes stay adapted', () => {
  assert.equal(adapterFor(['books', 'getRecordsByID'])!.key, 'books.getRecordsByID');
  assert.equal(adapterFor(['books', 'getRecordsById'])!.key, 'books.getRecordsByID');
  assert.notEqual(adapterFor(['books', 'getRecords'])!.key, 'books.getRecordsByID');
  assert.equal(adapterFor(['crm', 'createRecord'])!.key, 'crm.createRecord');
  assert.equal(adapterFor(['crm', 'searchRecords'])!.key, 'crm.searchRecords');
  assert.equal(adapterFor(['crm', 'updateRecord'])!.key, 'crm.updateRecord');
  assert.equal(connectionArg(adapterFor(['crm', 'getOrgVariable'])!.adapter, ['Score', 'c2c_crm']), null);
  assert.equal(TASK_ADAPTERS['crm.getRecordById']!.request(['Leads', ID19, { '': '' }, 'c'], 'com').url, `https://www.zohoapis.com/crm/v7/Leads/${ID19}`);
  assert.equal(
    TASK_ADAPTERS['crm.getRelatedRecords']!.request(['Notes', 'Leads', ID19], 'com').url,
    `https://www.zohoapis.com/crm/v7/Leads/${ID19}/Notes?page=1&per_page=200`,
  );
});

test('top-gap adapters: dry run records the DC URL and does not fetch', async () => {
  let fetched = 0;
  const runtime = createRuntime({
    appTimeZone: 'Asia/Kolkata',
    zohoConnections: {
      dc: 'in',
      connections: { c2c_crm: 'c2c_crm', c2c_books: 'c2c_books', c2c_cliq: 'c2c_cliq', 'default:crm': 'c2c_crm' },
      fetch: async () => {
        fetched += 1;
        return { status: 200, text: async () => '{}' };
      },
    },
  });
  const ctx = runtime.context({ record: {} });
  const calls: [string[], unknown[], string, string][] = [
    [['crm', 'getRecordById'], ['Leads', ID19, { fields: 'Last_Name' }, 'c2c_crm'], 'GET', `https://www.zohoapis.in/crm/v7/Leads/${ID19}?fields=Last_Name`],
    [['crm', 'getRelatedRecords'], ['Trucks', 'Accounts', ID19, 1, 200, {}, 'c2c_crm'], 'GET', `https://www.zohoapis.in/crm/v7/Accounts/${ID19}/Trucks?page=1&per_page=200`],
    [['books', 'getRecordsByID'], ['Contacts', '5379', '92275', 'c2c_books'], 'GET', 'https://www.zohoapis.in/books/v3/contacts/92275?organization_id=5379'],
    [['cliq', 'getRecords'], ['availabilitydatabase', { criteria: 'availability==true' }, 'c2c_cliq'], 'GET', 'https://cliq.zoho.in/api/v2/storages/availabilitydatabase/records?criteria=availability%3D%3Dtrue'],
    [['crm', 'getOrgVariable'], ['Score'], 'GET', 'https://www.zohoapis.in/crm/v7/settings/variables?api_names=Score'],
    [['crm', 'invokeConnector'], ['crm.getorg', { Fname: 'A' }], 'POST', 'https://www.zohoapis.in/crm/v7/settings/connectors/crm.getorg/actions/invoke'],
  ];
  for (const [path, args, method, url] of calls) {
    assert.deepEqual(await runtime.shim.zoho.task(ctx, path, args), { dryRun: true, path }, path.join('.'));
    const task = [...runtime.transcript].reverse().find((e) => e.op === 'zoho.task' && Array.isArray(e.path) && (e.path as string[]).join('.') === path.join('.')) as unknown as { request: { url: string; method: string } };
    assert.deepEqual([task.request.method, task.request.url], [method, url], path.join('.'));
  }
  assert.equal(fetched, 0);
});

function withDefaultCrm(origin: string, extra: Partial<ZohoConnectionsConfig> = {}): ZohoConnectionsConfig {
  const config = liveConfig(origin, extra);
  config.connections = { ...config.connections, 'default:crm': 'c2c_crm' };
  return config;
}

test('top-gap adapters: live 127.0.0.1 returns the Deluge shape and keeps a 19-digit id', async () => {
  const recordRaw = `{"data":[{"id":${ID19},"Last_Name":"Wills","Owner":{"name":"Ben","id":${ID19}}}]}`;
  const { origin, seen, server } = await fakeZoho([
    { method: 'GET', path: `/crm/v7/Leads/${ID19}?fields=Last_Name`, raw: recordRaw, reply: null },
    { method: 'GET', path: `/crm/v7/Accounts/${ID19}/Trucks?page=1&per_page=200`, raw: `{"data":[{"id":${ID19},"Truck_Status":"Leased"}]}`, reply: null },
    { method: 'GET', path: '/books/v3/contacts/92275?organization_id=5379', reply: { code: 0, message: 'success', contact: { contact_id: '92275', contact_name: 'C2C' } } },
    { method: 'GET', path: '/api/v2/storages/availabilitydatabase/records?criteria=availability%3D%3Dtrue', reply: { status: 'SUCCESS', url: '/api/v2/storages/availabilitydatabase/records', list: [{ id: '1775', name: 'John', availability: true }] } },
    { method: 'GET', path: '/crm/v7/settings/variables?api_names=Score', reply: { variables: [{ api_name: 'Score', value: 23 }] } },
    { method: 'POST', path: '/crm/v7/settings/connectors/crm.getorg/actions/invoke', raw: `{"org":[{"id":${ID19}}]}`, reply: null },
  ]);
  try {
    const { runtime, ctx } = live(withDefaultCrm(origin, { ownerApprovalToken: 'owner-secret-9' }));
    const record = await runtime.shim.zoho.task(ctx, ['crm', 'getRecordById'], ['Leads', ID19, { fields: 'Last_Name' }, 'c2c_crm']);
    const expectedRecord = { id: ID19, Last_Name: 'Wills', Owner: { name: 'Ben', id: ID19 } };
    assert.deepEqual(record, expectedRecord);
    assert.equal(String(record), JSON.stringify(expectedRecord));
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRelatedRecords'], ['Trucks', 'Accounts', ID19, 1, 200, {}, 'c2c_crm']), [{ id: ID19, Truck_Status: 'Leased' }]);
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['books', 'getRecordsByID'], ['Contacts', '5379', '92275', 'c2c_books']), { code: 0, message: 'success', contact: { contact_id: '92275', contact_name: 'C2C' } });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['cliq', 'getRecords'], ['availabilitydatabase', { criteria: 'availability==true' }, 'c2c_cliq']), {
      status: 'SUCCESS',
      url: '/api/v2/storages/availabilitydatabase/records',
      list: [{ id: '1775', name: 'John', availability: true }],
    });
    assert.equal(await runtime.shim.zoho.task(ctx, ['crm', 'getOrgVariable'], ['Score']), 23);
    const invoked = await runtime.shim.zoho.task(ctx, ['crm', 'invokeConnector'], ['crm.getorg', { Fname: 'A' }]);
    assert.deepEqual(invoked, { status_code: '200', response: JSON.stringify({ org: [{ id: ID19 }] }) });
    assert.equal(seen.length, 6);
    assert.ok(seen.every((s) => /^Zoho-oauthtoken fake-token-for-c2c_/.test(s.auth ?? '')));
    assert.equal(seen[5]!.body, JSON.stringify({ variables: { Fname: 'A' } }));
    assert.equal((record as { id: string }).id, ID19);
  } finally {
    server.close();
  }
});

test('top-gap adapters: a toLong() id is sent as its exact digits in the URL and the body', async () => {
  const { origin, seen, server } = await fakeZoho([
    { method: 'GET', path: `/crm/v7/Leads/${ID19}`, raw: `{"data":[{"id":${ID19}}]}`, reply: null },
    { method: 'POST', path: '/crm/v7/settings/connectors/crm.getorg/actions/invoke', reply: { ok: true } },
  ]);
  try {
    const { runtime, ctx } = live(withDefaultCrm(origin, { ownerApprovalToken: 'owner-secret-9' }));
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRecordById'], ['Leads', BigInt(ID19), {}, 'c2c_crm']), { id: ID19 });
    await runtime.shim.zoho.task(ctx, ['crm', 'invokeConnector'], ['crm.getorg', { id: BigInt(ID19), ids: [BigInt(ID19)] }]);
    assert.equal(seen[1]!.body, `{"variables":{"id":"${ID19}","ids":["${ID19}"]}}`);
  } finally {
    server.close();
  }
});

test('top-gap adapters: error bodies map to the Deluge error value', async () => {
  const { origin, server } = await fakeZoho([
    { method: 'GET', path: '/crm/v7/Leads/0', status: 400, reply: { code: 'INVALID_DATA', details: {}, message: 'the id given seems to be invalid', status: 'error' } },
    { method: 'GET', path: '/crm/v7/Leads/bad', status: 502, raw: 'upstream down', reply: null },
    { method: 'GET', path: '/crm/v7/Accounts/0/Trucks?page=1&per_page=200', status: 204, reply: null },
    { method: 'GET', path: '/crm/v7/Accounts/1/Trucks?page=1&per_page=1', status: 400, reply: { code: 'INVALID_DATA', message: 'the related id given seems to be invalid', status: 'error' } },
    { method: 'GET', path: '/books/v3/contacts/0?organization_id=1', status: 404, reply: { code: 1002, message: 'Resource does not exist.' } },
    { method: 'GET', path: '/api/v2/storages/missing/records', status: 404, reply: { status: 'FAILURE', message: 'Uh-oh! Looks like missing does not exist.', code: 'platform_storage_database_not_found' } },
    { method: 'GET', path: '/crm/v7/settings/variables?api_names=Missing', reply: { variables: [] } },
    { method: 'POST', path: '/crm/v7/settings/connectors/nope/actions/invoke', status: 400, reply: { message: 'no such connector' } },
  ]);
  try {
    const { runtime, ctx } = live(withDefaultCrm(origin, { ownerApprovalToken: 'owner-secret-9' }));
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRecordById'], ['Leads', '0', {}, 'c2c_crm']), { code: 'INVALID_DATA', details: {}, message: 'the id given seems to be invalid', status: 'error' });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRecordById'], ['Leads', 'bad', {}, 'c2c_crm']), { code: 'HTTP_502', message: 'upstream down', status: 'error' });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRelatedRecords'], ['Trucks', 'Accounts', '0', 1, 200, {}, 'c2c_crm']), []);
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRelatedRecords'], ['Trucks', 'Accounts', '1', 1, 1, {}, 'c2c_crm']), { code: 'INVALID_DATA', message: 'the related id given seems to be invalid', status: 'error' });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['books', 'getRecordsByID'], ['Contacts', '1', '0', 'c2c_books']), { code: 1002, message: 'Resource does not exist.' });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['cliq', 'getRecords'], ['missing', {}, 'c2c_cliq']), { status: 'FAILURE', message: 'Uh-oh! Looks like missing does not exist.', code: 'platform_storage_database_not_found' });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getOrgVariable'], ['Missing']), { code: 'INVALID_DATA', message: 'org variable was not in the response', status: 'error' });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'invokeConnector'], ['nope', {}]), { status_code: '400', response: JSON.stringify({ message: 'no such connector' }) });
  } finally {
    server.close();
  }
});

test('Retry-After is honoured, and a wait past the max fails without sleeping it', async () => {
  assert.equal(retryAfterMs('0'), 0);
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs(new Date(Date.now() - 5000).toUTCString()), 0);
  assert.equal(retryAfterMs('not-a-date'), -1);
  const { origin, seen, server } = await fakeZoho([
    { method: 'GET', path: '/crm/v7/Leads/9', status: 429, reply: null, headers: { 'Retry-After': '0' }, once: true },
    { method: 'GET', path: '/crm/v7/Leads/9', reply: { data: [{ id: '9', Last_Name: 'n' }] } },
  ]);
  try {
    const { runtime, ctx } = live(liveConfig(origin));
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRecordById'], ['Leads', '9', {}, 'c2c_crm']), { id: '9', Last_Name: 'n' });
    assert.equal(seen.length, 2);
  } finally {
    server.close();
  }
  const slow = await fakeZoho([{ method: 'GET', path: '/crm/v7/Leads/9', status: 429, reply: null, headers: { 'Retry-After': '120' } }]);
  try {
    const waited: number[] = [];
    const { runtime, ctx } = live(liveConfig(slow.origin, { sleep: async (ms) => { waited.push(ms); } }));
    await assert.rejects(runtime.shim.zoho.task(ctx, ['crm', 'getRecordById'], ['Leads', '9', {}, 'c2c_crm']), (err: ZohoConnectionRefused) => err.missing === 'rate-limit' && /120s/.test(err.message));
    assert.deepEqual(waited, []);
    assert.equal(slow.seen.length, 1);
  } finally {
    slow.server.close();
  }
});

test('cliq.getRecords is a read: the messaging guard still refuses a live post and does not refuse the read', async () => {
  const { origin, seen, server } = await fakeZoho([{ method: 'GET', path: '/api/v2/storages/db/records', reply: { status: 'SUCCESS', list: [] } }]);
  try {
    const { runtime, ctx } = live(liveConfig(origin));
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['cliq', 'getRecords'], ['db', {}, 'c2c_cliq']), { status: 'SUCCESS', list: [] });
    assert.equal(seen.length, 1);
    await assert.rejects(runtime.shim.zoho.task(ctx, ['cliq', 'postToChannel'], ['public-forum', 'hi', 'c2c_cliq']), refusedFor(/no org-internal allowlist/));
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});

test('messaging guard: crm.invokeConnector is an unclassified Zoho write — refused live without the owner token', async () => {
  let fetched = 0;
  let asked = 0;
  const config: ZohoConnectionsConfig = {
    ...liveConfig('http://127.0.0.1:9'),
    connections: { 'default:crm': 'c2c_crm' },
    orgInternal: ORG,
    credentials: async () => {
      asked += 1;
      return 't';
    },
    fetch: async () => {
      fetched += 1;
      return { status: 200, text: async () => '{}' };
    },
  };
  const { runtime, ctx } = live(config);
  // A connector is an opaque RPC that can call an arbitrary third-party API:
  // zoho-write is never on the org-internal allowlist.
  await assert.rejects(runtime.shim.zoho.task(ctx, ['crm', 'invokeConnector'], ['crm.getorg', { Fname: 'A' }]), refusedFor(/settings\/connectors\/crm\.getorg/));
  // The same endpoint reached through invokeurl is refused the same way.
  await assert.rejects(
    runtime.shim.http.invokeurl(ctx, { url: 'https://www.zohoapis.in/crm/v7/settings/connectors/crm.getorg/actions/invoke', type: 'POST', body: '{}', connection: 'c2c_crm' }),
    refusedFor(/settings\/connectors\/crm\.getorg/),
  );
  // And through the generic connection fallback (no zohoConnections).
  let connected = 0;
  const generic = createRuntime({ dryRun: false, appTimeZone: 'Asia/Kolkata', connection: async () => (connected += 1) });
  await assert.rejects(generic.shim.zoho.task(generic.context({ record: {} }), ['crm', 'invokeConnector'], ['crm.getorg', {}]), refusedFor(/settings\/connectors\/crm\.getorg/));
  assert.equal(connected, 0);
  assert.equal(fetched, 0);
  assert.equal(asked, 0);
});

test('messaging guard: the owner token lets invokeConnector run (plain, or scoped to the connector endpoint)', async () => {
  for (const token of ['plain-owner-token', 'www.zohoapis.in/crm/v7/settings/connectors/crm.getorg/actions/invoke=owner-secret-9']) {
    const { origin, seen, server } = await fakeZoho([{ method: 'POST', path: '/crm/v7/settings/connectors/crm.getorg/actions/invoke', reply: { ok: true } }]);
    try {
      const { runtime, ctx } = live(withDefaultCrm(origin, { orgInternal: ORG, ownerApprovalToken: token }));
      const out = await runtime.shim.zoho.task(ctx, ['crm', 'invokeConnector'], ['crm.getorg', { Fname: 'A' }]);
      assert.deepEqual(out, { status_code: '200', response: JSON.stringify({ ok: true }) });
      assert.equal(seen.length, 1);
      assert.ok(runtime.transcript.some((e) => e.op === 'messaging-guard' && e.approvedBy === 'owner-approval-token'));
      const secret = token.includes('=') ? token.split('=')[1]! : token;
      assert.ok(runtime.transcript.every((e) => !JSON.stringify(e).includes(secret)));
    } finally {
      server.close();
    }
  }
  // A scoped token naming a different destination does not approve it.
  const wrong = countingConfig({ ownerApprovalToken: 'www.zohoapis.in/crm/v7/settings/connectors/other/actions/invoke=tok' });
  const w = live({ ...wrong.config, connections: { 'default:crm': 'c2c_crm' } });
  await assert.rejects(w.runtime.shim.zoho.task(w.ctx, ['crm', 'invokeConnector'], ['crm.getorg', {}]), refusedFor(/settings\/connectors\/crm\.getorg/));
  assert.equal(wrong.counts.fetched, 0);
});

test('crm.getOrgVariable selects the entry whose api_name matches the request', async () => {
  const { origin, server } = await fakeZoho([
    { method: 'GET', path: '/crm/v7/settings/variables?api_names=Score', reply: { variables: [{ api_name: 'Other', value: 'WRONG' }, { api_name: 'Score', value: 23 }] } },
  ]);
  try {
    const { runtime, ctx } = live(withDefaultCrm(origin));
    assert.equal(await runtime.shim.zoho.task(ctx, ['crm', 'getOrgVariable'], ['Score']), 23);
  } finally {
    server.close();
  }
});

test('crm.getOrgVariable refuses an empty api_name before any fetch', async () => {
  let fetched = 0;
  const config = withDefaultCrm('http://127.0.0.1:9', {
    fetch: async () => {
      fetched += 1;
      return { status: 200, text: async () => '{}' };
    },
  });
  const { runtime, ctx } = live(config);
  await assert.rejects(runtime.shim.zoho.task(ctx, ['crm', 'getOrgVariable'], ['']), (err: ZohoConnectionRefused) => err instanceof ZohoConnectionRefused && err.missing === 'api_name');
  assert.equal(fetched, 0);
});

test('top-gap adapters: an empty-body error status is an error map, not an empty record or list', async () => {
  const { origin, server } = await fakeZoho([
    { method: 'GET', path: '/crm/v7/Leads/bad', status: 502, reply: null },
    { method: 'GET', path: '/crm/v7/Accounts/1/Trucks?page=1&per_page=200', status: 504, reply: null },
  ]);
  try {
    const { runtime, ctx } = live(withDefaultCrm(origin));
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRecordById'], ['Leads', 'bad', {}, 'c2c_crm']), { code: 'HTTP_502', message: 'request failed', status: 'error' });
    assert.deepEqual(await runtime.shim.zoho.task(ctx, ['crm', 'getRelatedRecords'], ['Trucks', 'Accounts', '1', 1, 200, {}, 'c2c_crm']), { code: 'HTTP_504', message: 'request failed', status: 'error' });
  } finally {
    server.close();
  }
});
