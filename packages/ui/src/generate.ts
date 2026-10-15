/**
 * Dry-run Slate PWA. Writes files only; it does not deploy.
 *
 * The client is vanilla ES modules (see docs/ui.md). Deluge client handlers are
 * copied in and called by the runtime. Server files from the Deluge generator
 * are copied beside the static app. Upload, lookup, and custom actions stay
 * dry-run. Submit and report read or write only when functions/c2c-deploy.json
 * mode is "live" and a datastore adapter is installed.
 */

import { scheduleAnchorFieldType, unquote, type App } from '../../core/src/ir.js';
import { clientRuntimeSource as bundledClientRuntime } from './client-runtime-parts.js';
import { toolchainBannerLines, toolchainHeader } from '../../core/src/toolchain.js';
import { accessPolicyFor, administratorProfiles, appUniqueColumnsOf, decimalColumnsOf, fieldRuleDenials, flowSpecs, generate as generateDeluge, blueprintFieldSpecs, type GeneratedFile } from '../../deluge/src/generate.js';
import { analyzeConnections } from '../../deluge/src/connections.js';
import { fieldStoreImports, fieldStoreShape, fieldStoreWriteArg, fileFieldsByForm, subformLinksFor, writeLiveSource } from '../../deluge/src/field-store.js';
import { reportCriteria } from '../../deluge/src/translate.js';
import type { WriteField } from '../../shims/src/access.js';
import { LIMITS } from '../../shims/src/index.js';
import { criteriaHasRelative, criteriaHasTodo, type Criteria } from '../../shims/src/criteria.js';
import { generateSchema, type SchemaPlan } from '../../schema/src/generator.js';
import { EXTENSION_KEY, limitValue, planReportQuery, planZcql, ZcqlLimitError } from '../../schema/src/limits.js';
import { fieldTypeRow } from '../../schema/src/mapping.js';
import { buildSlate, type OutFile } from './build.js';
import { buildModel, slug, smokeMarkerField, smokeNumberField, summarize, uiSnippetFiles, type UiModel, type UiSummary } from './model.js';
import { iconColorRgb, paletteFor } from './theme-map.js';
import { pwaFiles, pwaServiceWorkerSource } from './pwa.js';
import { BASE_CSS, SHELL_BACKGROUND } from './styles.js';
import { authPlan } from '../../auth/src/plan.js';
import { authApplyFiles } from '../../auth/src/apply.js';

export interface UiBundle {
  model: UiModel;
  summary: UiSummary;
  files: OutFile[];
}

export interface UiGenerateOptions {
  /** The Catalyst data centre this tree targets (deploy's registry dc). Written into c2c-deploy.json for c2c-auth-apply.mjs. */
  dc?: string;
  /** The schema plan provisioned for this deploy; generated runtime rules match its store constraints. */
  schema?: SchemaPlan;
  /** Opt-in async on-success lane: emit the event function, dead-letter store and sweep Job (docs/event-deadletter.md). */
  asyncOnSuccess?: boolean;
}

export function clientRuntimeSource(): string {
  return bundledClientRuntime();
}

/**
 * The service worker template (build tokens unfilled) for a shell that builds
 * its own bundle. Same bytes as the Slate sw.js source in pwa.ts, so every UI
 * target inherits one caching rule.
 */
export function serviceWorker(): string {
  return pwaServiceWorkerSource();
}

export function generateUi(app: App, opts: UiGenerateOptions = {}): UiBundle {
  // The stubs do not depend on the generated files (only handler wiring does),
  // so this first model pass supplies them before the Deluge pass writes
  // migration-report.json with them counted.
  const uiTodos = buildModel(app).todos;
  const deluge = generateDeluge(app, { schema: opts.schema, uiTodos, ...(opts.asyncOnSuccess ? { asyncOnSuccess: true } : {}) });
  const model = buildModel(app, deluge.files);
  const summary = summarize(model);
  const files: OutFile[] = [];

  for (const file of deluge.files) {
    if (file.path.startsWith('client/handlers/') && !file.path.includes('/functions/')) {
      const browser = `slate/assets/handlers/${file.path.slice('client/handlers/'.length).replace(/\.mjs$/, '.js')}`;
      if (model.handlers.some((handler) => handler.module === `@@asset:${browser}@@`)) {
        files.push({ path: browser, data: file.source });
      }
    }
    files.push({ path: file.path, data: file.source });
  }

  for (const file of uiSnippetFiles(model)) files.push({ path: file.path, data: file.source });

  files.push({ path: 'slate/assets/model.js', data: modelModule(model) });
  files.push({
    path: 'slate/assets/runtime.js',
    data: `import { model } from "@@asset:slate/assets/model.js@@";\n${clientRuntimeSource()}\nboot(model);\n`,
  });
  files.push({ path: 'slate/assets/app.css', data: css() });
  files.push({ path: 'slate/index.html', data: indexHtml(model) });
  files.push(
    ...pwaFiles({
      name: model.name || 'App',
      themeColor: paletteFor(model.theme?.theme).accent,
      backgroundColor: SHELL_BACKGROUND,
      iconRgb: iconColorRgb(model.theme?.iconColor),
    }),
  );
  files.push({ path: 'slate/c2c-config.js', data: slateConfigSource({ appTimeZone: appTimeZone(app) }) });
  files.push({ path: 'functions/access-policy.json', data: JSON.stringify(accessPolicyFor(app), null, 2) + '\n' });
  for (const file of authApplyFiles(authPlan(app), { ...(opts.dc !== undefined ? { dc: opts.dc } : {}) })) files.push(file);
  files.push({ path: 'functions/c2c-deploy.json', data: deployConfigSource(app, opts.dc) });
  files.push({ path: 'functions/c2c-store.mjs', data: storeModule() });
  if (analyzeConnections(app).entries.length) files.push({ path: 'functions/c2c-connections.mjs', data: connectionsModule() });
  files.push({ path: 'functions/uploads/stratus-upload.mjs', data: uploadStub(app) });
  if (Object.keys(fileFieldsByForm(app)).length) {
    files.push({ path: 'functions/uploads/stratus-download.mjs', data: downloadStub(app) });
    files.push({ path: 'functions/c2c-files.mjs', data: filesModule() });
  }
  files.push({ path: 'functions/lookups/lookup.mjs', data: lookupStub(app) });
  const schema = generateSchema(app);
  files.push({ path: 'functions/admin/smoke.mjs', data: smokeStub(app, model, schema) });
  const projectionByForm = new Map(
    schema.tables.map((table) => [table.name, projectionNames(table.columns.map((column) => column.name))]),
  );
  for (const report of model.reports) {
    files.push({
      path: `functions/reports/${slug(report.name)}.mjs`,
      data: reportStub(app, report, projectionByForm.get(report.form ?? '') ?? ['ROWID']),
    });
  }
  for (const report of model.reports) {
    for (const action of report.customActions) {
      files.push({
        path: `functions/reports/${slug(report.name)}-action-${slug(action.name)}.mjs`,
        data: actionStub(action.endpoint, action.name, report.form, action.workflow),
      });
    }
  }
  const covered = new Set(deluge.files.map((file) => endpointPath(file)).filter((item): item is string => !!item));
  for (const form of model.forms) {
    if (!covered.has(form.submitEndpoint)) {
      files.push({
        path: `functions/aio/${slug(form.name)}/submit.mjs`,
        data: submitStub(app, form, form.submitEndpoint, deluge.files, opts.schema, !!opts.asyncOnSuccess),
      });
    }
    files.push({
      path: `functions/aio/${slug(form.name)}/record.mjs`,
      data: recordStub(app, form, `/forms/${encodeURIComponent(form.name)}/record`),
    });
    files.push({
      path: `functions/aio/${slug(form.name)}/delete.mjs`,
      data: deleteStub(app, form, `/forms/${encodeURIComponent(form.name)}/delete`, deluge.files, opts.schema),
    });
  }
  files.push({ path: 'ui-summary.json', data: JSON.stringify({ dryRun: true, summary: publicSummary(summary) }, null, 2) + '\n' });
  files.push({ path: 'c2c-build.txt', data: toolchainHeader() });
  return { model, summary, files };
}

export function buildUi(app: App, opts: UiGenerateOptions = {}): UiBundle {
  const bundle = generateUi(app, opts);
  return { ...bundle, files: buildSlate(bundle.files) };
}

function publicSummary(summary: UiSummary) {
  return {
    forms: summary.forms,
    formsGenerated: summary.formsGenerated,
    formsTodo: summary.formsTodo,
    fields: summary.fields,
    fieldsGenerated: summary.fieldsGenerated,
    fieldsTodo: summary.fieldsTodo,
    reports: summary.reports,
    reportsGenerated: summary.reportsGenerated,
    reportsTodo: summary.reportsTodo,
    pages: summary.pages,
    pagesGenerated: summary.pagesGenerated,
    pagesTodo: summary.pagesTodo,
    pageElements: summary.pageElements,
    pageElementsTodo: summary.pageElementsTodo,
    handlers: summary.handlers,
    customActions: summary.customActions,
    uploads: summary.uploads,
    todos: summary.todos.length,
  };
}

function modelModule(model: UiModel): string {
  const json = JSON.stringify(model).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `export const model = ${json};\n`;
}

function endpointPath(file: GeneratedFile): string | undefined {
  return /path:\s*"([^"]+)"/.exec(file.source)?.[1];
}

function banner(lines: string[]): string {
  const stamped = [...lines, ...toolchainBannerLines()];
  return `/**\n${stamped.map((line) => ` * ${line}`).join('\n')}\n */\n`;
}

function policyPrelude(relativeJson: string, route = false, extraImport = ''): string {
  return `${extraImport}import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeRead, authorizeWrite, compileCriteria, jsonReplacer, principalFromRequest, projectFields } from "creator-to-catalyst/shims";

const policyPath = join(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(relativeJson)});
export const access = JSON.parse(readFileSync(policyPath, "utf8"));

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  // A bigint (a toLong id) is sent as its digits; JSON.stringify would throw.
  res.end(JSON.stringify(body, jsonReplacer));
}

function isHidden(name) {
  return !!name && Array.isArray(access.hidden) && access.hidden.includes(name);
}

function fail(res, err, live) {
  const denied = err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError");
  send(res, denied ? 403 : 500, { dryRun: !live, error: denied ? err.message : "request failed" });
}

function suppliedRows(req) {
  const rows = req && req.body && req.body.rows;
  return Array.isArray(rows) ? rows : [];
}
${route ? `
function routeOf(req, kind) {
  const params = req && req.params;
  if (params && params.form && params.field) {
    return { form: String(params.form), field: String(params.field) };
  }
  const raw = String((req && (req.url || req.path)) || "");
  const path = raw.split("?")[0];
  const match = path.match(new RegExp("/" + kind + "/([^/]+)/([^/]+)"));
  if (!match) return null;
  try {
    return { form: decodeURIComponent(match[1]), field: decodeURIComponent(match[2]) };
  } catch (err) {
    return null;
  }
}
` : ''}`;
}

function requirePrincipal(indent = '  '): string {
  return `${indent}const principal = principalFromRequest(req);
${indent}if (!principal?.profile) {
${indent}  send(res, 401, { dryRun: true, error: "authenticated caller required" });
${indent}  return;
${indent}}`;
}

function uploadStub(app: App): string {
  const fileFields = fileFieldsByForm(app);
  return `${banner([
    'Stratus upload. Dry run: no object is written and no bucket is created; the reference is { key } under dry-run/.',
    'Live (functions/c2c-deploy.json mode "live" and a file store in functions/c2c-files.mjs): returns { reference: { key }, upload } where upload is a signed Stratus PUT URL.',
    'The browser PUTs the bytes to upload.url with the Content-Type header in upload.headers, then submits reference as the field value.',
    'Key: uploads/<form>/<field>/<sha256>/<file name>. The client sends the SHA-256 of the bytes (64 hex).',
    'authorizeWrite accepts that object for a file, image, audio, video, or signature field and rejects any other shape, including {}.',
    'Only fields listed in fileFields are signed. The field must be writable under functions/access-policy.json.',
  ])}${policyPrelude('../access-policy.json', true, 'import { FileReferenceError, signUpload } from "creator-to-catalyst/shims";\n')}
export const endpoint = { type: "advancedio", method: "POST", path: "/uploads/:form/:field", dryRun: true };
export const fileFields = ${JSON.stringify(fileFields)};

${deployHelpers('../c2c-deploy.json', '../c2c-store.mjs')}
async function liveFileStore(req) {
  try {
    const mod = await import("../c2c-files.mjs");
    if (mod && typeof mod.fileStore === "function") return await mod.fileStore(req);
  } catch (err) {
    /* files module is absent when this file is loaded alone */
  }
  return null;
}

function fileReference(form, field, filename) {
  const clean = String(filename || "file").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "file";
  return { key: "dry-run/" + form + "/" + field + "/" + clean };
}

function isFileField(form, field) {
  return Object.prototype.hasOwnProperty.call(fileFields, form) && fileFields[form].includes(field);
}

export default async function handler(req, res) {
  const route = routeOf(req, "uploads");
  if (!route) {
    send(res, 404, { dryRun: true, error: "upload route not found" });
    return;
  }
  if (isHidden(route.form)) {
    send(res, 403, { dryRun: true, error: "hidden form" });
    return;
  }
${requirePrincipal()}
  try {
    authorizeWrite(access, principal, route.form, { [route.field]: null });
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const filename = typeof body.filename === "string" ? body.filename : "";
    if (deployConfig().mode !== "live") {
      send(res, 200, { dryRun: true, wrote: false, field: route.field, reference: fileReference(route.form, route.field, filename) });
      return;
    }
    if (!isFileField(route.form, route.field)) {
      send(res, 404, { dryRun: false, error: "not a file field" });
      return;
    }
    const store = await liveFileStore(req);
    if (!store) {
      send(res, 500, { dryRun: false, wrote: false, error: "live file store is not configured" });
      return;
    }
    const signed = await signUpload(store, route.form, route.field, { sha256: body.sha256, filename, contentType: body.contentType });
    send(res, 200, { dryRun: false, wrote: false, field: route.field, ...signed });
  } catch (err) {
    if (err instanceof FileReferenceError) {
      send(res, 400, { dryRun: false, error: err.message });
      return;
    }
    fail(res, err);
  }
}
`;
}

function downloadStub(app: App): string {
  const fileFields = fileFieldsByForm(app);
  return `${banner([
    'Stratus download. Returns a signed GET URL for the object a stored row holds in a file field.',
    'Body { rowId }. The row is read with the caller read policy (record filter included), so a caller gets only files of rows it can see.',
    'The key comes from the stored row, never from the request. Dry run signs nothing.',
    'Only fields listed in fileFields are signed.',
  ])}${policyPrelude('../access-policy.json', true, 'import { FileReferenceError, signDownload } from "creator-to-catalyst/shims";\n')}
export const endpoint = { type: "advancedio", method: "POST", path: "/files/:form/:field", dryRun: true };
export const fileFields = ${JSON.stringify(fileFields)};

${deployHelpers('../c2c-deploy.json', '../c2c-store.mjs')}
async function liveFileStore(req) {
  try {
    const mod = await import("../c2c-files.mjs");
    if (mod && typeof mod.fileStore === "function") return await mod.fileStore(req);
  } catch (err) {
    /* files module is absent when this file is loaded alone */
  }
  return null;
}

function isFileField(form, field) {
  return Object.prototype.hasOwnProperty.call(fileFields, form) && fileFields[form].includes(field);
}

function zcqlPredicate(where) {
  const text = typeof where === "string" ? where.trim() : "";
  return text === "true" ? "" : text;
}

export default async function handler(req, res) {
  const route = routeOf(req, "files");
  if (!route || !isFileField(route.form, route.field)) {
    send(res, 404, { dryRun: true, error: "file route not found" });
    return;
  }
  if (isHidden(route.form)) {
    send(res, 403, { dryRun: true, error: "hidden form" });
    return;
  }
${requirePrincipal()}
  try {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const rowId = body.rowId == null ? "" : String(body.rowId).trim();
    if (!/^\\d+$/.test(rowId)) {
      send(res, 400, { dryRun: true, error: "rowId must be a ROWID" });
      return;
    }
    const scoped = authorizeRead(access, principal, route.form, { op: "==", field: "ROWID", value: rowId }, route.field);
    if (deployConfig().mode !== "live") {
      send(res, 200, { dryRun: true, url: null });
      return;
    }
    const datastore = await liveDatastore();
    const store = await liveFileStore(req);
    if (!datastore || typeof datastore.query !== "function" || !store) {
      send(res, 500, { dryRun: false, error: "live datastore or file store is not configured" });
      return;
    }
    const where = zcqlPredicate(compileCriteria(scoped.criteria));
    const rows = await datastore.query(route.form, where, 1, 0, "ORDER BY ROWID");
    const row = Array.isArray(rows) && rows[0] && typeof rows[0] === "object" ? projectFields(rows[0], scoped.fields) : null;
    const key = row ? row[route.field] : null;
    if (!key) {
      send(res, 404, { dryRun: false, error: "no file" });
      return;
    }
    const signed = await signDownload(store, route.form, route.field, key);
    send(res, 200, { dryRun: false, ...signed });
  } catch (err) {
    if (err instanceof FileReferenceError) {
      send(res, 409, { dryRun: false, error: err.message });
      return;
    }
    fail(res, err);
  }
}
`;
}

const SCOPED_READ_IMPORT = 'import { needsExactRead, queryExact } from "creator-to-catalyst/shims";\n';

/**
 * The one parent read behind the lookup endpoint and a report's lookup display
 * column. The caller's record filter compiles with the parent form's decimal
 * shadows (decimal, currency and percent fields are varchar), then queryExact
 * keeps only the rows that match exactly, as the report read does. Needs
 * `parentDecimals` ({ form: decimal columns }) and zcqlPredicate in scope.
 */
function scopedReadSource(): string {
  return `// Decimal, currency and percent fields are varchar: a record filter on one
// compiles to its Double shadow column, and queryExact drops the rows the
// shadow over-matches. Never compare the raw varchar.
async function readScoped(datastore, form, criteria, offset, limit) {
  const decimals = Object.prototype.hasOwnProperty.call(parentDecimals, form) ? parentDecimals[form] : {};
  const where = zcqlPredicate(compileCriteria(criteria, undefined, decimals));
  if (needsExactRead(criteria, undefined, decimals)) {
    return queryExact((name, w, size, off, order) => datastore.query(name, w, size, off, order), form, where, { criteria, decimals, range: { from: offset + 1, to: offset + limit } });
  }
  return datastore.query(form, where, limit, offset, "ORDER BY ROWID");
}
`;
}

function filesModule(): string {
  return `${banner([
    'Stratus file store slot for upload and download signing.',
    'Handlers import this only when functions/c2c-deploy.json mode is "live".',
    'Default: catalyst.initialize(req, { scope: "admin" }).stratus().bucket(C2C_STRATUS_BUCKET).generatePreSignedUrl (admin scope is required to sign).',
    'https://docs.catalyst.zoho.com/en/sdk/nodejs/v2/cloud-scale/stratus/',
    'setFileStore installs a stand-in (tests). No bucket is created here; with no bucket name it returns null.',
  ])}import { catalystFileStore } from "creator-to-catalyst/shims";

let installed = null;

export function setFileStore(next) {
  installed = next || null;
  return installed;
}

export async function fileStore(req) {
  if (installed) return installed;
  const bucket = typeof process !== "undefined" && process.env ? process.env.C2C_STRATUS_BUCKET : "";
  if (!bucket) return null;
  const sdk = await import("zcatalyst-sdk-node");
  const catalyst = sdk.default || sdk;
  return catalystFileStore(catalyst.initialize(req, { scope: "admin" }), bucket);
}
`;
}

function lookupStub(app: App): string {
  return `${banner([
    'Lookup options for a form select. The path names the parent form and its display field.',
    `Page size ${LIMITS.zcqlRowsPerQuery} (measured ZCQL row cap).`,
    'authorizeRead applies functions/access-policy.json: only rows the caller can read,',
    'and only when the display field itself is readable. Hidden fields are not returned.',
    'A live query runs only when functions/c2c-deploy.json mode is "live" and a datastore adapter is installed.',
  ])}${policyPrelude('../access-policy.json', true, SCOPED_READ_IMPORT)}
export const endpoint = { type: "advancedio", method: "GET", path: "/lookups/:form/:field", dryRun: true, pageSize: ${LIMITS.zcqlRowsPerQuery} };
const parentDecimals = ${JSON.stringify(decimalColumnsOf(app))};

${deployHelpers('../c2c-deploy.json', '../c2c-store.mjs')}
// ZCQL has no boolean literal predicate: "WHERE true" is a syntax error. An always-true read sends no WHERE clause.
function zcqlPredicate(where) {
  const text = typeof where === "string" ? where.trim() : "";
  return text === "true" ? "" : text;
}

${scopedReadSource()}

// Paging comes from the query string (?page=&pageSize=): a GET has no body to
// trust. Only non-negative integer spellings are accepted; pageSize above the
// ZCQL row cap clamps to the cap, anything else malformed is a 400, and a page
// whose offset (page * pageSize) passes 100000 is a 400.
function queryInt(raw, fallback) {
  if (raw === null) return fallback;
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function paging(req) {
  let query;
  try {
    const raw = String((req && (req.url || req.path)) || "");
    query = new URL(raw, "http://localhost").searchParams;
  } catch (err) {
    return { error: "page and pageSize must be non-negative integers" };
  }
  const cap = ${LIMITS.zcqlRowsPerQuery};
  const page = queryInt(query.get("page"), 0);
  let pageSize = queryInt(query.get("pageSize"), cap);
  if (page === null || pageSize === null) return { error: "page and pageSize must be non-negative integers" };
  if (pageSize < 1) return { error: "pageSize must be between 1 and " + cap };
  if (pageSize > cap) pageSize = cap;
  if (page * pageSize > 100000) return { error: "page offset exceeds 100000" };
  return { page, pageSize };
}

// A composite display field (name, address) reads as an object; the option
// text joins its non-empty scalar parts with a space.
function displayText(value) {
  if (value == null) return "";
  if (typeof value !== "object") return String(value);
  const parts = [];
  for (const key of Object.keys(value)) {
    const part = value[key];
    if (part == null || part === "" || typeof part === "object") continue;
    parts.push(String(part));
  }
  return parts.join(" ");
}

// One option: the display value under its field name, keyed by ROWID. The
// display value passes the caller's field allowlist; ROWID is the row key the
// client submits back. Sibling fields never leave this endpoint.
function toOption(row, fields, display) {
  const source = row && typeof row === "object" ? row : {};
  const shown = projectFields(source, fields);
  const out = {};
  if (source.ROWID != null && source.ROWID !== "") out.ROWID = String(source.ROWID);
  if (Object.prototype.hasOwnProperty.call(shown, display)) out[display] = displayText(shown[display]);
  return out;
}

export default async function handler(req, res) {
  const route = routeOf(req, "lookups");
  if (!route) {
    send(res, 404, { dryRun: true, error: "lookup route not found" });
    return;
  }
  if (isHidden(route.form)) {
    send(res, 403, { dryRun: true, error: "hidden form" });
    return;
  }
${requirePrincipal()}
  try {
    const pagingArgs = paging(req);
    if (pagingArgs.error) {
      send(res, 400, { dryRun: true, error: pagingArgs.error });
      return;
    }
    const deploy = deployConfig();
    const scoped = authorizeRead(access, principal, route.form, { op: "true" }, route.field);
    const display = route.field;
    if (deploy.mode === "live") {
      const datastore = await liveDatastore();
      if (!datastore || typeof datastore.query !== "function") {
        send(res, 500, { dryRun: false, wrote: false, error: "live datastore is not configured" });
        return;
      }
      const { page, pageSize } = pagingArgs;
      const queried = await readScoped(datastore, route.form, scoped.criteria, page * pageSize, pageSize);
      const rows = (Array.isArray(queried) ? queried : []).map((row) => toOption(row, scoped.fields, display));
      send(res, 200, { dryRun: false, rows, field: display, page, pageSize });
      return;
    }
    const rows = suppliedRows(req).map((row) => toOption(row, scoped.fields, display));
    send(res, 200, { dryRun: true, rows, field: display, pageSize: ${LIMITS.zcqlRowsPerQuery} });
  } catch (err) {
    fail(res, err);
  }
}
`;
}

/**
 * The admin smoke endpoint, POST /admin/smoke — the server half of
 * `c2c smoke --in-browser` (the page is the hidden #/admin/smoke route).
 *
 *   - { op: "status" } answers whether the caller may run it.
 *   - { op: "delete", form, rowId, marker: { field, tag } } deletes one row
 *     only when the row's marker field carries the tag of the calling run.
 *     The in-app runner tags every row it creates ('c2c smoke <tag>' in the
 *     first required text field), so cleanup cannot remove a row this run did
 *     not write. The marker field name is a generated allowlist entry, not a
 *     caller-supplied column, and the tag must be a smoke-tag literal.
 *
 * The gate is principal.profile against the Administrator-preset names —
 * body, query and header values are never principals.
 *
 * The endpoint exists only when the function sets C2C_SMOKE_ENABLED=1
 * (cutover smoke). Any other value answers every op with 404, the same
 * reply an absent route gets, so production bundles carry no smoke
 * surface. The marker column stays a dedicated single generated column
 * per form (markerFields): a caller cannot nominate another column, and
 * marker values never leave the server in a reply.
 */
function smokeStub(app: App, model: UiModel, schema: ReturnType<typeof generateSchema>): string {
  const tables: Record<string, string> = {};
  for (const table of schema.tables) {
    if (table.role === 'form' && !table.nosql && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table.name)) tables[table.form] = table.name;
  }
  const markers: Record<string, string> = {};
  const numbers: Record<string, string> = {};
  for (const form of model.forms) {
    if (!tables[form.name]) continue;
    const field = smokeMarkerField(form.fields);
    if (field) markers[form.name] = field;
    const number = smokeNumberField(form.fields, field);
    if (field && number) numbers[form.name] = number;
  }
  return `${banner([
    'Admin smoke endpoint for `c2c smoke --in-browser` (the #/admin/smoke page).',
    'op "status" answers { ok, mode, forms }; op "update" patches one row, op "arith" stores 41 in',
    'one number field and checks that the live read gives a number (41 + 1 is 42, 41 > 9), and',
    'op "delete" removes one row — each only when its marker field carries the calling run\'s tag,',
    'so a run cannot touch a row it did not write. The generated app has no edit route: update lives here.',
    'Administrator-preset profiles only. The row read goes through authorizeRead, the patch through',
    'authorizeWrite, and the delete through authorizeDelete, with functions/c2c-deploy.json mode',
    'deciding live effects. Replies carry statuses and booleans only — never record values,',
    'tokens, or user data. The endpoint answers only when C2C_SMOKE_ENABLED is "1"',
    '(cutover smoke); otherwise every op is a 404, as if the route were absent.',
  ])}${policyPrelude('../access-policy.json', false, 'import { authorizeDelete } from "creator-to-catalyst/shims";\n')}
export const endpoint = { type: "advancedio", method: "POST", path: "/admin/smoke", dryRun: true };
const adminProfiles = ${JSON.stringify(administratorProfiles(app))};
/** Form link name -> Data Store table (form tables only). */
const tables = ${JSON.stringify(tables)};
/** Form link name -> the dedicated run-owned marker column ('c2c smoke <tag>'). One generated column per form: the caller cannot nominate another, and marker values never leave the server in a reply. */
const markerFields = ${JSON.stringify(markers)};
/** Form link name -> the number field op "arith" writes and reads back. */
const numberFields = ${JSON.stringify(numbers)};
const SMOKE_TAG = /^c2c smoke [A-Za-z0-9_-]{1,64}$/;

${deployHelpers('../c2c-deploy.json', '../c2c-store.mjs')}

// ZCQL has no boolean literal predicate: "WHERE true" is a syntax error. An always-true read sends no WHERE clause.
function zcqlPredicate(where) {
  const text = typeof where === "string" ? where.trim() : "";
  return text === "true" ? "" : text;
}

/** Cutover-only switch: C2C_SMOKE_ENABLED=1. Fail closed — anything else behaves as if the route were absent. */
function smokeEnabled() {
  const flag = typeof process !== "undefined" && process.env ? process.env.C2C_SMOKE_ENABLED : undefined;
  return flag === "1";
}

export default async function handler(req, res) {
  if (!smokeEnabled()) {
    send(res, 404, { error: "no such endpoint" });
    return;
  }
  const principal = principalFromRequest(req);
  if (!principal?.profile) {
    send(res, 401, { dryRun: true, error: "authenticated caller required" });
    return;
  }
  if (!adminProfiles.some((name) => name.toLowerCase() === String(principal.profile).toLowerCase())) {
    send(res, 403, { dryRun: true, error: "the smoke endpoint requires an Administrator profile" });
    return;
  }
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  if (body.op === "status" || body.op === undefined) {
    send(res, 200, { ok: true, dryRun: !live, mode: deploy.mode, forms: Object.keys(tables).length });
    return;
  }
  if (body.op !== "delete" && body.op !== "update" && body.op !== "arith") {
    send(res, 400, { dryRun: !live, error: "unknown op" });
    return;
  }
  const form = typeof body.form === "string" ? body.form : "";
  const table = Object.prototype.hasOwnProperty.call(tables, form) ? tables[form] : undefined;
  if (!table) {
    send(res, 404, { dryRun: !live, error: "no such form" });
    return;
  }
  const rowId = typeof body.rowId === "string" ? body.rowId.trim() : typeof body.rowId === "number" && Number.isSafeInteger(body.rowId) ? String(body.rowId) : "";
  if (!/^\\d+$/.test(rowId)) {
    send(res, 400, { dryRun: !live, error: "rowId must be a ROWID" });
    return;
  }
  const marker = body.marker && typeof body.marker === "object" && !Array.isArray(body.marker) ? body.marker : {};
  const field = typeof marker.field === "string" ? marker.field : "";
  if (!Object.prototype.hasOwnProperty.call(markerFields, form) || markerFields[form] !== field) {
    send(res, 400, { dryRun: !live, error: "no smoke marker field on this form" });
    return;
  }
  const tag = typeof marker.tag === "string" ? marker.tag : "";
  if (!SMOKE_TAG.test(tag)) {
    send(res, 400, { dryRun: !live, error: "marker tag is not a smoke tag" });
    return;
  }
  let patch = null;
  if (body.op === "update") {
    const fields = body.fields && typeof body.fields === "object" && !Array.isArray(body.fields) ? body.fields : null;
    if (!fields || !Object.keys(fields).length) {
      send(res, 400, { dryRun: !live, error: "update needs a fields object" });
      return;
    }
    for (const key of Object.keys(fields)) {
      if (/^(rowid|id)$/i.test(key) || /^(added|modified)_(user|time)$/i.test(key)) {
        send(res, 400, { dryRun: !live, error: "update cannot set system columns" });
        return;
      }
    }
    patch = fields;
  }
  if (body.op === "arith") {
    const number = typeof body.field === "string" ? body.field : "";
    if (!Object.prototype.hasOwnProperty.call(numberFields, form) || numberFields[form] !== number) {
      send(res, 400, { dryRun: !live, error: "no smoke number field on this form" });
      return;
    }
    patch = { [number]: 41 };
  }
  try {
    if (body.op === "delete") authorizeDelete(access, principal, form);
    const screened = patch ? authorizeWrite(access, principal, form, patch, undefined, "update").values : null;
    if (!live) {
      send(res, 200, { dryRun: true, deleted: false, updated: false });
      return;
    }
    const datastore = await liveDatastore();
    if (!datastore || typeof datastore.query !== "function" || typeof datastore.delete !== "function" || typeof datastore.update !== "function") {
      send(res, 500, { dryRun: false, error: "live datastore is not configured" });
      return;
    }
    const scoped = authorizeRead(access, principal, form, { op: "==", field: "ROWID", value: rowId }, undefined, "modify");
    const where = zcqlPredicate(compileCriteria(scoped.criteria));
    const rows = await datastore.query(table, where, 1, 0, "ORDER BY ROWID", ["ROWID", field]);
    const row = Array.isArray(rows) && rows[0] && typeof rows[0] === "object" ? rows[0] : null;
    if (!row) {
      send(res, 404, { dryRun: false, deleted: false, updated: false, error: "no such row" });
      return;
    }
    const stored = row[field];
    if (stored !== tag) {
      send(res, 409, { dryRun: false, deleted: false, updated: false, error: "the row carries no marker of this run" });
      return;
    }
    if (body.op === "update") {
      await datastore.update(table, [{ ROWID: rowId, ...screened }]);
      send(res, 200, { dryRun: false, updated: true });
      return;
    }
    if (body.op === "arith") {
      // The store returns integer columns as text; "41" + 1 is "411" and "41" > "9" is false.
      const number = numberFields[form];
      await datastore.update(table, [{ ROWID: rowId, ...screened }]);
      const again = await datastore.query(table, where, 1, 0, "ORDER BY ROWID", ["ROWID", number]);
      const value = Array.isArray(again) && again[0] && typeof again[0] === "object" ? again[0][number] : undefined;
      const ok = typeof value === "number" && value + 1 === 42 && value > 9;
      send(res, 200, ok ? { dryRun: false, arithmetic: true } : { dryRun: false, arithmetic: false, error: "the number field reads back as " + typeof value + ", not a number" });
      return;
    }
    await datastore.delete(table, [rowId]);
    const after = await datastore.query(table, "ROWID = " + rowId, 1, 0, "ORDER BY ROWID", ["ROWID"]);
    if (Array.isArray(after) && after.length) {
      send(res, 500, { dryRun: false, deleted: false, error: "the row is still present" });
      return;
    }
    send(res, 200, { dryRun: false, deleted: true });
  } catch (err) {
    fail(res, err, live);
  }
}
`;
}

function namedFilterList(app: App, report: UiModel['reports'][number]): { label: string; criteria: Criteria }[] {
  const source = app.reports.find((item) => item.name === report.name);
  const out: { label: string; criteria: Criteria }[] = [];
  for (const filter of source?.filters ?? []) {
    const label = filter.label?.trim();
    const text = filter.criteria?.trim();
    if (!label || !text) continue;
    const criteria = reportCriteria(text);
    // An untranslatable named filter ships closed, not dropped: selecting it
    // returns no rows instead of silently applying no filter.
    out.push({ label, criteria: criteriaHasTodo(criteria) ? { op: 'todo', construct: 'report-criteria' } : criteria });
  }
  return out;
}

function reportBaseCriteria(app: App, report: UiModel['reports'][number]): Criteria {
  const source = app.reports.find((item) => item.name === report.name);
  // No criteria means all rows; a criteria that did not translate means none.
  const text = source?.criteria?.trim();
  if (!text) return { op: 'true' };
  const parsed = reportCriteria(text);
  return criteriaHasTodo(parsed) ? { op: 'todo', construct: 'report-criteria' } : parsed;
}

function projectionNames(columnNames: readonly string[]): string[] {
  const names = ['ROWID'];
  for (const name of columnNames) if (!names.includes(name)) names.push(name);
  return names;
}

const schemaCache = new WeakMap<App, SchemaPlan>();

function schemaOf(app: App): SchemaPlan {
  const cached = schemaCache.get(app);
  if (cached) return cached;
  const plan = generateSchema(app);
  schemaCache.set(app, plan);
  return plan;
}

/** IR columns (field plus composite parts). The UI model drops subcolumns. */
function reportSelectColumns(app: App, report: UiModel['reports'][number]): { field: string; subcolumns?: { field: string }[] }[] {
  const source = app.reports.find((item) => item.name === report.name);
  if (!source) return report.columns.map((column) => ({ field: column.field }));
  return source.columns.map((column) => ({
    field: column.field,
    ...(column.subcolumns.length ? { subcolumns: column.subcolumns.map((sub) => ({ field: sub.field })) } : {}),
  }));
}

/**
 * Staged SQL when one SELECT cannot cover this report: the listed columns, the
 * table projection, or the joins exceed a cap, or a selected column lives on
 * an extension table. Under every cap this returns null and the report file
 * is unchanged.
 */
function stagedReportQueries(app: App, report: UiModel['reports'][number]): string[] | null {
  const formName = report.form;
  if (!formName) return null;
  const plan = schemaOf(app);
  const base = plan.tables.find((table) => table.role === 'form' && table.form === formName && !table.nosql);
  if (!base) return null;
  const columns = reportSelectColumns(app, report);
  const listed: string[] = [];
  for (const column of columns) {
    if (column.subcolumns?.length) {
      for (const sub of column.subcolumns) listed.push(sub.field);
    } else listed.push(column.field);
  }
  const payload = base.columns
    .filter((column) => column.matrixId !== 'c2c-system-field' && column.matrixId !== 'c2c-source-id' && column.name !== EXTENSION_KEY)
    .map((column) => column.name);
  const extensionOf = new Map<string, string>();
  for (const table of plan.tables) {
    if (table.role !== 'extension' || table.form !== formName) continue;
    for (const column of table.columns) {
      if (column.name !== EXTENSION_KEY) {
        extensionOf.set(column.name, table.name);
        payload.push(column.name);
      }
    }
  }
  const fields = listed.length ? listed : payload;
  const dotted = new Set<string>();
  const extensions = new Set<string>();
  for (const field of fields) {
    const dot = field.indexOf('.');
    if (dot > 0) {
      const head = field.slice(0, dot);
      if (head !== formName && head !== 'input' && head !== 'old' && head !== 'row') dotted.add(head);
      continue;
    }
    const ext = extensionOf.get(field);
    if (ext) extensions.add(ext);
  }
  // A dotted column under the join cap stays on today's query. An extension
  // column is not on the base table, so leaving today's query would drop it.
  // The stub's SELECT lists the stored projection (ROWID plus every schema
  // column). A list past the unverified cap is several statements; no column
  // is omitted. Listed columns and joins stay on the report planner so a
  // later chunk does not ask for columns the report does not read.
  const selectLimit = limitValue('zcql.select_columns');
  const projection = projectionNames(base.columns.map((column) => column.name));
  const selectOver = fields.length > selectLimit || projection.length > selectLimit;
  const joinOver = dotted.size + extensions.size > limitValue('zcql.joins');
  if (!selectOver && !joinOver && extensions.size === 0) return null;
  if (fields.length > selectLimit || joinOver || extensions.size > 0 || dotted.size > 0) {
    const read = planReportQuery(plan, formName, columns);
    if (read.staged) return read.queries;
  }
  if (projection.length > selectLimit && extensions.size === 0 && dotted.size === 0) {
    const wide = planZcql({
      from: base.name,
      columns: projection.map((column) => ({ table: base.name, column })),
      orderBy: 'ORDER BY ROWID',
    });
    if (wide.staged) return wide.queries;
  }
  return null;
}

const REPORT_SHIM_IMPORT = 'import { authorizeRead, authorizeWrite, compileCriteria, jsonReplacer, principalFromRequest, projectFields } from "creator-to-catalyst/shims";';
const REPORT_SHIM_IMPORT_STAGED = 'import { authorizeRead, authorizeWrite, compileCriteria, createRuntime, jsonReplacer, principalFromRequest, projectFields } from "creator-to-catalyst/shims";';

function reportLiveBounds(source: string): { liveStart: number; liveEnd: number } {
  const liveStart = source.indexOf('      const where = zcqlPredicate(compileCriteria(resolved');
  const liveEnd = source.indexOf('      return;\n    }\n    const scoped = authorizeRead(access, principal, formName, baseCriteria);', liveStart < 0 ? 0 : liveStart);
  return { liveStart, liveEnd };
}

/**
 * The planner threw. The live branch names the limit instead of returning an
 * empty 200. A template mismatch still throws: that is not an over-cap report.
 */
function refuseOverLimit(source: string, err: ZcqlLimitError): string {
  const { liveStart, liveEnd } = reportLiveBounds(source);
  if (liveStart < 0 || liveEnd < 0) throw err;
  const stagedLive = `      send(res, 501, {
        dryRun: false,
        code: "REPORT_OVER_LIMIT",
        limit: ${JSON.stringify(err.limitId)},
        error: ${JSON.stringify(err.message)},
        criteria: scoped.criteria,
        page,
        pageSize,
      });
`;
  const out = `${source.slice(0, liveStart)}${stagedLive}${source.slice(liveEnd)}`;
  if (out.includes('notice: "staged zcql"') || out.includes('await datastore.query(') || out.includes('SELECT *')) throw err;
  return out;
}

/** Lookup field name -> parent form, for every lookup field of the form. */
function lookupParentsOf(app: App, formName: string): Record<string, string> {
  const out: Record<string, string> = {};
  const form = app.forms.find((item) => item.name === formName);
  for (const field of form?.fields ?? []) if (field.lookup?.form) out[field.name] = field.lookup.form;
  return out;
}

/**
 * Parent form -> `{ <composite>.<part>: <stored column> }`, for the lookup
 * parents of one form. A criteria leaf such as `Owner.Name.first_name` walks a
 * lookup, then a composite part; the store keeps one column per part, so the
 * leaf rewrites onto `Name_first_name`. Columns come from the generated schema
 * (allocated names included), never a re-derived `Field_part` guess.
 */
function compositePartsOfParents(app: App, parents: Record<string, string>, plan: SchemaPlan): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const parentForm of Object.values(parents).sort().filter((name, index, all) => index === 0 || name !== all[index - 1])) {
    const form = app.forms.find((item) => item.name === parentForm);
    const table = plan.tables.find((item) => item.role === 'form' && item.form === parentForm && !item.nosql);
    if (!form || !table) continue;
    const map: Record<string, string> = {};
    for (const field of form.fields) {
      if (fieldTypeRow(field.type)?.kind !== 'composite') continue;
      for (const column of table.columns) {
        if (column.name.startsWith(`${field.name}_`)) map[`${field.name}.${column.name.slice(field.name.length + 1)}`] = column.name;
      }
    }
    if (Object.keys(map).length) out[parentForm] = map;
  }
  return out;
}

/** Swap only the over-cap report. The unstaged source is returned untouched. */
function stageReportSource(source: string, queries: readonly string[]): string {
  const bound = source.includes('function boundCriteria(');
  const criteriaName = bound ? 'applied' : 'scoped.criteria';
  const columnLine = source.indexOf('export const columnFields = ');
  if (columnLine < 0) throw new ZcqlLimitError('zcql.select_columns', 'report stub has no columnFields export');
  const lineEnd = source.indexOf('\n', columnLine);
  const stagedExport = `export const zcqlStages = ${JSON.stringify(queries)};\n`;
  let out = `${source.slice(0, lineEnd + 1)}${stagedExport}${source.slice(lineEnd + 1)}`;
  // Lookup display reads still call queryExact. Only the report row fetch moves to staged ZCQL.
  if (!out.includes(REPORT_SHIM_IMPORT)) throw new ZcqlLimitError('zcql.select_columns', 'report stub shim import was not found');
  out = out.replace(REPORT_SHIM_IMPORT, REPORT_SHIM_IMPORT_STAGED);
  const dry = `    const queryShape = sqlIdent
      ? \`SELECT \${projection.join(", ")} FROM \${sqlIdent}\${whereClause(where)} ORDER BY ROWID LIMIT 1, ${LIMITS.zcqlRowsPerQuery}\`
      : "not emitted: the form name is not a bare ZCQL identifier";`;
  if (!out.includes(dry)) throw new ZcqlLimitError('zcql.select_columns', 'report stub dry-run queryShape was not found');
  out = out.replace(dry, '    const queryShape = zcqlStages.join("\\n");');
  const { liveStart, liveEnd } = reportLiveBounds(out);
  if (liveStart < 0 || liveEnd < 0) throw new ZcqlLimitError('zcql.select_columns', 'report stub live query was not found');
  // Access stays in the handler's authorizeRead. Passing it again would AND the
  // record filter twice and project dotted lookup keys off the row.
  const decimalOpt = source.includes('export const decimalColumns') ? '\n        decimalColumns: { [formName]: decimalColumns },' : '';
  const stagedLive = `      const offset = page * pageSize;
      const chosenSort = Array.isArray(body.sort) && body.sort.length ? body.sort[0] : (Array.isArray(reportSort) && reportSort.length ? reportSort[0] : null);
      let sort = null;
      if (chosenSort && typeof chosenSort.field === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(chosenSort.field)) {
        const raw = String(chosenSort.order || chosenSort.dir || "").toLowerCase();
        const dir = raw === "desc" || raw === "descending" ? "DESC" : raw === "asc" || raw === "ascending" ? "ASC" : "";
        sort = dir ? { field: chosenSort.field, dir } : { field: chosenSort.field };
      }
      const runtime = createRuntime({
        dryRun: false,
        appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined,
        datastore,${decimalOpt}
        ...(datastore.now ? { now: datastore.now } : {}),
      });
      const ctx = runtime.context({
        principal,
        appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined,
      });
      const queried = await runtime.shim.datastore.rows(ctx, runtime.shim.datastore.query(ctx, formName, resolved, {
        zcql: zcqlStages,
        range: { from: offset + 1, to: offset + pageSize },
        ...(sort ? { sort } : {}),
      }));
      // A stage attaches Lookup.Display from the parent form. The parent check
      // is the unstaged lookup read's: lookupDisplayScope on the parent form,
      // then the parent record filter. A display that fails it is dropped and
      // the lookup id stays.
      const parentScopes = {};
      const parentScope = (lookup, display) => {
        const key = lookup + "." + display;
        if (!Object.prototype.hasOwnProperty.call(parentScopes, key)) {
          const form = Object.prototype.hasOwnProperty.call(lookupParents, lookup) ? lookupParents[lookup] : lookup;
          parentScopes[key] = { form, lookup, display, scoped: lookupDisplayScope(principal, form, display, { op: "true" }) };
        }
        return parentScopes[key];
      };
      const rows = (Array.isArray(queried) ? queried : []).map((row) => {
        const values = row && typeof row === "object" && row.values && typeof row.values === "object" ? row.values : {};
        const projected = projectFields(values, scoped.fields);
        const grant = scoped.fields;
        for (const field of Object.keys(values)) {
          if (typeof field !== "string") continue;
          const dot = field.indexOf(".");
          if (dot <= 0) continue;
          const lookup = field.slice(0, dot);
          const display = field.slice(dot + 1);
          // Dotted key Lookup.Display a stage resolved. Re-add it only when the
          // field grant allows the lookup and this display. Generated grants
          // name the lookup, not the dotted column, so a granted lookup allows
          // its display — whether or not it is also a report column. A hidden
          // lookup is dropped, even if projectFields copied the dotted name.
          const lookupOk = !grant || grant.includes(lookup);
          const displayOk = !grant || grant.includes(lookup) || grant.includes(display) || grant.includes(field);
          if (lookupOk && displayOk && parentScope(lookup, display).scoped) projected[field] = values[field];
          else delete projected[field];
        }
        return projected;
      });
      for (const parent of Object.values(parentScopes)) {
        if (!parent.scoped || !parent.scoped.criteria || parent.scoped.criteria.op === "true") continue;
        const field = parent.lookup + "." + parent.display;
        const ids = [];
        for (let i = 0; i < rows.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(rows[i], field)) continue;
          const id = queried[i] && queried[i].values ? queried[i].values[parent.lookup] : undefined;
          if (typeof id === "string" && /^[0-9]+$/.test(id) && !ids.includes(id)) ids.push(id);
        }
        const readable = {};
        const scopedParent = ids.length ? lookupDisplayScope(principal, parent.form, parent.display, { op: "in", field: "ROWID", value: ids }) : null;
        if (scopedParent) {
          try {
            const parents = await readScoped(datastore, parent.form, scopedParent.criteria, 0, ids.length);
            for (const item of Array.isArray(parents) ? parents : []) {
              if (item && typeof item === "object" && item.ROWID != null && item.ROWID !== "") readable[String(item.ROWID)] = true;
            }
          } catch (err) {
            // A parent read that fails shows no display, as on the unstaged read.
          }
        }
        for (let i = 0; i < rows.length; i++) {
          const id = queried[i] && queried[i].values ? queried[i].values[parent.lookup] : undefined;
          if (!Object.prototype.hasOwnProperty.call(readable, String(id))) delete rows[i][field];
        }
      }
${bound ? '      const shown = relative ? rows.filter((row) => matchRow(row, resolved, decimalColumns)) : rows;\n' : ''}      const queryShape = zcqlStages.join("\\n");
      send(res, 200, {
        dryRun: false,
        rows${bound ? ': shown' : ''},
        fields: scoped.fields ?? null,
        queries: zcqlStages,
        queryShape,
        criteria: ${criteriaName},
        page,
        pageSize,
      });
`;
  out = `${out.slice(0, liveStart)}${stagedLive}${out.slice(liveEnd)}`;
  if (out.includes('await datastore.query(') || out.includes('await queryExact(') || out.includes('SELECT *') || out.includes('notice: "staged zcql"')) {
    throw new ZcqlLimitError('zcql.select_columns', 'staged report still short-circuits or selects through datastore.query');
  }
  if (!out.includes('zcql: zcqlStages') || !out.includes('createRuntime(')) {
    throw new ZcqlLimitError('zcql.select_columns', 'staged report does not execute zcqlStages');
  }
  return out;
}

/** Columns whose relative bounds are dates (`yyyy-MM-dd`) rather than datetimes. */
function dateFieldKinds(app: App, formName: string): Record<string, 'date' | 'datetime'> {
  const out: Record<string, 'date' | 'datetime'> = { Added_Time: 'datetime', Modified_Time: 'datetime' };
  const form = app.forms.find((item) => item.name === formName);
  const put = (name: string, owner: string, field: string) => {
    const type = scheduleAnchorFieldType(app, owner, field);
    if (type === 'Date') out[name] = 'date';
    else if (type === 'DateTime') out[name] = 'datetime';
  };
  for (const field of form?.fields ?? []) {
    put(field.name, formName, field.name);
    const target = field.lookup?.form;
    if (!target) continue;
    for (const column of app.forms.find((item) => item.name === target)?.fields ?? []) {
      put(`${field.name}.${column.name}`, target, column.name);
    }
    out[`${field.name}.Added_Time`] = 'datetime';
    out[`${field.name}.Modified_Time`] = 'datetime';
  }
  return out;
}

function reportStub(app: App, report: UiModel['reports'][number], projection: readonly string[]): string {
  const formName = report.form ?? '';
  const ident = formName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(formName) ? formName : '';
  const base = reportBaseCriteria(app, report);
  const named = namedFilterList(app, report);
  const wantsRelative = criteriaHasRelative(base) || named.some((item) => criteriaHasRelative(item.criteria));
  const criteriaRef = wantsRelative ? 'applied' : 'scoped.criteria';
  const columns = report.columns.map((column) => column.field);
  const decimals = Object.hasOwn(decimalColumnsOf(app), formName) ? decimalColumnsOf(app)[formName]! : {};
  const exact = Object.keys(decimals).length > 0;
  const exactNote = exact
    ? ['Decimal, currency, and percent fields are varchar. Criteria and sort on them use the Double shadow column in ZCQL, then queryExact keeps and orders rows by the exact value (shim.decimal.cmp) and applies the page.']
    : [];
  const subformLinks = formName ? subformLinksFor(app, formName) : [];
  const lookups = report.columns.filter((column) => column.lookup).map((column) => ({ column: column.field, form: column.lookup!.form, field: column.lookup!.field }));
  const shimNames = ['criteriaHasTodo', 'needsExactRead', 'queryExact', ...(subformLinks.length ? ['attachSubforms'] : []), ...(wantsRelative ? ['criteriaHasRelative', 'bindRelativeCriteria', 'matchRow'] : [])];
  const shimImport = `import { ${shimNames.join(', ')} } from "creator-to-catalyst/shims";\n`;
  const subformConst = subformLinks.length
    ? `/** Inline subforms of this form, each a child table. Report rows carry them as lists in row order. */\nexport const subformTables = ${JSON.stringify({ [formName]: subformLinks })};\n`
    : '';
  const appDecimals = decimalColumnsOf(app);
  // The staged read resolves every lookup field of the form, including a display
  // column (Author.Author_Name) that does not list the lookup itself. The decimal
  // shadow map has to name those parents too, or a record filter on a decimal
  // column compares the varchar ('10' < '5').
  const parents = lookupParentsOf(app, formName);
  const parentParts = compositePartsOfParents(app, parents, schemaOf(app));
  const parentForms: string[] = [];
  const seenParents = new Set<string>();
  for (const item of lookups) {
    if (seenParents.has(item.form)) continue;
    seenParents.add(item.form);
    parentForms.push(item.form);
  }
  for (const form of Object.values(parents).sort()) {
    if (seenParents.has(form)) continue;
    seenParents.add(form);
    parentForms.push(form);
  }
  const parentDecimals = Object.fromEntries(parentForms.flatMap((form) => (Object.hasOwn(appDecimals, form) ? [[form, appDecimals[form]!]] : [])));
  const exactConst = `${exact ? `export const decimalColumns = ${JSON.stringify(decimals)};\n` : `const decimalColumns = {};\n`}${subformConst}const parentDecimals = ${JSON.stringify(parentDecimals)};\nconst projection = ${JSON.stringify(projection)};\n`;
  const attachRows = subformLinks.length ? `\n      if (Array.isArray(queried)) await attachSubforms(datastore, subformTables, formName, queried);` : '';
  const liveQuery = exact
    ? `const resolved = await resolveLookupCriteria(datastore, ${criteriaRef}, principal);
      const where = zcqlPredicate(compileCriteria(resolved, undefined, decimalColumns));
      const sort = sortOf(body.sort);
      const orderBy = orderByOf(body.sort);
      const offset = page * pageSize;
      const queried = needsExactRead(resolved, sort || undefined, decimalColumns)
        ? await queryExact((form, w, limit, off, ob) => datastore.query(form, w, limit, off, ob, projection), formName, where, {
            criteria: resolved,
            decimals: decimalColumns,
            ...(sort ? { sort } : {}),
            range: { from: offset + 1, to: offset + pageSize },
          })
        : await datastore.query(formName, where, pageSize, offset, orderBy, projection);`
    : `const resolved = await resolveLookupCriteria(datastore, ${criteriaRef}, principal);
      const where = zcqlPredicate(compileCriteria(resolved));
      const orderBy = orderByOf(body.sort);
      const offset = page * pageSize;
      const queried = needsExactRead(resolved, undefined, decimalColumns)
        ? await queryExact((form, w, limit, off, ob) => datastore.query(form, w, limit, off, ob, projection), formName, where, {
            criteria: resolved,
            decimals: decimalColumns,
            range: { from: offset + 1, to: offset + pageSize },
          })
        : await datastore.query(formName, where, pageSize, offset, orderBy, projection);`;
  const relativePrelude = wantsRelative
    ? `const dateFieldKinds = ${JSON.stringify(dateFieldKinds(app, formName))};
function reportInstant() {
  const raw = typeof process !== "undefined" && process.env ? process.env.C2C_NOW : undefined;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}
function reportZone() {
  const envZone = typeof process !== "undefined" && process.env ? process.env.C2C_APP_TIMEZONE : undefined;
  if (typeof envZone === "string" && envZone.trim()) return envZone.trim();
  const configured = deployConfig();
  return configured && typeof configured.appTimeZone === "string" ? configured.appTimeZone.trim() : "";
}
function boundCriteria(criteria) {
  if (!criteriaHasRelative(criteria)) return criteria;
  try {
    return bindRelativeCriteria(criteria, reportInstant(), reportZone(), dateFieldKinds);
  } catch (err) {
    return null;
  }
}
`
    : '';
  const liveBind = wantsRelative
    ? `      const relative = criteriaHasRelative(scoped.criteria);
      const applied = relative ? boundCriteria(scoped.criteria) : scoped.criteria;
      if (relative && !applied) {
        send(res, 200, {
          dryRun: false,
          rows: [],
          fields: scoped.fields ?? null,
          notice: "filter not migrated",
          criteria: scoped.criteria,
          page,
          pageSize,
        });
        return;
      }
`
    : '';
  const dryBind = wantsRelative
    ? `    const relative = criteriaHasRelative(scoped.criteria);
    const applied = relative ? boundCriteria(scoped.criteria) : scoped.criteria;
    if (relative && !applied) {
      send(res, 200, {
        dryRun: true,
        rows: [],
        fields: scoped.fields ?? null,
        notice: "filter not migrated",
        criteria: scoped.criteria,
        pageSize: ${LIMITS.zcqlRowsPerQuery},
      });
      return;
    }
`
    : '';
  const rowWord = wantsRelative ? 'let rows' : 'const rows';
  const orderBy = exact
    ? `function sortOf(bodySort) {
  const chosen = Array.isArray(bodySort) && bodySort.length ? bodySort[0] : (Array.isArray(reportSort) && reportSort.length ? reportSort[0] : null);
  if (!chosen || typeof chosen.field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(chosen.field)) return null;
  const raw = String(chosen.order || chosen.dir || "").toLowerCase();
  const dir = raw === "desc" || raw === "descending" ? "DESC" : raw === "asc" || raw === "ascending" ? "ASC" : "";
  return dir ? { field: chosen.field, dir } : { field: chosen.field };
}

function orderByOf(bodySort) {
  const chosen = sortOf(bodySort);
  if (!chosen) return "ORDER BY ROWID";
  const dir = chosen.dir || "";
  if (chosen.field === "ROWID" || chosen.field === "ID") return dir ? "ORDER BY ROWID " + dir : "ORDER BY ROWID";
  const column = Object.prototype.hasOwnProperty.call(decimalColumns, chosen.field) ? decimalColumns[chosen.field].shadow : chosen.field;
  return dir ? "ORDER BY " + column + " " + dir + ", ROWID" : "ORDER BY " + column + ", ROWID";
}`
    : `function orderByOf(bodySort) {
  const chosen = Array.isArray(bodySort) && bodySort.length ? bodySort[0] : (Array.isArray(reportSort) && reportSort.length ? reportSort[0] : null);
  if (!chosen || typeof chosen.field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(chosen.field)) return "ORDER BY ROWID";
  const raw = String(chosen.order || chosen.dir || "").toLowerCase();
  const dir = raw === "desc" || raw === "descending" ? "DESC" : raw === "asc" || raw === "ascending" ? "ASC" : "";
  if (chosen.field === "ROWID" || chosen.field === "ID") return dir ? "ORDER BY ROWID " + dir : "ORDER BY ROWID";
  return dir ? "ORDER BY " + chosen.field + " " + dir + ", ROWID" : "ORDER BY " + chosen.field + ", ROWID";
}`;
  // Blueprint stage field settings apply to the list read too: each row is
  // filtered against its own stored stage, the same rule the single-record
  // read applies, so a stage-hidden field cannot leak through a report.
  const stage = { modules: formName ? blueprintFieldSpecs(app, formName).map((item) => `../flow/${item.slug}.mjs`) : [] };
  const stageConst = stage.modules.length
    ? `/** Blueprint machines whose stage field settings govern these rows. */\nconst stageModules = ${JSON.stringify(stage.modules)};\n`
    : '';
  const stageLoad = (indent: string): string =>
    stage.modules.length
      ? `${indent}const stageMods = [];
${indent}for (const spec of stageModules) {
${indent}  const mod = await import(spec);
${indent}  if (!mod || typeof mod.visibleRecord !== "function") throw new Error("stage field module missing");
${indent}  stageMods.push(mod);
${indent}}
`
      : '';
  const stageApply = stage.modules.length ? 'for (const mod of stageMods) projected = mod.visibleRecord(projected, row);' : '';
  const source = `${banner([
    `Report ${report.name}. Dry run: no ZCQL query is sent.`,
    `Page size ${LIMITS.zcqlRowsPerQuery}.`,
    'The report criteria and the profile record filter are ANDed via authorizeRead.',
    'Hidden fields are removed with projectFields. Policy: functions/access-policy.json.',
    ...(stage.modules.length ? ['Blueprint field settings drop the fields each row\'s own stage does not show, the same rule the record read applies.'] : []),
    'A live query runs only when functions/c2c-deploy.json mode is "live", body.op is "query", and a datastore adapter is installed.',
    'body.filter is a predefined filter label. It applies only when that label was baked in from the report. A field-only filter has no criteria and does not filter. An unknown string is ignored and is not compiled as criteria.',
    'A criteria that did not migrate fails closed: zero rows and notice "filter not migrated", never an unfiltered read.',
    ...(wantsRelative
      ? ['A relative date is evaluated when the report is read, in the application time zone. A week starts on Sunday (https://www.zoho.com/deluge/help/functions/datetime/getweekofyear.html). today is 00:00:00 (https://www.zoho.com/deluge/help/functions/datetime/today.html). A missing time zone fails closed.']
      : []),
    ...exactNote,
    report.status === 'todo' ? `TODO: ${report.todo}` : `View: ${report.view}.`,
  ])}${policyPrelude('../access-policy.json', false, shimImport)}
export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(report.queryEndpoint)}, dryRun: true, pageSize: ${LIMITS.zcqlRowsPerQuery} };
export const formName = ${JSON.stringify(formName)};
export const reportName = ${JSON.stringify(report.name)};
export const baseCriteria = ${JSON.stringify(base)};
export const sqlIdent = ${JSON.stringify(ident)};
export const columnFields = ${JSON.stringify(columns)};
export const lookupColumns = ${JSON.stringify(lookups)};
/** Parent form of each lookup field on this form. A criteria leaf on a lookup display path resolves against it, and a staged display is checked against it. */
export const lookupParents = ${JSON.stringify(parents)};
/** Stored part column of each lookup parent's composite parts: "Name.first_name" -> "Name_first_name". */
export const parentParts = ${JSON.stringify(parentParts)};
export const reportSort = ${JSON.stringify(report.sort)};
${exactConst}const namedFilters = ${JSON.stringify(named)};
${stageConst}

${deployHelpers('../c2c-deploy.json', '../c2c-store.mjs')}
${relativePrelude}function searchCriteria(q, fields) {
  const text = typeof q === "string" ? q.trim() : "";
  if (!text) return null;
  const args = [];
  for (const field of fields) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) continue;
    args.push({ op: "contains", field, value: text });
  }
  if (!args.length) return null;
  if (args.length === 1) return args[0];
  return { op: "or", args };
}

function filterCriteria(filter) {
  if (typeof filter === "string") {
    const label = filter.trim();
    if (!label) return null;
    const named = namedFilters.find((item) => item && item.label === label);
    return named ? named.criteria : null;
  }
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return null;
  const field = filter.field;
  if (typeof field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) return null;
  return { op: "==", field, value: filter.value };
}

function combineCriteria(base, extras) {
  const args = [base, ...extras].filter((item) => item && item.op !== "true");
  if (!args.length) return { op: "true" };
  if (args.length === 1) return args[0];
  return { op: "and", args };
}

${scopedReadSource()}
// The parent read scope for one lookup display, or null when the caller may
// not read that display: a hidden parent form or display field, a parent read
// authorizeRead refuses, or a field allowlist without the display field
// (authorizeRead normally refuses first; this holds even if it did not). No
// allowlist at all means every field is readable. The criteria is ANDed with
// the caller's record filter on the parent form.
function lookupDisplayScope(principal, form, display, criteria) {
  if (isHidden(form) || isHidden(display)) return null;
  let scoped;
  try {
    scoped = authorizeRead(access, principal, form, criteria, display);
  } catch (err) {
    return null;
  }
  if (Array.isArray(scoped.fields) && !scoped.fields.includes(display)) return null;
  return scoped;
}

// A lookup column stores the parent ROWID; the report shows the parent display
// value instead. One ROWID IN query per lookup column, through the same
// authorizeRead scope as the lookup endpoint: the caller's record filter is
// ANDed into the parent query and the display field must be readable, so a
// parent the caller cannot read keeps its ROWID in the cell. A hidden parent
// form or display field, or a field allowlist without the display field, keeps
// the ROWID too: the hidden value never reaches the report.
async function resolveLookupDisplays(datastore, rows, columns, principal) {
  // A composite display field (name, address) reads as an object; the cell
  // text joins its non-empty scalar parts with a space.
  const displayText = (value) => {
    if (value == null) return "";
    if (typeof value !== "object") return String(value);
    const parts = [];
    for (const key of Object.keys(value)) {
      const part = value[key];
      if (part == null || part === "" || typeof part === "object") continue;
      parts.push(String(part));
    }
    return parts.join(" ");
  };
  for (const column of columns || []) {
    if (!column || typeof column.column !== "string" || typeof column.form !== "string" || typeof column.field !== "string") continue;
    const seen = {};
    const ids = [];
    for (const row of rows) {
      const value = row ? row[column.column] : undefined;
      if (typeof value !== "string" || !/^[0-9]+$/.test(value) || seen[value]) continue;
      seen[value] = true;
      ids.push(value);
    }
    if (!ids.length) continue;
    const display = column.field;
    // A display the caller may not read resolves to nothing: the cell keeps
    // the parent ROWID. The hidden value must never reach the report.
    const scoped = lookupDisplayScope(principal, column.form, display, { op: "in", field: "ROWID", value: ids });
    if (!scoped) continue;
    let parents;
    try {
      parents = await readScoped(datastore, column.form, scoped.criteria, 0, ids.length);
    } catch (err) {
      continue;
    }
    const names = {};
    for (const parent of Array.isArray(parents) ? parents : []) {
      if (!parent || typeof parent !== "object" || parent.ROWID == null || parent.ROWID === "") continue;
      names[String(parent.ROWID)] = displayText(parent[display]);
    }
    for (const row of rows) {
      const key = row && typeof row[column.column] === "string" ? row[column.column] : "";
      if (Object.prototype.hasOwnProperty.call(names, key)) row[column.column] = names[key];
    }
  }
}

// A criteria leaf that never matches a stored row (ID isNull: ROWID is never
// NULL) and one that always matches. A lookup-path leaf that cannot be
// resolved narrows to neverRows — the read fails closed, never widened.
function neverRows() {
  return { op: "isNull", field: "ID" };
}
function alwaysRows() {
  return { op: "notNull", field: "ID" };
}

const LOOKUP_POSITIVE_OPS = new Set(["==", "<", ">", "<=", ">=", "contains", "startsWith", "endsWith", "in", "isNull", "notNull"]);
const LOOKUP_PARENT_PAGE_CAP = 1000;

// ROWIDs of the parent rows one lookup-path leaf matches, read under the
// caller's scope (the same lookupDisplayScope a display column uses). null
// when the parent read is refused or fails — the leaf then matches nothing.
async function lookupParentIds(datastore, form, field, leaf, principal) {
  const scoped = lookupDisplayScope(principal, form, field, leaf);
  if (!scoped) return null;
  const ids = [];
  const page = ${LIMITS.zcqlRowsPerQuery};
  for (let offset = 0; ; offset += page) {
    let rows;
    try {
      rows = await readScoped(datastore, form, scoped.criteria, offset, page);
    } catch (err) {
      return null;
    }
    const list = Array.isArray(rows) ? rows : [];
    for (const row of list) {
      const id = row && row.ROWID != null && row.ROWID !== "" ? String(row.ROWID) : "";
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (list.length < page) break;
    if (ids.length > LOOKUP_PARENT_PAGE_CAP) return null;
  }
  return ids;
}

// A criteria leaf on a lookup display path (Call_Owner.Email) is not a
// base-table column: the lookup stores the parent ROWID. The leaf runs as a
// parent query and rewrites onto the lookup column — Call_Owner IN (ids) for
// the positive ops, NOT (Call_Owner IN (ids)) for !=. A leaf on a parent
// composite part (Owner.Name.first_name) reads its stored column through
// parentParts. A path the maps do not know, or a parent read that is refused,
// fails closed to neverRows.
async function resolveLookupCriteria(datastore, criteria, principal) {
  if (!criteria || typeof criteria !== "object") return criteria;
  if (criteria.op === "and" || criteria.op === "or") {
    const args = [];
    for (const arg of criteria.args) args.push(await resolveLookupCriteria(datastore, arg, principal));
    return { ...criteria, args };
  }
  if (criteria.op === "not") return { ...criteria, arg: await resolveLookupCriteria(datastore, criteria.arg, principal) };
  const field = typeof criteria.field === "string" ? criteria.field : "";
  const dot = field.indexOf(".");
  if (dot <= 0 || dot === field.length - 1) return criteria;
  const head = field.slice(0, dot);
  let rest = field.slice(dot + 1);
  const parent = Object.prototype.hasOwnProperty.call(lookupParents, head) ? lookupParents[head] : "";
  if (!parent) return neverRows();
  if (rest.indexOf(".") >= 0) {
    const parts = Object.prototype.hasOwnProperty.call(parentParts, parent) ? parentParts[parent] : {};
    rest = Object.prototype.hasOwnProperty.call(parts, rest) ? parts[rest] : "";
    if (!rest) return neverRows();
  }
  if (criteria.op === "!=") {
    const excluded = await lookupParentIds(datastore, parent, rest, { op: "==", field: rest, value: criteria.value }, principal);
    if (excluded === null) return neverRows();
    return excluded.length ? { op: "not", arg: { op: "in", field: head, value: excluded } } : alwaysRows();
  }
  if (!LOOKUP_POSITIVE_OPS.has(criteria.op)) return neverRows();
  const ids = await lookupParentIds(datastore, parent, rest, { op: criteria.op, field: rest, value: criteria.value }, principal);
  if (ids === null) return neverRows();
  return ids.length ? { op: "in", field: head, value: ids } : neverRows();
}

// ZCQL has no boolean literal predicate: "WHERE true" is a syntax error. An always-true read sends no WHERE clause.
function zcqlPredicate(where) {
  const text = typeof where === "string" ? where.trim() : "";
  return text === "true" ? "" : text;
}

function whereClause(where) {
  return where ? " WHERE " + where : "";
}

function pageOf(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function pageSizeOf(value) {
  const cap = ${LIMITS.zcqlRowsPerQuery};
  return Number.isInteger(value) && value >= 1 && value <= cap ? value : cap;
}

${orderBy}

export default async function handler(req, res) {
  if (isHidden(reportName) || isHidden(formName)) {
    send(res, 403, { dryRun: true, error: "hidden form" });
    return;
  }
${requirePrincipal()}
  try {
    const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const deploy = deployConfig();
    if (deploy.mode === "live" && body.op === "query") {
      const datastore = await liveDatastore();
      if (!datastore || typeof datastore.query !== "function") {
        send(res, 500, { dryRun: false, wrote: false, error: "live datastore is not configured" });
        return;
      }
      const page = pageOf(body.page);
      const pageSize = pageSizeOf(body.pageSize);
      const criteria = combineCriteria(baseCriteria, [searchCriteria(body.q, columnFields), filterCriteria(body.filter)]);
      const scoped = authorizeRead(access, principal, formName, criteria);
      if (criteriaHasTodo(scoped.criteria)) {
        send(res, 200, {
          dryRun: false,
          rows: [],
          fields: scoped.fields ?? null,
          notice: "filter not migrated",
          criteria: scoped.criteria,
          page,
          pageSize,
        });
        return;
      }
${liveBind}      ${liveQuery}${attachRows}
${stageLoad('      ')}      ${rowWord} = (Array.isArray(queried) ? queried : []).map((row) => {
        ${stageApply ? 'let' : 'const'} projected = projectFields(row && typeof row === "object" ? row : {}, scoped.fields);${stageApply ? `\n        ${stageApply}` : ''}
        if (${JSON.stringify(columns.includes('ID'))} && projected.ID === undefined && row && typeof row === "object") projected.ID = row.ROWID ?? row.rowid;
        return projected;
      });
${wantsRelative ? '      if (relative) rows = rows.filter((row) => matchRow(row, resolved, decimalColumns));\n' : ''}      await resolveLookupDisplays(datastore, rows, lookupColumns, principal);
      const queryShape = sqlIdent
        ? \`SELECT \${projection.join(", ")} FROM \${sqlIdent}\${whereClause(where)} \${orderBy} LIMIT \${offset + 1}, \${pageSize}\`
        : "not emitted: the form name is not a bare ZCQL identifier";
      send(res, 200, {
        dryRun: false,
        rows,
        fields: scoped.fields ?? null,
        queryShape,
        criteria: ${criteriaRef},
        page,
        pageSize,
      });
      return;
    }
    const scoped = authorizeRead(access, principal, formName, baseCriteria);
    if (criteriaHasTodo(scoped.criteria)) {
      send(res, 200, {
        dryRun: true,
        rows: [],
        fields: scoped.fields ?? null,
        notice: "filter not migrated",
        criteria: scoped.criteria,
        pageSize: ${LIMITS.zcqlRowsPerQuery},
      });
      return;
    }
${dryBind}    const where = zcqlPredicate(compileCriteria(${criteriaRef}${exact ? ', undefined, decimalColumns' : ''}));
    const queryShape = sqlIdent
      ? \`SELECT \${projection.join(", ")} FROM \${sqlIdent}\${whereClause(where)} ORDER BY ROWID LIMIT 1, ${LIMITS.zcqlRowsPerQuery}\`
      : "not emitted: the form name is not a bare ZCQL identifier";
${stageLoad('    ')}    ${rowWord} = suppliedRows(req).map((row) => {
      ${stageApply ? 'let' : 'const'} projected = projectFields(row && typeof row === "object" ? row : {}, scoped.fields);${stageApply ? `\n      ${stageApply}` : ''}
      if (${JSON.stringify(columns.includes('ID'))} && projected.ID === undefined && row && typeof row === "object") projected.ID = row.ROWID ?? row.rowid;
      return projected;
    });
${wantsRelative ? '    if (relative) rows = rows.filter((row) => matchRow(row, applied, decimalColumns));\n' : ''}    send(res, 200, {
      dryRun: true,
      rows,
      fields: scoped.fields ?? null,
      queryShape,
      criteria: ${criteriaRef},
      pageSize: ${LIMITS.zcqlRowsPerQuery},
    });
  } catch (err) {
    // An unmigrated criteria also lands in the profile record filter, where
    // authorizeRead refuses it; that is the same "filter not migrated" gap.
    // The "for <form>" wording marks the todo rejection; bind-resolution
    // failures say "record filter could not be applied" and stay errors.
    if (err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError") && /record filter for .+ could not be applied/.test(String(err.message || ""))) {
      send(res, 200, { dryRun: true, rows: [], notice: "filter not migrated" });
      return;
    }
    fail(res, err);
  }
}
`;
  let queries: string[] | null;
  try {
    queries = stagedReportQueries(app, report);
  } catch (err) {
    if (!(err instanceof ZcqlLimitError)) throw err;
    return refuseOverLimit(source, err);
  }
  return queries ? stageReportSource(source, queries) : source;
}

function actionStub(path: string, name: string, form: string | undefined, workflow?: string): string {
  return `${banner([
    `Custom action ${name}. Dry run: the workflow is not executed.`,
    workflow ? `Workflow: ${workflow}.` : 'No workflow name on the action.',
    'The caller must be allowed to read the report form. Policy: functions/access-policy.json.',
  ])}${policyPrelude('../access-policy.json')}
export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(path)}, dryRun: true };
export const formName = ${JSON.stringify(form ?? '')};

export default async function handler(req, res) {
  if (isHidden(formName)) {
    send(res, 403, { dryRun: true, error: "hidden form" });
    return;
  }
${requirePrincipal()}
  try {
    if (formName) authorizeRead(access, principal, formName, { op: "true" });
    send(res, 200, { dryRun: true, action: ${JSON.stringify(name)} });
  } catch (err) {
    fail(res, err);
  }
}
`;
}

function fieldNamesOf(fields: UiModel['forms'][number]['fields']): { names: string[]; readonlyNames: string[]; fields: WriteField[] } {
  const names: string[] = [];
  const readonlyNames: string[] = [];
  const walk = (list: UiModel['forms'][number]['fields']) => {
    for (const field of list) {
      names.push(field.name);
      if (field.readonly) readonlyNames.push(field.name);
      if (field.subfields?.length) walk(field.subfields);
    }
  };
  walk(fields);
  return { names, readonlyNames, fields: fields.map(writeFieldOf) };
}

/**
 * Storage family for blank-to-null. Mirrors the deluge writeScalar
 * mapping, keyed by Slate widget instead of matrix id.
 */
function scalarOf(widget: UiModel['forms'][number]['fields'][number]['widget']): WriteField['scalar'] {
  switch (widget) {
    case 'number':
      return 'number';
    case 'decimal':
    case 'percent':
    case 'currency':
      return 'decimal';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'time':
      return 'time';
    default:
      return undefined;
  }
}

/**
 * Static Creator initial value from the already-unquoted Slate prefill text
 *. Anything shaped like a dynamic expression (a call, or a dotted
 * path such as zoho.currentdate or input.X) is left unset so the submit
 * handler never stores expression source as a cell.
 */
function staticDisplayDefault(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  if (/[()]/.test(text)) return undefined;
  if (/[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_]/.test(text)) return undefined;
  return text;
}

function writeFieldOf(field: UiModel['forms'][number]['fields'][number]): WriteField {
  const node: WriteField = { name: field.name, ...(field.readonly ? { readOnly: true } : {}) };
  if (field.widget === 'lookup' || field.widget === 'lookup-multi') {
    node.kind = 'lookup';
  } else if (field.widget === 'file' || field.widget === 'image' || field.widget === 'audio' || field.widget === 'video' || field.widget === 'signature') {
    node.kind = 'file';
  } else if (field.widget === 'subform') {
    node.kind = 'subform';
    node.fields = (field.subfields ?? []).map(writeFieldOf);
  } else if (field.widget === 'name' || field.widget === 'address') {
    node.kind = 'composite';
    node.fields = (field.subfields ?? []).map(writeFieldOf);
  } else {
    const scalar = scalarOf(field.widget);
    if (scalar) node.scalar = scalar;
    const initial = staticDisplayDefault(field.initialValue);
    if (initial !== undefined) node.defaultValue = initial;
  }
  return node;
}

function submitStub(app: App, form: UiModel['forms'][number], path: string, delugeFiles: GeneratedFile[], schema?: SchemaPlan, deferSuccess = false): string {
  const fields = fieldNamesOf(form.fields);
  const ruleDenied = fieldRuleDenials(app, form.name);
  const zone = appTimeZone(app);
  const validate = siblingSpecs(delugeFiles, form.name, 'validate');
  const success = siblingSpecs(delugeFiles, form.name, 'success');
  // State machines (approvals, blueprints) that govern this form: begin() stamps
  // the start stage before the row write, commit() logs the history row after.
  // Emitted only for governed forms, so a machine-free form's stub is unchanged.
  const flowModules = flowSpecs(app)
    .filter((spec) => spec.form === form.name)
    .map((spec) => `../../flow/${spec.slug}.mjs`);
  const flowLine = flowModules.length ? `\nconst flowModules = ${JSON.stringify(flowModules)};` : '';
  // Blueprint stage field settings: an edit of a field the stored record's
  // stage does not let a caller change answers 400 naming it, before any write.
  const stage = stageFieldModules(app, form.name);
  const stageLine = stage.modules.length ? `\nconst stageModules = ${JSON.stringify(stage.modules)};` : '';
  const stageCheck = stage.modules.length
    ? `    if (ctx.rowId) {
      const where = compileCriteria({ op: "==", field: "ROWID", value: ctx.rowId });
      const storedRows = await datastore.query(formName, where === "true" ? "" : where, 1, 0, "ORDER BY ROWID");
      const stored = Array.isArray(storedRows) && storedRows[0] && typeof storedRows[0] === "object" ? storedRows[0] : null;
      for (const spec of stored ? stageModules : []) {
        const mod = await import(spec);
        if (!mod || typeof mod.stageUpdateError !== "function") throw new Error("stage field module missing");
        const refused = mod.stageUpdateError(stored, submitted);
        if (refused) {
          send(res, 400, { dryRun: false, wrote: false, error: refused.error, field: refused.field });
          return;
        }
      }
    }
`
    : '';
  const flowBegin = flowModules.length
    ? `    for (const spec of flowModules) {
      const mod = await import(spec);
      if (mod && typeof mod.begin === "function") await mod.begin(ctx);
    }
`
    : '';
  const flowCommit = flowModules.length
    ? `    for (const spec of flowModules) {
      const mod = await import(spec);
      if (mod && typeof mod.commit === "function") await mod.commit(ctx);
    }
`
    : '';
  const zoneLine = zone ? `\n      settingsTimeZone: ${JSON.stringify(zone)},` : '';
  const storeShape = fieldStoreShape(app, form.name);
  const decimalMap = decimalColumnsOf(app);
  const decimalLine = Object.keys(decimalMap).length ? `\n      decimalColumns: ${JSON.stringify(decimalMap)},` : '';
  const uniqueMap = appUniqueColumnsOf(app, schema);
  const uniqueLine = Object.keys(uniqueMap).length ? `\n      appUniqueColumns: ${JSON.stringify(uniqueMap)},` : '';
  // A cancel submit in on validate refuses the write with 422 and the alert
  // text. The validate set follows the record event: `on add` and unscoped
  // when inserting, `on edit` and unscoped when the request's ROWID marks an
  // update.
  const validateRun = validate.add.length + validate.edit.length
    ? `    try {
      for (const spec of eventSpecs(validateAdd, validateEdit, ctx.rowId)) {
        const mod = await import(spec);
        if (mod && typeof mod.handle === "function") await mod.handle(ctx);
      }
    } catch (err) {
      if (err && err.code === "SUBMIT_REFUSED") {
        send(res, 422, { dryRun: false, wrote: false, refused: true, error: err.message });
        return;
      }
      throw err;
    }
`
    : `    for (const spec of eventSpecs(validateAdd, validateEdit, ctx.rowId)) {
      const mod = await import(spec);
      if (mod && typeof mod.handle === "function") await mod.handle(ctx);
    }
`;
  return `${banner([
    `Submit ${form.name}. Dry run: the record is not inserted.`,
    'authorizeWrite checks that the form is viewable and editable.',
    'A key that is not a writable field at that depth is rejected, not dropped.',
    'Hidden and read-only fields are rejected. A successful dry run returns the checked values and does not write.',
    'Add needs the Create grant and edit (body.ROWID names a row) needs the Edit grant. An edit finds the row under the caller\'s modify scope: without Modify All only a row the caller added can be edited.',
    'A live reply carries only the fields the caller may read, plus the row id and system columns.',
    'Policy file: functions/access-policy.json. This module embeds it as access.',
    'When functions/c2c-deploy.json mode is "live" and a datastore is injected, accepted values are written after validate and before on-success scripts. Dry run does not write and does not run those scripts. On success sees the inserted row, including ID (the stored ROWID) and system fields. If an on-success script throws after the write, the row stays: a Deluge runtime or refused-connection error reports its text; any other failure replies 500 request failed.',
    'Creator runs On Success after the record is submitted (https://help.zoho.com/portal/en/kb/creator/developer-guide/workflows/create-and-manage-on-success-action/articles/understand-on-success-action): "The actions that you define in the On success event will be executed when a new record is successfully submitted to the database or when an existing record is updated or deleted from the database." Whether Creator rolls that row back when On Success throws is unverified; this port leaves the row.',
    ...(deferSuccess
      ? ['Async on-success opt-in: in live mode this endpoint validates and stores the row, then replies without running the on-success modules. The after-commit event function (functions/events/after-commit.mjs) runs them when the record trigger fires; a failure dead-letters to C2CEventDeadLetter for the sweep Job (docs/event-deadletter.md).']
      : []),
  ])}${policyPrelude('../../access-policy.json', false, `import { ${[...new Set(['applyInitialValues', 'createRuntime', 'projectReadable', 'replyStoreError', ...fieldStoreImports(storeShape)])].sort().join(', ')} } from "creator-to-catalyst/shims";\n`)}
export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(path)}, dryRun: true };
export const formName = ${JSON.stringify(form.name)};
export const fieldNames = ${JSON.stringify(fields.names)};
export const readonlyFields = ${JSON.stringify(fields.readonlyNames)};
export const fields = ${JSON.stringify(fields.fields)};${ruleDenied.length ? `\nexport const fieldRuleDenied = ${JSON.stringify(ruleDenied)};` : ''}
const validateAdd = ${JSON.stringify(validate.add)};
const validateEdit = ${JSON.stringify(validate.edit)};
const successAdd = ${JSON.stringify(success.add)};
const successEdit = ${JSON.stringify(success.edit)};
function eventSpecs(addSpecs, editSpecs, rowId) {
  return rowId ? editSpecs : addSpecs;
}${flowLine}${stageLine}

${deployHelpers('../../c2c-deploy.json', '../../c2c-store.mjs')}
function requestRowId(req) {
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  if (!body) return "";
  const id = body.ROWID != null ? body.ROWID : body.rowid;
  if (id == null || typeof id === "object") return "";
  return String(id).trim();
}

function insertedRow(result) {
  if (Array.isArray(result)) {
    const row = result[0];
    return row && typeof row === "object" ? row : null;
  }
  if (!result || typeof result !== "object") return null;
  if (Array.isArray(result.rows) && result.rows[0] && typeof result.rows[0] === "object") return result.rows[0];
  if (Array.isArray(result.data) && result.data[0] && typeof result.data[0] === "object") return result.data[0];
  if (result.ROWID != null || result.ID != null || result.id != null) return result;
  return null;
}

function mergeInserted(record, result) {
  const row = insertedRow(result);
  if (!row) return;
  const raw = row.ROWID != null && row.ROWID !== "" ? row.ROWID : row.ID != null && row.ID !== "" ? row.ID : row.id;
  if (raw != null && raw !== "") {
    const id = String(raw);
    record.ID = id;
    record.ROWID = id;
  }
  const system = ["Added_User", "Added_Time", "Modified_User", "Modified_Time"];
  for (const key of system) {
    if (row[key] != null && row[key] !== "") record[key] = row[key];
  }
  const keys = Object.keys(row).sort();
  for (const key of keys) {
    if (key === "ROWID" || key === "ID" || key === "id") continue;
    if (!Object.prototype.hasOwnProperty.call(record, key)) record[key] = row[key];
  }
}

${writeLiveSource(form.name, storeShape)}

export default async function handler(req, res) {
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  if (isHidden(formName)) {
    send(res, 403, { dryRun: !live, error: "hidden form" });
    return;
  }
${requirePrincipal()}
  const record = req && req.body && req.body.record && typeof req.body.record === "object" && !Array.isArray(req.body.record) ? req.body.record : {};
  try {
    if (req && req.body && req.body.op === "view") {
      authorizeRead(access, principal, formName, { op: "true" });
      send(res, 200, { dryRun: !live, view: true });
      return;
    }
    const decision = authorizeWrite(access, principal, formName, record, { readonlyFields, fieldNames, fields${ruleDenied.length ? ', ruleDenied: fieldRuleDenied' : ''} }, requestRowId(req) ? "update" : "insert");
    const submitted = Object.keys(decision.values);
    if (!live) {
      send(res, 200, { dryRun: true, wrote: false, values: decision.values, transcript: [] });
      return;
    }
    const datastore = await liveDatastore();
    if (!datastore) {
      send(res, 500, { dryRun: false, wrote: false, error: "live datastore is not configured" });
      return;
    }
    const runtime = createRuntime({
      dryRun: false,
      appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined,${zoneLine}${decimalLine}${uniqueLine}
      ...(datastore ? { datastore, ...(datastore.now ? { now: datastore.now } : {}) } : {}),
      access,
      // writeLive -> datastore.update re-authorizes the screened values; the
      // schema lets a granted composite field carry its nested parts.
      writeSchemas: { [formName]: { readonlyFields, fieldNames, fields } },
    });
    const ctx = runtime.context({
      record: { ...decision.values },
      old: { __c2c: "dry-run-old", loaded: false },
      principal,
      appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined,
      rowId: requestRowId(req),
    });
${stageCheck}    // API and import inserts never saw the Slate prefill. Absent
    // fields fall back to their Creator initial values on insert only.
    if (!ctx.rowId && ctx.writeOp !== "update") applyInitialValues(ctx.record, fields);
${validateRun}${flowBegin}    await writeLive(runtime, ctx, formName${fieldStoreWriteArg(storeShape)});
${flowCommit}${deferSuccess
        ? `    // Async on-success opt-in: the on-success modules are not run here. The
    // record trigger fires the after-commit event function on the committed
    // row, which runs them once; a failure dead-letters for the sweep Job.
`
        : `    try {
      for (const spec of eventSpecs(successAdd, successEdit, ctx.rowId)) {
        const mod = await import(spec);
        if (mod && typeof mod.handle === "function") await mod.handle(ctx);
      }
    } catch (err) {
      // A store refusal from a post-write script call maps before the
      // generic fail. Catalyst's text never reaches the caller.
      if (replyStoreError(res, err, { live: true, table: formName, wrote: true })) return;
      const denied = err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError");
      // Caller-facing texts only: Creator's own Deluge messages and the named
      // live-refused policy denials. Adapter and JS internals stay server-side.
      const reportable = err && (err.code === "DELUGE_RUNTIME" || err.code === "DELUGE_CONVERSION" || err.code === "ZOHO_CONNECTION_REFUSED");
      const message = (denied || reportable) && err && err.message ? err.message : "request failed";
      send(res, denied ? 403 : 500, { dryRun: false, wrote: true, error: message, values: projectReadable(access, principal, formName, ctx.record, submitted) });
      return;
    }
`}    // Live replies never carry the runtime transcript: it holds record
    // values, table names and ops.
    send(res, 200, { dryRun: false, wrote: true, values: projectReadable(access, principal, formName, ctx.record, submitted) });
  } catch (err) {
    // The row write itself failed at the store (409/422/400 naming
    // the field, plus a structured log line); anything else stays a
    // sanitized 500 with dryRun of the real mode.
    if (replyStoreError(res, err, { live, table: formName, wrote: false })) return;
    fail(res, err, live);
  }
}
`;
}

export function appTimeZone(app: App): string {
  const raw = app.settings.find((item) => item.key.toLowerCase() === 'time zone')?.value;
  return raw ? unquote(raw).trim() : '';
}

/** The blueprint machines with stage field settings on `formName`, as stub-relative imports, and their status columns. */
function stageFieldModules(app: App, formName: string): { modules: string[]; columns: string[] } {
  const specs = blueprintFieldSpecs(app, formName);
  const columns: string[] = [];
  for (const item of specs) if (!columns.includes(item.spec.statusColumn)) columns.push(item.spec.statusColumn);
  return { modules: specs.map((item) => `../../flow/${item.slug}.mjs`), columns };
}

/**
 * Scoped single-row read for the edit flow's prefill. Dry run answers an
 * empty record carrying only the requested ROWID; live runs the caller-
 * scoped read and answers 404 when the row is outside the read policy.
 */
function recordStub(app: App, form: UiModel['forms'][number], path: string): string {
  const subformLinks = subformLinksFor(app, form.name);
  const shimImport = subformLinks.length ? 'import { attachSubforms } from "creator-to-catalyst/shims";\n' : '';
  const subformConst = subformLinks.length
    ? `/** Inline subforms of this form, each a child table. The edit record carries them as lists in row order. */\nexport const subformTables = ${JSON.stringify({ [form.name]: subformLinks })};\n`
    : '';
  const queryName = subformLinks.length ? 'queried' : 'rows';
  const attachRows = subformLinks.length ? 'if (Array.isArray(queried)) await attachSubforms(datastore, subformTables, formName, queried);\n    ' : '';
  const bannerLines = [
    `Record ${form.name}. Reads one row for the generated edit screen.`,
    'authorizeRead applies functions/access-policy.json: only a row the caller can read is returned,',
    'projected to the readable fields. Dry run echoes the ROWID and reads nothing.',
  ];
  if (subformLinks.length) bannerLines.push('Inline subform rows are attached in row order, the same way a report row carries them.');
  const stage = stageFieldModules(app, form.name);
  if (stage.modules.length) bannerLines.push('Blueprint field settings drop the fields the stored stage does not show; the reply names that stage under stages.');
  const stageConst = stage.modules.length ? `/** Blueprint machines whose stage field settings govern this form. */\nconst stageModules = ${JSON.stringify(stage.modules)};\n` : '';
  const stageApply = stage.modules.length
    ? `
    const stored = ${queryName}[0];
    let shown = row;
    for (const spec of stageModules) {
      const mod = await import(spec);
      if (!mod || typeof mod.visibleRecord !== "function") throw new Error("stage field module missing");
      shown = mod.visibleRecord(shown, stored);
    }
    send(res, 200, { dryRun: false, record: shown, stages: Object.fromEntries(${JSON.stringify(stage.columns)}.map((column) => [column, stored[column] ?? null])) });`
    : `
    send(res, 200, { dryRun: false, record: row });`;
  return `${banner(bannerLines)}${policyPrelude('../../access-policy.json', false, shimImport)}
export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(path)}, dryRun: true };
export const formName = ${JSON.stringify(form.name)};

${subformConst}${stageConst}${deployHelpers('../../c2c-deploy.json', '../../c2c-store.mjs')}

export default async function handler(req, res) {
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  if (isHidden(formName)) {
    send(res, 403, { dryRun: !live, error: "hidden form" });
    return;
  }
${requirePrincipal()}
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const raw = body.ROWID != null ? body.ROWID : body.rowid;
  const rowId = raw == null || typeof raw === "object" ? "" : String(raw).trim();
  if (!rowId) {
    send(res, 400, { dryRun: !live, error: "record needs body.ROWID" });
    return;
  }
  try {
    const scoped = authorizeRead(access, principal, formName, { op: "==", field: "ROWID", value: rowId });
    if (!live) {
      send(res, 200, { dryRun: true, record: { ROWID: rowId } });
      return;
    }
    const datastore = await liveDatastore();
    if (!datastore || typeof datastore.query !== "function") {
      send(res, 500, { dryRun: false, error: "live datastore is not configured" });
      return;
    }
    const where = compileCriteria(scoped.criteria);
    const ${queryName} = await datastore.query(formName, where === "true" ? "" : where, 1, 0, "ORDER BY ROWID");
    ${attachRows}const row = Array.isArray(${queryName}) && ${queryName}[0] && typeof ${queryName}[0] === "object" ? projectFields(${queryName}[0], scoped.fields) : null;
    if (!row) {
      send(res, 404, { dryRun: false, error: "no such row" });
      return;
    }${stageApply}
  } catch (err) {
    fail(res, err, live);
  }
}
`;
}

/**
 * Record delete. Dry run checks the grant and the ROWID, then reports
 * `deleted: false` without running scripts. Live loads the row under the
 * caller's read scope, runs the `on delete`-scoped validates (a `cancel
 * delete` refuses with 422), removes the row through the shim's authorized
 * delete, then runs the `on delete` script and delete-scoped success
 * modules.
 */
function deleteStub(app: App, form: UiModel['forms'][number], path: string, delugeFiles: GeneratedFile[], schema?: SchemaPlan): string {
  const validateDel = siblingSpecs(delugeFiles, form.name, 'validate').del;
  const successDel = siblingSpecs(delugeFiles, form.name, 'success').del;
  const scriptDel = siblingSpecs(delugeFiles, form.name, 'delete').del;
  const zone = appTimeZone(app);
  const zoneLine = zone ? `\n      settingsTimeZone: ${JSON.stringify(zone)},` : '';
  const decimalMap = decimalColumnsOf(app);
  const decimalLine = Object.keys(decimalMap).length ? `\n      decimalColumns: ${JSON.stringify(decimalMap)},` : '';
  const uniqueMap = appUniqueColumnsOf(app, schema);
  const uniqueLine = Object.keys(uniqueMap).length ? `\n      appUniqueColumns: ${JSON.stringify(uniqueMap)},` : '';
  const moduleRun = (list: string) =>
    `      for (const spec of ${list}) {
        const mod = await import(spec);
        if (mod && typeof mod.handle === "function") await mod.handle(ctx);
      }
`;
  return `${banner([
    `Delete ${form.name}. Dry run: the row is not removed.`,
    'authorizeDelete checks the profile delete grant — edit does not imply delete.',
    'Live order: caller-scoped row read under the modify scope (404 outside it; without',
    'Modify All only a row the caller added), on-delete-scoped validates,',
    'the shim delete, then the on-delete script and delete-scoped on-success modules.',
    'A `cancel delete` in a validate answers 422 refused; the row stays.',
  ])}${policyPrelude('../../access-policy.json', false, 'import { authorizeDelete, createRuntime, replyStoreError } from "creator-to-catalyst/shims";\n')}
export const endpoint = { type: "advancedio", method: "POST", path: ${JSON.stringify(path)}, dryRun: true };
export const formName = ${JSON.stringify(form.name)};
const validateDel = ${JSON.stringify(validateDel)};
const successDel = ${JSON.stringify(successDel)};
const scriptDel = ${JSON.stringify(scriptDel)};

${deployHelpers('../../c2c-deploy.json', '../../c2c-store.mjs')}

export default async function handler(req, res) {
  const deploy = deployConfig();
  const live = deploy.mode === "live";
  if (isHidden(formName)) {
    send(res, 403, { dryRun: !live, error: "hidden form" });
    return;
  }
${requirePrincipal()}
  const body = req && req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const raw = body.ROWID != null ? body.ROWID : body.rowid;
  const rowId = raw == null || typeof raw === "object" ? "" : String(raw).trim();
  if (!rowId) {
    send(res, 400, { dryRun: !live, error: "delete needs body.ROWID" });
    return;
  }
  try {
    authorizeDelete(access, principal, formName);
    if (!live) {
      send(res, 200, { dryRun: true, deleted: false });
      return;
    }
    const datastore = await liveDatastore();
    if (!datastore) {
      send(res, 500, { dryRun: false, deleted: false, error: "live datastore is not configured" });
      return;
    }
    const runtime = createRuntime({
      dryRun: false,
      appTimeZone: process.env.C2C_APP_TIMEZONE || deploy.appTimeZone || undefined,${zoneLine}${decimalLine}${uniqueLine}
      ...(datastore ? { datastore, ...(datastore.now ? { now: datastore.now } : {}) } : {}),
      access,
    });
    // The on-delete script's input object is the deleted row: read it under the
    // caller's policy before the delete so the script sees real values.
    // Modify scope: without Modify All only a row the caller added is found.
    const scoped = authorizeRead(access, principal, formName, { op: "==", field: "ROWID", value: rowId }, undefined, "modify");
    const where = compileCriteria(scoped.criteria);
    const rows = await datastore.query(formName, where === "true" ? "" : where, 1, 0, "ORDER BY ROWID");
    const row = Array.isArray(rows) && rows[0] && typeof rows[0] === "object" ? projectFields(rows[0], scoped.fields) : null;
    if (!row) {
      send(res, 404, { dryRun: false, deleted: false, error: "no such row" });
      return;
    }
    const ctx = runtime.context({ record: row, old: row, principal, rowId });
    try {
${moduleRun('validateDel')}    } catch (err) {
      if (err && err.code === "DELETE_REFUSED") {
        send(res, 422, { dryRun: false, deleted: false, refused: true, error: err.message });
        return;
      }
      throw err;
    }
    await ctx.shim.datastore.delete(ctx, formName, { op: "==", field: "ROWID", value: rowId });
    try {
${moduleRun('scriptDel')}${moduleRun('successDel')}    } catch (err) {
      if (replyStoreError(res, err, { live: true, table: formName, wrote: true })) return;
      const denied = err && (err.code === "RECORD_ACCESS_DENIED" || err.name === "RecordAccessError");
      const reportable = err && (err.code === "DELUGE_RUNTIME" || err.code === "DELUGE_CONVERSION" || err.code === "ZOHO_CONNECTION_REFUSED");
      const message = (denied || reportable) && err && err.message ? err.message : "request failed";
      send(res, denied ? 403 : 500, { dryRun: false, deleted: true, error: message });
      return;
    }
    send(res, 200, { dryRun: false, deleted: true });
  } catch (err) {
    if (replyStoreError(res, err, { live, table: formName, wrote: false })) return;
    fail(res, err, live);
  }
}
`;
}


function deployConfigSource(app: App, dc?: string): string {
  const links = analyzeConnections(app).entries.map((e) => e.configKey);
  // zohoDc and connections only for apps that call another Zoho service; null until set by the user.
  const extra = links.length ? { zohoDc: null, connections: Object.fromEntries(links.map((l) => [l, null])) } : {};
  // dc is the registry's Catalyst DC — c2c-auth-apply.mjs derives its host from it.
  return `${JSON.stringify({ mode: 'dry-run', dc: dc ?? null, appTimeZone: appTimeZone(app), ...extra }, null, 2)}\n`;
}

function connectionsModule(): string {
  return `${banner([
    'Catalyst Connections credentials for zoho.<svc>.<task> and invokeurl connection: calls.',
    'Handlers import this only when functions/c2c-deploy.json mode is "live".',
    'Default: app.connections().getConnectionCredentials(name), Catalyst Node SDK v3.2.0+.',
    'https://docs.catalyst.zoho.com/en/cloud-scale/help/connections/',
    'setConnectionCredentials installs a stand-in (tests). Nothing here logs a token.',
  ])}let installed = null;

export function setConnectionCredentials(next) {
  installed = typeof next === "function" ? next : null;
  return installed;
}

export function connectionCredentials(req) {
  if (installed) return installed;
  return async (name) => {
    const sdk = await import("zcatalyst-sdk-node");
    const catalyst = sdk.default || sdk;
    return catalyst.initialize(req).connections().getConnectionCredentials(name);
  };
}
`;
}

function storeModule(): string {
  return `${banner([
    'In-process datastore slot.',
    'Handlers import this only when functions/c2c-deploy.json mode is "live".',
    'Nothing here opens a network connection. setDatastore installs the adapter.',
    'runWithDatastore scopes an adapter to one request, so concurrent requests never share it.',
  ])}import { AsyncLocalStorage } from "node:async_hooks";

let installed = null;
const scoped = new AsyncLocalStorage();

export function setDatastore(next) {
  installed = next || null;
  return installed;
}

export function runWithDatastore(datastore, fn) {
  return scoped.run(datastore || null, fn);
}

export function getDatastore() {
  const current = scoped.getStore();
  return current || installed;
}
`;
}

/** C2C_DEPLOY_MODE (live or dry-run) overrides functions/c2c-deploy.json. Any other value is ignored. */
export const MODE_OVERRIDE_SOURCE = `function modeOverride() {
  const value = typeof process !== "undefined" && process.env ? process.env.C2C_DEPLOY_MODE : undefined;
  return value === "live" || value === "dry-run" ? value : "";
}
`;

function deployHelpers(configSpec: string, storeSpec: string): string {
  return `${MODE_OVERRIDE_SOURCE}
function deployConfig() {
  try {
    const file = join(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(configSpec)});
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const mode = modeOverride() || (parsed && parsed.mode === "live" ? "live" : "dry-run");
    const appTimeZone = parsed && typeof parsed.appTimeZone === "string" ? parsed.appTimeZone : "";
    return { mode, appTimeZone };
  } catch (err) {
    return { mode: modeOverride() || "dry-run", appTimeZone: "" };
  }
}

async function liveDatastore() {
  try {
    const mod = await import(${JSON.stringify(storeSpec)});
    if (mod && typeof mod.getDatastore === "function") {
      const stored = mod.getDatastore();
      if (stored) return stored;
    }
  } catch (err) {
    /* store module is absent when this file is loaded alone */
  }
  try {
    if (globalThis.__c2cDatastore) return globalThis.__c2cDatastore;
  } catch (err) {
    /* no injected global */
  }
  return null;
}
`;
}

/**
 * AIO sibling modules for a form, split by the record event scope they run
 * under. `on add`/`on edit`/`on delete` scripts run only in that write's
 * context; unscoped and `on add or edit` run in every context of their kind.
 */
export function siblingSpecs(files: GeneratedFile[], formName: string, kind: 'validate' | 'success' | 'delete'): { add: string[]; edit: string[]; del: string[] } {
  const prefix = `functions/aio/${slug(formName)}/`;
  const add: string[] = [];
  const edit: string[] = [];
  const del: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith(prefix) || !file.path.endsWith('.mjs')) continue;
    const base = file.path.slice(prefix.length);
    if (base.includes('/')) continue;
    const match = /path:\s*"([^"]+)"/.exec(file.source);
    // on-delete script modules declare `.../delete-script`; `/delete` itself
    // is the stub's endpoint.
    if (!match?.[1].endsWith(`/${kind === 'delete' ? 'delete-script' : kind}`)) continue;
    const rec = /export const recordEvent = (null|"[^"]*");/.exec(file.source);
    const scope = rec?.[1] && rec[1] !== 'null' ? JSON.parse(rec[1]).toLowerCase() : '';
    const spec = `./${base}`;
    if (scope === 'on add') add.push(spec);
    else if (scope === 'on edit') edit.push(spec);
    else if (scope === 'on delete') del.push(spec);
    else {
      // Unscoped and `on add or edit` modules run on insert and update. For
      // `kind === 'delete'` the module is the on-delete script itself, which
      // runs after every delete; for validate/success the delete path only
      // runs `on delete`-scoped siblings.
      add.push(spec);
      edit.push(spec);
      if (kind === 'delete') del.push(spec);
    }
  }
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return { add: [...new Set(add)].sort(byName), edit: [...new Set(edit)].sort(byName), del: [...new Set(del)].sort(byName) };
}

function indexHtml(model: UiModel): string {
  const title = model.name || 'App';
  const theme = model.theme || {};
  const palette = paletteFor(theme.theme);
  const attrs =
    (theme.theme ? ` data-theme="${escapeText(theme.theme)}"` : '') +
    ` data-menu="${theme.menu === 'rail' ? 'rail' : 'list'}"` +
    (theme.font ? ` data-font="${escapeText(theme.font)}"` : '') +
    (theme.iconColor ? ` data-icon-color="${escapeText(theme.iconColor)}"` : '');
  return `<!doctype html>
<html lang="en"${attrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(title)}</title>
<link rel="manifest" href="@@asset:slate/manifest.webmanifest@@">
<link rel="stylesheet" href="@@asset:slate/assets/app.css@@">
<script src="@@asset:slate/pwa-register.js@@" defer></script>
<meta name="theme-color" content="${palette.accent}">
<!-- Slate sends cache-control: public, max-age=31536000 on every asset, including this
     file, and does not support per-file cache configuration. Meta cache directives are
     not honoured for document caching, so this page carries none. Freshness comes from
     sw.js: it precaches this file with cache:"reload" and answers navigations
     network-first, so a controlled page never gets a stale shell. -->
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <button id="menu-toggle" type="button" aria-expanded="true" aria-controls="nav">Menu</button>
  <strong id="app-title"></strong>
  <button id="install" hidden type="button">Install app</button>
</header>
<div class="shell">
<nav id="nav" aria-label="Sections"></nav>
<div id="c2c-login" hidden></div>
<main id="main" tabindex="-1"></main>
</div>
<nav id="tabbar" aria-label="Primary"></nav>
<div id="more-sheet" hidden role="dialog" aria-modal="true" aria-label="More"></div>
<div id="toasts" aria-live="polite"></div>
<p id="offline" hidden>Offline: data unavailable. Reports and forms load again when the network is back.</p>
<!-- c2c-config.js keeps a stable URL. c2c deploy rewrites it with the function base URL and the Catalyst Web SDK. -->
<script src="./c2c-config.js"></script>
<script type="module" src="@@asset:slate/assets/runtime.js@@"></script>
</body>
</html>
`;
}

/** Default function name and base path for the generated Advanced I/O function. */
export const API_FUNCTION = 'c2c_api';
export const DEFAULT_API_BASE = `/server/${API_FUNCTION}`;
/** Catalyst Web SDK that provides catalyst.auth.generateAuthToken (v4.6.1+). */
export const CATALYST_WEB_SDK = 'https://static.zohocdn.com/catalyst/sdk/js/4.6.1/catalystWebSDK.js';

/**
 * slate/c2c-config.js. A classic script with a stable URL, loaded before the runtime.
 * apiBase: the function base. On Slate it must be absolute (Slate and the function
 * are on different domains). auth: load the Catalyst Web SDK and /__catalyst/sdk/init.js.
 * appTimeZone: the Creator app `time zone` setting, so a client `zoho.currentdate`
 * is the app-zone day, not the browser's. Absent when the app sets none.
 */
export function slateConfigSource(opts: { apiBase?: string; auth?: boolean; appTimeZone?: string; smokePlan?: readonly unknown[]; smokeProject?: string }): string {
  const lines = [
    '// c2c runtime config. Stable URL (not content-hashed). c2c deploy rewrites this file.',
    `globalThis.C2C_API_BASE = ${JSON.stringify(opts.apiBase ?? DEFAULT_API_BASE)};`,
  ];
  if (opts.appTimeZone) lines.push(`globalThis.C2C_APP_TIMEZONE = ${JSON.stringify(opts.appTimeZone)};`);
  // The smoke plan the hidden #/admin/smoke page runs: form/field/route names
  // and canned fill values only — no credentials, no record data. `</` is
  // escaped so the JSON cannot close the inline script element.
  if (opts.smokePlan) lines.push(`globalThis.C2C_SMOKE_PLAN = ${JSON.stringify(opts.smokePlan).replace(/</g, '\\u003c')};`);
  // The project the deploy targeted — the page stamps it into its result block
  // so `c2c smoke --result` can refuse a block from another project. An id, not a secret.
  if (opts.smokePlan && opts.smokeProject && /^[0-9]{1,24}$/.test(opts.smokeProject)) {
    lines.push(`globalThis.C2C_SMOKE_PROJECT = ${JSON.stringify(opts.smokeProject)};`);
  }
  if (opts.auth) {
    lines.push(
      `document.write(${JSON.stringify(`<script src="${CATALYST_WEB_SDK}"></scr`)} + "ipt>");`,
      `document.write(${JSON.stringify('<script src="/__catalyst/sdk/init.js"></scr')} + "ipt>");`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function css(): string {
  return BASE_CSS;
}
