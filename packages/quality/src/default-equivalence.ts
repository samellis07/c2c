import type { UiField, Widget } from '../../ui/src/model.js';

/**
 * Field properties whose Creator value describes exactly what the generated
 * widget already does. The generators ignore these properties: the generated
 * output for a field carrying the listed value is byte-identical to the same
 * field without it (packages/quality/test/default-equivalence.test.ts), and
 * the reason column says why that output behaves as Creator does for that
 * value. Only the exact listed value is proved; any other value of the same
 * property (for example `source = public_url,file`, which offers a URL entry
 * the generated widget does not draw) stays a silent drop.
 *
 * Not listed on purpose: `timedisplayoptions = "hh:mm:ss"` (the generated
 * datetime-local input shows hours and minutes, not seconds) and
 * `toolbar = enable` (a rich text field is generated as a plain textarea).
 */
export interface DefaultEquivalence {
  /** Generated widget the field must have. */
  widget: Widget;
  /** Accept filter the generated file input must carry (undefined: none). */
  accept: string | undefined;
  /** Property key, lower case with single spaces. */
  key: string;
  /** The one value, after unquoting and trimming, that is proved. */
  value: string;
  why: string;
}

export const DEFAULT_EQUIVALENCE: readonly DefaultEquivalence[] = [
  {
    widget: 'image',
    accept: 'image/*',
    key: 'source',
    value: 'file',
    why: 'Image comes from an uploaded file only. The generated field offers only a device file picker (a file input in the static UI, a drop zone in the React app) and uploads one chosen image; it has no URL entry.',
  },
  {
    widget: 'image',
    accept: 'image/*',
    key: 'aspect ratio',
    value: 'original',
    why: 'The image keeps its original proportions. The generated upload sends the chosen file unchanged; it never crops or resizes.',
  },
  {
    widget: 'image',
    accept: 'image/*',
    key: 'camera',
    value: 'primary',
    why: 'Capture uses the device default camera. The generated input sets no capture attribute, so a phone opens its own camera on its default (primary) lens.',
  },
  {
    widget: 'image',
    accept: 'image/*',
    key: 'switch camera',
    value: 'true',
    why: 'The user may switch cameras. The generated input hands capture to the device camera app, which offers the switch.',
  },
  {
    widget: 'image',
    accept: 'image/*',
    key: 'show gallery',
    value: 'true',
    why: 'The user may pick an existing photo. The generated input has no capture attribute, so the device picker offers the photo library next to the camera.',
  },
  {
    widget: 'file',
    accept: undefined,
    key: 'browse',
    value: 'local_drive',
    why: 'Files come from the local drive only. The generated field offers only a device file picker (a file input in the static UI, a drop zone in the React app) and has no cloud document picker.',
  },
];

/** True when `key = text` is a listed default the generated widget `ui` already behaves as. */
export function defaultEquivalent(key: string, text: string, ui: UiField | undefined): boolean {
  if (!ui || ui.status !== 'generated') return false;
  return DEFAULT_EQUIVALENCE.some((row) => row.key === key && row.value === text && row.widget === ui.widget && row.accept === ui.accept);
}
