#!/usr/bin/env node
/**
 * Security gate for one generated app: every c2c_api route, called directly.
 *
 *   npm run build
 *   node tools/security-gate/gate.mjs <app.ds | app-dir> [--out <dir>] [--public "POST /x=reason"]...
 *
 * The app is generated as a live deploy tree (the same deployFiles a deploy
 * writes) into --out (default: a fresh temp dir). The routes are the
 * generator's own route table, functions/c2c_api/routes.json — never a hand
 * list — and each one is called through the generated index.js entry over
 * loopback HTTP with tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs:
 *
 *   a   no principal (no session, no token)             -> 401 JSON, and no
 *       ZCQL or write reaches the fake Data Store
 *   a2  a signed-in user whose role maps to no profile
 *       ("App User" when the app has no User profile, and
 *       a role the app never declared)                    -> 403 JSON, code ROLE_UNMAPPED
 *   a3  no principal, body that is not JSON               -> 401 JSON (auth before input parsing)
 *   b   a principal whose profile has no grant on the
 *       route's form (or a non-Administrator on /admin/*) -> 403 JSON
 *   c   a principal whose grant is owner-scoped, given the
 *       ROWID of a row another user owns (read / edit /
 *       delete / report query)                            -> no data, row unchanged
 *
 * A declared-public route (PUBLIC_ROUTES below, or --public) is listed with its
 * reason instead of being held to a/a2/a3. There are none today: the entry
 * refuses every route without a principal.
 *
 * Entry checks (not per route): an unknown path and a wrong method without a
 * principal must also answer 401, so a caller cannot map the route table
 * before signing in. A route handler that fails to import is an entry
 * failure (handler-import), not a route that silently loses b and c.
 *
 * Client checks (jsdom): the vanilla runtime's apiCall (the app's own
 * slate/assets/runtime.<hash>.js) and the React template's createApi().post /
 * apiCall (runtime/api.ts) on a 401 must navigate to
 * /__catalyst/auth/login?service_url=<current page>, and on a 403 must show an
 * access-denied state ([data-access-status="403"], [data-access-denied], or
 * the words "access denied" / "not available" / "do not have access").
 *
 * Output: <out>/security-gate.json and <out>/security-gate.md (route x check).
 * Exit 0 when nothing fails, 1 when a check fails, 2 on a usage or build error.
 * The run is in-process and in memory; nothing is sent off the machine.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../..');
const FAKE_SDK = join(REPO_ROOT, 'tools/catalyst-harness/fake-zcatalyst-sdk-node.cjs');
const ENTRY_SOURCE = 'packages/deploy/fn/index.js';
const LOGIN_PATH = '/__catalyst/auth/login';

/** "METHOD /path" -> why it may answer without a principal. Empty: every route needs one. */
export const PUBLIC_ROUTES = Object.freeze({});

/**
 * Checks that fail today and are tracked as a known issue. Each marker
 * names the one outcome that is known today; only that outcome is reported
 * as `xfail` with the issue id. Any other failure under a marker
 * (a 200 where a 401 is known, say) is a plain FAIL, so a marker can never
 * hide a bypass. A marked check that passes is also a FAIL ("remove the
 * marker"), so the list has to shrink when a fix lands. Keys: a check id,
 * an entry check id, or `client`. `outcome` is matched against the whole
 * detail of the failing check.
 */
export const EXPECTED_FAIL = Object.freeze({
  a2: { issue: 'known-401-unmapped-role', outcome: /^401 for [^,]+(?:, 401 for [^,]+)*$/ },
  a3: { issue: 'known-400-before-auth', outcome: /^400 before auth$/ },
  'unknown-route': { issue: 'known-404-before-auth', outcome: /^404 before auth$/ },
  'wrong-method': { issue: 'known-405-before-auth', outcome: /^405 before auth$/ },
  client: { issue: 'known-client-auth-redirect', outcome: /^(?:no navigation|nothing rendered)$/ },
});

export const CHECKS = ['a', 'a2', 'a3', 'b', 'c'];
export const CHECK_TITLES = {
  a: 'no principal -> 401',
  a2: 'unmapped role -> 403 ROLE_UNMAPPED',
  a3: 'no principal + bad body -> 401',
  b: 'non-permitted profile -> 403',
  c: 'other owner row -> no data',
};

const OWNER = 'gate-owner@example.test';
const INTRUDER = 'gate-intruder@example.test';
const ROLE_PREFIX = 'C2C Gate ';

// ---------- build ----------

/** Generate the live deploy tree for one .ds file or app directory. Returns the tree dir. */
export async function buildTree(target, out) {
  const { loadApp } = await import(pathToFileURL(join(REPO_ROOT, 'dist/determinism/src/tree.js')).href);
  const { deployFiles, writeDeployTree } = await import(pathToFileURL(join(REPO_ROOT, 'dist/deploy/src/plan.js')).href);
  const { ALLOWED_ENV, catalystProjectName } = await import(pathToFileURL(join(REPO_ROOT, 'dist/deploy/src/guards.js')).href);
  const app = loadApp(target);
  return buildTreeFromApp(app, out, { deployFiles, writeDeployTree, ALLOWED_ENV, catalystProjectName });
}

/** Same, from an App IR (the unit tests build one from inline .ds text). */
export async function buildTreeFromApp(app, out, mods) {
  const m =
    mods ??
    {
      ...(await import(pathToFileURL(join(REPO_ROOT, 'dist/deploy/src/plan.js')).href)),
      ...(await import(pathToFileURL(join(REPO_ROOT, 'dist/deploy/src/guards.js')).href)),
    };
  const org = '10000000000';
  const guard = {
    org,
    projectId: '1001',
    environment: m.ALLOWED_ENV,
    projectName: m.catalystProjectName(app.name || 'app'),
    dc: 'us',
    registry: { org, env: 'Development', projects: {}, dc: 'us' },
  };
  m.writeDeployTree(out, m.deployFiles(app, guard, false, { mode: 'live' }).files);
  return { dir: out, app: app.name || basename(out) };
}

// ---------- fake runtime ----------

let fakeInstalled = false;
function fakeSdk() {
  if (!fakeInstalled) {
    const anyModule = Module;
    const original = anyModule._resolveFilename;
    anyModule._resolveFilename = function resolveFake(request, ...rest) {
      if (request === 'zcatalyst-sdk-node') return FAKE_SDK;
      return original.call(this, request, ...rest);
    };
    fakeInstalled = true;
  }
  return createRequire(import.meta.url)(FAKE_SDK);
}

/**
 * Add one Catalyst role per declared profile to principal-map.json, the shape
 * the auth apply plan writes for a deployed app, so a session can carry each
 * profile. Returns profile -> role name.
 */
function mapGateRoles(fnDir, profiles) {
  const file = join(fnDir, 'principal-map.json');
  const map = JSON.parse(readFileSync(file, 'utf8'));
  const roles = { ...(map.roles ?? {}) };
  const out = {};
  for (const profile of profiles) {
    const role = `${ROLE_PREFIX}${profile}`;
    roles[role] = profile;
    out[profile] = role;
  }
  writeFileSync(file, `${JSON.stringify({ ...map, roles }, null, 2)}\n`);
  return out;
}

async function listen(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(599, { 'content-type': 'text/plain' });
      res.end(`gate: entry threw ${err && err.message}`);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, port: server.address().port };
}

async function call(port, functionName, method, path, { session, body, rawBody } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session) headers.cookie = `c2c-harness-session=${session}`;
  const init = { method, headers, signal: AbortSignal.timeout(15_000) };
  if (method !== 'GET' && method !== 'HEAD') init.body = rawBody ?? JSON.stringify(body ?? {});
  const res = await fetch(`http://127.0.0.1:${port}/server/${functionName}${path}`, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, type: res.headers.get('content-type') ?? '', text, json };
}

// ---------- route model ----------

function lineOf(file, needle) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((line) => line.includes(needle));
    return at >= 0 ? at + 1 : 1;
  } catch {
    return 1;
  }
}

function entryRef(needle) {
  return `${ENTRY_SOURCE}:${lineOf(join(REPO_ROOT, ENTRY_SOURCE), needle)}`;
}

/** Lookup (form, field) pairs and file-field pairs the generated modules declare. */
function paramSources(modules) {
  const lookups = [];
  const uploads = [];
  for (const mod of modules.values()) {
    if (Array.isArray(mod.lookupColumns)) {
      for (const item of mod.lookupColumns) if (item && item.form && item.field) lookups.push([item.form, item.field]);
    }
    if (mod.fileFields && typeof mod.fileFields === 'object') {
      for (const [form, fields] of Object.entries(mod.fileFields)) {
        const list = Array.isArray(fields) ? fields : Object.keys(fields ?? {});
        for (const field of list) uploads.push([form, typeof field === 'string' ? field : field.name]);
      }
    }
  }
  return { lookups, uploads };
}

function formOfModule(mod) {
  if (typeof mod.formName === 'string' && mod.formName) return mod.formName;
  if (mod.machine && typeof mod.machine.form === 'string') return mod.machine.form;
  return '';
}

/** A field the edit check can change with a plain string: named by the module, not read-only, not typed in c2c-columns.json. */
function textField(mod, typed) {
  const names = Array.isArray(mod.fieldNames) ? mod.fieldNames : [];
  const readonly = new Set(Array.isArray(mod.readonlyFields) ? mod.readonlyFields : []);
  const composite = new Set((Array.isArray(mod.fields) ? mod.fields : []).filter((f) => f && f.kind).map((f) => f.name));
  return names.find((name) => !readonly.has(name) && !composite.has(name) && !Object.hasOwn(typed ?? {}, name) && !/^(Added|Modified)_/.test(name)) ?? '';
}

/** One concrete request per route: path with params filled, the form it acts on, and its kind. */
function instantiate(key, spec, mod, sources, columns) {
  const space = key.indexOf(' ');
  const method = key.slice(0, space);
  const pattern = key.slice(space + 1);
  let path = pattern;
  let form = formOfModule(mod) || (/^\/forms\/([^/:]+)\//.exec(pattern)?.[1] ?? '');
  let note = '';
  if (pattern.includes(':')) {
    const pairs = pattern.startsWith('/lookups/') ? sources.lookups : /^\/(?:uploads|files)\//.test(pattern) ? sources.uploads : [];
    const pair = pairs[0];
    if (pair) {
      path = pattern.replace(':form', encodeURIComponent(pair[0])).replace(':field', encodeURIComponent(pair[1]));
      form = pair[0];
    } else {
      path = pattern.replace(/:[A-Za-z_]+/g, 'C2C_Gate_Param');
      note = 'no declared value for the route parameters';
    }
  }
  const kind = /\/record$/.test(pattern)
    ? 'record'
    : /\/delete$/.test(pattern)
      ? 'delete'
      : /\/submit$/.test(pattern)
        ? 'submit'
        : pattern.startsWith('/reports/') && !pattern.includes('/actions/')
          ? 'report'
          : pattern.startsWith('/admin/')
            ? 'admin'
            : 'other';
  const table = typeof mod.sqlIdent === 'string' && mod.sqlIdent ? mod.sqlIdent : form;
  return { key, method, pattern, path, spec, form, kind, note, table, editField: textField(mod, columns[table]) };
}

/**
 * A declared profile the policy does not let use this route: no grant on the
 * form, or a grant without the bit the route needs (delete, write, read).
 * /admin/* needs an Administrator profile.
 */
export function deniedProfile(route, policy, profiles) {
  if (route.kind === 'admin') {
    const profile = profiles.find((p) => !/admin/i.test(p));
    return profile ? { profile, why: 'not an Administrator profile' } : null;
  }
  if (!route.form) return null;
  for (const profile of profiles) {
    const grant = policy.profiles[profile]?.[route.form];
    if (!grant) return { profile, why: `no grant on ${route.form}` };
  }
  for (const profile of profiles) {
    const grant = policy.profiles[profile][route.form];
    if (route.kind === 'delete' && grant.delete !== true) return { profile, why: 'no delete grant' };
    if (route.kind === 'submit' && grant.write !== true) return { profile, why: 'no write grant' };
    if ((route.kind === 'record' || route.kind === 'report') && grant.read === false) return { profile, why: 'create-only grant' };
  }
  return null;
}

function bodyFor(route, rowId) {
  if (route.kind === 'record' || route.kind === 'delete') return { ROWID: rowId };
  if (route.kind === 'submit') return { record: {} };
  if (route.kind === 'report') return { op: 'query' };
  if (route.kind === 'admin') return { op: 'status' };
  if (route.pattern.startsWith('/flows/')) return { action: 'approve', rowid: rowId, ROWID: rowId };
  if (route.pattern.startsWith('/files/')) return { rowId };
  return rowId ? { ROWID: rowId } : {};
}

function isJson401(reply) {
  return reply.status === 401 && /application\/json/i.test(reply.type) && reply.json && typeof reply.json === 'object';
}

function cell(status, detail, ref) {
  return ref ? { status, detail, ref } : { status, detail };
}

// ---------- server gate ----------

/**
 * Run checks a..c on every route of one generated tree.
 * opts.publicRoutes: extra "METHOD /path" -> reason entries.
 */
export async function serverGate(treeDir, opts = {}) {
  const fnDir = join(treeDir, 'functions/c2c_api');
  const config = JSON.parse(readFileSync(join(fnDir, 'catalyst-config.json'), 'utf8'));
  const functionName = config.deployment.name;
  const routes = JSON.parse(readFileSync(join(fnDir, 'routes.json'), 'utf8'));
  // The declared policy: what the app says each profile may do. The handlers
  // enforce their own copy; opts.declaredPolicy lets a test plant a mismatch.
  const policy = opts.declaredPolicy ?? JSON.parse(readFileSync(join(fnDir, 'access-policy.json'), 'utf8'));
  const profiles = Object.keys(policy.profiles ?? {}).sort();
  const publicRoutes = { ...PUBLIC_ROUTES, ...(opts.publicRoutes ?? {}) };
  const roleOf = mapGateRoles(fnDir, profiles);

  for (const [key, value] of Object.entries(config.deployment.env_variables ?? {})) process.env[key] = String(value);
  process.env.C2C_DEPLOY_MODE = 'live';
  const sdk = fakeSdk();
  const entry = createRequire(import.meta.url)(join(fnDir, config.execution.main));

  // A handler that does not import would lose its form (and so b and c)
  // silently; it is reported as an entry failure instead.
  const modules = new Map();
  const importErrors = [];
  for (const spec of new Set(Object.values(routes))) {
    try {
      modules.set(spec, await import(pathToFileURL(join(fnDir, spec)).href));
    } catch (err) {
      modules.set(spec, {});
      importErrors.push({ spec, message: String(err && err.message).split('\n')[0] });
    }
  }
  const sources = paramSources(modules);
  const columns = JSON.parse(readFileSync(join(fnDir, 'c2c-columns.json'), 'utf8'));
  const list = Object.entries(routes).map(([key, spec]) => instantiate(key, spec, modules.get(spec) ?? {}, sources, columns));

  // Sessions: one per profile (owner + intruder for owner-scoped grants), one unmapped role.
  const session = (name, email, role) => {
    const token = `gate-${name}`;
    sdk.setSession(token, { user_id: String(9000 + Object.keys(sessionIds).length), email_id: email, role_details: { role_name: role } });
    sessionIds[token] = true;
    return token;
  };
  const sessionIds = {};
  // The default "App User" role is unmapped when its profile is not declared.
  const roleMap = JSON.parse(readFileSync(join(fnDir, 'principal-map.json'), 'utf8')).roles ?? {};
  const unmappedRoles = ['C2C Gate Undeclared Role'];
  if (!Object.hasOwn(policy.profiles ?? {}, roleMap['App User'] ?? '')) unmappedRoles.unshift('App User');
  const unmapped = unmappedRoles.map((role, i) => ({ role, token: session(`unmapped-${i}`, 'gate-unmapped@example.test', role) }));
  const dataCalls = () => sdk.state().calls.filter((c) => c[0] === 'zcql' || /Rows$/.test(c[0])).length;
  const profileSession = {};
  for (const profile of profiles) profileSession[profile] = session(`p-${profile}`, INTRUDER, roleOf[profile]);

  // One owned row per form, owned by someone else, for b (a real ROWID) and c.
  const seeded = new Map();
  const seed = async (route) => {
    const table = route.table;
    if (!table) return '';
    if (!seeded.has(table)) {
      const admin = sdk.initialize({ headers: {} }, { scope: 'admin' }).datastore().table(table);
      const [row] = await admin.insertRows([{ Added_User: OWNER }]);
      seeded.set(table, String(row.ROWID));
    }
    return seeded.get(table);
  };
  const rowOf = (table, id) => (sdk.state().tables[table] ?? []).find((row) => String(row.ROWID) === id);

  const { server, port } = await listen(entry);
  const rows = [];
  try {
    for (const route of list) {
      const handlerRef = `functions/c2c_api/${route.spec.replace(/^\.\//, '')}:${lineOf(join(fnDir, route.spec), 'export default')}`;
      const checks = {};
      const reason = publicRoutes[route.key];
      const rowId = await seed(route);

      // a, a2, a3
      if (reason) {
        for (const id of ['a', 'a2', 'a3']) checks[id] = cell('public', reason);
      } else {
        const callsBefore = dataCalls();
        const anon = await call(port, functionName, route.method, route.path, { body: bodyFor(route, rowId) });
        const touched = dataCalls() - callsBefore;
        checks.a = !isJson401(anon)
          ? cell('fail', `${anon.status} ${/json/i.test(anon.type) ? 'json' : anon.type || 'no type'}`, anon.status === 401 ? entryRef("send(res, 401, { error: 'sign in required' })") : handlerRef)
          : touched
            ? cell('fail', `401 after ${touched} Data Store call(s)`, handlerRef)
            : cell('pass', '401');
        const roleFails = [];
        for (const { role, token } of unmapped) {
          const reply = await call(port, functionName, route.method, route.path, { session: token, body: bodyFor(route, rowId) });
          if (!(reply.status === 403 && reply.json && reply.json.code === 'ROLE_UNMAPPED')) roleFails.push(`${reply.status} for ${role}`);
        }
        checks.a2 = roleFails.length ? cell('fail', roleFails.join(', '), entryRef("send(res, 401, { error: 'sign in required' })")) : cell('pass', '403 ROLE_UNMAPPED');
        if (route.method === 'GET') {
          checks.a3 = cell('n/a', 'GET has no body');
        } else {
          const bad = await call(port, functionName, route.method, route.path, { rawBody: '{not json' });
          checks.a3 = isJson401(bad) ? cell('pass', '401') : cell('fail', `${bad.status} before auth`, entryRef('const body = await readBody(req);'));
        }
      }

      // b
      const denial = deniedProfile(route, policy, profiles);
      if (!profiles.length) checks.b = cell('n/a', 'no profiles declared');
      else if (!route.form && route.kind !== 'admin') checks.b = cell('n/a', 'route names no form');
      else if (!denial) checks.b = cell('n/a', `every profile may ${route.kind === 'other' ? 'use' : route.kind} ${route.form}`);
      else {
        const reply = await call(port, functionName, route.method, route.path, { session: profileSession[denial.profile], body: bodyFor(route, rowId) });
        const ok = reply.status === 403 && /json/i.test(reply.type);
        checks.b = ok ? cell('pass', `403 (${denial.profile}: ${denial.why})`) : cell('fail', `${reply.status} for ${denial.profile} (${denial.why})`, handlerRef);
      }

      // c
      const scoped = route.form ? profiles.filter((p) => policy.profiles[p]?.[route.form]?.ownerScope) : [];
      if (!['record', 'delete', 'submit', 'report'].includes(route.kind)) checks.c = cell('n/a', 'not a record read/edit/delete');
      else if (!scoped.length) checks.c = cell('n/a', 'no owner-scoped grant on this form');
      else {
        const who = scoped[0];
        const scope = policy.profiles[who][route.form].ownerScope;
        if (scope === 'modify' && (route.kind === 'record' || route.kind === 'report')) {
          checks.c = cell('n/a', `${who} has View All (modify scope)`);
        } else {
          const before = JSON.stringify(rowOf(route.table, rowId) ?? null);
          const body =
            route.kind === 'submit' ? { ROWID: rowId, record: route.editField ? { [route.editField]: 'c2c gate edit' } : {} } : bodyFor(route, rowId);
          const reply = await call(port, functionName, route.method, route.path, { session: profileSession[who], body });
          const after = rowOf(route.table, rowId);
          const leaked = reply.status >= 200 && reply.status < 300 && reply.text.includes(rowId);
          let fail = '';
          if (route.kind === 'delete' && !after) fail = `row deleted (${reply.status})`;
          else if (route.kind === 'submit' && JSON.stringify(after ?? null) !== before) fail = `row changed (${reply.status})`;
          else if (leaked) fail = `row returned (${reply.status})`;
          checks.c = fail ? cell('fail', `${fail} for ${who}`, handlerRef) : cell('pass', `${reply.status} (${who})`);
          if (!after) {
            // Put the row back so later routes still have a foreign row to target.
            seeded.delete(route.table);
          }
        }
      }
      rows.push({ route: route.key, path: route.path, form: route.form || '', handler: handlerRef, note: route.note || undefined, checks });
    }

    // Entry-level: the route table must not be mappable without a principal.
    const entry404 = await call(port, functionName, 'POST', '/c2c-gate/no-such-route', {});
    const firstPost = list.find((r) => r.method === 'POST' && !r.pattern.includes(':'));
    const entry405 = firstPost ? await call(port, functionName, 'DELETE', firstPost.path, {}) : null;
    const entryChecks = [
      {
        id: 'unknown-route',
        title: 'unknown path, no principal -> 401',
        ...(isJson401(entry404) ? cell('pass', '401') : cell('fail', `${entry404.status} before auth`, entryRef("send(res, 404, { error: 'no such endpoint' })"))),
      },
    ];
    if (entry405) {
      entryChecks.push({
        id: 'wrong-method',
        title: `DELETE ${firstPost.pattern}, no principal -> 401`,
        ...(isJson401(entry405) ? cell('pass', '401') : cell('fail', `${entry405.status} before auth`, entryRef("send(res, 405, { error: 'method not allowed' })"))),
      });
    }
    for (const { spec, message } of importErrors) {
      entryChecks.push({
        id: 'handler-import',
        title: `handler ${spec} imports`,
        ...cell('fail', `import failed: ${message}`, `functions/c2c_api/${spec.replace(/^\.\//, '')}:1`),
      });
    }
    return { functionName, profiles, publicRoutes, routes: rows, entry: entryChecks };
  } finally {
    await new Promise((done) => server.close(done));
  }
}

// ---------- client gate ----------

/** A window-like view over a jsdom window whose navigations are recorded, not performed. */
function recordingView(dom, fetchImpl) {
  const win = dom.window;
  const navigations = [];
  const location = {
    get href() {
      return win.location.href;
    },
    set href(value) {
      navigations.push(String(value));
    },
    get origin() {
      return win.location.origin;
    },
    get pathname() {
      return win.location.pathname;
    },
    get hash() {
      return win.location.hash;
    },
    set hash(value) {
      win.location.hash = value;
    },
    get search() {
      return win.location.search;
    },
    get host() {
      return win.location.host;
    },
    get protocol() {
      return win.location.protocol;
    },
    assign(value) {
      navigations.push(String(value));
    },
    replace(value) {
      navigations.push(String(value));
    },
    reload() {},
    toString() {
      return win.location.href;
    },
  };
  const view = new Proxy(win, {
    get(target, prop) {
      if (prop === 'location') return location;
      if (prop === 'fetch') return fetchImpl;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' && prop !== 'constructor' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      if (prop === 'location') {
        navigations.push(String(value));
        return true;
      }
      return Reflect.set(target, prop, value);
    },
  });
  return { view, navigations, document: win.document };
}

function stubFetch(status) {
  return async () =>
    new Response(JSON.stringify({ error: status === 401 ? 'sign in required' : 'forbidden' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const PAGE = 'https://app.example.test/app/index.html#/report/C2C_Gate_Report';

function expectedLogin(href) {
  return `${LOGIN_PATH}?service_url=${encodeURIComponent(href)}`;
}

function navigatedToLogin(navigations, href) {
  const want = expectedLogin(href);
  return navigations.some((to) => {
    try {
      const url = new URL(to, href);
      return `${url.pathname}${url.search}` === want || (url.pathname === LOGIN_PATH && url.searchParams.get('service_url') === href);
    } catch {
      return false;
    }
  });
}

function showsDenied(document) {
  if (document.querySelector('[data-access-status="403"], [data-access-denied]')) return true;
  return /access denied|not available|do not have access/i.test(document.body ? document.body.textContent ?? '' : '');
}

async function settle() {
  await new Promise((done) => setTimeout(done, 20));
}

/**
 * Run one wrapper against a 401 and a 403 reply. `invoke(view)` makes one API
 * call through the wrapper. A wrapper that throws still counts by what it did.
 */
export async function wrapperChecks(name, invoke, source) {
  const { JSDOM } = await import('jsdom');
  const out = [];
  for (const status of [401, 403]) {
    const dom = new JSDOM('<!doctype html><html><body><main id="main"></main></body></html>', { url: PAGE });
    const { view, navigations, document } = recordingView(dom, stubFetch(status));
    let threw = '';
    try {
      await invoke(view);
    } catch (err) {
      threw = String(err && err.message);
    }
    await settle();
    if (status === 401) {
      const ok = navigatedToLogin(navigations, PAGE);
      out.push({
        wrapper: name,
        check: '401 -> sign-in redirect',
        status: ok ? 'pass' : 'fail',
        detail: ok ? expectedLogin(PAGE) : navigations.length ? `navigated to ${navigations.join(', ')}` : `no navigation${threw ? ` (threw: ${threw})` : ''}`,
        ...(ok ? {} : { ref: source }),
      });
    } else {
      const ok = showsDenied(document);
      out.push({
        wrapper: name,
        check: '403 -> access denied shown',
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'access-denied state rendered' : `nothing rendered${threw ? ` (threw: ${threw})` : ''}`,
        ...(ok ? {} : { ref: source }),
      });
    }
    dom.window.close();
  }
  return out;
}

async function transpiledReactApi() {
  const { TEMPLATE_DIR } = await import(pathToFileURL(join(REPO_ROOT, 'dist/ui-react/src/index.js')).href);
  const ts = (await import('typescript')).default;
  const file = join(TEMPLATE_DIR, 'lib/c2c-ui/runtime/api.ts');
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'api.ts',
  }).outputText;
  const dir = mkdtempSync(join(tmpdir(), 'c2c-security-gate-react-'));
  const out = join(dir, 'api.mjs');
  writeFileSync(out, js);
  return { mod: await import(pathToFileURL(out).href), source: relative(REPO_ROOT, file), file };
}

/** The vanilla wrapper from the app's own slate bundle, and the React template wrapper. */
export async function clientGate(treeDir) {
  const results = [];
  const assets = join(treeDir, 'slate/assets');
  const runtimeFile = existsSync(assets) ? readdirSync(assets).find((name) => /^runtime\.[0-9a-f]+\.js$/.test(name)) : undefined;
  const vanillaRef = `packages/ui/src/client-runtime.js:${lineOf(join(REPO_ROOT, 'packages/ui/src/client-runtime.js'), 'export async function apiCall(')}`;
  if (runtimeFile) {
    const mod = await import(pathToFileURL(join(assets, runtimeFile)).href);
    if (typeof mod.apiCall === 'function') {
      results.push(
        ...(await wrapperChecks('vanilla apiCall', (view) => mod.apiCall(view.fetch, view, '/reports/C2C_Gate_Report', { method: 'POST', body: '{}' }), vanillaRef)),
      );
    } else {
      results.push({ wrapper: 'vanilla apiCall', check: 'present', status: 'fail', detail: `${runtimeFile} exports no apiCall`, ref: vanillaRef });
    }
  } else {
    results.push({ wrapper: 'vanilla apiCall', check: 'present', status: 'n/a', detail: 'no slate runtime in this tree' });
  }
  const react = await transpiledReactApi();
  const postRef = `${react.source}:${lineOf(react.file, 'export function createApi(')}`;
  const callRef = `${react.source}:${lineOf(react.file, 'export async function apiCall(')}`;
  results.push(...(await wrapperChecks('react createApi().post', (view) => react.mod.createApi(view).post('/reports/C2C_Gate_Report', {}), postRef)));
  results.push(...(await wrapperChecks('react apiCall', (view) => react.mod.apiCall(view, '/reports/C2C_Gate_Report', { method: 'POST', body: '{}' }), callRef)));
  return results;
}

// ---------- report ----------

/**
 * Apply EXPECTED_FAIL: a failure with the marker's known outcome becomes
 * `xfail`; a failure with any other outcome stays `fail` and says so; a pass
 * under a marker becomes `fail`, because the marker must be removed.
 */
export function applyExpected(report, expected = EXPECTED_FAIL) {
  const markerRef = `tools/security-gate/gate.mjs:${lineOf(fileURLToPath(import.meta.url), 'export const EXPECTED_FAIL')}`;
  const mark = (c, key) => {
    const marker = expected[key];
    if (!c || !marker) return;
    if (typeof marker !== 'object' || !(marker.outcome instanceof RegExp) || !marker.issue) {
      throw new TypeError(`EXPECTED_FAIL.${key} must be { issue, outcome: RegExp }: a marker is scoped to its known outcome`);
    }
    if (c.status === 'fail') {
      if (marker.outcome.test(c.detail)) {
        c.status = 'xfail';
        c.issue = marker.issue;
      } else {
        c.detail = `${c.detail} (not the known outcome of expected-fail ${marker.issue}: ${marker.outcome.source})`;
      }
    } else if (c.status === 'pass') {
      c.status = 'fail';
      c.detail = `${c.detail}: passes under expected-fail ${marker.issue}, remove the marker`;
      c.ref = markerRef;
    }
  };
  for (const row of report.server.routes) for (const id of CHECKS) mark(row.checks[id], id);
  for (const item of report.server.entry) mark(item, item.id);
  for (const item of report.client) mark(item, 'client');
  return report;
}

export function summarize(report) {
  const counts = { pass: 0, fail: 0, xfail: 0, 'n/a': 0, public: 0 };
  for (const row of report.server.routes) for (const id of CHECKS) counts[row.checks[id]?.status] = (counts[row.checks[id]?.status] ?? 0) + 1;
  for (const item of report.server.entry) counts[item.status] += 1;
  for (const item of report.client) counts[item.status] = (counts[item.status] ?? 0) + 1;
  const failures = [];
  for (const row of report.server.routes) {
    for (const id of CHECKS) {
      const c = row.checks[id];
      if (c?.status === 'fail' || c?.status === 'xfail') failures.push({ route: row.route, check: id, detail: c.detail, ref: c.ref, issue: c.issue });
    }
  }
  for (const item of report.server.entry) {
    if (item.status === 'fail' || item.status === 'xfail') failures.push({ route: '(entry)', check: item.id, detail: item.detail, ref: item.ref, issue: item.issue });
  }
  for (const item of report.client) {
    if (item.status === 'fail' || item.status === 'xfail') failures.push({ route: `(client) ${item.wrapper}`, check: item.check, detail: item.detail, ref: item.ref, issue: item.issue });
  }
  return { routes: report.server.routes.length, counts, failures };
}

/** Failures that share a check, a result and a fix site, with the routes they hit. */
export function groupFailures(failures) {
  const groups = new Map();
  for (const f of failures) {
    const key = `${f.check}\u0000${f.detail}\u0000${f.ref ?? ''}\u0000${f.issue ?? ''}`;
    if (!groups.has(key)) groups.set(key, { check: f.check, detail: f.detail, ref: f.ref, issue: f.issue, routes: [] });
    groups.get(key).routes.push(f.route);
  }
  return [...groups.values()];
}

const MARK = { pass: 'PASS', fail: 'FAIL', xfail: 'XFAIL', 'n/a': 'n/a', public: 'public' };

export function toMarkdown(report) {
  const s = report.summary;
  const lines = [];
  lines.push(`# Security gate: ${report.app}`, '');
  lines.push(
    `${s.routes} routes from routes.json. Checks: pass ${s.counts.pass}, fail ${s.counts.fail}, expected-fail ${s.counts.xfail}, n/a ${s.counts['n/a']}, public ${s.counts.public}.`,
    '',
  );
  lines.push(`| route | ${CHECKS.map((id) => `${id}: ${CHECK_TITLES[id]}`).join(' | ')} |`);
  lines.push(`|---|${CHECKS.map(() => '---').join('|')}|`);
  for (const row of report.server.routes) {
    const cells = CHECKS.map((id) => {
      const c = row.checks[id];
      return c ? `${MARK[c.status]} ${c.detail}`.replace(/\|/g, '\\|') : '';
    });
    lines.push(`| \`${row.route}\` | ${cells.join(' | ')} |`);
  }
  lines.push('', '| entry check | result |', '|---|---|');
  for (const item of report.server.entry) lines.push(`| ${item.title} | ${MARK[item.status]} ${item.detail} |`);
  lines.push('', '| client wrapper | check | result |', '|---|---|---|');
  for (const item of report.client) lines.push(`| ${item.wrapper} | ${item.check} | ${MARK[item.status]} ${item.detail} |`);
  if (s.failures.length) {
    lines.push('', '## Failures by fix site', '', '| check | result | fix at | expected-fail issue | routes |', '|---|---|---|---|---|');
    for (const g of groupFailures(s.failures)) {
      const shown = g.routes.slice(0, 6).map((r) => `\`${r}\``).join(', ');
      lines.push(`| ${g.check} | ${g.detail} | \`${g.ref ?? ''}\` | ${g.issue ?? '**none: new failure**'} | ${g.routes.length}: ${shown}${g.routes.length > 6 ? ', ...' : ''} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function runGate(treeDir, app, opts = {}) {
  const server = await serverGate(treeDir, opts);
  const client = opts.client === false ? [] : await clientGate(treeDir);
  const report = { app, server, client };
  if (opts.expected !== false) applyExpected(report, opts.expected ?? EXPECTED_FAIL);
  report.summary = summarize(report);
  return report;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { target: '', out: '', publicRoutes: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') out.out = argv[++i] ?? '';
    else if (arg === '--public') {
      const value = argv[++i] ?? '';
      const at = value.indexOf('=');
      if (at > 0) out.publicRoutes[value.slice(0, at).trim()] = value.slice(at + 1).trim();
    } else if (!out.target) out.target = arg;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) {
    process.stderr.write('usage: node tools/security-gate/gate.mjs <app.ds | app-dir> [--out <dir>] [--public "METHOD /path=reason"]\n');
    return 2;
  }
  const target = resolve(args.target);
  const name = basename(target).replace(/\.ds$/i, '');
  const out = resolve(args.out || mkdtempSync(join(tmpdir(), `c2c-security-gate-${name}-`)));
  const tree = join(out, 'tree');
  try {
    await buildTree(target, tree);
  } catch (err) {
    process.stderr.write(`security-gate: ${name}: generate failed: ${err && err.message}\n`);
    writeFileSync(join(out, 'security-gate.json'), `${JSON.stringify({ app: name, error: `generate failed: ${err && err.message}` }, null, 2)}\n`);
    return 2;
  }
  const report = await runGate(tree, name, { publicRoutes: args.publicRoutes });
  writeFileSync(join(out, 'security-gate.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, 'security-gate.md'), toMarkdown(report));
  const c = report.summary.counts;
  process.stdout.write(`security-gate ${name}: routes=${report.summary.routes} pass=${c.pass} fail=${c.fail} expected-fail=${c.xfail} n/a=${c['n/a']} public=${c.public} -> ${join(out, 'security-gate.md')}\n`);
  return c.fail ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`security-gate: ${err && err.stack ? err.stack : err}\n`);
      process.exit(2);
    },
  );
}
