/**
 * Opt-in document pickers for a file field's `browse` property
 * (docs/doc-pickers.md).
 *
 * Generated output never carries a key or a third-party origin. A deployer who
 * wants the Google Drive picker supplies two deploy-time settings in the
 * environment of `c2c deploy`; only then does the deploy write the runtime
 * config and widen the shell CSP, and only for an app that has such a field.
 * Without them the field is the local upload plus the existing note.
 */
import type { App } from '../../core/src/index.js';
import { buildModel } from './model.js';

/** Environment variable names; the values are the deployer's, never stored in generated source. */
export const DOC_PICKER_ENV = { apiKey: 'C2C_GOOGLE_PICKER_API_KEY', clientId: 'C2C_GOOGLE_PICKER_CLIENT_ID' } as const;

export interface DocPickerConfig {
  apiKey: string;
  clientId: string;
}

/**
 * The only origins the picker adds, per directive. script-src: the Google API
 * loader and Google Identity Services. frame-src: the picker frame and the
 * sign-in frame. connect-src: the Drive download of the one chosen file.
 */
export const GOOGLE_PICKER_CSP = {
  'script-src': ['https://apis.google.com', 'https://accounts.google.com'],
  'frame-src': ['https://docs.google.com', 'https://accounts.google.com'],
  'connect-src': ['https://www.googleapis.com'],
} as const;

const API_KEY = /^[A-Za-z0-9_-]{20,128}$/;
const CLIENT_ID = /^[0-9]{6,20}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/;

/**
 * Read the picker settings. Both unset (or empty) means "not configured" and
 * returns undefined. One set, or a value of the wrong shape, throws an error
 * that names the variable and never echoes the value.
 */
export function readDocPickerEnv(env: Readonly<Record<string, string | undefined>>): DocPickerConfig | undefined {
  const apiKey = (env[DOC_PICKER_ENV.apiKey] ?? '').trim();
  const clientId = (env[DOC_PICKER_ENV.clientId] ?? '').trim();
  if (!apiKey && !clientId) return undefined;
  if (!apiKey) throw new Error(`${DOC_PICKER_ENV.clientId} is set but ${DOC_PICKER_ENV.apiKey} is not; set both or neither`);
  if (!clientId) throw new Error(`${DOC_PICKER_ENV.apiKey} is set but ${DOC_PICKER_ENV.clientId} is not; set both or neither`);
  if (!API_KEY.test(apiKey)) throw new Error(`${DOC_PICKER_ENV.apiKey} is not a Google API key (letters, digits, - and _ only, 20 to 128 characters)`);
  if (!CLIENT_ID.test(clientId)) throw new Error(`${DOC_PICKER_ENV.clientId} is not a Google OAuth client id (<digits>-<id>.apps.googleusercontent.com)`);
  return { apiKey, clientId };
}

const CSP_META = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/;

/** Add the picker origins to the shell CSP meta. Idempotent; a document with no CSP meta is returned unchanged. */
export function applyDocPickerCsp(html: string): string {
  return html.replace(CSP_META, (_all, open: string, policy: string, close: string) => {
    const directives = policy.split(';').map((d) => d.trim()).filter(Boolean);
    for (const [name, origins] of Object.entries(GOOGLE_PICKER_CSP).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const at = directives.findIndex((d) => d.startsWith(`${name} `));
      if (at < 0) continue;
      const have = directives[at]!.split(/\s+/);
      for (const origin of origins) if (!have.includes(origin)) have.push(origin);
      directives[at] = have.join(' ');
    }
    return `${open}${directives.join('; ')};${close}`;
  });
}

/** Remove the picker origins again (a redeploy without a key must not leave the widened policy behind). */
export function stripDocPickerCsp(html: string): string {
  return html.replace(CSP_META, (_all, open: string, policy: string, close: string) => {
    const directives = policy.split(';').map((d) => d.trim()).filter(Boolean).map((directive) => {
      const [name = '', ...values] = directive.split(/\s+/);
      const added = (GOOGLE_PICKER_CSP as Record<string, readonly string[]>)[name] ?? [];
      return [name, ...values.filter((v) => !added.includes(v))].join(' ');
    });
    return `${open}${directives.join('; ')};${close}`;
  });
}

/** True when a top-level file field names `google_docs` in `browse`: the only case a configured key changes anything. */
export function appHasGoogleBrowse(app: App): boolean {
  return buildModel(app).forms.some((form) => form.fields.some((field) => field.browseSources?.includes('google_docs')));
}
