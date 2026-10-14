/**
 * Default field widgets. Each renders one Creator field inside a
 * [data-field] box with a visible label, a named record control and its
 * error. A custom Arc widget never gets `name`; its wrapper mirrors the
 * answer into named hidden inputs in the shape record.ts reads at submit.
 * The heavier widgets load lazily so a form only pays for the widgets it
 * draws; record.ts reads the hidden inputs, which exist either way.
 * Replace any of them per widget kind or per field through the
 * customization (runtime/extend.tsx); the generated forms only ever render
 * <Field name="..." />.
 */
import { lazy, Suspense, useContext, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Input } from '../arc/components/input/input';
import { Textarea } from '../arc/components/textarea/textarea';
import { Button } from '../arc/components/button/button';
import inputStyles from '../arc/components/input/input.module.css';
import { canonicalNumber, fractionDigits, localDay, parseLocalDay, toCanonicalDecimal, toMinorUnits } from './value';
import type { FieldSpec, FormSpec } from '../types';
import { useCustomization, type FieldProps } from '../runtime/extend';
import { useEnv } from '../runtime/env';
import { failureText } from '../runtime/StatusScreens';
import type { InkStroke } from '../arc/components/signature-pad/signature-pad';
import type { RichTextValue } from '../arc/components/rich-text-editor/rich-text-editor';
import { FormContext } from './context';

export { FormContext, type FormState } from './context';

const NumberField = lazy(() => import('../arc/components/number-field/number-field').then((m) => ({ default: m.NumberField })));
const MoneyInput = lazy(() => import('../arc/components/money-input/money-input').then((m) => ({ default: m.MoneyInput })));
const PhoneInput = lazy(() => import('../arc/components/phone-input/phone-input').then((m) => ({ default: m.PhoneInput })));
const DatePicker = lazy(() => import('../arc/components/date-picker/date-picker').then((m) => ({ default: m.DatePicker })));
const TimePicker = lazy(() => import('../arc/components/time-picker/time-picker').then((m) => ({ default: m.TimePicker })));
const RadioCards = lazy(() => import('../arc/components/radio-cards/radio-cards').then((m) => ({ default: m.RadioCards })));
const FileDropzone = lazy(() => import('../arc/components/file-dropzone/file-dropzone').then((m) => ({ default: m.FileDropzone })));
const SignaturePad = lazy(() => import('../arc/components/signature-pad/signature-pad').then((m) => ({ default: m.SignaturePad })));
const RichTextEditor = lazy(() => import('../arc/components/rich-text-editor/rich-text-editor').then((m) => ({ default: m.RichTextEditor })));
const LookupField = lazy(() => import('../lookup/LookupField').then((m) => ({ default: m.LookupField })));
const LookupMultiField = lazy(() => import('../lookup/LookupField').then((m) => ({ default: m.LookupMultiField })));
const SubformGrid = lazy(() => import('../subform/SubformGrid').then((m) => ({ default: m.SubformGrid })));

/** Native input types for the widgets with no custom control and for subform cells. */
const INPUT_TYPE: Record<string, string> = {
  text: 'text', email: 'email', phone: 'tel', url: 'url', number: 'number', decimal: 'number', percent: 'number', currency: 'number',
  date: 'date', datetime: 'datetime-local', time: 'time', users: 'email', richtext: 'text',
};

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
}

/** Signed download route for a stored file, image, audio, video or signature. The stored key is not a URL. */
function signedFilePath(form: FormSpec, field: FieldSpec): string {
  return `/files/${encodeURIComponent(form.name)}/${encodeURIComponent(field.name)}`;
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  const one = text(value);
  return one !== undefined ? [one] : [];
}

function optionsOf(field: FieldSpec): { value: string; label: string }[] {
  return (field.choices ?? []).map((choice) => ({ value: choice, label: choice }));
}

function Box({ field, children, className }: { field: FieldSpec; children: ReactNode; className?: string }) {
  return (
    <div className={['c2c-field', className].filter(Boolean).join(' ')} data-field={field.name} data-widget={field.widget} data-required={field.required || undefined}>
      {children}
    </div>
  );
}

/** `on user input` for widgets whose answer mirrors into a hidden input: no DOM change event reaches the form. */
function useNotify(name: string): () => void {
  const state = useContext(FormContext);
  return () => state?.notify?.(name);
}

function FieldError({ name, error, id }: { name: string; error?: string; id?: string }) {
  return error ? (
    <p id={id} className="c2c-error" data-error-for={name} role="alert">
      {error}
    </p>
  ) : null;
}

/**
 * The resting state a lazy widget grows out of. It is a real field box, not
 * just a shell: the label and a disabled control in the field's own shape, so
 * the layout, the label and the mandatory marker are final while the enhanced
 * widget loads, and a host that never resolves the lazy chunks still shows a
 * complete (if not editable) form.
 */
const LOADING_WIDGET = new Set(['file', 'image', 'audio', 'video', 'signature']);
function LoadingControl({ field, id }: { field: FieldSpec; id: string }) {
  const common = {
    id,
    disabled: true,
    required: field.required || undefined,
    'aria-required': field.required || undefined,
    'aria-label': field.label,
    className: inputStyles.input,
  };
  if (LOADING_WIDGET.has(field.widget)) return <input type="file" accept={field.accept} {...common} />;
  if (field.widget === 'decision') return <input type="checkbox" {...common} />;
  if (field.widget === 'multiselect' || field.widget === 'lookup-multi') {
    return (
      <select multiple size={Math.min(Math.max(field.choices?.length ?? 2, 2), 6)} {...common}>
        {optionsOf(field).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.widget === 'select' || field.widget === 'radio' || field.widget === 'lookup') {
    return (
      <select {...common}>
        <option value="" />
        {optionsOf(field).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.widget === 'textarea' || field.widget === 'richtext' || field.widget === 'notes') return <textarea {...common} />;
  if (field.widget === 'subform') {
    return (
      <fieldset data-subform={field.name} disabled>
        <input type="text" {...common} />
      </fieldset>
    );
  }
  return <input type={INPUT_TYPE[field.widget] ?? 'text'} {...common} />;
}

function FieldLoading({ field, bare }: { field: FieldSpec; bare?: boolean }) {
  const id = useId();
  return (
    <Box field={field} className="c2c-loading">
      <div className={inputStyles.field} aria-busy="true">
        {bare ? null : (
          <label className={`${inputStyles.label} c2c-label`} htmlFor={id}>
            {field.label}
          </label>
        )}
        <LoadingControl field={field} id={id} />
      </div>
    </Box>
  );
}

/** A widget whose record control is the hidden input `hidden` renders. */
function WidgetBox({ field, children, hidden }: { field: FieldSpec; children: ReactNode; hidden: ReactNode }) {
  return (
    <Box field={field}>
      <Suspense fallback={<FieldLoading field={field} />}>{children}</Suspense>
      {hidden}
    </Box>
  );
}

export function TextField({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  const type = INPUT_TYPE[field.widget] ?? 'text';
  return (
    <Box field={field}>
      <Input
        label={field.label}
        name={name}
        type={type}
        required={field.required}
        maxLength={field.maxLength}
        pattern={field.pattern}
        step={type === 'number' ? 'any' : undefined}
        defaultValue={text(value)}
        error={error}
      />
      <FieldError name={name} error={error} />
    </Box>
  );
}

export function TextAreaField({ field, error, value }: FieldProps) {
  return (
    <Box field={field}>
      <Textarea
        label={field.label}
        name={field.name}
        required={field.required}
        maxLength={field.maxLength}
        defaultValue={text(value)}
        error={error}
      />
      <FieldError name={field.name} error={error} />
    </Box>
  );
}

/** A number as its full digit string; String() would switch to exponent form at 1e21. */
function digitsOf(n: number, scale: number | null): string {
  if (scale !== null) return toCanonicalDecimal(n, scale);
  return Number.isInteger(n) ? BigInt(n).toString() : String(n);
}

/** A stored number as the text to post: exact digits, decimal and percent at their scale; blank or unreadable is ''. */
function storedNumber(value: unknown, scale: number | null): string {
  if (typeof value === 'number') return Number.isFinite(value) ? digitsOf(value, scale) : '';
  return typeof value === 'string' ? canonicalNumber(value, scale) ?? '' : '';
}

export function NumberFieldWrapper({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  // A whole-number field keeps its digits as given and steps in ones;
  // decimal and percent post and step at their stored scale.
  const scale = field.widget === 'number' ? null : field.decimalPlaces ?? 2;
  const digits = scale ?? 0;
  // The posted text, '' when empty. It is kept as text so a stored or typed
  // value posts exactly, however many digits it has.
  const [posted, setPosted] = useState<string>(() => storedNumber(value, scale));
  const typed = useRef('');
  const notify = useNotify(name);
  const change = (next: number) => {
    const exact = canonicalNumber(typed.current, scale);
    setPosted(exact !== null && Number(exact) === next ? exact : digitsOf(next, scale));
    notify();
  };
  return (
    <WidgetBox
      field={field}
      hidden={<input type="hidden" name={name} value={posted} />}
    >
      <div style={{ display: 'contents' }} onInputCapture={(event) => { typed.current = (event.target as HTMLInputElement).value ?? ''; }}>
        <NumberField
          label={field.label}
          defaultValue={num(value)}
          empty={posted === ''}
          onValueChange={change}
          onClear={() => setPosted('')}
          min={-Infinity}
          max={Infinity}
          step={10 ** -digits}
          formatOptions={{ minimumFractionDigits: digits, maximumFractionDigits: digits }}
          suffix={field.widget === 'percent' ? '%' : undefined}
          required={field.required}
        />
      </div>
      <FieldError name={name} error={error} />
    </WidgetBox>
  );
}

export function MoneyFieldWrapper({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  const scale = field.decimalPlaces ?? 2;
  const [code, setCode] = useState<string | undefined>(field.currencyCode);
  const digits = fractionDigits(code);
  const [minor, setMinor] = useState<number | null>(() => {
    const stored = text(value);
    return stored === undefined ? null : toMinorUnits(stored, digits);
  });
  const posted = minor === null ? '' : toCanonicalDecimal(minor / 10 ** digits, scale);
  const notify = useNotify(name);
  return (
    <WidgetBox
      field={field}
      hidden={<input type="hidden" name={name} value={posted} />}
    >
      <MoneyInput
        label={field.label}
        defaultValue={minor}
        onValueChange={(next) => { setMinor(next); notify(); }}
        currency={code}
        currencies={code ? [code] : undefined}
        onCurrencyChange={setCode}
        required={field.required}
      />
      <FieldError name={name} error={error} />
    </WidgetBox>
  );
}

export function PhoneFieldWrapper({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  const [current, setCurrent] = useState<string>(text(value) ?? '');
  const notify = useNotify(name);
  return (
    <WidgetBox field={field} hidden={<input type="hidden" name={name} value={current} />}>
      <PhoneInput
        label={field.label}
        defaultValue={current}
        onValueChange={(next) => { setCurrent(next); notify(); }}
        required={field.required}
      />
      <FieldError name={name} error={error} />
    </WidgetBox>
  );
}

export function DateFieldWrapper({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  const [current, setCurrent] = useState<Date | undefined>(() => parseLocalDay(text(value)));
  const notify = useNotify(name);
  return (
    <WidgetBox
      field={field}
      hidden={
        <input
          className={inputStyles.input}
          name={name}
          readOnly
          value={current ? localDay(current) : ''}
          aria-label={`${field.label} value`}
          required={field.required || undefined}
          aria-required={field.required || undefined}
        />
      }
    >
      <DatePicker
        label={field.label}
        value={current}
        onChange={(next) => { setCurrent(next); notify(); }}
      />
      <FieldError name={name} error={error} />
    </WidgetBox>
  );
}

export function TimeFieldWrapper({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  const [current, setCurrent] = useState<string>(text(value) ?? '');
  const notify = useNotify(name);
  return (
    <WidgetBox
      field={field}
      hidden={
        <input
          className={inputStyles.input}
          name={name}
          readOnly
          value={current}
          aria-label={`${field.label} value`}
          required={field.required || undefined}
          aria-required={field.required || undefined}
        />
      }
    >
      <TimePicker
        label={field.label}
        defaultValue={current}
        onChange={(next) => { setCurrent(next); notify(); }}
      />
      <FieldError name={name} error={error} />
    </WidgetBox>
  );
}

export function SelectField({ field, error, value }: FieldProps) {
  const id = useId();
  const [current, setCurrent] = useState<string>(text(value) ?? '');
  // A native select: the control the user sees is the one that posts.
  return (
    <Box field={field}>
      <div className={inputStyles.field}>
        <label className={`${inputStyles.label} c2c-label`} htmlFor={id}>
          {field.label}
        </label>
        <select
          id={id}
          className={inputStyles.input}
          name={field.name}
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          required={field.required || undefined}
          aria-required={field.required || undefined}
          aria-invalid={error ? true : undefined}
        >
          <option value="" />
          {optionsOf(field).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <FieldError name={field.name} error={error} />
    </Box>
  );
}

export function MultiSelectField({ field, error, value }: FieldProps) {
  const id = useId();
  const [current, setCurrent] = useState<string[]>(list(value));
  const all = optionsOf(field);
  // The record reader takes the select's selectedOptions in document order,
  // so the chosen options lead in the order they were picked and a
  // load→save round trip posts the stored order back unchanged.
  const options = [...current.map((v) => all.find((option) => option.value === v)).filter((o): o is { value: string; label: string } => !!o), ...all.filter((option) => !current.includes(option.value))];
  return (
    <Box field={field}>
      <div className={inputStyles.field}>
        <label className={`${inputStyles.label} c2c-label`} htmlFor={id}>
          {field.label}
        </label>
        <select
          id={id}
          className={inputStyles.input}
          name={field.name}
          multiple
          size={Math.min(Math.max(options.length, 2), 8)}
          value={current}
          onChange={(event) => setCurrent(Array.from(event.target.selectedOptions, (option) => option.value))}
          required={field.required || undefined}
          aria-required={field.required || undefined}
          aria-invalid={error ? true : undefined}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {current.length ? (
          <button type="button" className="c2c-clear" aria-label="Clear selections" onClick={() => setCurrent([])}>
            Clear
          </button>
        ) : null}
      </div>
      <FieldError name={field.name} error={error} />
    </Box>
  );
}

export function CheckboxField({ field, error, value, path }: FieldProps) {
  const name = path ?? field.name;
  const id = useId();
  const [checked, setChecked] = useState<boolean>(value === true || value === 'true');
  return (
    <Box field={field}>
      <div className={inputStyles.field}>
        <label className={`${inputStyles.label} c2c-label`} htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            required={field.required || undefined}
            aria-required={field.required || undefined}
            aria-invalid={error ? true : undefined}
          />{' '}
          {field.label}
        </label>
      </div>
      <input type="hidden" name={name} value={checked ? 'true' : 'false'} />
      <FieldError name={name} error={error} />
    </Box>
  );
}

export function RadioCardsField({ field, error, value }: FieldProps) {
  const [current, setCurrent] = useState<string>(text(value) ?? '');
  return (
    <Box field={field}>
      <Suspense fallback={<FieldLoading field={field} />}>
        <fieldset className="c2c-choices" aria-invalid={error ? true : undefined}>
          <legend className={`${inputStyles.label} c2c-label`}>{field.label}</legend>
          <RadioCards
            name={field.name}
            options={optionsOf(field)}
            defaultValue={current}
            onValueChange={setCurrent}
            required={field.required}
          />
        </fieldset>
        <FieldError name={field.name} error={error} />
      </Suspense>
    </Box>
  );
}

/**
 * Why a stored file could not be opened, for the inline error under the view
 * link. A refusal, an ended session, an outage or a dropped network gets the
 * app's own line; the server's text is never shown for those.
 */
function downloadError(reply: { ok: boolean; status: number; body: unknown }, label: string): string {
  if (reply.status === 403) return `You do not have access to this ${label}.`;
  if (failureText(reply.status)) return failureText(reply.status);
  const body = reply.body as { error?: unknown; url?: unknown } | undefined;
  if (body && typeof body.error === 'string' && body.error) return body.error;
  if (!reply.ok) {
    if (reply.status === 404) return `This ${label} was not found or its link has expired.`;
    return `The ${label} could not be opened${reply.status ? ` (error ${reply.status})` : ''}.`;
  }
  return `No ${label} download is available.`;
}

function StoredFileLink({ form, field, rowId }: { form: FormSpec; field: FieldSpec; rowId?: string }) {
  const { api, view } = useEnv();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!rowId) return null;
  const label = field.label.toLowerCase();
  const show = (message: string, win: Window | null) => {
    setError(message);
    if (win) {
      try {
        win.document.body.textContent = message;
      } catch {
        win.close();
      }
    }
  };
  const download = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (downloading) return;
    setDownloading(true);
    setError(null);
    let win: Window | null = null;
    try {
      win = view.open('', '_blank');
      if (win) win.document.write('Loading...');
    } catch {
      // ignore
    }
    try {
      const reply = await api.post<{ url?: string | null }>(signedFilePath(form, field), { rowId });
      const url = reply.ok ? reply.body?.url : undefined;
      if (typeof url === 'string' && url && win) {
        win.location.href = url;
      } else {
        show(downloadError(reply, label), win);
      }
    } catch {
      show(`The ${label} could not be opened.`, win);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <span>
      <a href="#" onClick={download} className="c2c-link" style={{ fontSize: '14px', pointerEvents: downloading ? 'none' : 'auto', opacity: downloading ? 0.7 : 1 }}>
        {downloading ? 'Loading...' : `View ${field.label}`}
      </a>
      {error ? (
        <p className="c2c-error" role="alert">
          {error}
        </p>
      ) : null}
    </span>
  );
}

/**
 * A stored signature drawn on the form as an image. The stored value is an
 * object key, not a URL, so the image source is the same short-lived signed
 * URL the view link fetches.
 */
function StoredSignature({ form, field, rowId }: { form: FormSpec; field: FieldSpec; rowId?: string }) {
  const { api } = useEnv();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (rowId) {
      api
        .post<{ url?: string | null }>(signedFilePath(form, field), { rowId })
        .then((reply) => {
          const url = reply.ok ? reply.body?.url : undefined;
          if (live && typeof url === 'string' && url) setSrc(url);
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [api, form.name, field.name, rowId]);
  if (!rowId) return null;
  return (
    <span>
      {src ? <img src={src} alt="Signature" height="60" style={{ border: '1px solid var(--border)' }} /> : null}
      <StoredFileLink form={form} field={field} rowId={rowId} />
    </span>
  );
}

export function FileDropzoneField({ form, field, error, value, rowId }: FieldProps) {
  const mirror = useRef<HTMLInputElement>(null);
  const notify = useNotify(field.name);
  const mirrorId = useId();
  const sync = (files: File[]) => {
    notify();
    const input = mirror.current;
    if (!input || typeof DataTransfer === 'undefined') return;
    try {
      const data = new DataTransfer();
      for (const file of files) data.items.add(file);
      input.files = data.files;
    } catch {
      // An engine without DataTransfer keeps the dropzone's own list; the named input stays empty.
    }
  };
  const [cleared, setCleared] = useState(false);
  const stored = text(value);
  return (
    <Box field={field}>
      {stored && !cleared ? (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <StoredFileLink form={form} field={field} rowId={rowId} />
          <Button type="button" variant="secondary" size="sm" onClick={() => setCleared(true)}>Remove file</Button>
        </div>
      ) : (
        <>
          <label className={`${inputStyles.label} c2c-label`} htmlFor={mirrorId}>
            {field.label}
            {field.required ? <span aria-hidden="true"> *</span> : null}
          </label>
          <Suspense fallback={<FieldLoading field={field} bare />}>
            <FileDropzone
              label="Choose a file or drop it here"
              accept={field.accept}
              onFilesChange={sync}
            />
          </Suspense>
          <input ref={mirror} id={mirrorId} type="file" name={field.name} accept={field.accept} hidden aria-hidden="true" tabIndex={-1} required={field.required || undefined} />
        </>
      )}
      {cleared && <input type="hidden" name={`${field.name}_cleared`} value="true" />}
      <FieldError name={field.name} error={error} />
    </Box>
  );
}

export function SignaturePadField({ form, field, error, value, rowId }: FieldProps) {
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [cleared, setCleared] = useState(false);
  const notify = useNotify(field.name);
  const stored = text(value);
  return (
    <Box field={field}>
      <label id={`${field.name}-label`} className={`${inputStyles.label} c2c-label field-title`}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {stored && !cleared ? (
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <StoredSignature form={form} field={field} rowId={rowId} />
          <Button type="button" variant="secondary" size="sm" onClick={() => setCleared(true)}>Remove signature</Button>
        </div>
      ) : (
        <>
          <Suspense fallback={<FieldLoading field={field} bare />}>
            <SignaturePad label={field.label} required={field.required} labelledBy={`${field.name}-label`} onChange={(next) => { setStrokes(next); notify(); }} />
          </Suspense>
          <input type="hidden" name={field.name} value={strokes.length ? JSON.stringify(strokes) : ''} />
        </>
      )}
      {cleared && <input type="hidden" name={`${field.name}_cleared`} value="true" />}
      <FieldError name={field.name} error={error} />
    </Box>
  );
}

export function RichTextField({ field, error, value }: FieldProps) {
  const [current, setCurrent] = useState<string>(text(value) ?? '');
  const notify = useNotify(field.name);
  return (
    <Box field={field}>
      <label id={`${field.name}-label`} className={`${inputStyles.label} c2c-label field-title`}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <Suspense fallback={<FieldLoading field={field} bare />}>
        <RichTextEditor
          defaultValue={current}
          onChange={(next: RichTextValue) => { setCurrent(next.html); notify(); }}
          aria-label={field.label}
          aria-labelledby={`${field.name}-label`}
          aria-required={field.required || undefined}
        />
      </Suspense>
      <input type="hidden" name={field.name} value={current} />
      <FieldError name={field.name} error={error} />
    </Box>
  );
}

export function CompositeField({ form, field, error, value }: FieldProps) {
  const parts = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return (
    <Box field={field}>
      <fieldset className="c2c-composite" aria-invalid={error ? true : undefined}>
        <legend className={inputStyles.label}>{field.label}</legend>
        <div className="c2c-composite-grid">
          {(field.subfields ?? []).map((part, index) => (
            <TextField key={part.name} form={form} field={{ ...part, required: field.required && index === 0 }} path={`${field.name}.${part.name}`} value={parts[part.name]} />
          ))}
        </div>
      </fieldset>
      <FieldError name={field.name} error={error} />
    </Box>
  );
}

/** A Creator subform: an editable grid (see subform/SubformGrid.tsx). */
export const SubformField = SubformGrid;

export function SectionField({ field }: FieldProps) {
  return field.titled === false ? null : <h2 className="c2c-section" data-section={field.name}>{field.label}</h2>;
}

export function NotesField({ field }: FieldProps) {
  return field.note ? <p className="c2c-note">{field.note}</p> : null;
}

export function ComputedField({ field, value }: FieldProps) {
  return (
    <Box field={field}>
      <span className={`${inputStyles.label} field-title`}>{field.label}</span>
      <output className="c2c-computed">{text(value) ?? 'Calculated when the record is saved'}</output>
    </Box>
  );
}

/** A field the generator cannot draw yet: visible, labelled and counted, never silently dropped. */
export function TodoField({ field }: FieldProps) {
  return (
    <Box field={field} className="todo">
      <span className={`${inputStyles.label} field-title`}>{field.label}</span>
      <p className="c2c-todo-reason">Not generated yet: {field.todo ?? field.widget}</p>
    </Box>
  );
}

export function defaultWidget(field: FieldSpec): ComponentType<FieldProps> {
  if (!field.generated) return TodoField;
  switch (field.widget) {
    case 'section': return SectionField;
    case 'notes': return NotesField;
    case 'textarea': return TextAreaField;
    case 'select': return SelectField;
    case 'radio': return RadioCardsField;
    case 'multiselect': return MultiSelectField;
    case 'decision': return CheckboxField;
    case 'name':
    case 'address': return CompositeField;
    case 'file':
    case 'image':
    case 'audio':
    case 'video': return FileDropzoneField;
    case 'signature': return SignaturePadField;
    case 'richtext': return RichTextField;
    case 'number':
    case 'decimal':
    case 'percent': return NumberFieldWrapper;
    case 'currency': return MoneyFieldWrapper;
    case 'phone': return PhoneFieldWrapper;
    case 'date': return DateFieldWrapper;
    case 'time': return TimeFieldWrapper;
    case 'datetime': return TextField; // A native datetime-local input: it already posts the contract value.
    case 'subform': return SubformGrid;
    case 'lookup': return LookupField;
    case 'lookup-multi': return LookupMultiField;
    case 'formula':
    case 'autonumber':
    case 'zia':
    case 'barcode': return ComputedField;
    default: return TextField;
  }
}

/** One Creator field, by name. Overrides: forms[form].fields[name], then components.fields[widget], then the default. */
export function Field({ name }: { name: string }) {
  const state = useContext(FormContext);
  const custom = useCustomization();
  if (!state) throw new Error('@c2c/ui: <Field> outside <FormView>');
  const field = state.form.fields.find((item) => item.name === name);
  if (!field) return null;
  const Widget = custom.forms?.[state.form.name]?.fields?.[name] ?? custom.components?.fields?.[field.widget] ?? defaultWidget(field);
  const version = state.versions?.[name] ?? 0;
  // The boundary also covers customizations that render a lazily-imported widget.
  const widget = (
    <Suspense fallback={<FieldLoading field={field} />}>
      <Widget key={version} form={state.form} field={field} error={state.errors[name]} value={state.record[name]} rowId={state.rowId} />
    </Suspense>
  );
  // A `hide` rule marks the field box hidden, like the vanilla runtime: the
  // control stays mounted, so a stored or scripted value still posts.
  if (state.hidden?.has(name)) {
    return (
      <div className="c2c-field" data-field={name} hidden>
        {widget}
      </div>
    );
  }
  // A `disable` rule wraps the control in a disabled fieldset: the inputs inside
  // are disabled without poking their DOM nodes.
  if (state.disabled?.has(name)) {
    return (
      <fieldset className="c2c-field-disabled" disabled data-field-disabled={name} style={{ display: 'contents' }}>
        {widget}
      </fieldset>
    );
  }
  return widget;
}
