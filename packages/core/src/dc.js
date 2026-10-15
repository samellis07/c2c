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
};
export const KNOWN_DCS = Object.keys(DC_ENDPOINTS);
/** Other spellings in use: the domain suffix (c2c-deploy.json `zohoDc`, zcatalyst-cli `active_dc`) and the CLI's `uae`. */
export const DC_ALIASES = { com: 'us', 'com.au': 'au', uae: 'ae' };
function dc(ext) {
    return {
        creator: `https://www.zohoapis.${ext}`,
        catalyst: `https://api.catalyst.zoho.${ext}`,
        accounts: `https://accounts.zoho.${ext}`,
        console: `https://console.catalyst.zoho.${ext}`,
        suffixes: [`zoho.${ext}`, `zohoapis.${ext}`],
    };
}
export class UnknownDcError extends Error {
    dc;
    constructor(value) {
        super(`unknown data centre "${value}"; valid values: ${KNOWN_DCS.join(', ')}`);
        this.name = 'UnknownDcError';
        this.dc = value;
    }
}
/** Canonical key for a DC spelling, or undefined when it is not a known DC. */
export function normalizeDc(value) {
    const key = value.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DC_ENDPOINTS, key))
        return key;
    return DC_ALIASES[key];
}
/** Canonical key for a DC spelling. Throws {@link UnknownDcError} listing the valid ones. */
export function parseDc(value) {
    const key = normalizeDc(value);
    if (!key)
        throw new UnknownDcError(value);
    return key;
}
export function dcEndpoints(value) {
    return DC_ENDPOINTS[parseDc(value)];
}
export function catalystBaseFor(value) {
    return dcEndpoints(value).catalyst;
}
/** CRM/Books/Creator/Desk/Cliq hosts for a DC spelling, or undefined when it is not a known DC. */
export function zohoConnectionHosts(value) {
    const key = normalizeDc(value);
    if (!key)
        return undefined;
    const endpoints = DC_ENDPOINTS[key];
    const suffix = new URL(endpoints.accounts).hostname.replace(/^accounts\./, '');
    return {
        apis: new URL(endpoints.creator).origin,
        desk: `https://desk.${suffix}`,
        cliq: `https://cliq.${suffix}`,
    };
}
/** Canonical keys, then accepted spellings (`com`, `com.au`, `uae`). */
export function zohoDcSpellings() {
    return [...KNOWN_DCS, ...Object.keys(DC_ALIASES)];
}
/**
 * ESM the function bundle vendors beside the shims. The runtime must not
 * import packages/core; this module is the same table, generated from it.
 */
export function zohoConnectionHostModuleSource() {
    const hosts = {};
    for (const dc of KNOWN_DCS) {
        const row = zohoConnectionHosts(dc);
        if (!row)
            throw new Error(`missing Zoho hosts for ${dc}`);
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
export function creatorBaseFor(value) {
    return dcEndpoints(value).creator;
}
export const DC_HOW_TO_SET = 'pass --dc <dc>, set "dc" in c2c-deploy.json, or log the Catalyst CLI in to your data centre (catalyst login --dc <dc>)';
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
export function resolveDc(candidates) {
    for (const item of candidates) {
        if (item.value === undefined || item.value === null || item.value.trim() === '')
            continue;
        const key = normalizeDc(item.value);
        if (!key)
            throw new UnknownDcError(item.value);
        return { dc: key, source: item.source, origin: item.origin };
    }
    throw new DcNotConfiguredError();
}
export function describeDc(resolved) {
    return `data centre: ${resolved.dc} (from ${resolved.origin})`;
}
