/**
 * The hidden #/admin/smoke runner. Same contract as the vanilla client's
 * runSmokePlan (packages/ui/src/client-runtime.js): the plan a deploy embeds
 * as globalThis.C2C_SMOKE_PLAN is run through the same guarded endpoints the
 * forms and reports use. The page speaks in statuses and counts — never
 * tokens or record values — and cleanup deletes only rows that carry this
 * run's marker (the server re-checks the tag before deleting).
 */
import { apiCall, LOOPBACK_HOSTS, type ApiResponse, type AppWindow } from '../runtime/api';

/** The embedded plan steps, as smoke.ts's planSmoke writes them into c2c-config.js. */
export interface SmokeFieldPlan {
  name: string;
  source?: string;
  value?: unknown;
  skipped?: boolean;
  /** The form of a created-or-listed parent row for a lookup. */
  lookupForm?: string;
  lookupTable?: string;
  /** The generated lookup endpoint — the runner's fallback for a parent row. */
  lookupEndpoint?: string;
  multi?: boolean;
  children?: SmokeFieldPlan[];
  /** Resolved at run time from the upload step's stored reference. */
  fileRef?: boolean;
}

export interface SmokeStep {
  kind: 'session' | 'submit' | 'read-back' | 'update' | 'upload' | 'report' | 'cleanup' | 'skip' | string;
  label?: string;
  method?: string;
  path?: string;
  form?: string;
  table?: string;
  record?: SmokeFieldPlan[];
  reason?: string;
  update?: { field?: string; value?: unknown };
  marker?: { field?: string };
  upload?: { field?: string };
  expect?: { field: string; value?: unknown; submitted?: 'record' | 'update' };
  children?: { field: string }[];
  lookups?: { field: string; endpoint: string }[];
  files?: { field: string; filesPath: string }[];
}

/** What the runner needs of the app model: a name for the seal and reports for child checks. */
export interface SmokeModel {
  name?: string;
  reports?: readonly { form?: string; queryEndpoint?: string }[];
}

/** The generated AppSpec as the runner sees it: name plus the reports a read-back's child check queries. */
export function smokeModel(spec: { name?: string; reports?: Record<string, { form?: string; queryEndpoint?: string }> }): SmokeModel {
  // determinism-allow: the spec's reports map is written in app order, so its values are source order
  return { name: spec.name, reports: Object.values(spec.reports ?? {}) };
}

export interface SmokeLine {
  label: string;
  ok: boolean;
  detail: string;
}

export interface SmokeRun {
  ok: boolean;
  lines: string[];
  json: unknown;
  /** The copy-safe result code packing json (empty without WebCrypto). */
  code: string;
}

type FetchCall = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<ApiResponse>;

/** A bigint (a toLong id) is written as its digit string. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Wrap every integer literal outside a string that is not a safe integer in
 * quotes, so JSON.parse keeps a 19-digit Creator id or a 17-digit ROWID exact.
 * Same algorithm as packages/ui/src/client-runtime.js quoteUnsafeIntegers.
 */
function quoteUnsafeIntegers(text: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = i;
      i += 1;
      while (i < text.length && /[0-9.eE+-]/.test(text[i]!)) i += 1;
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

/** Response body as JSON, ids past 2^53 kept as digit strings; {} on any failure. */
export async function readJson(res: ApiResponse | undefined | null): Promise<Record<string, unknown>> {
  if (!res || typeof res.text !== 'function') return {};
  try {
    return (await JSON.parse(quoteUnsafeIntegers(await res.text()))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Lowercase hex SHA-256 of the file's bytes, or '' when the browser cannot hash it. */
async function sha256Hex(file: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';
  const digest = new Uint8Array(await subtle.digest('SHA-256', await file.arrayBuffer()));
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Lookup options for a select: `{ rows, field }` keyed by ROWID, text under `field`. */
async function loadLookupOptions(view: AppWindow, endpoint: string | undefined): Promise<{ value: string; label: string }[]> {
  const call = view.fetch ?? globalThis.fetch;
  if (!endpoint || typeof call !== 'function') throw new Error('lookup endpoint missing');
  const separator = endpoint.includes('?') ? '&' : '?';
  const res = await apiCall(view, `${endpoint}${separator}page=0&pageSize=300`, { method: 'GET', headers: { 'content-type': 'application/json' } });
  if (!res || res.ok === false) throw new Error(`lookup request failed (${res ? res.status : 'no response'})`);
  const body = await readJson(res);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const field = typeof body.field === 'string' ? body.field : '';
  const options: { value: string; label: string }[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    if (record.ROWID == null || record.ROWID === '') continue;
    const label = field && record[field] != null ? String(record[field]) : '';
    options.push({ value: String(record.ROWID), label });
  }
  return options;
}

function smokeTag(): string {
  // determinism-allow: runtime-only run tag, like browserShim's formNonce — never evaluated while generating.
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4).toString(36)}`;
}

/** One row by ROWID through the lookup endpoint — <field> is read as the display column. */
async function smokeReadRow(api: FetchCall, step: SmokeStep, field: string | undefined, rowId: string): Promise<Record<string, unknown> | null> {
  const endpoint = `/lookups/${encodeURIComponent(step.form ?? '')}/${encodeURIComponent(field || 'ROWID')}`;
  const res = await api(`${endpoint}?page=0&pageSize=300`, { method: 'GET', headers: { 'content-type': 'application/json' } });
  if (!res || res.ok === false) return null;
  const body = await readJson(res);
  const rows = Array.isArray(body.rows) ? body.rows : [];
  return (rows.find((row) => row && typeof row === 'object' && String((row as Record<string, unknown>).ROWID) === String(rowId)) as Record<string, unknown> | undefined) ?? null;
}

/**
 * Run one embedded smoke plan. Returns { ok, lines, json } where json is the
 * machine-readable block the page prints and `c2c smoke --in-browser` reads
 * back: version, counts, and per-step labels — never tokens or record values.
 */
export async function runSmokePlan(model: SmokeModel, plan: readonly SmokeStep[], view: AppWindow): Promise<SmokeRun> {
  const call = (view.fetch ?? globalThis.fetch?.bind(globalThis)) as FetchCall;
  const api: FetchCall = (endpoint, init) => {
    // A plan endpoint is always app-relative — an absolute URL would carry
    // the session's auth token to another origin.
    if (typeof endpoint !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(endpoint)) return Promise.resolve({ ok: false, status: 0, text: async () => '' });
    return apiCall(view, endpoint, init ?? {});
  };
  const tag = smokeTag();
  const lines: string[] = [];
  const rows: SmokeLine[] = [];
  const created = new Map<string, string>();
  const verified = new Set<string>();
  const submitted = new Map<string, Record<string, unknown>>();
  const updateSent = new Map<string, { field: string; value: unknown }>();
  const uploaded = new Map<string, string>();
  // Steps that made a real call — a run that exercised nothing is a failure,
  // never a pass.
  let exercised = 0;
  let uploadedUrl = '';
  let deleted = 0;
  let failed = false;
  const push = (label: unknown, detail: unknown, ok?: boolean) => {
    const entry = { label: String(label || ''), ok: ok !== false, detail: String(detail || '') };
    rows.push(entry);
    lines.push(entry.detail ? `${entry.label}: ${entry.detail}` : entry.label);
  };
  // Same fill rules as recordFor() in the vanilla runner: canned scalars, the
  // run tag for text, a created-or-listed parent row for lookups, the stored
  // upload key for file fields, one row for a required subform.
  const recordFor = async (plans: readonly SmokeFieldPlan[] | undefined, form: string, prefix: string, notes: string[]): Promise<Record<string, unknown>> => {
    const record: Record<string, unknown> = {};
    for (const field of plans ?? []) {
      const dotted = prefix ? `${prefix}.${field.name}` : field.name;
      if (field.skipped) {
        notes.push(`${dotted}: ${field.source || 'skipped'}`);
        continue;
      }
      if (field.fileRef) {
        const key = uploaded.get(`${form}.${field.name}`);
        if (!key) {
          notes.push(`${dotted}: skipped — no uploaded object`);
          continue;
        }
        record[field.name] = { key };
        continue;
      }
      if (field.lookupTable || field.lookupEndpoint) {
        let id = created.get(field.lookupForm || '');
        if (!id && field.lookupEndpoint) {
          const options = await loadLookupOptions(view, field.lookupEndpoint);
          const first = options.find((option) => option && option.value);
          if (first) id = String(first.value);
        }
        if (!id) {
          notes.push(`${dotted}: skipped — no parent row`);
          continue;
        }
        record[field.name] = field.multi ? [id] : id;
        continue;
      }
      if (field.children) {
        const inner = await recordFor(field.children, form, dotted, notes);
        record[field.name] = field.source === 'one subform row' ? [inner] : inner;
        continue;
      }
      record[field.name] = field.value !== undefined ? field.value : `c2c smoke ${tag}`;
    }
    return record;
  };

  for (const step of plan ?? []) {
    const label = step?.label || 'step';
    try {
      switch (step?.kind) {
        case 'session':
          push(label, 'signed-in app session');
          break;
        case 'skip':
          push(label, step.reason || 'skipped');
          break;
        case 'upload': {
          const text = `c2c smoke ${tag}\n`;
          const bytes = new TextEncoder().encode(text);
          exercised += 1;
          const res = await api(step.path ?? '', {
            method: step.method || 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              filename: `c2c-smoke-${tag}.txt`,
              contentType: 'text/plain',
              sha256: await sha256Hex({ arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }),
            }),
          });
          const body = await readJson(res);
          const reference = body?.reference as Record<string, unknown> | undefined;
          const key = reference?.key;
          if (!res || res.ok === false || typeof key !== 'string' || !key) {
            failed = true;
            push(label, `${res?.status || '?'} ${(body?.error as string | undefined) || 'no reference key'}`, false);
            break;
          }
          uploaded.set(`${step.form}.${step.upload?.field || ''}`, key);
          const upload = body?.upload as Record<string, unknown> | undefined;
          const put = typeof upload?.url === 'string' ? upload.url : '';
          // A presigned PUT is https to the object store (loopback allowed on
          // the dev stack) — never wherever an endpoint happens to point. The
          // host check is on the parsed hostname: a name that only starts with
          // a loopback spelling (127.0.0.1.<host>, localhost.<host>) is not
          // loopback.
          let putTarget: URL | null = null;
          try {
            putTarget = put ? new URL(put) : null;
          } catch {
            putTarget = null;
          }
          const putLoopback = putTarget !== null && LOOPBACK_HOSTS.has(putTarget.hostname);
          if (put && (!putTarget || (putTarget.protocol !== 'https:' && !(putTarget.protocol === 'http:' && putLoopback)))) {
            failed = true;
            push(label, 'the signed upload url is not an https target', false);
            break;
          }
          if (put) {
            // The signed URL goes to Stratus — never the app session headers.
            const sent = await call(put, { method: 'PUT', headers: { 'Content-Type': 'text/plain', ...((upload?.headers as Record<string, string> | undefined) ?? {}) }, body: text });
            if (!sent || sent.ok === false) {
              failed = true;
              push(label, `${res.status} reference stored but the PUT answered ${sent?.status || '?'}`, false);
              break;
            }
            uploadedUrl = put;
            push(label, `${res.status} stored (PUT ${sent.status})`);
          } else {
            push(label, `${res.status} reference stored`);
          }
          break;
        }
        case 'submit': {
          const notes: string[] = [];
          const record = await recordFor(step.record, step.form ?? '', '', notes);
          exercised += 1;
          const res = await api(step.path ?? '', {
            method: step.method || 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ record }, jsonReplacer),
          });
          const body = await readJson(res);
          const suffix = notes.length ? ` (${notes.join('; ')})` : '';
          if (!res || res.ok === false) {
            failed = true;
            push(label, `${res?.status || '?'} ${(body?.error as string | undefined) || ''}`.trim() + suffix, false);
            break;
          }
          const values = body?.values as Record<string, unknown> | undefined;
          const rowid = values?.ROWID != null ? String(values.ROWID) : '';
          if (body?.wrote === true && /^\d+$/.test(rowid)) {
            created.set(step.form ?? '', rowid);
            submitted.set(step.form ?? '', record);
            push(label, `${res.status} wrote ${rowid}${suffix}`);
          } else if (body?.wrote === true) {
            failed = true;
            push(label, `${res.status} wrote but returned no usable ROWID${suffix}`, false);
          } else {
            push(label, `${res.status} dry-run — nothing written${suffix}`);
          }
          break;
        }
        case 'read-back': {
          const rowId = created.get(step.form ?? '');
          if (!rowId) {
            push(label, 'skipped — no row created');
            break;
          }
          const field = step.expect?.field || step.marker?.field || 'ROWID';
          exercised += 1;
          const row = await smokeReadRow(api, step, field, rowId);
          if (!row) {
            failed = true;
            push(label, `missing — the store holds no row ${rowId}`, false);
            break;
          }
          verified.add(step.form ?? '');
          push(label, `row ${rowId} present`);
          if (step.expect) {
            const expected =
              step.expect.value !== undefined
                ? step.expect.value
                : step.expect.submitted === 'update'
                  ? updateSent.get(step.form ?? '')?.value
                  : (submitted.get(step.form ?? '') ?? {})[step.expect.field];
            if (expected === undefined) push(label, `${step.expect.field} — nothing sent to compare`);
            else if (String(row[step.expect.field] ?? '') === String(expected)) push(label, `${step.expect.field} matches what the run sent`);
            else {
              failed = true;
              push(label, `${step.expect.field} does not match what the run sent`, false);
            }
          }
          for (const child of step.children ?? []) {
            const report = (model.reports ?? []).find((item) => item && item.form === step.form && item.queryEndpoint);
            if (!report) {
              push(label, `child ${child.field}: no report on ${step.form} to read it`);
              break;
            }
            const res = await api(report.queryEndpoint ?? '', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ op: 'query', page: 0, pageSize: 300, filter: { field: 'ROWID', value: rowId } }, jsonReplacer),
            });
            const body = await readJson(res);
            const reportRows = body && Array.isArray(body.rows) ? body.rows : [];
            const parent = res && res.ok ? (reportRows.find((item) => String((item as Record<string, unknown>)?.ROWID) === String(rowId)) as Record<string, unknown> | undefined) : undefined;
            const list = parent && Array.isArray(parent[child.field]) ? (parent[child.field] as unknown[]) : [];
            if (list.length) push(label, `child ${child.field}: ${list.length} row`);
            else {
              failed = true;
              push(label, `child ${child.field}: no row`, false);
            }
          }
          for (const check of step.lookups ?? []) {
            const sent = (submitted.get(step.form ?? '') ?? {})[check.field];
            const ids = Array.isArray(sent) ? sent : sent != null ? [sent] : [];
            if (!ids.length) {
              push(label, `lookup ${check.field}: skipped — no value submitted`);
              continue;
            }
            const options = await loadLookupOptions(view, check.endpoint);
            const missing = ids.filter((id) => {
              const option = options.find((entry) => entry && String(entry.value) === String(id));
              return !option || option.label === '';
            });
            if (missing.length) {
              failed = true;
              push(label, `lookup ${check.field}: no display for ${missing.length} id(s)`, false);
            } else push(label, `lookup ${check.field}: display resolved`);
          }
          for (const check of step.files ?? []) {
            const res = await api(check.filesPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowId }) });
            const body = await readJson(res);
            if (res && res.ok && typeof body?.url === 'string' && body.url) push(label, `file ${check.field}: key resolves`);
            else {
              failed = true;
              push(label, `${res?.status || '?'} ${(body?.error as string | undefined) || 'no file key'}`.trim(), false);
            }
          }
          break;
        }
        case 'update': {
          const rowId = created.get(step.form ?? '');
          const update = step.update ?? {};
          const markerField = step.marker?.field;
          if (!rowId || !update.field) {
            push(label, 'skipped — no row created');
            break;
          }
          if (!markerField) {
            push(label, 'skipped — no marker field to scope the update');
            break;
          }
          const sent = update.value !== undefined ? update.value : `${String((submitted.get(step.form ?? '') ?? {})[update.field] ?? `c2c smoke ${tag}`)} (updated)`;
          exercised += 1;
          const res = await api('/admin/smoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'update', form: step.form, rowId, marker: { field: markerField, tag: `c2c smoke ${tag}` }, fields: { [update.field]: sent } }, jsonReplacer),
          });
          const body = await readJson(res);
          if (!res || res.ok === false) {
            failed = true;
            push(label, `${res?.status || '?'} ${(body?.error as string | undefined) || ''}`.trim(), false);
          } else if (body?.updated === true) {
            updateSent.set(step.form ?? '', { field: update.field, value: sent });
            push(label, `${res.status} updated`);
          } else {
            push(label, `${res.status} dry-run — nothing written`);
          }
          break;
        }
        case 'report': {
          exercised += 1;
          const res = await api(step.path ?? '', {
            method: step.method || 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'query', page: 0, pageSize: 300 }),
          });
          const body = await readJson(res);
          if (!res || res.ok === false) {
            failed = true;
            push(label, `${res?.status || '?'} ${(body?.error as string | undefined) || ''}`.trim(), false);
          } else if (!body || !Array.isArray(body.rows)) {
            // A 200 that is not the report's JSON shape — a sign-in page
            // answers 200 HTML — proves nothing.
            failed = true;
            push(label, `${res.status} but the answer is not the report shape`, false);
          } else push(label, `${res.status} (${body.rows.length} rows)`);
          break;
        }
        case 'cleanup': {
          const rowId = created.get(step.form ?? '');
          if (!rowId) {
            push(label, 'skipped — nothing created');
            break;
          }
          if (!verified.has(step.form ?? '')) {
            failed = true;
            push(label, `skipped — read-back did not confirm row ${rowId}; left in place`, false);
            break;
          }
          const marker = step.marker?.field;
          if (!marker) {
            push(label, `skipped — ${step.form} has no marker field; left in place`);
            break;
          }
          exercised += 1;
          const res = await api('/admin/smoke', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op: 'delete', form: step.form, rowId, marker: { field: marker, tag: `c2c smoke ${tag}` } }),
          });
          const body = await readJson(res);
          if (!res || res.ok === false || body?.deleted !== true) {
            failed = true;
            push(label, `${res?.status || '?'} ${(body?.error as string | undefined) || 'not deleted'}`.trim(), false);
            break;
          }
          const gone = await smokeReadRow(api, step, marker, rowId);
          if (gone) {
            failed = true;
            push(label, `row ${rowId} still present after delete`, false);
          } else {
            deleted += 1;
            // The object does not ride the row delete — ask the store to drop
            // it. Best effort: a PUT-scoped presign may not allow DELETE.
            if (uploadedUrl) {
              try {
                await call(uploadedUrl, { method: 'DELETE' });
              } catch {
                /* best effort */
              }
              uploadedUrl = '';
            }
            push(label, `row ${rowId} deleted (verified gone)`);
          }
          break;
        }
        default:
          push(label, 'unknown step');
      }
    } catch (err) {
      failed = true;
      push(label, `failed — ${(err as Error)?.message || 'error'}`, false);
    }
  }
  const summary = `created ${created.size}, deleted ${deleted}, left ${created.size - deleted}`;
  // A run that touched nothing — every step skipped — verified nothing; it is
  // a failure, not a pass. A plan whose submits all dry-ran wrote nothing
  // either; the page's ok agrees with the verdict the CLI reads back.
  const submits = (plan ?? []).filter((step) => step && step.kind === 'submit').length;
  const ok = !failed && created.size === deleted && exercised > 0 && !(submits > 0 && created.size === 0);
  lines.push(summary);
  const block = { version: 'c2c-smoke/1', ok, created: created.size, deleted, left: created.size - deleted, exercised, steps: rows };
  const project = typeof view.C2C_SMOKE_PROJECT === 'string' ? view.C2C_SMOKE_PROJECT : '';
  const json = await sealSmokeBlock(block, {
    origin: view.location ? view.location.origin : '',
    app: model.name || '',
    project,
    plan,
    // determinism-allow: runtime-only browser clock stamping the result block; not evaluated while generating files
    at: new Date().toISOString(),
  });
  return { ok, lines, json, code: await smokeResultCode(json, plan) };
}

/** Sorted-key JSON, so the page and `c2c smoke --result` hash the same bytes for the same block. */
export function smokeCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => smokeCanonical(item === undefined ? null : item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // determinism-allow: keys are sorted before use; runtime-only result sealing
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${smokeCanonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

async function smokeSha256(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder !== 'function') return '';
  const bytes = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Bind a c2c-smoke/1 block to where and what it ran: the page origin, the app
 * name, the project id the deploy embedded, a SHA-256 of the embedded plan,
 * and the finish time. `digest` is a SHA-256 over the whole bound block, so
 * `c2c smoke --result` refuses a block that was edited or cut short after the
 * page printed it. No secret goes into the seal and none comes out of it.
 */
export async function sealSmokeBlock(
  block: Record<string, unknown>,
  bind: { origin?: string; app?: string; project?: string; plan?: unknown; at?: string },
): Promise<Record<string, unknown>> {
  const sealed = {
    ...block,
    origin: String(bind?.origin || ''),
    app: String(bind?.app || ''),
    ...(bind?.project ? { project: String(bind.project) } : {}),
    plan: await smokeSha256(smokeCanonical(bind?.plan || [])),
    at: String(bind?.at || ''),
  };
  const digest = await smokeSha256(smokeCanonical(sealed));
  return digest ? { ...sealed, digest } : sealed;
}

const SMOKE_CODE_PREFIX = 'c2cs1';

function smokeBase64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function smokeDeflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function' || typeof Blob !== 'function' || typeof Response !== 'function') return null;
  try {
    return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * The result code the page shows beside its Copy button: the whole sealed
 * block, packed copy-safe (packages/deploy/src/smoke-code.ts has the format) —
 * `c2cs1`, a format letter (`k` deflate-raw, `c` plain where the browser
 * cannot compress), base64url of the canonical compact JSON `[rest, steps]`,
 * then 6 check characters (base64url of the first 4 bytes of SHA-256 over
 * everything before them). The compact form leaves out the digest (it is
 * recomputed) and names a step label or detail that is one of the plan's
 * strings by its index. `c2c smoke --result-code` unpacks it and runs the
 * same verifier as --result.
 */
export async function smokeResultCode(block: unknown, plan: readonly SmokeStep[] | undefined): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  const sealed = block as { digest?: unknown; steps?: unknown } | null;
  if (!subtle || typeof TextEncoder !== 'function' || typeof btoa !== 'function' || !sealed || !sealed.digest || !Array.isArray(sealed.steps)) return '';
  const { steps, digest: _digest, ...rest } = sealed as Record<string, unknown> & { steps: SmokeLine[] };
  // The plan's strings, in plan order: each step's label and skip reason.
  const strings: string[] = [];
  for (const step of plan ?? []) {
    if (!step || typeof step !== 'object') continue;
    if (typeof step.label === 'string') strings.push(step.label);
    if (typeof step.reason === 'string') strings.push(step.reason);
  }
  const ref = (text: string): string | number => {
    const at = strings.indexOf(text);
    return at >= 0 ? at : text;
  };
  const compact = [rest, steps.map((step) => [ref(String(step.label)), step.ok ? 1 : 0, ref(String(step.detail))])];
  const raw = new TextEncoder().encode(smokeCanonical(compact));
  const packed = await smokeDeflate(raw);
  const body = packed && packed.length < raw.length ? `${SMOKE_CODE_PREFIX}k${smokeBase64url(packed)}` : `${SMOKE_CODE_PREFIX}c${smokeBase64url(raw)}`;
  const check = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(body))).slice(0, 4);
  return `${body}${smokeBase64url(check)}`;
}

/** Copy the code: the clipboard API, else select it and execCommand('copy'). */
function wireSmokeCopy(section: Element, view: AppWindow): void {
  const button = section.querySelector('[data-smoke-copy-code]');
  const codeEl = section.querySelector('#c2c-smoke-code');
  if (!button || !codeEl) return;
  button.addEventListener('click', () => {
    const text = codeEl.textContent || '';
    const done = (label: string) => {
      button.textContent = label;
    };
    const fallback = () => {
      const doc = section.ownerDocument;
      const selection = doc.defaultView?.getSelection?.() ?? null;
      if (selection) {
        const range = doc.createRange();
        range.selectNodeContents(codeEl);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      let copied = false;
      try {
        copied = typeof doc.execCommand === 'function' && doc.execCommand('copy');
      } catch {
        /* selected for a manual copy */
      }
      done(copied ? 'Copied' : 'Selected — press Ctrl+C / ⌘C');
    };
    const clipboard = view.navigator?.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(text).then(() => done('Copied'), fallback);
    else fallback();
  });
}

/**
 * Fill a mounted smoke shell — the same element contract the vanilla page and
 * the CLI browser driver share: [data-smoke-state] carries the run state,
 * [data-smoke-steps] one td per line, #c2c-smoke-json the sealed block.
 * Imperative like the vanilla page it must stay compatible with: the driver
 * polls attributes, so the page does not route its states through React.
 * A section mounts once — a StrictMode re-mount does not start a second run.
 */
const mountedSmoke = new WeakSet<Element>();

export function mountSmoke(section: Element, model: SmokeModel, view: AppWindow): void {
  if (mountedSmoke.has(section)) return;
  mountedSmoke.add(section);
  const state = section.querySelector('[data-smoke-state]');
  const tbody = section.querySelector('[data-smoke-steps]');
  const pre = section.querySelector('#c2c-smoke-json');
  const table = tbody?.closest('table');
  const doc = section.ownerDocument;
  const setState = (value: string, text?: string) => {
    if (!state) return;
    state.setAttribute('data-smoke-state', value);
    if (text) state.textContent = text;
  };
  const call = view.fetch ?? (globalThis as { fetch?: unknown }).fetch;
  const plan = view.C2C_SMOKE_PLAN;
  if (typeof call !== 'function' || !Array.isArray(plan) || !plan.length) {
    setState('unavailable', 'No smoke plan is embedded in this build.');
    return;
  }
  void apiCall(view, '/admin/smoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'status' }),
  })
    .then(async (res) => {
      // Authorization is the documented status shape — { ok: true, dryRun,
      // mode, forms } — never a bare 2xx: a sign-in page or any HTML answer
      // is 200 and is not authorization.
      const status = res.status === 200 ? await readJson(res) : null;
      const granted = status !== null && status.ok === true && typeof status.mode === 'string' && Number.isInteger(status.forms);
      if (!granted) {
        if (res.status === 403) {
          setState('denied', 'The smoke service denied this sign-in — it needs an Administrator profile.');
        } else {
          setState('not-signed-in', `Not signed in or the smoke service did not answer its status shape (status ${res.status || '?'}). Sign in as an app administrator.`);
        }
        return;
      }
      setState('running', 'Running the smoke contract…');
      const result = await runSmokePlan(model, plan as SmokeStep[], view);
      if (tbody && doc) {
        for (const line of result.lines) {
          const tr = doc.createElement('tr');
          const td = doc.createElement('td');
          td.textContent = line;
          tr.appendChild(td);
          tbody.appendChild(tr);
        }
        if (table) table.hidden = false;
      }
      const codeBox = section.querySelector('[data-smoke-code]');
      const codeEl = section.querySelector('#c2c-smoke-code');
      if (result.code && codeBox && codeEl) {
        codeEl.textContent = result.code;
        (codeBox as HTMLElement).hidden = false;
        wireSmokeCopy(section, view);
      }
      if (pre) {
        pre.textContent = JSON.stringify(result.json, null, 2);
        (pre as HTMLElement).hidden = false;
        const copy = section.querySelector('[data-smoke-copy]');
        if (copy) (copy as HTMLElement).hidden = false;
      }
      setState(result.ok ? 'done' : 'failed', result.ok ? 'Done — every check passed.' : 'Failed — see the steps below.');
    })
    .catch(() => setState('failed', 'The smoke run failed to finish.'));
}
