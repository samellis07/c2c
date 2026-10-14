/**
 * The new-project IaC import: POST the project-template bundle, confirm the
 * deploy, poll the import to Completed.
 *
 *   provision/iac/project-template-1.0.0.json   the full template (iac.ts)
 *   provision/iac/functions/c2c_api.zip         the function code zip
 *
 * The two are packed into one STORE zip and sent as the `code` part of a
 * multipart POST /baas/v1/project/import. GET …/deploy confirms the staged
 * import with the CLI bearer token; GET …/<import-id> is polled until the
 * status leaves Scheduled/Processing/Staged. Completed is the only success —
 * a bounded poll keeps a stuck "Importing" run finite. The name a posted
 * import consumed stays recorded in provision/state.json, and the next run
 * re-polls every recorded import id before the first POST — a stuck import
 * whose name never comes up in the run's sequence must not be orphaned by a
 * fresh POST next to it. A still-running or unreadable import refuses the
 * run (a stuck Importing project cannot be deleted — a second POST would
 * only orphan it), a terminal non-Completed read frees the name, and a
 * Completed read is adopted when it names that import and a name in the
 * run's sequence, else refused rather than orphaned. A POST that fails
 * before answering an import id records nothing; the next run POSTs the
 * name again (a kept Staged import answering 409 moves to the next suffix).
 * A refused deploy confirm keeps the posted import recorded: the next run
 * reads it Staged and re-issues the confirm for that same import id.
 *
 * The bundle zip is deterministic: STORE method, entries sorted by name, a
 * fixed DOS timestamp — two runs over the same tree are byte-identical.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { API_FUNCTION } from './function-dir.js';
import { PROJECT_TEMPLATE_FILE } from './iac.js';
import { parseJsonExact } from './json-exact.js';
import { invalidTokenAnswer, readWithNewerToken } from './retry.js';

// ---------------------------------------------------------------------------
// deterministic STORE zip

export interface ZipEntry {
  name: string;
  data: string | Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

/** A deterministic uncompressed zip: names sorted, DOS timestamp 1980-01-01, UTF-8 flag set. */
export function zipStore(entries: readonly ZipEntry[]): Buffer {
  const sorted = [...entries]
    .map((entry) => ({ name: Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8'), data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8') }))
    .sort((a, b) => Buffer.compare(a.name, b.name));
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00:00 — a fixed stamp keeps the bytes deterministic.
  const dosTime = 0;
  const dosDate = 0x21;
  for (const entry of sorted) {
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26);
    local.writeUInt16LE(0, 28); // no extra
    chunks.push(local, entry.name, entry.data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10); // STORE
    dir.writeUInt16LE(dosTime, 12);
    dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.data.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(entry.name.length, 28);
    // extra, comment, disk, internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([dir, entry.name]));
    offset += 30 + entry.name.length + entry.data.length;
  }
  const dirBlock = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(dirBlock.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dirBlock, end]);
}

/** A hard link shares its bytes with a file elsewhere on disk, so it is refused like a link. */
function hardLink(rel: string, links: number): Error {
  return new Error(`provision/iac/${rel} has ${links} hard links — the import bundle takes only the files c2c plan wrote; re-run c2c plan for a new project`);
}

/**
 * Check one bundle member without following a link: every path component
 * below the iac directory must be a real directory or a regular file, and the
 * member's realpath must stay under the realpath of the iac directory.
 */
function checkMember(root: string, rel: string): void {
  const path = join(root, ...rel.split('/'));
  // A linked functions directory is refused like a linked file.
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const part = join(root, ...parts.slice(0, i));
    const st = lstatSync(part, { throwIfNoEntry: false });
    if (!st) throw new Error(`provision/iac is missing ${rel} — re-run c2c plan for a new project`);
    if (st.isSymbolicLink()) throw new Error(`provision/iac/${parts.slice(0, i).join('/')} is a link — the import bundle takes only the files c2c plan wrote; re-run c2c plan for a new project`);
    if (i < parts.length ? !st.isDirectory() : !st.isFile()) {
      throw new Error(`provision/iac/${parts.slice(0, i).join('/')} is not a ${i < parts.length ? 'directory' : 'regular file'} — re-run c2c plan for a new project`);
    }
    if (i === parts.length && st.nlink > 1) throw hardLink(rel, st.nlink);
  }
  const real = realpathSync(path);
  if (!real.startsWith(`${root}${sep}`)) {
    throw new Error(`provision/iac/${rel} resolves outside provision/iac — re-run c2c plan for a new project`);
  }
}

/** Read a checked member through O_NOFOLLOW (where the platform has it), refusing a hard link. */
function readMember(root: string, rel: string): Buffer {
  const path = join(root, ...rel.split('/'));
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`provision/iac/${rel} is not a regular file — re-run c2c plan for a new project`);
    if (st.nlink > 1) throw hardLink(rel, st.nlink);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The import `code` part: the template plus functions/<fn>.zip, like an export
 * unpacks. Both members are checked before either is read: no link, no hard
 * link, nothing that resolves outside the directory.
 */
export function iacImportBundle(dir: string): Buffer {
  const root = realpathSync(dir);
  const members = [PROJECT_TEMPLATE_FILE, `functions/${API_FUNCTION}.zip`];
  for (const rel of members) checkMember(root, rel);
  const data = members.map((rel) => readMember(root, rel));
  return zipStore(members.map((name, i) => ({ name, data: data[i]! })));
}

// ---------------------------------------------------------------------------
// the import calls

const BOUNDARY = 'c2c-iac-import-boundary';

/** multipart/form-data for POST /baas/v1/project/import: project_name, template_format=JSON, code=<zip>, schedule=false. */
export function importMultipart(projectName: string, bundle: Buffer): Buffer {
  const field = (name: string, value: string) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = Buffer.from(`${field('project_name', projectName)}${field('template_format', 'JSON')}--${BOUNDARY}\r\nContent-Disposition: form-data; name="code"; filename="code.zip"\r\nContent-Type: application/zip\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="schedule"\r\n\r\nfalse\r\n--${BOUNDARY}--\r\n`, 'utf8');
  return Buffer.concat([head, bundle, tail]);
}

export interface ImportFetch {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
  }>;
}

export interface ImportAttempt {
  name: string;
  outcome: 'imported' | 'duplicate' | 'ended';
}

export interface ImportResult {
  /** The project name the import actually used (a "-2" style suffix on a clash). */
  projectName: string;
  projectId: string;
  importId: string;
  /** Every distinct status the poll observed, in order. */
  states: string[];
  attempts: ImportAttempt[];
}

/**
 * The deploy confirm's redirect_url: the same loopback success page the
 * Catalyst CLI's iac:import uses (it picks a free port from 3000 up and serves
 * /success for the browser hand-off). The confirm here goes out with the
 * token directly, so nothing listens on the port — the service only checks
 * the shape and answers the GET with its HTML redirect stub. The console URL
 * is refused: 400 INVALID_REDIRECT_URL.
 */
export const IAC_DEPLOY_REDIRECT_URL = 'http://localhost:3999/success';

/**
 * The redirect_url a deploy confirm may carry: exactly
 * `http://localhost:<port>/success`, nothing else. Checked before any call so
 * an import is never staged with a confirm that cannot be accepted.
 */
export function assertDeployRedirectUrl(url: string): string {
  const port = /^http:\/\/localhost:([0-9]{1,5})\/success$/.exec(url)?.[1];
  if (port === undefined || Number(port) < 1 || Number(port) > 65535 || String(Number(port)) !== port) {
    throw new Error(`refusing the deploy confirm redirect_url ${JSON.stringify(url)}: it must be a full http://localhost:<port>/success URL`);
  }
  return url;
}

/** The import did not finish inside the poll bound; the name it used stays blocked. */
export class StuckImportError extends Error {
  readonly projectName: string;
  readonly importId: string | undefined;
  constructor(projectName: string, importId: string | undefined, lastStatus: string) {
    super(
      `the import of "${projectName}" did not finish in time (last status ${lastStatus}); the project name stays blocked until Catalyst finishes the import — a stuck "Importing" project cannot be deleted. Re-running re-polls this import first; if it truly cannot finish, remove learned.imports["${projectName}"] from provision/state.json so a retry can take the next name suffix.`,
    );
    this.name = 'StuckImportError';
    this.projectName = projectName;
    this.importId = importId;
  }
}

/** The import's own status read returned a terminal non-Completed state: it is over and its name is free. */
export class ImportEndedError extends Error {
  readonly projectName: string;
  readonly importId: string | undefined;
  readonly lastStatus: string;
  constructor(projectName: string, importId: string | undefined, lastStatus: string, body: unknown) {
    super(`import ${importId} ended with status ${lastStatus}: ${JSON.stringify(body ?? {}).slice(0, 300)}`);
    this.name = 'ImportEndedError';
    this.projectName = projectName;
    this.importId = importId;
    this.lastStatus = lastStatus;
  }
}

const LIVE_STATES = new Set(['Scheduled', 'Processing', 'Staged']);
/** The shape of an import id the POST answers; anything else never reaches a URL path. */
const IMPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMPORT_MAX_NAMES = 5;
const IMPORT_MAX_POLLS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function parseBody(res: { text(): Promise<string> }): Promise<unknown> {
  try {
    return parseJsonExact(await res.text());
  } catch {
    return undefined;
  }
}

/** A decimal project id from project_details, or undefined. */
function projectIdOf(details: Record<string, unknown> | undefined): string | undefined {
  const rawId = details?.id ?? details?.project_id;
  return typeof rawId === 'string' && /^[0-9]+$/.test(rawId) ? rawId : typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId >= 0 ? String(rawId) : undefined;
}

function statusError(what: string, res: { status: number }, body: unknown): Error {
  return new Error(`${what} failed: ${res.status} ${JSON.stringify(body ?? {}).slice(0, 300)}`);
}

/** Only the recorded duplicate-name shapes count as a name clash: a 409, or a DUPLICATE_* error code whose message names the project name. Any other 4xx is a real failure — it does not consume the name list. */
function nameClash(status: number, body: unknown): boolean {
  if (status < 400) return false;
  if (status === 409) return true;
  const data = isRecord(body) && isRecord(body.data) ? body.data : isRecord(body) ? body : {};
  const code = typeof data.error_code === 'string' ? data.error_code : '';
  const message = typeof data.message === 'string' ? data.message : '';
  return /^DUPLICATE(_[A-Z]+)?$/i.test(code) && /project name/i.test(message);
}

/**
 * Create a project by importing the IaC bundle. The name is tried as-is first;
 * a duplicate-name 409 moves to the documented "<name>-2", "<name>-3" …
 * suffix, up to 5 names. Before the first POST every recorded stuck import is
 * re-polled — a live or unreadable import refuses the run, a terminal read
 * frees the name, and a Completed read is adopted only when it names that
 * import and a name in this run's sequence, else refused so the minted
 * project is never orphaned. Every status the poll observes is reported
 * through onStatus.
 */
export async function runProjectImport(opts: {
  baseUrl: string;
  org: string;
  token: string;
  /**
   * A newer access token, or undefined when there is none. A status read that
   * answers 401 INVALID_TOKEN is re-sent once, and only when this returns a
   * token other than the one that failed; the POST and the deploy confirm are
   * never re-sent.
   */
  renewToken?: () => Promise<string | undefined>;
  name: string;
  /** Names a previous stuck run consumed — every one is re-polled to a terminal read before the first POST. */
  takenNames?: readonly string[];
  /** Import ids a previous stuck run recorded, by name — resolved before the first POST, whatever name this run is minting. */
  stuckIds?: Readonly<Record<string, string>>;
  /** Called with the import id as soon as the POST answers, before the deploy confirm and the poll. */
  onPosted?: (name: string, importId: string) => void;
  bundle: Buffer;
  fetch: ImportFetch;
  sleep: (ms: number) => Promise<void>;
  maxNames?: number;
  maxPolls?: number;
  onStatus?: (line: string) => void;
}): Promise<ImportResult> {
  const maxNames = opts.maxNames ?? IMPORT_MAX_NAMES;
  const maxPolls = opts.maxPolls ?? IMPORT_MAX_POLLS;
  const attempts: ImportAttempt[] = [];
  let token = opts.token;
  let auth = { Authorization: `Bearer ${token}` };
  const report = (line: string) => opts.onStatus?.(line);
  const base = opts.baseUrl.replace(/\/$/, '');
  // Imports are org-scoped. Bind every request to the selected org and fail
  // before the first call rather than letting Catalyst select a default org.
  if (!/^\d+$/.test(opts.org)) throw new Error('the project import needs a resolved Catalyst org id — pass --org or set "org" in c2c-deploy.json');
  const catalystFetch: ImportFetch = (url, init = {}) =>
    opts.fetch(url, { ...init, headers: { ...(init.headers ?? {}), 'CATALYST-ORG': opts.org } });
  // Fail closed before any call: a confirm the service would refuse must
  // never follow a POST that stages an import under the name.
  const redirectUrl = assertDeployRedirectUrl(IAC_DEPLOY_REDIRECT_URL);
  const deployUrl = (importId: string) => `${base}/baas/v1/project/import/${importId}/deploy?catalyst_org=${opts.org}&redirect_url=${encodeURIComponent(redirectUrl)}`;
  /** A refused confirm leaves the import staged under the name: say so, and that a re-run re-issues the confirm for that same import. */
  const confirmRefused = (importId: string, name: string, res: { status: number }, body: unknown) =>
    new Error(
      `the import is staged as ${importId} ("${name}"); the confirm failed with ${res.status} ${JSON.stringify(body ?? {}).slice(0, 300)}; re-run to retry the confirm — the staged import holds the name and stays recorded in provision/state.json`,
    );

  /** One status read. A >=400 answer or a transport failure throws — to the caller the import's outcome stays unknown. */
  const readStatus = async (importId: string): Promise<{ status: string; data: Record<string, unknown> | undefined; body: unknown }> => {
    const renewToken = opts.renewToken;
    const { res, body } = await readWithNewerToken({
      readOnly: !!renewToken,
      attempt: async () => {
        const answer = await catalystFetch(`${base}/baas/v1/project/import/${importId}`, { method: 'GET', headers: { ...auth } });
        return { res: answer, body: await parseBody(answer) };
      },
      expired: (read) => invalidTokenAnswer(read.res.status, read.body),
      renew: async () => {
        const next = await renewToken!();
        if (!next || next === token) return false;
        token = next;
        auth = { Authorization: `Bearer ${token}` };
        return true;
      },
      describe: `GET /baas/v1/project/import/${importId}`,
      log: report,
    });
    if (res.status >= 400) throw statusError(`GET /baas/v1/project/import/${importId}`, res, body);
    const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
    return { status: typeof data?.status === 'string' ? data.status : 'unknown', data, body };
  };

  /** The project a Completed read is accepted for: only the one this import minted under this name. */
  const mintedProject = (
    importId: string,
    name: string,
    data: Record<string, unknown> | undefined,
    fallback: Record<string, unknown> | undefined,
    fail: (why: string) => Error,
  ): string => {
    if (data?.id !== undefined && String(data.id) !== importId) throw fail(`the status read names import ${JSON.stringify(data.id)}, not the recorded ${importId}`);
    const details = isRecord(data?.project_details) ? data.project_details : fallback;
    const minted = details?.project_name ?? details?.name;
    if (minted !== name) throw fail(`the completed import names project ${JSON.stringify(minted ?? null)}, not "${name}"`);
    const projectId = projectIdOf(details);
    if (!projectId) throw fail(`the completed import has no well-formed project id (${JSON.stringify(details?.id ?? details?.project_id ?? null)})`);
    return projectId;
  };

  /** Poll one import to a terminal read. Live at the bound → StuckImportError; an unreadable answer throws before this returns. */
  const pollToEnd = async (
    importId: string,
    name: string,
    first: string,
    states: string[],
    fallback: Record<string, unknown> | undefined,
    fail: (why: string) => Error,
  ): Promise<{ kind: 'completed'; projectId: string } | { kind: 'ended'; status: string; body: unknown }> => {
    let last = first;
    for (let poll = 0; poll < maxPolls; poll++) {
      await opts.sleep(Math.min(2000 + poll * 1000, 5000));
      const { status, data, body } = await readStatus(importId);
      if (data?.id !== undefined && String(data.id) !== importId) {
        throw fail(`the status read names import ${JSON.stringify(data.id)}, not the recorded ${importId}`);
      }
      if (status !== last) {
        states.push(status);
        report(`import ${importId}: ${status}`);
        last = status;
      }
      if (status === 'Completed') return { kind: 'completed', projectId: mintedProject(importId, name, data, fallback, fail) };
      if (!LIVE_STATES.has(status) && status !== 'unknown') return { kind: 'ended', status, body };
    }
    throw new StuckImportError(name, importId, last);
  };

  /** The name at an attempt index: opts.name, then the documented -2/-3… suffixes. */
  const sequenceName = (attempt: number) => (attempt === 0 ? opts.name : `${opts.name}-${attempt + 1}`);
  const sequence = new Set(Array.from({ length: maxNames }, (_, attempt) => sequenceName(attempt)));

  // Every recorded stuck row is resolved before the first POST — a stuck
  // import whose name never comes up in this run's sequence must still not be
  // orphaned by a fresh POST next to it. A live or unreadable import refuses
  // the run (its outcome is unknown); a verifiably-ended import frees its
  // name; a Completed import is adopted only when it minted a name in the
  // sequence, else refused so the project is never orphaned.
  const recorded = new Set<string>([...(opts.takenNames ?? []), ...Object.keys(opts.stuckIds ?? {})]);
  for (const blocked of recorded) {
    const stuckId = opts.stuckIds?.[blocked];
    const refuse = (why: string) =>
      new Error(`refusing to adopt the recorded import of "${blocked}": ${why} — check the project in the console; to start over, remove learned.imports["${blocked}"] from provision/state.json`);
    // A blocked name with no recorded import id can never be judged — refuse.
    if (typeof stuckId !== 'string' || !IMPORT_ID.test(stuckId)) {
      throw refuse(stuckId === undefined ? 'no import id was recorded' : 'the recorded import id is not an import id');
    }
    report(`import ${stuckId}: re-polling the recorded import before the next name`);
    // The import's own status read is the only truth. A live or unreadable
    // import keeps the run refused — nothing is posted over an unknown
    // outcome; a terminal non-Completed read frees it for another POST.
    const first = await readStatus(stuckId);
    if (first.data?.id !== undefined && String(first.data.id) !== stuckId) {
      throw refuse(`the status read names import ${JSON.stringify(first.data.id)}, not the recorded ${stuckId}`);
    }
    const states: string[] = [first.status];
    let outcome: { kind: 'completed'; projectId: string } | { kind: 'ended'; status: string; body: unknown };
    if (first.status === 'Completed') {
      outcome = { kind: 'completed', projectId: mintedProject(stuckId, blocked, first.data, undefined, refuse) };
    } else if (LIVE_STATES.has(first.status) || first.status === 'unknown') {
      // A Staged import never got its deploy confirm (the last run failed
      // there) — re-issue it, then keep polling the same import id.
      if (first.status === 'Staged') {
        report(`import ${stuckId}: still Staged — re-issuing the deploy confirm`);
        const deployed = await catalystFetch(deployUrl(stuckId), { method: 'GET', headers: { ...auth } });
        const deployBody = await parseBody(deployed);
        if (deployed.status >= 400) throw confirmRefused(stuckId, blocked, deployed, deployBody);
      }
      outcome = await pollToEnd(stuckId, blocked, first.status, states, undefined, refuse);
    } else {
      outcome = { kind: 'ended', status: first.status, body: first.body };
    }
    if (outcome.kind === 'completed') {
      if (!sequence.has(blocked)) {
        throw new Error(
          `refusing to mint a new project: the recorded import ${stuckId} completed as project "${blocked}", a name this run does not mint — it would be orphaned. Re-run with --name ${blocked} to adopt it, or remove learned.imports["${blocked}"] from provision/state.json to start over`,
        );
      }
      attempts.push({ name: blocked, outcome: 'imported' });
      report(`import ${stuckId}: Completed — the recorded import created the project`);
      return { projectName: blocked, projectId: outcome.projectId, importId: stuckId, states, attempts };
    }
    // The recorded import is verifiably over: the name is free again and can
    // be posted by the loop below if it is in this run's sequence.
    report(`import ${stuckId}: ${outcome.status} — the recorded import is over; "${blocked}" is free to try again`);
    attempts.push({ name: blocked, outcome: 'ended' });
  }

  for (let attempt = 0; attempt < maxNames; attempt++) {
    const name = sequenceName(attempt);
    report(`import: POST /baas/v1/project/import org=${opts.org} project_name="${name}"`);
    const posted = await catalystFetch(`${base}/baas/v1/project/import`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
      body: importMultipart(name, opts.bundle),
    });
    const postBody = await parseBody(posted);
    if (nameClash(posted.status, postBody)) {
      attempts.push({ name, outcome: 'duplicate' });
      report(`import: project name "${name}" is taken in org ${opts.org} — retrying as "${sequenceName(attempt + 1)}"`);
      continue;
    }
    if (posted.status >= 400) throw statusError('POST /baas/v1/project/import', posted, postBody);
    const data = isRecord(postBody) && isRecord(postBody.data) ? postBody.data : undefined;
    const importId = typeof data?.id === 'string' && data.id.length > 0 ? data.id : typeof data?.id === 'number' ? String(data.id) : undefined;
    if (!importId || !IMPORT_ID.test(importId)) throw new Error(`POST /baas/v1/project/import answered ${posted.status} without an import id: ${JSON.stringify(postBody ?? {}).slice(0, 300)}`);
    opts.onPosted?.(name, importId);
    attempts.push({ name, outcome: 'imported' });

    report(`import: GET /baas/v1/project/import/${importId}/deploy`);
    const deployed = await catalystFetch(deployUrl(importId), { method: 'GET', headers: { ...auth } });
    const deployBody = await parseBody(deployed);
    if (deployed.status >= 400) throw confirmRefused(importId, name, deployed, deployBody);

    const states: string[] = [];
    const first = typeof data?.status === 'string' ? data.status : 'Staged';
    states.push(first);
    report(`import ${importId}: ${first}`);
    const outcome = await pollToEnd(importId, name, first, states, isRecord(data?.project_details) ? data.project_details : undefined, (why) => new Error(`import ${importId}: ${why}`));
    if (outcome.kind === 'ended') throw new ImportEndedError(name, importId, outcome.status, outcome.body);
    return { projectName: name, projectId: outcome.projectId, importId, states, attempts };
  }
  throw new Error(`every project name attempt was refused (${attempts.length} names tried, latest "${opts.name}-${maxNames}") — pick a different name in c2c-deploy.json or the console`);
}
