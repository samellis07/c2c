/**
 * The customer's Zoho data centre (DC): the one table every package derives
 * Creator, Catalyst, accounts and console hosts from. No DC is implicit.
 *
 * Keys follow zcatalyst-cli's DC_TYPE (lib/util_modules/constants/lib/dc-type.js):
 * us, eu, in, au, ca, sa, jp, uae (ref `ae`). Hosts follow its mapDataCenterUrl:
 * the `.com` suffix becomes the DC's `ext`, and Canada uses `zohocloud.ca`.
 * The CLI lists no UK or China DC for Catalyst, so neither is accepted here.
 * Zoho multi-DC API domains: https://www.zoho.com/accounts/protocol/oauth/multi-dc.html
 */
export interface DcEndpoints {
  /** Creator REST API base (www.zohoapis.<ext>). */
  creator: string;
  /** Catalyst API base. */
  catalyst: string;
  accounts: string;
  console: string;
  /** Host suffixes a request for this DC may go to (host equals one or is a subdomain). */
  suffixes: readonly string[];
}

export const DC_ENDPOINTS = {
  us: dc('com'),
  eu: dc('eu'),
  in: dc('in'),
  au: dc('com.au'),
  jp: dc('jp'),
  ca: {
    creator: 'https://www.zohoapis.ca',
    catalyst: 'https://api.catalyst.zohocloud.ca',
    accounts: 'https://accounts.zohocloud.ca',
    console: 'https://console.catalyst.zohocloud.ca',
    suffixes: ['zoho.ca', 'zohoapis.ca', 'zohocloud.ca'],
  },
  sa: dc('sa'),
  ae: dc('ae'),
} as const satisfies Record<string, DcEndpoints>;

export type Dc = keyof typeof DC_ENDPOINTS;
export const KNOWN_DCS = Object.keys(DC_ENDPOINTS) as Dc[];

/** Other spellings in use: the domain suffix (c2c-deploy.json `zohoDc`, zcatalyst-cli `active_dc`) and the CLI's `uae`. */
export const DC_ALIASES: Readonly<Record<string, Dc>> = { com: 'us', 'com.au': 'au', uae: 'ae' };

/** Hosts a Zoho connection call uses. Derived from {@link DC_ENDPOINTS}; Canada follows accounts (`zohocloud.ca`). */
export interface ZohoConnectionHosts {
  /** `https://www.zohoapis.<ext>` — CRM, Books, Creator. */
  apis: string;
  /** `https://desk.zoho.<ext>` or `https://desk.zohocloud.ca`. */
  desk: string;
  /** `https://cliq.zoho.<ext>` or `https://cliq.zohocloud.ca`. */
  cliq: string;
}

function dc(ext: string): DcEndpoints {
  return {
    creator: `https://www.zohoapis.${ext}`,
    catalyst: `https://api.catalyst.zoho.${ext}`,
    accounts: `https://accounts.zoho.${ext}`,
    console: `https://console.catalyst.zoho.${ext}`,
    suffixes: [`zoho.${ext}`, `zohoapis.${ext}`],
  };
}

export class UnknownDcError extends Error {
  readonly dc: string;
  constructor(value: string) {
    super(`unknown data centre "${value}"; valid values: ${KNOWN_DCS.join(', ')}`);
    this.name = 'UnknownDcError';
    this.dc = value;
  }
}

/** Canonical key for a DC spelling, or undefined when it is not a known DC. */
export function normalizeDc(value: string): Dc | undefined {
  const key = value.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DC_ENDPOINTS, key)) return key as Dc;
  return Object.prototype.hasOwnProperty.call(DC_ALIASES, key) ? DC_ALIASES[key] : undefined;
}

/** Canonical key for a DC spelling. Throws {@link UnknownDcError} listing the valid ones. */
export function parseDc(value: string): Dc {
  const key = normalizeDc(value);
  if (!key) throw new UnknownDcError(value);
  return key;
}

export function dcEndpoints(value: string): DcEndpoints {
  return DC_ENDPOINTS[parseDc(value)];
}

export function catalystBaseFor(value: string): string {
  return dcEndpoints(value).catalyst;
}

/** CRM/Books/Creator/Desk/Cliq hosts for a DC spelling, or undefined when it is not a known DC. */
export function zohoConnectionHosts(value: string): ZohoConnectionHosts | undefined {
  const key = normalizeDc(value);
  if (!key) return undefined;
  const endpoints = DC_ENDPOINTS[key];
  const suffix = new URL(endpoints.accounts).hostname.replace(/^accounts\./, '');
  return {
    apis: new URL(endpoints.creator).origin,
    desk: `https://desk.${suffix}`,
    cliq: `https://cliq.${suffix}`,
  };
}

/** Canonical keys, then accepted spellings (`com`, `com.au`, `uae`). */
export function zohoDcSpellings(): readonly string[] {
  return [...KNOWN_DCS, ...Object.keys(DC_ALIASES)];
}

/**
 * ESM the function bundle vendors beside the shims. The runtime must not
 * import packages/core; this module is the same table, generated from it.
 */
export function zohoConnectionHostModuleSource(): string {
  const hosts: Record<string, ZohoConnectionHosts> = {};
  for (const dc of KNOWN_DCS) {
    const row = zohoConnectionHosts(dc);
    if (!row) throw new Error(`missing Zoho hosts for ${dc}`);
    hosts[dc] = row;
  }
  const table = JSON.stringify({ hosts, aliases: DC_ALIASES });
  return [
    '// Generated from packages/core/src/dc.ts DC_ENDPOINTS. Do not edit.',
    `const ZOHO_DC_TABLE = ${table};`,
    'export function zohoConnectionHosts(value) {',
    "  if (typeof value !== 'string') return undefined;",
    '  const key = value.trim().toLowerCase();',
    '  const canon = Object.prototype.hasOwnProperty.call(ZOHO_DC_TABLE.hosts, key) ? key : ZOHO_DC_TABLE.aliases[key];',
    '  return canon ? ZOHO_DC_TABLE.hosts[canon] : undefined;',
    '}',
    'export function zohoDcSpellings() {',
    '  return [...Object.keys(ZOHO_DC_TABLE.hosts), ...Object.keys(ZOHO_DC_TABLE.aliases)];',
    '}',
    '',
  ].join('\n');
}

export function creatorBaseFor(value: string): string {
  return dcEndpoints(value).creator;
}

/** Where a resolved DC came from, for dry-run output and the deploy report. */
export type DcSource = 'flag' | 'config' | 'registry' | 'catalyst-cli';

export interface DcCandidate {
  source: DcSource;
  /** Human label: `--dc`, the config file path, ... */
  origin: string;
  value: string | undefined | null;
}

export interface ResolvedDc {
  dc: Dc;
  source: DcSource;
  origin: string;
}

export const DC_HOW_TO_SET =
  'pass --dc <dc>, set "dc" in c2c-deploy.json, or log the Catalyst CLI in to your data centre (catalyst login --dc <dc>)';

export class DcNotConfiguredError extends Error {
  constructor() {
    super(`data centre is not configured; ${DC_HOW_TO_SET}. Valid values: ${KNOWN_DCS.join(', ')}`);
    this.name = 'DcNotConfiguredError';
  }
}

/**
 * First candidate that names a DC wins; candidates are in precedence order.
 * An unknown value is an error, never skipped. No candidate is an error, never IN.
 */
export function resolveDc(candidates: readonly DcCandidate[]): ResolvedDc {
  for (const item of candidates) {
    if (item.value === undefined || item.value === null || item.value.trim() === '') continue;
    const key = normalizeDc(item.value);
    if (!key) throw new UnknownDcError(item.value);
    return { dc: key, source: item.source, origin: item.origin };
  }
  throw new DcNotConfiguredError();
}

export function describeDc(resolved: ResolvedDc): string {
  return `data centre: ${resolved.dc} (from ${resolved.origin})`;
}
