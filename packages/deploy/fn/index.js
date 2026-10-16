'use strict';
/**
 * c2c_api: the Catalyst Advanced I/O entry for every generated form, report,
 * upload, and lookup endpoint. Catalyst calls module.exports(req, res) with
 * Node's http request and response; an Express app is called the same way.
 * Node SDK: https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/overview/
 *
 * Routes are in routes.json ("POST /forms/<Form>/submit" -> module). The route
 * is the request path after /server/<function>/ and an optional /execute.
 *
 * Principal: c2c-principal.mjs resolves the signed-in Catalyst Authentication
 * user (user scope) and maps the user's Catalyst role to a Creator profile from
 * principal-map.json. No user, or an unmapped role, gets 401 before any handler
 * runs. The handler sees only that principal: a caller cannot set req.user.
 *
 * Data: the handler's datastore is the zcatalyst-sdk adapter (admin scope),
 * scoped to this request. c2c-deploy.json (or C2C_DEPLOY_MODE) decides whether
 * a handler writes at all.
 */
const { existsSync, readFileSync } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const FUNCTION_NAME = JSON.parse(readFileSync(join(__dirname, 'catalyst-config.json'), 'utf8')).deployment.name;
const ROUTES = JSON.parse(readFileSync(join(__dirname, 'routes.json'), 'utf8'));
/** Data Store column types per table, so the adapter converts booleans, datetimes and ids by type. */
const COLUMNS = JSON.parse(readFileSync(join(__dirname, 'c2c-columns.json'), 'utf8'));
/**
 * c2c-schema.json lists every column the schema generated. c2c-projections.json
 * is the ZCQL name list (ROWID plus those columns, including decimal shadows).
 * A projection that drops a schema column would silently narrow every read, so
 * the function refuses to load and names the column. c2c-columns.json stays the
 * type map and is not that list.
 */
const SCHEMA = existsSync(join(__dirname, 'c2c-schema.json')) ? JSON.parse(readFileSync(join(__dirname, 'c2c-schema.json'), 'utf8')) : {};
function projectionsFromSchema(schema) {
  const out = {};
  for (const table of Object.keys(schema)) {
    const columns = schema[table];
    if (!Array.isArray(columns)) continue;
    const names = ['ROWID'];
    for (const column of columns) {
      if (typeof column === 'string' && !names.includes(column)) names.push(column);
    }
    out[table] = names;
  }
  return out;
}
const projectionPath = join(__dirname, 'c2c-projections.json');
const PROJECTIONS = existsSync(projectionPath) ? JSON.parse(readFileSync(projectionPath, 'utf8')) : projectionsFromSchema(SCHEMA);
/**
 * c2c-rules.json lists the write-rule columns per table (the generated schema's
 * length, scale, date-format, exact-decimal, significant-digit, and mandatory
 * rules). The adapter runs them on every write — including child-table rows a
 * handler sends through the adapter directly — so a value Catalyst would
 * truncate or coerce is refused before the SDK call. A computed decimal with
 * extra fractional digits is rounded to the column scale first.
 */
/**
 * c2c-renames.json maps, per table, a Creator field whose name is a reserved
 * Data Store column name to the column that stores it. Handlers keep the field
 * name; the adapter translates. Absent when no column was renamed.
 */
const renamesPath = join(__dirname, 'c2c-renames.json');
const RENAMES = existsSync(renamesPath) ? JSON.parse(readFileSync(renamesPath, 'utf8')) : {};
const rulesPath = join(__dirname, 'c2c-rules.json');
const WRITE_RULES = existsSync(rulesPath) ? JSON.parse(readFileSync(rulesPath, 'utf8')) : {};
for (const table of Object.keys(SCHEMA)) {
  const columns = SCHEMA[table];
  if (!Array.isArray(columns)) continue;
  const listed = new Set(Array.isArray(PROJECTIONS[table]) ? PROJECTIONS[table] : []);
  for (const column of columns) {
    if (!listed.has(column)) throw new Error(`datastore: c2c-projections.json drops ${table}.${column}`);
  }
}
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Wrap every integer literal outside a string that is not a safe integer in
 * quotes, so JSON.parse keeps a 19-digit Creator id or a 17-digit ROWID exact.
 * Same algorithm as packages/shims/src/ids.ts quoteUnsafeIntegers.
 */
function quoteUnsafeIntegers(text) {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      i += 1;
      while (i < text.length && /[0-9.eE+-]/.test(text[i])) i += 1;
      const token = text.slice(start, i);
      if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += `${text.slice(last, start)}"${token}"`;
        last = i;
      }
      continue;
    }
    i += 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** A bigint (a toLong id) is written as its digit string. */
function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function send(res, status, body, err) {
  if (res.headersSent) {
    // A handler that wrote headers and then threw must not leave the request
    // hanging until the gateway times out: end the response and log. The log
    // carries only the error class and code: the message, the stack, and the
    // body can name profiles, forms, and record values.
    const name = err && typeof err.name === 'string' && err.name ? err.name : 'Error';
    const code = err && err.code != null && String(err.code) ? ` code=${String(err.code)}` : '';
    console.error(`c2c_api: send(${status}) skipped, response headers already sent: name=${name}${code}`);
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, jsonReplacer));
}

/** Every failed request uses {code,message}; caller input and runtime details stay private. */
function errorReply(res, status, message, extra = {}, err) {
  const code = status === 400 ? 'BAD_REQUEST'
    : status === 401 ? 'UNAUTHENTICATED'
      : status === 403 ? 'FORBIDDEN'
        : status === 404 ? 'NOT_FOUND'
          : status === 405 ? 'METHOD_NOT_ALLOWED'
            : status === 413 ? 'PAYLOAD_TOO_LARGE'
              : status === 422 ? 'UNPROCESSABLE_ENTITY'
                : status === 409 ? 'CONFLICT'
                  : status === 429 ? 'TOO_MANY_REQUESTS'
                    : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  send(res, status, { code, message, ...extra }, err);
}

function normalizeErrorBody(body, responseStatus) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  if (responseStatus >= 500) {
    const correlationId = randomUUID();
    // Handler response bodies can contain runtime messages, stacks, query
    // fragments, or record values. Keep them in the server log only.
    console.error(`c2c_api: handler returned ${responseStatus} correlationId=${correlationId} body=${JSON.stringify(body)}`);
    return { code: 'INTERNAL_ERROR', message: 'Internal server error', correlationId, ...(body.wrote === true ? { wrote: true } : {}) };
  }
  const out = { ...body };
  const oldMessage = typeof out.message === 'string' ? out.message : typeof out.error === 'string' ? out.error : '';
  const status = Number.isInteger(out.status) ? out.status : responseStatus;
  if (typeof out.code !== 'string') {
    out.code = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 400 ? 'BAD_REQUEST' : status === 422 ? 'UNPROCESSABLE_ENTITY' : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  }
  if (typeof out.message !== 'string') out.message = oldMessage && !/request failed|kaboom|stack|node_modules|\/Users\/|\/private\//i.test(oldMessage) ? oldMessage : status >= 500 ? 'Request failed' : 'Request failed';
  delete out.error;
  delete out.stack;
  delete out.status;
  return out;
}

/**
 * Submit idempotency. A form screen sends one idempotencyKey per opened form
 * (body.idempotencyKey, or the Idempotency-Key header) and keeps it until a
 * submit commits. The first committed answer for a key (a 2xx, or any answer
 * that says wrote true), scoped to the caller and the route, is kept for
 * SUBMIT_KEY_TTL_MS: a repeat of that key gets the same status and body back
 * instead of a second write or a duplicate-value refusal. A repeat that
 * arrives while the first is still running waits for its answer. An answer
 * that wrote nothing is not kept, so a corrected retry still writes. Keys
 * live in this function instance's memory, so a repeat served by another
 * instance is not deduplicated; the form screens also disable submit while a
 * submit is in flight.
 */
const SUBMIT_KEY_TTL_MS = 15 * 60 * 1000;
const SUBMIT_KEY_MAX = 1000;
const SUBMIT_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const submitKeys = new Map();

/** The request's idempotency key, or '' (absent or malformed). The body copy is removed before the handler runs. */
function takeSubmitKey(req, body) {
  let raw = '';
  if (body && typeof body === 'object' && Object.hasOwn(body, 'idempotencyKey')) {
    if (typeof body.idempotencyKey === 'string') raw = body.idempotencyKey;
    delete body.idempotencyKey;
  }
  const header = req && req.headers ? req.headers['idempotency-key'] : undefined;
  if (!raw && typeof header === 'string') raw = header;
  return SUBMIT_KEY_PATTERN.test(raw) ? raw : '';
}

function submitScope(principal, method, path, key) {
  const who = principal && principal.userId != null ? String(principal.userId) : '';
  return createHash('sha256').update(`${who}\n${method} ${path}\n${key}`).digest('hex');
}

function pruneSubmitKeys(now) {
  for (const [scope, entry] of submitKeys) {
    if (now - entry.at > SUBMIT_KEY_TTL_MS || submitKeys.size > SUBMIT_KEY_MAX) submitKeys.delete(scope);
    else break;
  }
}

/** A stored answer is kept only when the row committed: a 2xx that wrote, or any status whose body says wrote true. */
function committedAnswer(captured) {
  if (!captured || typeof captured.body !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(captured.body);
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && parsed.wrote === true ? captured : null;
}

/** The Creator app time zone: C2C_APP_TIMEZONE, else c2c-deploy.json appTimeZone, else none. */
function appTimeZone() {
  const fromEnv = typeof process.env.C2C_APP_TIMEZONE === 'string' ? process.env.C2C_APP_TIMEZONE.trim() : '';
  if (fromEnv) return fromEnv;
  try {
    const deploy = JSON.parse(readFileSync(join(__dirname, 'c2c-deploy.json'), 'utf8'));
    return deploy && typeof deploy.appTimeZone === 'string' && deploy.appTimeZone.trim() ? deploy.appTimeZone.trim() : undefined;
  } catch {
    return undefined;
  }
}

function routePath(rawUrl) {
  let path = new URL(rawUrl || '/', 'http://function.invalid').pathname;
  const prefix = `/server/${FUNCTION_NAME}`;
  if (path === prefix || path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
  if (path === '/execute' || path.startsWith('/execute/')) path = path.slice('/execute'.length);
  return path || '/';
}

/**
 * The query string of the incoming request, if any. Route matching stays on
 * the pathname, but handlers read paging (?page=&pageSize=) off req.url, so
 * the entry forwards pathname + search to the handler. Generated routeOf()
 * splits on "?" before matching, so no other handler changes behaviour.
 */
function routeSearch(rawUrl) {
  try {
    return new URL(rawUrl || '/', 'http://function.invalid').search || '';
  } catch {
    return '';
  }
}

/** Return the normalized request media type without parameters. */
function requestMediaType(req) {
  const headers = req && typeof req.headers === 'object' ? req.headers : {};
  const value = headers['content-type'] ?? headers['Content-Type'];
  return String(Array.isArray(value) ? value[0] ?? '' : (value ?? ''))
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
}

async function readBody(req) {
  // Simple cross-site form content types do not require CORS preflight. Refuse
  // them on writes so cookie-authenticated requests cannot reach a handler.
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && requestMediaType(req) !== 'application/json') {
    throw Object.assign(new Error('content type must be application/json'), { status: 415 });
  }
  // Every body is a JSON object: an array, a string or a number is a 400, never
  // read as an empty body. A body a runtime already read is held to the same
  // byte cap as a streamed one.
  const notObject = () => Object.assign(new Error('request body must be a JSON object'), { status: 400 });
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    if (Array.isArray(req.body)) throw notObject();
    return req.body;
  }
  const tooLarge = () => Object.assign(new Error('request body too large'), { status: 413 });
  let raw = '';
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) throw tooLarge();
    raw = req.body;
  } else if (Buffer.isBuffer(req.body)) {
    if (req.body.length > MAX_BODY_BYTES) throw tooLarge();
    raw = req.body.toString('utf8');
  } else {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw tooLarge();
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(quoteUnsafeIntegers(raw));
  } catch {
    throw Object.assign(new Error('request body is not JSON'), { status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw notObject();
  return parsed;
}

async function load(spec) {
  return import(pathToFileURL(join(__dirname, spec)).href);
}

/**
 * A routes.json key matches exactly, or segment by segment when the key has
 * `:param` segments ("/lookups/:form/:field" matches "/lookups/Vendor/Name").
 * Matched params are decoded and handed to the handler as req.params, which the
 * generated routeOf() reads first. An exact match always wins over a pattern.
 */
function matchRoute(method, path) {
  const exact = ROUTES[`${method} ${path}`];
  if (exact) return { spec: exact, params: {} };
  const segs = path.split('/');
  let methodKnown = Object.keys(ROUTES).some((key) => key.slice(key.indexOf(' ') + 1) === path);
  for (const key of Object.keys(ROUTES)) {
    const space = key.indexOf(' ');
    const routeMethod = key.slice(0, space);
    const routePath = key.slice(space + 1);
    if (!routePath.includes(':')) continue;
    const parts = routePath.split('/');
    if (parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        if (!segs[i]) {
          ok = false;
          break;
        }
        try {
          params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
        } catch {
          ok = false;
          break;
        }
      } else if (parts[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (routeMethod === method) return { spec: ROUTES[key], params };
    methodKnown = true;
  }
  return methodKnown ? { methodNotAllowed: true } : null;
}

module.exports = async function c2cApi(req, res) {
  try {
    const path = routePath(req.url);
    const method = String(req.method || 'GET').toUpperCase();
    const matched = matchRoute(method, path);
    if (!matched) {
      errorReply(res, 404, 'No such endpoint');
      return;
    }
    if (matched.methodNotAllowed) {
      errorReply(res, 405, 'Method not allowed');
      return;
    }
    const body = await readBody(req);
    const sdk = require('zcatalyst-sdk-node');
    const { resolvePrincipal } = await load('c2c-principal.mjs');
    const principal = await resolvePrincipal(sdk, req);
    if (!principal) {
      errorReply(res, 401, 'Sign in required');
      return;
    }
    const handlerModule = await load(matched.spec);
    const form = typeof handlerModule.formName === 'string' ? handlerModule.formName : '';
    if (form && body.record && typeof body.record === 'object' && !Array.isArray(body.record)) {
      // A posted record is read by field type before the handler sees it, with the
      // same rules as a stored row: input.Qty posted as "5" is the number 5, so
      // input.Qty + rec.Stock adds. Subform rows are read by their child table's
      // types, and a JSON number in a decimal field is written out to its decimal
      // places. A value that is not its type is a 400.
      const { createFieldReader, FieldValueError } = await load('c2c-field-values.mjs');
      const reader = createFieldReader({ columns: COLUMNS, renames: RENAMES, rules: WRITE_RULES, subforms: handlerModule.subformTables });
      try {
        body.record = reader.input(form, body.record);
      } catch (err) {
        if (!(err instanceof FieldValueError)) throw err;
        errorReply(res, 400, err.message, { field: err.field });
        return;
      }
    }
    const { createSdkDatastore } = await load('c2c-sdk-datastore.mjs');
    // Only a generated bundle ships c2c-rules.json + vendored shims; a deploy
    // without it (or a hand-built dir) runs without the write-rule gate.
    let checkWrite;
    if (existsSync(rulesPath)) {
      const { assertWritable, quantizeRow } = await load('vendor/shims/write-rules.js');
      checkWrite = (form, row, kind) =>
        assertWritable(form, WRITE_RULES[form], quantizeRow(WRITE_RULES[form], row), { required: kind === 'insert' });
    }
    const datastore = createSdkDatastore(sdk.initialize(req, { scope: 'admin' }), {
      columns: COLUMNS,
      projections: PROJECTIONS,
      renames: RENAMES,
      appTimeZone: appTimeZone(),
      checkWrite,
    });
    const store = await load('c2c-store.mjs');
    const handler = handlerModule.default;
    const submitKey = method === 'POST' ? takeSubmitKey(req, body) : '';
    const scope = submitKey ? submitScope(principal, method, path, submitKey) : '';
    let entry = null;
    if (scope) {
      pruneSubmitKeys(Date.now());
      for (let prior = submitKeys.get(scope); prior; prior = submitKeys.get(scope)) {
        const answer = await prior.answer;
        if (answer) {
          res.writeHead(answer.status, { 'Content-Type': 'application/json' });
          res.end(answer.body);
          return;
        }
        if (submitKeys.get(scope) === prior) submitKeys.delete(scope);
      }
      let settle;
      entry = { at: Date.now(), answer: new Promise((resolve) => { settle = resolve; }), settle };
      submitKeys.set(scope, entry);
    }
    let captured = null;
    const call = { url: path + routeSearch(req.url), method, headers: req.headers, body, params: matched.params, catalyst: { user: principal } };
    try {
      await store.runWithDatastore(datastore, async () => {
        const originalEnd = res.end;
        res.end = function normalizedEnd(body) {
          if (typeof body === 'string') {
            try {
              const parsed = JSON.parse(body);
              if (parsed && typeof parsed === 'object' && (Object.hasOwn(parsed, 'error') || res.statusCode >= 400)) {
                body = JSON.stringify(normalizeErrorBody(parsed, res.statusCode), jsonReplacer);
              }
            } catch {
              /* Leave non-JSON responses unchanged. */
            }
            captured = { status: res.statusCode, body };
          }
          return originalEnd.call(this, body);
        };
        try {
          await handler(call, res);
        } finally {
          res.end = originalEnd;
        }
      });
    } finally {
      if (entry) {
        const answer = committedAnswer(captured);
        if (!answer && submitKeys.get(scope) === entry) submitKeys.delete(scope);
        entry.settle(answer);
      }
    }
  } catch (err) {
    // A write-rule refusal or store error that escaped the handler still gets
    // the mapped 4xx, not an opaque 500.
    try {
      const { replyStoreError } = await load('vendor/shims/store-errors.js');
      const table = err && typeof err === 'object' && typeof err.table === 'string' ? err.table : 'datastore';
      if (!res.headersSent && replyStoreError(res, err, { live: true, table })) {
        // Older vendored classifiers may emit `error`; normalize at the entry boundary.
        return;
      }
    } catch {
      /* the classifier is best-effort; fall through to the generic reply */
    }
    const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    errorReply(res, status, status === 500 ? 'Request failed' : 'Invalid request', {}, err);
  }
};
