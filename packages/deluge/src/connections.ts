/**
 * Connections analysis: every `zoho.<svc>.<task>(…)` and every `invokeurl`
 * with `connection:` in an app's Deluge, grouped by Creator connection link
 * name. Feeds the migration report's `connections` section and the
 * per-project Catalyst Connections checklist (CONNECTIONS.md).
 *
 * Parse-only: no network, no credentials.
 */
import { unquote, type App } from '../../core/src/ir.js';
import { compareEnUs } from '../../core/src/order.js';
import { SERVICE_NAMES, TASK_ADAPTERS, adapterFor, dcOfUrl, invokeurlScope, serviceOfUrl, type ZohoService } from '../../shims/src/zoho-adapters.js';
import type { Expr } from './ast.js';
import { ZOHO_ENV, dispatchGet } from './dispatch.js';
import { parse } from './parser.js';

export interface ConnectionUse {
  /** `crm.createRecord` or `invokeurl GET`. */
  task: string;
  /** Workflow or function name, plus the event for a workflow. */
  where: string;
  /** Minimal scope, or null when it cannot be derived from the call. */
  scope: string | null;
  /** True when a product adapter exists for the task. */
  adapter: boolean;
  /** invokeurl only: the literal URL prefix when the URL starts with a string. */
  url?: string;
}

export interface ConnectionEntry {
  /** Creator connection link name (null when the call passes none or a non-literal). */
  link: string | null;
  service: ZohoService | null;
  serviceName: string | null;
  uses: ConnectionUse[];
  /** Sorted, distinct minimal scopes over `uses`. */
  scopes: string[];
  /** Proposed Catalyst connection name: the Creator link name. */
  catalystName: string | null;
  /** c2c-deploy.json `connections` key: the link name, or `default:<service>` for calls that name none. */
  configKey: string;
}

export interface ConnectionsReport {
  entries: ConnectionEntry[];
  /** Integration tasks with no adapter (`zoho-task:<path>`). */
  unsupported: string[];
  /** DCs named by absolute invokeurl URLs. */
  urlDcs: string[];
  diagnostics: string[];
}

const SERVICES = new Set(['crm', 'books', 'desk', 'cliq', 'creator']);

/** A connection declared in the application's `connections` block. */
export interface DeclaredConnection {
  /** Block link name. */
  link: string;
  /** Decoded `displayname`, or null when the block declares none. */
  displayName: string | null;
  /** Scope names the block's `permissions = {...}` literal grants, in source order. */
  scopes: string[];
  /** Count of `permissions` values that are not scope-name shaped (never echoed: one may be a secret or a URL). */
  unverified: number;
}

/** A scope name: identifier-shaped, no punctuation a URL or key could carry. */
const SCOPE_NAME = /^[A-Za-z][A-Za-z0-9_.]*$/;

/**
 * Scope names in a `permissions = {"a","b"}` literal. A value that is not
 * scope-name shaped never enters the report: `permissions` sits beside
 * `client_secret` and `url`, so a stray value may be sensitive. It is counted
 * in `unverified` instead.
 */
export function permissionScopes(raw: string | undefined): { scopes: string[]; unverified: number } {
  if (!raw) return { scopes: [], unverified: 0 };
  const body = raw.trim().replace(/^\{/, '').replace(/\}\s*$/, '');
  const scopes: string[] = [];
  let unverified = 0;
  for (const token of body.split(',')) {
    const s = unquote(token.trim()).trim();
    if (!s) continue;
    if (SCOPE_NAME.test(s)) scopes.push(s);
    else unverified++;
  }
  return { scopes, unverified };
}

export type ConnectionArgResolution =
  | { kind: 'link' }
  | { kind: 'display'; link: string }
  | { kind: 'ambiguous'; links: string[] }
  | { kind: 'none' };

/** Connection blocks on the app. The block name is the link name. */
export function declaredConnections(app: App): DeclaredConnection[] {
  const out: DeclaredConnection[] = [];
  for (const block of app.configuration) {
    if (block.name.toLowerCase() !== 'connections') continue;
    for (const child of block.blocks) {
      const raw = child.properties.find((property) => property.key.toLowerCase() === 'displayname')?.value;
      const displayName = raw == null ? '' : unquote(raw).trim();
      const { scopes, unverified } = permissionScopes(child.properties.find((property) => property.key.toLowerCase() === 'permissions')?.value);
      out.push({ link: child.name.trim(), displayName: displayName || null, scopes, unverified });
    }
  }
  return out;
}

/**
 * How a connection argument relates to the declared connections.
 * A value that is some connection's link name stays a link name.
 * A value that equals exactly one other connection's display name resolves
 * to that link name. Two display names is ambiguous: the value is not replaced.
 */
export function resolveConnectionArgument(argument: string, declared: readonly DeclaredConnection[]): ConnectionArgResolution {
  const value = argument.trim();
  if (!value || !declared.length) return { kind: 'none' };
  if (declared.some((item) => item.link === value)) return { kind: 'link' };
  const links = [
    ...new Set(declared.filter((item) => item.displayName === value && item.link !== value).map((item) => item.link)),
  ].sort(compareEnUs);
  if (links.length === 1) return { kind: 'display', link: links[0]! };
  if (links.length > 1) return { kind: 'ambiguous', links };
  return { kind: 'none' };
}

/** Link name to record. A unique display name becomes its link name. Anything else stays as written. */
export function connectionLinkFor(argument: string | null, declared: readonly DeclaredConnection[]): string | null {
  if (argument == null) return null;
  const resolved = resolveConnectionArgument(argument, declared);
  return resolved.kind === 'display' ? resolved.link : argument;
}

/**
 * Index of the connection argument on `zoho.<service>.<task>`, or null.
 * Adapted tasks use the adapter's connection index. An unadapted task of a
 * known service uses its last argument, which is the same position the
 * connection report records.
 */
export function connectionArgIndex(path: readonly string[], argCount: number): number | null {
  if (path.length !== 2 || argCount < 1) return null;
  if (!SERVICES.has(path[0]!.toLowerCase())) return null;
  const hit = adapterFor(path);
  if (hit) {
    const index = hit.adapter.connectionIndex;
    return index >= 0 && index < argCount ? index : null;
  }
  return argCount - 1;
}

export function memberChain(e: Expr): string[] | null {
  if (e.kind === 'name') return [e.name];
  if (e.kind === 'member') {
    const head = memberChain(e.object);
    return head ? [...head, e.property] : null;
  }
  return null;
}

function literal(e: Expr | undefined): string | null {
  if (!e) return null;
  if (e.kind === 'string') return e.value;
  if (e.kind === 'paren') return literal(e.expr);
  return null;
}

/** Leading string of a `"https://…" + x` URL. */
function urlPrefix(e: Expr | undefined, assigned: Map<string, Expr>): string | null {
  if (!e) return null;
  if (e.kind === 'string') return e.value;
  if (e.kind === 'binary' && e.op === '+') return urlPrefix(e.left, assigned);
  if (e.kind === 'name' && assigned.has(e.name)) return urlPrefix(assigned.get(e.name), new Map());
  return null;
}

/** True when the expression calls `thisapp.<fn>(…)` anywhere. */
function usesThisapp(e: Expr): boolean {
  let found = false;
  walk(e, (n) => {
    if (n.kind === 'call') {
      const chain = memberChain(n.callee as Expr);
      if (chain && chain[0] === 'thisapp') found = true;
    }
  });
  return found;
}

export function walk(node: unknown, visit: (n: { kind: string } & Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as { kind?: unknown } & Record<string, unknown>;
  if (typeof obj.kind === 'string') visit(obj as { kind: string } & Record<string, unknown>);
  // determinism-allow: AST key order is the parser's construction order, so the walk follows source order
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'span') continue;
    walk(value, visit);
  }
}

interface RawUse extends ConnectionUse {
  link: string | null;
  service: ZohoService | null;
  dc?: string | null;
}

/** Uses in one script. `assigned` is the last string-ish assignment per local, for invokeurl URLs held in a variable. */
export function scriptUses(text: string, where: string): { uses: RawUse[]; diagnostics: string[] } {
  const uses: RawUse[] = [];
  const diagnostics: string[] = [];
  let script;
  try {
    script = parse(text);
  } catch (err) {
    return { uses, diagnostics: [`${where}: parse failed (${err instanceof Error ? err.message : String(err)})`] };
  }
  const assigned = new Map<string, Expr>();
  const fromThisapp = new Set<string>();
  const stubbed = (e: Expr) => usesThisapp(e) || (e.kind === 'name' && fromThisapp.has(e.name));
  walk(script, (n) => {
    if (n.kind === 'assign' && (n.target as Expr).kind === 'name') {
      const name = (n.target as { name: string }).name;
      if (usesThisapp(n.value as Expr)) fromThisapp.add(name);
      else fromThisapp.delete(name);
      const prefix = urlPrefix(n.value as Expr, assigned);
      if (prefix && /^https?:\/\//.test(prefix)) assigned.set(name, n.value as Expr);
    }
    if (n.kind === 'call') {
      const chain = memberChain(n.callee as Expr);
      if (!chain || chain[0] !== 'zoho' || chain.length !== 3) return;
      const path = chain.slice(1);
      const args = n.args as Expr[];
      const hit = adapterFor(path);
      // Computed locally: no connection and no checklist row.
      if (hit?.adapter.local) return;
      // Date, time, and app env roots are evaluated locally by the translator, never a service call.
      if (!hit && dispatchGet(ZOHO_ENV, chain[1]!.toLowerCase())) return;
      if (!hit) {
        const last = literal(args[args.length - 1]);
        uses.push({ task: path.join('.'), where, scope: null, adapter: false, link: last, service: SERVICES.has(chain[1]!) ? (path[0] as ZohoService) : null });
        return;
      }
      if (args.some((a, i) => i !== hit.adapter.connectionIndex && stubbed(a))) diagnostics.push(`${where}: zoho.${hit.key} takes an argument from thisapp.<function>(); the runtime runs thisapp calls as dry-run stubs, so a live call is refused until that value is inlined or the function is ported`);
      const connArg = args[hit.adapter.connectionIndex];
      const link = literal(connArg);
      if (connArg && !link) diagnostics.push(`${where}: zoho.${hit.key} connection argument is not a string literal`);
      if (hit.adapter.connectionIndex < 0) diagnostics.push(`${where}: zoho.${hit.key} has no connection parameter in Deluge; a live call uses the configured default:${hit.adapter.service} connection`);
      else if (!connArg) diagnostics.push(`${where}: zoho.${hit.key} passes no connection (a Catalyst connection is still needed)`);
      const scope = hit.adapter.scope(args.map((a) => literal(a)));
      uses.push({ task: hit.key, where, scope: scope.includes('..') ? null : scope, adapter: true, link, service: hit.adapter.service });
      if (path.some((p, i) => p !== hit.key.split('.')[i])) diagnostics.push(`${where}: zoho.${path.join('.')} matched adapter ${hit.key} case-insensitively`);
    }
    if (n.kind === 'invokeurl') {
      const entries = n.entries as { key: string; value: Expr }[];
      const get = (key: string) => entries.find((e) => e.key.toLowerCase() === key)?.value;
      const connExpr = get('connection');
      const typeExpr = get('type');
      const method = typeExpr?.kind === 'name' ? typeExpr.name.toUpperCase() : (literal(typeExpr)?.toUpperCase() ?? 'GET');
      if (!connExpr) {
        diagnostics.push(`${where}: invokeurl ${method} names no connection; a live call still needs a configured connection, and the service and scope need a human`);
        uses.push({ task: `invokeurl ${method}`, where, scope: null, adapter: false, link: null, service: null });
        return;
      }
      const link = literal(connExpr);
      const url = urlPrefix(get('url'), assigned);
      const service = url ? serviceOfUrl(url) : null;
      const scope = url ? invokeurlScope(url, method) : null;
      if (!url) diagnostics.push(`${where}: invokeurl ${method} URL is not a literal; service and scope need a human`);
      uses.push({ task: `invokeurl ${method}`, where, scope, adapter: true, link, service, ...(url ? { url, dc: dcOfUrl(url) } : {}) });
    }
  });
  return { uses, diagnostics };
}

/** All Deluge in the app, with a readable location. */
function scripts(app: App): { text: string; where: string }[] {
  const out: { text: string; where: string }[] = [];
  for (const w of app.workflows) if (w.deluge) out.push({ text: w.deluge.text, where: `${w.name} (${w.event})` });
  for (const fn of app.functions) for (const d of fn.deluge) out.push({ text: d.text, where: `function ${fn.name}` });
  return out;
}

export function analyzeConnections(app: App): ConnectionsReport {
  const raw: RawUse[] = [];
  const diagnostics: string[] = [];
  for (const s of scripts(app)) {
    const r = scriptUses(s.text, s.where);
    raw.push(...r.uses);
    diagnostics.push(...r.diagnostics);
  }
  // A workflow that calls a function holding connection calls: thisapp calls run as dry-run stubs.
  const holders = new Set(app.functions.filter((fn) => raw.some((u) => u.where === `function ${fn.name}`)).map((fn) => fn.name));
  for (const w of app.workflows) {
    if (!w.deluge) continue;
    for (const name of [...holders].sort(compareEnUs)) {
      if (new RegExp(`\\bthisapp\\.${name}\\s*\\(`).test(w.deluge.text)) {
        diagnostics.push(`${w.name} (${w.event}): calls thisapp.${name}(), which makes connection calls; the runtime runs thisapp calls as dry-run stubs, so those calls do not run live until the function is ported`);
      }
    }
  }
  const declared = declaredConnections(app);
  const byLink = new Map<string, ConnectionEntry>();
  for (const use of raw) {
    const link = connectionLinkFor(use.link, declared);
    const key = link ?? `default:${use.service ?? 'unknown'}`;
    let entry = byLink.get(key);
    if (!entry) {
      entry = { link, service: null, serviceName: null, uses: [], scopes: [], catalystName: link, configKey: link ?? `default:${use.service ?? 'unknown'}` };
      byLink.set(key, entry);
    }
    if (use.service && entry.service && use.service !== entry.service) diagnostics.push(`connection ${link}: used for ${entry.service} and ${use.service}`);
    entry.service = entry.service ?? use.service;
    entry.uses.push({ task: use.task, where: use.where, scope: use.scope, adapter: use.adapter, ...(use.url ? { url: use.url } : {}) });
  }
  // determinism-allow: Map insertion order is source order; entries are sorted before they are returned
  for (const entry of byLink.values()) {
    entry.serviceName = entry.service ? SERVICE_NAMES[entry.service] : null;
    entry.scopes = [...new Set(entry.uses.map((u) => u.scope).filter((s): s is string => !!s))].sort(compareEnUs);
    if (entry.uses.some((u) => !u.scope)) diagnostics.push(`connection ${entry.link ?? '(none)'}: a call has no derivable scope; add it by hand`);
  }
  const entries = [...byLink.values()].sort((a, b) => compareEnUs(a.link ?? '', b.link ?? ''));
  // A `permissions = {...}` literal on a declared connection is its granted
  // scope list: nothing else reads it, so the report lists it for the user to
  // carry onto the Catalyst connection.
  for (const d of declared) {
    if (d.scopes.length) diagnostics.push(`connection ${d.link}: declares granted scopes ${d.scopes.join(', ')}; carry them to the Catalyst connection`);
    if (d.unverified) diagnostics.push(`connection ${d.link}: permissions literal lists ${d.unverified} value(s) that are not scope names; verify them by hand`);
  }
  const unsupported = [...new Set(raw.filter((u) => !u.adapter).map((u) => (u.task.startsWith('invokeurl ') ? u.task : `zoho-task:${u.task}`)))].sort(compareEnUs);
  const urlDcs = [...new Set(raw.map((u) => u.dc).filter((d): d is string => !!d))].sort(compareEnUs);
  // determinism-allow: diagnostics keep source order (script order, then call order)
  return { entries, unsupported, urlDcs, diagnostics: [...new Set(diagnostics)] };
}

/** Optional evidence of the scopes each connection link was granted (`scopes.<link>`). */
export interface ScopeEvidence {
  proposed?: string[];
  granted?: unknown;
  refusedWith?: unknown;
}

/** The Catalyst Connections checklist for one converted app (CONNECTIONS.md). */
export function connectionsChecklist(appName: string, report: ConnectionsReport, evidence: Record<string, ScopeEvidence> = {}): string {
  const out: string[] = [
    `# Catalyst Connections checklist: ${appName}`,
    '',
    'Generated by the converter. Catalyst cannot create or authorise a Connection from code. Create each one in the Catalyst console (CloudScale → Connections → Create Connection → Default Service → the Zoho service), authorise it with the scopes below, then put its name in `functions/c2c-deploy.json` `connections` and set `zohoDc`.',
    '',
    'Runtime: live calls use `app.connections().getConnectionCredentials(<name>)` (Catalyst Node SDK v3.2.0+). Docs: https://docs.catalyst.zoho.com/en/cloud-scale/help/connections/ . Dry run is the default; a live call is refused unless `mode` is `live`, `zohoDc` is set, and the Creator link name maps to a connection name.',
    '',
  ];
  if (!report.entries.length) {
    out.push('This app makes no connection calls. Nothing to create.', '');
    return out.join('\n');
  }
  out.push('| Create connection (name) | Service | Minimal scopes | Creator link | Used by |', '| --- | --- | --- | --- | --- |');
  for (const e of report.entries) {
    const used = e.uses.map((u) => `\`${u.task}\` in ${u.where}`).join('<br>');
    out.push(`| \`${e.catalystName ?? '(choose a name)'}\` | ${e.serviceName ?? 'unknown (needs a human)'} | ${e.scopes.length ? e.scopes.map((s) => `\`${s}\``).join('<br>') : 'none derivable'} | ${e.link ? `\`${e.link}\`` : `(none: set \`${e.configKey}\`)`} | ${used} |`);
  }
  out.push('');
  const manualUses = report.entries.flatMap((entry) => entry.uses.filter((use) => !use.adapter).map((use) => ({ entry, use })));
  const detected = report.entries.reduce((n, entry) => n + entry.uses.length, 0);
  const generated = detected - manualUses.length;
  out.push(
    '',
    `## Integration coverage (${detected} detected calls)`,
    '',
    'Adapter-backed calls are generated. Calls without an adapter are counted below as manual work and remain dry-run only; the connection name and derivable scope are shown for each call.',
    '',
    `Generated calls: ${generated}. Manual integration calls: ${manualUses.length}. Manual connection setup steps: ${report.entries.length} (the owner must create and authorize each connection with their credentials).`,
    '',
  );
  if (manualUses.length) {
    out.push('### Manual integration calls', '');
    for (const { entry, use } of manualUses) {
      out.push(`- [ ] \`${use.task}\` in ${use.where}: connection \`${entry.catalystName ?? entry.configKey}\`; service ${entry.serviceName ?? 'unknown (identify by hand)'}; scope ${use.scope ? `\`${use.scope}\`` : 'not derivable (identify and authorize by hand)'}.`);
    }
    out.push('');
  }
  const withEvidence = report.entries.filter((e) => e.link && evidence[e.link]);
  if (withEvidence.length) {
    out.push('## Creator scope evidence', '');
    for (const e of withEvidence) {
      const ev = evidence[e.link!]!;
      out.push(`- \`${e.link}\`: proposed ${ev.proposed?.length ? ev.proposed.map((s) => `\`${s}\``).join(', ') : 'none'}; granted in Creator: ${typeof ev.granted === 'string' ? ev.granted : JSON.stringify(ev.granted ?? null)}${ev.refusedWith ? `; refused with: ${JSON.stringify(ev.refusedWith)}` : ''}`);
      const extra = e.scopes.filter((s) => !(ev.proposed ?? []).includes(s));
      if (extra.length) out.push(`  - derived but not in the proposed set: ${extra.map((s) => `\`${s}\``).join(', ')}`);
    }
    out.push('');
  }
  const messaging = report.entries.some((e) => e.service === 'cliq');
  const orgInternal = messaging ? { orgInternal: { cliqChannels: ['<org-internal channel unique name>'], mailRecipients: ['@<your org domain>'] } } : {};
  out.push('## c2c-deploy.json', '', '```json', JSON.stringify({ mode: 'live', zohoDc: report.urlDcs[0] ?? '<in|com|eu|com.au|jp>', connections: Object.fromEntries(report.entries.map((e) => [e.configKey, e.catalystName ?? '<connection name>'])), ...orgInternal }, null, 2), '```', '');
  if (messaging) {
    out.push(
      '## Messaging guard (org-internal destinations only)',
      '',
      'A live Cliq post (`postToChannel`, `postToUser`, bots, chats, or an `invokeurl` write to a Cliq message endpoint), a live `sendmail`, and a live `invokeurl` write to Zoho Mail (`mail.zoho.*`, recipients read from `toAddress`/`ccAddress`/`bccAddress`) go only to destinations listed in `orgInternal`. Anything else throws `ZohoConnectionRefused` (`owner-approval`) naming the destination, before any credential or request. A mail with one outside recipient is refused as a whole; a mail write whose recipients cannot be read is refused. A missing or empty `orgInternal` refuses every live message. Dry run is unchanged.',
      '',
      '- Deny by default: a live `invokeurl` write (POST/PUT/PATCH/DELETE) to a Zoho host is allowed without the token only as a record write to CRM, Books, Creator (zohoapis) or Desk. A write to any other Zoho endpoint, or to a send/email/reminder endpoint of those services, is refused naming its host and path. A write to a non-Zoho host is not inspected by this guard: it needs the configured connection like any other call.',
      '',
      '- Org-internal means: a Cliq channel of the owner\'s own Zoho organisation (listed by its unique name), or a mail address/domain the owner\'s organisation controls. Cliq `postToUser` is checked against `mailRecipients`. Bots, chats and channel ids are never allowlisted.',
      '- Public forums, community channels and any destination outside the owner\'s organisation are never valid `orgInternal` entries.',
      '- A one-off owner-approved send needs `C2C_OWNER_APPROVAL_TOKEN` set in the function environment by the owner. It is never written to a file or the transcript. Scope it to what it approves: `<destination>=<token>` pairs separated by commas, or a JSON map `{"<destination>": "<token>"}` (a mail address or `@domain`, a Cliq channel name, or the `host/path` of an unclassified Zoho write). A plain token approves every outside destination on that deploy.',
      '',
    );
  }
  if (report.unsupported.length) out.push('## No adapter (dry run only)', '', ...report.unsupported.map((u) => `- ${u}`), '');
  if (report.diagnostics.length) out.push('## Diagnostics', '', ...report.diagnostics.map((d) => `- ${d}`), '');
  return out.join('\n');
}

/** Task keys the adapters cover (for docs and tests). */
export const ADAPTED_TASKS = Object.keys(TASK_ADAPTERS).sort(compareEnUs);
