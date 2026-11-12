/**
 * The React side of Creator client handlers: the same generated handler
 * modules the vanilla target ships (src/generated/handlers/, emitted from
 * client/handlers/*.mjs) and the same browser shim (src/generated/
 * client-runtime.js), driven through React state instead of DOM writes.
 *
 * This module is pure and DOM-free so the effect of a handler — which
 * fields hide, disable, clear or take a scripted value — is testable
 * against the vanilla applyActions without rendering React.
 */
import type { HandlerSpec } from '../types.js';

/** The generated handler module shape (client/handlers/*.mjs → handlers/*.ts). */
export interface HandlerModule {
  c2cHandler?: unknown;
  clientActions?: (ctx: HandlerCtx) => HandlerAction[] | Promise<HandlerAction[]>;
}

/** The context a generated clientActions(ctx) reads. `shim` is the vanilla browserShim(). */
export interface HandlerCtx {
  record: Record<string, unknown>;
  old: Record<string, unknown>;
  formNonce: string;
  subformRow?: { field: string; index: number };
  appTimeZone?: string;
  args?: unknown[];
  shim: unknown;
}

/** One action a handler pushes (the same op set the vanilla applyActions reads). */
export interface HandlerAction {
  op?: string;
  targets?: unknown[];
  target?: unknown;
  args?: unknown[];
  method?: string;
  message?: unknown;
  note?: string;
  url?: string;
  value?: unknown;
}

/** The shim proxy answers `then`, so a promise would adopt it as a thenable and resolve undefined — it crosses an async boundary only boxed. */
export interface ShimBox {
  shim: unknown;
}

/** Module registry + shim factory from src/generated/handlers.ts. */
export interface FormHandlers {
  modules: Record<string, () => Promise<HandlerModule>>;
  createShim: (fetchImpl?: unknown) => ShimBox | Promise<ShimBox>;
}

/** Mutable draft the actions write; FormView publishes it into React state. */
export interface HandlerDraft {
  hidden: Set<string>;
  disabled: Set<string>;
  /** Current record: loaded values plus reads of the live controls. */
  record: Record<string, unknown>;
  banner?: { tone: 'success' | 'danger' | 'info'; title: string };
  /** Counted manual items (fidelity gaps and failed actions), rendered under the form. */
  notes: string[];
}

export interface ApplyOptions {
  reload?: () => void;
  openUrl?: (url: string, target?: string) => void;
}

/** Record events that fire on this screen, like the vanilla wireForm set. */
export function recordEvents(mode: 'add' | 'edit'): Set<string> {
  return new Set(mode === 'edit' ? ['', 'on edit', 'on add or edit'] : ['', 'on add', 'on add or edit']);
}

/** The handlers that fire for a lifecycle slot, honouring field scope and record event. */
export function matchingHandlers(handlers: readonly HandlerSpec[], when: string, mode: 'add' | 'edit', fieldName?: string): HandlerSpec[] {
  const events = recordEvents(mode);
  return handlers.filter((handler) => {
    if (handler.when !== when) return false;
    if (fieldName && handler.field && handler.field !== fieldName) return false;
    return events.has((handler.recordEvent ?? '').toLowerCase());
  });
}

/**
 * Run every matching handler module in spec order. A throwing module is a
 * counted manual item, never a raw "Client handler failed" in the UI.
 */
export async function runHandlers(specs: readonly HandlerSpec[], modules: FormHandlers['modules'], ctx: HandlerCtx): Promise<HandlerAction[]> {
  const actions: HandlerAction[] = [];
  for (const spec of specs) {
    const load = modules[spec.module];
    if (!load) {
      actions.push({ op: 'fidelity', note: `Client handler "${spec.event}" has no generated module.` });
      continue;
    }
    try {
      const mod = await load();
      if (typeof mod.clientActions !== 'function') continue;
      const list = await mod.clientActions(ctx);
      if (Array.isArray(list)) actions.push(...list);
    } catch {
      actions.push({ op: 'fidelity', note: `Client handler "${spec.event}" could not run.` });
    }
  }
  return actions;
}

function targetNames(target: unknown): string[] {
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target.flatMap((item) => targetNames(item));
  return [];
}

/** Write a scripted value at a field link name; `Sub.Col` writes every loaded row of that column. */
export function writeScriptValue(record: Record<string, unknown>, name: string, value: unknown): void {
  if (!name) return;
  const dot = name.indexOf('.');
  if (dot < 0) {
    record[name] = value;
    return;
  }
  const parent = name.slice(0, dot);
  const column = name.slice(dot + 1);
  const rows = record[parent];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (row && typeof row === 'object' && !Array.isArray(row)) (row as Record<string, unknown>)[column] = value;
    }
    return;
  }
  const cell = record[parent];
  if (cell && typeof cell === 'object' && !Array.isArray(cell)) (cell as Record<string, unknown>)[column] = value;
}

/** The empty a `clear` rule leaves: a cleared multi-value is [], anything else ''. */
function clearedValue(record: Record<string, unknown>, name: string): unknown {
  return Array.isArray(record[name]) ? [] : '';
}

/**
 * Apply one action list to the draft, the React-state equivalent of the
 * vanilla applyActions. Returns the note stream it produces: 'cancel'
 * blocks the submit, 'success' says the handler owns the success banner.
 */
export function applyHandlerActions(actions: readonly HandlerAction[], draft: HandlerDraft, opts: ApplyOptions = {}): string[] {
  const notes: string[] = [];
  for (const action of actions || []) {
    const op = action?.op;
    if (op === 'successMessage') {
      notes.push('success');
      draft.banner = { tone: 'success', title: String(action.message ?? '') };
    } else if (op === 'alert' || op === 'info') {
      const message = String(action.message ?? '');
      notes.push(message);
      draft.banner = { tone: 'info', title: message };
    } else if (op === 'hide' || op === 'show' || op === 'enable' || op === 'disable') {
      for (const target of action.targets ?? []) {
        for (const name of targetNames(target)) {
          if (!name) continue;
          notes.push(`${op}:${name}`);
          if (op === 'hide') draft.hidden.add(name);
          if (op === 'show') draft.hidden.delete(name);
          if (op === 'disable') draft.disabled.add(name);
          if (op === 'enable') draft.disabled.delete(name);
        }
      }
    } else if (op === 'clear') {
      for (const target of action.targets ?? []) {
        for (const name of targetNames(target)) {
          if (!name) continue;
          notes.push(`clear:${name}`);
          writeScriptValue(draft.record, name, clearedValue(draft.record, name));
        }
      }
    } else if (op === 'setValue' || op === 'set value') {
      const value = Array.isArray(action.args) ? action.args[0] : action.value;
      for (const target of action.targets ?? []) {
        for (const name of targetNames(target)) {
          if (!name) continue;
          notes.push(`set:${name}`);
          writeScriptValue(draft.record, name, value);
        }
      }
    } else if (op === 'reload') {
      notes.push('reload');
      opts.reload?.();
    } else if (op === 'openUrl') {
      const url = Array.isArray(action.args) ? action.args[0] : action.url;
      const target = Array.isArray(action.args) ? action.args[1] : undefined;
      notes.push(`openUrl:${String(url ?? '')}`);
      if (typeof url === 'string' && url) opts.openUrl?.(url, typeof target === 'string' ? target : undefined);
    } else if (op === 'cancelSubmit') {
      notes.push('cancel');
    } else if (op === 'fidelity') {
      const note = String(action.note || 'This action is not implemented in the migrated app.');
      notes.push(`fidelity:${note}`);
      draft.notes.push(`Not implemented: ${note}`);
    } else if (op) {
      const note = `Action "${String(op)}" is not implemented in the migrated app.`;
      notes.push(`fidelity:${note}`);
      draft.notes.push(`Not implemented: ${note}`);
    }
  }
  return notes;
}

/** Merge shim-written record values (input.X = v, record.set) into the draft record. */
export function mergeScriptRecord(draft: Record<string, unknown>, written: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(written)) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(value)) draft[key] = value;
  }
}
