/**
 * Read the deployed Slate app URL back from the Slate API.
 * `slate:link` can print only "Slate linked successfully" and `deploy slate`
 * can finish without an "App Url:" line, so the URL is looked up by app name:
 * GET /slate/v1/project/<id>/app lists the apps; when the row has no domain of
 * its own, GET /slate/v1/project/<id>/app/<appId>/deployment/<deploymentId>
 * (zgraphql origin) reports `domain` and `origin_domain`. These are read-only
 * calls — they retry a transient 429/5xx like every other read.
 */
import { restWithRetry, type RetryOptions } from './retry.js';
import type { RestFn } from './tables.js';

export interface SlateAppRef {
  id: string;
  name: string;
  domain?: string;
  deploymentId?: string;
}

/** Rows of GET /slate/v1/project/<id>/app (`data[]`). */
export function slateApps(body: unknown): SlateAppRef[] {
  const root = asRecord(body) ?? {};
  const data = Array.isArray(root.data) ? root.data : [];
  const out: SlateAppRef[] = [];
  for (const item of data) {
    const record = asRecord(item);
    if (!record) continue;
    const id = decimalOf(record.id ?? record.app_id);
    const name = stringOf(record.name);
    if (!id || !name) continue;
    const config = asRecord(record.deployment_type_config);
    const build = asRecord(config?.current_build);
    out.push({
      id,
      name,
      ...(stringOf(record.domain) || stringOf(config?.domain) || stringOf(config?.origin_domain)
        ? { domain: (stringOf(record.domain) ?? stringOf(config?.domain) ?? stringOf(config?.origin_domain))! }
        : {}),
      ...(decimalOf(config?.id ?? build?.deployment_id) ? { deploymentId: decimalOf(config?.id ?? build?.deployment_id)! } : {}),
    });
  }
  return out;
}

/** `domain`, else `origin_domain`, of a deployment read-back body. */
export function slateDeploymentDomain(body: unknown): string | undefined {
  const root = asRecord(body) ?? {};
  const data = asRecord(root.data) ?? root;
  return stringOf(data.domain) ?? stringOf(data.origin_domain);
}

/**
 * `.catalyst/slate-config.toml` inside the uploaded Slate tree: framework +
 * deployment the link registered. The deploy writes it after the React build
 * because a clean `vite build` empties dist/ (catalyst-slate reference,
 * "slate-config.toml wiped by clean builds"). The source is already the built
 * output, so the framework is `static`.
 */
export function slateConfigToml(): string {
  return 'framework = "static"\ndeployment_name = "default"\n';
}

/** A host or https URL → `https://<host>` — only a plain host, the same set the CORS domain check accepts. */
export function slateUrlOf(domain: string | undefined): string | undefined {
  const raw = domain?.trim();
  if (!raw) return undefined;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /^[a-z0-9][a-z0-9.-]*$/i.test(parsed.host) ? `https://${parsed.host}` : undefined;
  } catch {
    return undefined;
  }
}

export interface SlateRead {
  /** The app list answered 2xx; `apps` is then the exact-name match set. */
  listed: boolean;
  /** Exact-name matches — can exceed one: the API does not make app names unique. */
  apps: SlateAppRef[];
  /** The served URL — set only when exactly one app matched and a domain resolved. */
  url?: string;
  /** One printable line explaining why `url` is unset. */
  note?: string;
}

/**
 * Read the served URL of the Slate app named `appName` back from the API.
 * Never throws for a server refusal and never picks between same-name apps:
 * two matches are reported with their candidates, a missing app and a failed
 * list get a one-line note so the absent CORS domain is explained.
 */
export async function readSlateAppUrl(rest: RestFn, projectId: string, appName: string, opts: RetryOptions = {}): Promise<SlateRead> {
  const base = `/slate/v1/project/${projectId}`;
  const listed = await restWithRetry(rest, { method: 'GET', path: `${base}/app` }, opts);
  if (listed.result.status < 200 || listed.result.status >= 300) {
    return { listed: false, apps: [], note: `slate url not found: the Slate app list answered HTTP ${listed.result.status}` };
  }
  const matches = slateApps(listed.result.body).filter((item) => item.name === appName);
  if (matches.length > 1) {
    const candidates = matches.map((app) => slateUrlOf(app.domain) ?? `app id ${app.id}`).join(', ');
    return { listed: true, apps: matches, note: `${matches.length} Slate apps named "${appName}" (${candidates}) — pass --slate-domain <host>` };
  }
  const app = matches[0];
  if (!app) return { listed: true, apps: [], note: `slate url not found: no app named "${appName}" in the project's Slate app list` };
  const direct = slateUrlOf(app.domain);
  if (direct) return { listed: true, apps: matches, url: direct };
  if (app.deploymentId) {
    const deployment = await restWithRetry(rest, { method: 'GET', path: `${base}/app/${app.id}/deployment/${app.deploymentId}`, origin: 'zgraphql' }, opts);
    if (deployment.result.status >= 200 && deployment.result.status < 300) {
      const url = slateUrlOf(slateDeploymentDomain(deployment.result.body));
      if (url) return { listed: true, apps: matches, url };
    }
  }
  return { listed: true, apps: matches, note: `slate url not found: the Slate app "${appName}" reports no served domain yet` };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function decimalOf(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}
