# Document pickers for file fields (`browse`)

Creator's file field `browse = local_drive, google_docs, zoho_docs` offers document stores beside the local drive.

## Default (no key): local upload plus the note

With default settings the generated app uploads from the local drive only. The field keeps its note ("Browse option(s) ... have no Catalyst equivalent; file uploads are supported from local drive only."). That note is **not** a counted TODO and never was (`docs/known-gaps.md`), so this construct does not affect the deterministic count: no app is non-deterministic because of it, and enabling the picker changes no count in `docs/determinism-status.md`. Generation stays byte-for-byte deterministic: no key, no third-party origin and no config line is written by `c2c generate` (a test asserts it).

## Google Drive picker (opt-in at deploy)

Supply two settings in the environment of `c2c deploy` (never committed, never in generated source):

| name | value |
|---|---|
| `C2C_GOOGLE_PICKER_API_KEY` | a Google API key with the Picker API enabled (browser key, restricted to the Slate origin) |
| `C2C_GOOGLE_PICKER_CLIENT_ID` | an OAuth web client id (`<digits>-<id>.apps.googleusercontent.com`); the leading digits are the project number passed as the picker app id |

Both or neither: one without the other, or a value of the wrong shape, stops the deploy naming the variable (never the value). They take effect only for an app with a top-level file field whose `browse` names `google_docs`; otherwise the deploy says so and changes nothing. A later deploy without them removes the opt-in again.

When enabled the deploy (a) writes `globalThis.C2C_DOC_PICKER` into `c2c-config.js` (the deploy-time config file, not content-hashed) and (b) adds exactly these origins to the shell CSP meta:

| directive | added origins |
|---|---|
| `script-src` | `https://apis.google.com`, `https://accounts.google.com` |
| `frame-src` | `https://docs.google.com`, `https://accounts.google.com` |
| `connect-src` | `https://www.googleapis.com` |

No wildcard, no `unsafe-inline`, no `unsafe-eval`. The origin list is `GOOGLE_PICKER_CSP` in `packages/ui/src/doc-picker.ts`. [UNVERIFIED] These are the origins documented for the Picker, Google Identity Services and the Drive v3 download; no run against live Google was made, so a browser console CSP violation naming another Google origin means that origin must be reviewed and added to the list deliberately.

Runtime behaviour (vanilla and React): a "Choose from Google Drive" button appears beside the local upload only when the config carries the key. It asks for the `drive.file` scope only, shows the Google Picker, refuses a Google-native document (Docs, Sheets, Slides: export one first), an id that is not a plain Drive id, a file over the shared 100 MiB upload cap (declared size and read size) and a type the field's `accept` does not allow, then downloads the one chosen file and hands it to the same signed upload as a picked file. The local upload stays available.

## Zoho WorkDrive (`zoho_docs`): still local upload plus the note

No Zoho WorkDrive picker script or frame contract is documented in this repository's facts, so nothing is generated and nothing about it is guessed. A `zoho_docs` source keeps the note. [UNVERIFIED] whether WorkDrive offers an embeddable picker.

## Determinism

The definition in `docs/determinism-status.md` is "no residual TODO and no silent drop". The browse note is a generated note, not a TODO, and a configured key is deploy-time state outside the generator. So: with default settings the app is as deterministic as before (counted or not exactly as it was); this lane flips no app and the count stays as the status doc says.
