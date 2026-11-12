#!/usr/bin/env node
/**
 * Authenticated c2c_api read-back for the live E2E. The function stays token
 * protected (Catalyst security rules), so a call without an app user's token
 * answers 401 NO_ACCESS. Given a project, the invoke URL and an app-user
 * token, this calls one read route and asserts a 200 with a `rows` array.
 *
 *   C2C_APP_USER_TOKEN=<token> node tools/catalyst-harness/api-readback.mjs \
 *     --project <name> --invoke-url https://<host>/server/c2c_api \
 *     [--path '/reports/<Report>?page=0&pageSize=1'] [--expect-text <text>]
 *
 * The token comes from the environment, never an argument, and is never
 * printed. Exit 0 on a 200 read-back, 1 with one clear line otherwise.
 */
import { pathToFileURL } from 'node:url';

export class ReadBackError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ReadBackError';
    this.status = status;
  }
}

/** Join the invoke URL and an app-relative path without doubling or dropping a slash. */
export function readBackUrl(invokeUrl, path) {
  let base;
  try {
    base = new URL(invokeUrl);
  } catch {
    throw new ReadBackError(`the invoke URL is not a URL: ${String(invokeUrl).slice(0, 80)}`);
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new ReadBackError('the invoke URL must be http(s)');
  return `${base.href.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

/**
 * Call c2c_api with the app user's token as the raw Authorization header (the
 * Catalyst Web SDK form: no prefix) and assert a 200 read-back. Resolves to
 * `{ status, body }`; rejects with a ReadBackError naming the project.
 */
export async function readBack({ project, invokeUrl, token, path = '/reports/?page=0&pageSize=1', expectText, fetchImpl = globalThis.fetch }) {
  const label = project ? `project ${project}` : 'the project';
  if (!token) throw new ReadBackError(`no app-user token for ${label}: sign up an app user, obtain its token, and pass it (see the guide section "How to call your API and how the generated pages authenticate")`);
  const url = readBackUrl(invokeUrl, path);
  const res = await fetchImpl(url, { method: 'GET', headers: { authorization: token, accept: 'application/json' } });
  const text = await res.text();
  if (res.status === 401) {
    throw new ReadBackError(`401 from ${label}'s c2c_api: the app-user token was rejected or missing. Check that Authentication is enabled, the user signed up on this project, and the token is current (tokens expire).`, 401);
  }
  if (res.status !== 200) throw new ReadBackError(`expected 200 from ${label}'s c2c_api but got ${res.status}`, res.status);
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ReadBackError(`${label}'s c2c_api answered 200 with a body that is not JSON`, 200);
  }
  if (!body || !Array.isArray(body.rows)) throw new ReadBackError(`${label}'s c2c_api answered 200 but the body has no rows array`, 200);
  if (expectText !== undefined && !JSON.stringify(body.rows).includes(expectText)) {
    throw new ReadBackError(`${label}'s c2c_api answered 200 but the rows do not contain the expected text`, 200);
  }
  return { status: 200, body };
}

async function main(argv, env) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const result = await readBack({
      project: flag('--project'),
      invokeUrl: flag('--invoke-url'),
      token: env.C2C_APP_USER_TOKEN,
      ...(flag('--path') ? { path: flag('--path') } : {}),
      expectText: flag('--expect-text'),
    });
    console.log(`c2c_api read-back ok: 200, ${result.body.rows.length} row(s)`);
    return 0;
  } catch (err) {
    console.error(err instanceof ReadBackError ? err.message : `c2c_api read-back failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2), process.env);
