/**
 * The opt-in Google Drive picker for a `browse = google_docs` file field.
 *
 * Off unless the deployer's runtime config (`globalThis.C2C_DOC_PICKER`, written
 * by `c2c deploy` from C2C_GOOGLE_PICKER_API_KEY and C2C_GOOGLE_PICKER_CLIENT_ID)
 * carries a key. Asks for the `drive.file` scope only, refuses Google-native
 * documents and ids that are not plain Drive ids, bounds the download by the
 * shared upload cap, then hands back a File that takes the same signed upload
 * as a picked file. The two script URLs are constants here: no configured or
 * user value reaches a `src`.
 */
import type { FieldSpec } from '../types';
import { UPLOAD_SOURCE_MAX_BYTES, uploadSourceBlob, uploadSourceTypeOk } from './record';

const GOOGLE_API_SCRIPT = 'https://apis.google.com/js/api.js';
const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';
const GOOGLE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;

export interface GooglePickerConfig {
  apiKey: string;
  clientId: string;
}

/** The slice of the window the picker touches; a test passes a fake. */
export type PickerView = Record<string, any> & { document: Document };

/** The deployer's picker settings, or null when none are configured (the default). */
export function googlePickerConfig(view: Record<string, any> = (typeof window !== 'undefined' ? window : globalThis) as Record<string, any>): GooglePickerConfig | null {
  const google = view.C2C_DOC_PICKER?.google;
  if (!google || typeof google.apiKey !== 'string' || typeof google.clientId !== 'string' || !google.apiKey || !google.clientId) return null;
  return { apiKey: google.apiKey, clientId: google.clientId };
}

function loadGoogleScript(view: PickerView, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = view.document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('script'));
    view.document.head.appendChild(script);
  });
}

const limitText = `${UPLOAD_SOURCE_MAX_BYTES / (1024 * 1024)} MB`;

/** Resolves to a File, null when the user cancels, or `{ error }` with a message the field can show. */
export async function pickGoogleDoc(field: Pick<FieldSpec, 'accept'>, view: PickerView): Promise<File | { error: string } | null> {
  const config = googlePickerConfig(view);
  if (!config) return { error: 'The Google Drive picker is not configured; choose a file from this device.' };
  try {
    if (!view.gapi) await loadGoogleScript(view, GOOGLE_API_SCRIPT);
    if (!view.google?.accounts?.oauth2) await loadGoogleScript(view, GOOGLE_IDENTITY_SCRIPT);
    await new Promise<void>((resolve) => view.gapi.load('picker', () => resolve()));
    const token = await new Promise<string>((resolve, reject) => {
      const client = view.google.accounts.oauth2.initTokenClient({
        client_id: config.clientId,
        scope: GOOGLE_DRIVE_SCOPE,
        callback: (response: { access_token?: string }) => (response?.access_token ? resolve(response.access_token) : reject(new Error('auth'))),
        error_callback: () => reject(new Error('auth')),
      });
      client.requestAccessToken();
    });
    const picker = view.google.picker;
    const chosen = await new Promise<Record<string, unknown> | null>((resolve) => {
      new picker.PickerBuilder()
        .setDeveloperKey(config.apiKey)
        .setAppId(config.clientId.split('-')[0])
        .setOAuthToken(token)
        .addView(new picker.DocsView())
        .setCallback((response: Record<string, any>) => {
          const action = response[picker.Response.ACTION];
          if (action === picker.Action.PICKED) resolve((response[picker.Response.DOCUMENTS] ?? [])[0] ?? null);
          else if (action === picker.Action.CANCEL) resolve(null);
        })
        .build()
        .setVisible(true);
    });
    if (!chosen) return null;
    const id = String(chosen[picker.Document.ID] ?? '');
    const mime = String(chosen[picker.Document.MIME_TYPE] ?? '');
    const size = Number(chosen[picker.Document.SIZE_BYTES]);
    if (!GOOGLE_FILE_ID.test(id)) return { error: 'That Google Drive item could not be used.' };
    if (mime.toLowerCase().startsWith(GOOGLE_NATIVE_PREFIX)) return { error: 'Google-native documents (Docs, Sheets, Slides) cannot be attached; download or export one first.' };
    if (Number.isFinite(size) && size > UPLOAD_SOURCE_MAX_BYTES) return { error: `The file is larger than the ${limitText} limit.` };
    if (field.accept && !uploadSourceTypeOk(mime, field.accept)) return { error: 'That file type is not accepted by this field.' };
    const res: Response = await view.fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res?.ok) return { error: 'Google Drive did not return the file.' };
    const blob = await uploadSourceBlob(res);
    // eslint-disable-next-line no-control-regex
    const name = String(chosen[picker.Document.NAME] ?? 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 255) || 'file';
    return new (view.File as typeof File)([blob], name, { type: mime });
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'size') return { error: `The file is larger than the ${limitText} limit.` };
    return { error: 'Could not read the file from Google Drive.' };
  }
}
