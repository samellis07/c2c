/**
 * A Creator form screen: heading, field grid, Creator buttons, submit.
 * Submit runs the browser checks, uploads chosen files (a dry run returns a
 * { key } reference), lets the customization adjust the record, then posts
 * { record, ROWID? } to the form's submit endpoint on c2c_api. The reply's
 * dryRun flag decides the wording: a dry run says nothing was saved.
 *
 * Creator client handlers (on load, on user input, on validate, on success)
 * and field rules run here through the same generated modules and browser
 * shim as the vanilla target. Their effects — hide/show, enable/disable,
 * clear and scripted set-value — land in React state, not the DOM. A
 * handler that cannot run becomes a counted manual note under the form.
 *
 * Refusals: a 403 swaps the screen for the access-denied screen. When the
 * session ends (the api wrapper's session-expired event) the typed values are
 * saved to sessionStorage under the route, and the same route restores them
 * once after the sign-in round trip. An edit screen whose record read fails
 * shows why and never opens the form. The server's text for 401, 403 and 5xx
 * is never shown; a 4xx validation answer still is.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Alert } from '../arc/components/alert/alert';
import { Button } from '../arc/components/button/button';
import type { FieldSpec, FormRecord, FormSpec, RecordValue } from '../types';
import { SESSION_EXPIRED_EVENT, type AppWindow } from '../runtime/api';
import { useEnv } from '../runtime/env';
import { failureText, retryable, useAccessDenied } from '../runtime/StatusScreens';
import { Slot, useCustomization } from '../runtime/extend';
import { FormContext } from './fields';
import { applyHandlerActions, matchingHandlers, mergeScriptRecord, runHandlers, type FormHandlers, type HandlerCtx, type HandlerDraft } from './handlers';
import { chosenFiles, firstErrorControl, readRecord, validate } from './record';
import { subformRows, validateSubforms } from '../subform/rows';

interface Banner {
  tone: 'success' | 'danger' | 'info';
  title: string;
}

interface WriteReply {
  ok?: boolean;
  dryRun?: boolean;
  message?: string;
  error?: string;
  record?: Record<string, unknown>;
  reference?: { key?: string };
}

/** `Sub[2].Col` → the handler field `Sub.Col` and the row it fired on. */
function handlerFieldName(control: string): { field: string; row?: { field: string; index: number } } {
  const m = /^(.+)\[(\d+)\]\.(.+)$/.exec(control);
  if (!m) return { field: control };
  return { field: `${m[1]}.${m[3]}`, row: { field: m[1]!, index: Number(m[2]) } };
}

/** The sessionStorage key of a session's sign-in draft: signed-in user + route + form. */
export function draftKey(hash: string, user: string, formName: string): string {
  return `c2c-draft:${user || 'anon'}:${hash || '#/'}:${formName || ''}`;
}

/**
 * The signed-in Catalyst user a draft belongs to, read from the Web SDK so a
 * draft one user saved never restores into another's session on the same
 * tab. '' when there is no SDK or no session — those drafts key under 'anon'.
 */
async function draftUserId(view: AppWindow): Promise<string> {
  const auth = view.catalyst?.auth;
  if (!auth) return '';
  try {
    const detail =
      typeof auth.getCurrentUser === 'function'
        ? await auth.getCurrentUser()
        : typeof auth.isUserAuthenticated === 'function'
          ? await auth.isUserAuthenticated()
          : null;
    const boxed = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : null;
    const user = boxed && typeof boxed.content === 'object' ? boxed.content : typeof boxed?.user === 'object' ? boxed.user : boxed;
    const id = user && typeof user === 'object' ? (user as Record<string, unknown>) : null;
    const value = id && (id.user_id ?? id.userId ?? id.zaid ?? id.ZAID ?? id.id ?? id.email_id ?? id.email);
    return value == null || value === '' ? '' : String(value);
  } catch {
    return '';
  }
}

/**
 * The record with every password/encrypted-typed field removed — decided by
 * the spec's field type (the generator marks them `secret`), never by name.
 */
function stripSecrets(record: FormRecord, form: FormSpec): FormRecord {
  const secrets = (field: FieldSpec) => (field.subfields ?? []).filter((sub) => sub.secret);
  const out: FormRecord = { ...record };
  for (const field of form.fields) {
    if (field.secret) {
      delete out[field.name];
      continue;
    }
    const subs = secrets(field);
    if (!subs.length) continue;
    const value = out[field.name];
    const drop = (row: unknown): unknown => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
      const copy = { ...(row as Record<string, unknown>) };
      for (const sub of subs) delete copy[sub.name];
      return copy;
    };
    if (Array.isArray(value)) out[field.name] = value.map(drop) as RecordValue;
    else if (value && typeof value === 'object' && !('key' in value)) out[field.name] = drop(value) as RecordValue;
  }
  return out;
}

/** Files and other non-JSON values stay out of a draft; a bigint keeps its digits. */
function draftReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof Blob !== 'undefined' && value instanceof Blob) return undefined;
  return value;
}

function saveDraft(view: Window, key: string, values: unknown): void {
  try {
    view.sessionStorage.setItem(key, JSON.stringify(values, draftReplacer));
  } catch {
    // storage refused: the prompt still says to sign in, the entries stay on screen
  }
}

/** The route's draft, read once: a read removes it. */
function takeDraft(view: Window, key: string): Record<string, unknown> | null {
  try {
    const raw = view.sessionStorage.getItem(key);
    if (raw === null) return null;
    view.sessionStorage.removeItem(key);
    const draft = JSON.parse(raw) as unknown;
    return draft && typeof draft === 'object' && !Array.isArray(draft) ? (draft as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function FormView({ form, edit, children, handlers }: { form: FormSpec; edit?: string; children?: ReactNode; handlers?: FormHandlers }) {
  const { view, api } = useEnv();
  const custom = useCustomization().forms?.[form.name];
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [record, setRecord] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldState, setFieldState] = useState<{ hidden: ReadonlySet<string>; disabled: ReadonlySet<string> }>({ hidden: new Set(), disabled: new Set() });
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const mode = edit ? 'edit' : 'add';
  // The live draft the handlers read and write between publishes.
  const live = useRef({ record: {} as Record<string, unknown>, old: {} as Record<string, unknown>, notes: [] as string[] });
  // The last record the controls mounted with: a script write that differs
  // from it bumps that field's remount key.
  const published = useRef<Record<string, unknown>>({});
  const loadRan = useRef(false);

  /** Publish a handler draft into React state and remount any field a script rewrote. */
  const publish = useCallback((draft: HandlerDraft) => {
    setFieldState({ hidden: new Set(draft.hidden), disabled: new Set(draft.disabled) });
    const keys = new Set([...Object.keys(published.current), ...Object.keys(draft.record)]);
    const changed = [...keys].filter((key) => JSON.stringify(published.current[key]) !== JSON.stringify(draft.record[key]));
    published.current = draft.record;
    setRecord({ ...draft.record });
    if (changed.length) {
      setVersions((v) => {
        const next = { ...v };
        for (const key of changed) next[key] = (next[key] ?? 0) + 1;
        return next;
      });
    }
    if (draft.banner) setBanner(draft.banner);
    setNotes([...draft.notes]);
  }, []);

  /**
   * Run the handlers for one lifecycle slot at the same moment the vanilla
   * runtime does. The record the script sees is the loaded record overlaid
   * with the live control values; `shim.input.set` writes land back in
   * React state through the draft record.
   */
  const run = useCallback(
    async (when: string, fieldName?: string, subformRow?: { field: string; index: number }): Promise<string[]> => {
      const specs = matchingHandlers(form.handlers ?? [], when, mode, fieldName);
      if (!specs.length || !handlers) return [];
      const formEl = formRef.current;
      const controls = formEl ? (readRecord(formEl, form) as Record<string, unknown>) : {};
      // The handler record keeps every drawn grid row, including the empty
      // rows the submit body drops: `row` binds at the grid index the row
      // event carried, and publishing this record never collapses the grid.
      if (formEl) {
        for (const field of form.fields) {
          if (field.widget !== 'subform') continue;
          controls[field.name] = subformRows(formEl, field).map((row) => row.values);
        }
      }
      const ctx: HandlerCtx = {
        record: { ...live.current.record, ...controls },
        old: live.current.old,
        formNonce: '',
        ...(subformRow ? { subformRow } : {}),
        ...(typeof view.C2C_APP_TIMEZONE === 'string' ? { appTimeZone: view.C2C_APP_TIMEZONE } : {}),
        shim: (await handlers.createShim(typeof view.fetch === 'function' ? view.fetch.bind(view) : undefined)).shim,
      };
      const draft: HandlerDraft = {
        hidden: new Set(fieldState.hidden),
        disabled: new Set(fieldState.disabled),
        record: { ...ctx.record },
        notes: [...live.current.notes],
      };
      const actions = await runHandlers(specs, handlers.modules, ctx);
      const results = applyHandlerActions(actions, draft, {
        reload: () => view.location?.reload?.(),
        openUrl: (url, target) => {
          if (target === '_blank') view.open?.(url, '_blank');
          else if (view.location) view.location.href = url;
        },
      });
      mergeScriptRecord(draft.record, ctx.record);
      // A deleterow run reads the record before the grid drops the row, so the
      // removed index is still in it — the handler needs `row` bound. Drop it
      // from the published record so it never repaints as a live row.
      if (when === 'deleterow' && subformRow) {
        const list = draft.record[subformRow.field];
        if (Array.isArray(list) && subformRow.index >= 0 && subformRow.index < list.length) list.splice(subformRow.index, 1);
      }
      live.current.record = draft.record;
      live.current.notes = draft.notes;
      publish(draft);
      return results;
    },
    [fieldState.disabled, fieldState.hidden, form, handlers, mode, publish, view],
  );

  // On load runs once per screen: immediately on add, after the row arrives on edit.
  useEffect(() => {
    if (edit || loadRan.current) return;
    loadRan.current = true;
    void run('load');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one on-load pass per screen, like the vanilla wireForm.
  }, [edit]);

  /** The status of a failed edit-screen read (0 = no answer); null while it loads or after it worked. */
  const [readFailed, setReadFailed] = useState<number | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const deny = useAccessDenied();

  // The session ended: keep what was typed — never the secret-typed fields —
  // under this user's route+form key until the sign-in round trip returns here.
  useEffect(() => {
    const onExpired = () => {
      const formEl = formRef.current;
      if (!formEl) return;
      const values = stripSecrets(readRecord(formEl, form), form);
      void draftUserId(view).then((user) => saveDraft(view, draftKey(view.location.hash, user, form.name), values));
    };
    view.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => view.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [view, form]);

  // Add screen: back from sign-in, the saved draft fills the controls once —
  // only for the user who saved it.
  useEffect(() => {
    if (edit) return;
    let live = true;
    void draftUserId(view).then((user) => {
      if (!live) return;
      const saved = takeDraft(view, draftKey(view.location.hash, user, form.name));
      if (!saved) return;
      setRecord(saved);
      setLoaded((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [view, edit, form.name]);

  // Edit screen: read the row through the scoped record endpoint, then remount the controls with its values.
  useEffect(() => {
    if (!edit) return;
    let active = true;
    setReadFailed(null);
    api.post<WriteReply>(form.recordEndpoint, { ROWID: edit }).then(
      (reply) => {
        if (!active) return;
        const row = reply.body?.record;
        if (reply.ok && row && typeof row === 'object' && !Array.isArray(row)) {
          live.current.record = { ...row };
          live.current.old = { ...row };
          published.current = { ...row };
          // A draft saved before a sign-in round trip wins over the stored values.
          void draftUserId(view).then((user) => {
            if (!active) return;
            const saved = takeDraft(view, draftKey(view.location.hash, user, form.name));
            setRecord(saved ? { ...row, ...saved } : row);
            setLoaded((n) => n + 1);
            if (!loadRan.current) {
              loadRan.current = true;
              void run('load');
            }
          });
        } else if (reply.status === 403) deny();
        else setReadFailed(reply.ok ? 404 : reply.status);
      },
      () => active && setReadFailed(0),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the row loads once per edit route, retried via readAttempt.
  }, [api, view, deny, edit, form.name, form.recordEndpoint, readAttempt]);

  /** A control change fires `on user input` for that field (or Subform.Column, with its row bound). */
  const notify = useCallback(
    (name: string) => {
      const { field, row } = handlerFieldName(name);
      void run('input', field, row);
    },
    [run],
  );

  /** A grid row add/remove fires `on add row` / `on delete row` with the row index bound. */
  const rowEvent = useCallback(
    (field: string, event: 'addrow' | 'deleterow', index: number) => {
      void run(event, undefined, { field, index });
    },
    [run],
  );

  function onFieldChange(event: FormEvent<HTMLFormElement>) {
    const el = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (el && typeof el.name === 'string' && el.name !== '') notify(el.name);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (edit && !loaded) return;
    const formEl = event.currentTarget;
    let next = readRecord(formEl, form);
    const files = chosenFiles(formEl, form);
    const found = { ...validate(form, next, files), ...validateSubforms(formEl, form) };
    setErrors(found);
    if (Object.keys(found).length) {
      setBanner({ tone: 'danger', title: 'Check the highlighted fields.' });
      firstErrorControl(formEl, found)?.focus();
      return;
    }
    // On validate runs after the browser checks, like the vanilla submit; a
    // `cancel submit` in the script stops the write here.
    const verdict = await run('validate');
    if (verdict.includes('cancel')) return;
    if (view.navigator && view.navigator.onLine === false) {
      setBanner({ tone: 'info', title: 'Offline. Submitting a form needs a network. Saved report reads stay available.' });
      return;
    }
    setBusy(true);
    try {
      for (const [field, file] of files) {
        if (!field.uploadEndpoint) continue;
        const up = await api.post<WriteReply>(field.uploadEndpoint, { filename: file.name, contentType: file.type || 'application/octet-stream' });
        if (up.status === 403) {
          deny();
          return;
        }
        if (failureText(up.status)) {
          setBanner({ tone: 'danger', title: failureText(up.status) });
          return;
        }
        const key = up.body?.reference?.key;
        if (!up.ok || typeof key !== 'string') throw new Error('upload');
        next[field.name] = { key };
      }
      const ctx = { form, mode, rowId: edit } as const;
      if (custom?.beforeSubmit) {
        const changed = await custom.beforeSubmit(next, ctx);
        if (changed === false) return;
        next = changed as FormRecord;
      }
      const endpoint = mode === 'edit' && form.editSubmitEndpoint ? form.editSubmitEndpoint : form.submitEndpoint;
      const reply = await api.post<WriteReply>(endpoint, { record: next, ...(edit ? { ROWID: edit } : {}) });
      const dryRun = reply.body?.dryRun !== false;
      if (reply.status === 403) {
        deny();
        return;
      }
      if (!reply.ok) {
        // 401, 5xx and a dropped network get the app's copy; only a validation answer carries the server's words.
        const server = failureText(reply.status) ? undefined : reply.body?.message ?? reply.body?.error;
        setBanner({ tone: 'danger', title: failureText(reply.status) || (typeof server === 'string' && server.trim() ? server : 'The record was not saved.') });
      } else {
        // On success may set its own `success message`; the default banner
        // only shows when no handler claimed it.
        const success = await run('success');
        if (!success.includes('success')) {
          const done = form.successMessage || (mode === 'edit' ? 'Record updated.' : 'Record added.');
          setBanner({ tone: 'success', title: dryRun ? `${done} Dry run: nothing was saved.` : done });
        }
        if (mode === 'add' && !dryRun) formEl.reset();
      }
      await custom?.afterSubmit?.({ ok: reply.ok, dryRun, body: reply.body }, ctx);
    } catch (error) {
      setBanner({ tone: 'danger', title: error instanceof Error && error.message === 'upload' ? 'Upload failed. The form was not submitted.' : 'The form was not submitted. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  const buttons = mode === 'edit' ? form.buttons.edit : form.buttons.add;
  const shown = buttons.some((b) => b.type === 'submit') ? buttons : [{ name: 'submit', label: mode === 'edit' ? 'Update' : 'Submit', type: 'submit' as const }, ...buttons];

  // A failed read never opens the edit form: an Update over blank fields would overwrite the record.
  if (edit && readFailed !== null) {
    return (
      <section className="c2c-card" data-form-card="" data-state="error">
        <h1>{form.label}</h1>
        <Alert tone="danger" title={failureText(readFailed) || 'The record could not be loaded.'}>
          {retryable(readFailed) ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => setReadAttempt((n) => n + 1)}>
              Retry
            </Button>
          ) : null}
        </Alert>
      </section>
    );
  }

  return (
    <section className="c2c-card" data-form-card="">
      <h1>{form.label}</h1>
      <Slot>{custom?.slots?.before}</Slot>
      <FormContext.Provider value={{ form, errors, record, rowId: edit, hidden: fieldState.hidden, disabled: fieldState.disabled, versions, notify, rowEvent }}>
        <form ref={formRef} data-form={form.name} data-layout={form.layout} data-mode={mode} noValidate onSubmit={onSubmit} onChange={onFieldChange} onReset={() => { setErrors({}); setBanner(null); }}>
          <div className="form-grid" key={loaded}>
            {children}
          </div>
          {banner ? <Alert className="c2c-banner" tone={banner.tone} title={banner.title} /> : null}
          {notes.map((note, index) => (
            <p key={`${index}-${note}`} className="fidelity-note">
              {note}
            </p>
          ))}
          <div className="c2c-form-actions">
            <Slot>{custom?.slots?.actions}</Slot>
            {shown.map((button) =>
              button.type === 'cancel' ? (
                <Button key={button.name} type="button" variant="ghost" onClick={() => view.history.back()}>{button.label}</Button>
              ) : (
                <Button key={button.name} type={button.type === 'reset' ? 'reset' : button.type === 'submit' ? 'submit' : 'button'} variant={button.type === 'submit' ? 'primary' : 'secondary'} loading={button.type === 'submit' && busy} aria-disabled={button.type === 'submit' && mode === 'edit' && !loaded ? true : undefined}>
                  {button.label}
                </Button>
              ),
            )}
          </div>
        </form>
      </FormContext.Provider>
      <Slot>{custom?.slots?.after}</Slot>
    </section>
  );
}
