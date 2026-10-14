/**
 * Blueprint transition owners and during-phase field settings.
 *
 * Transition owners decide who may perform a transition. Creator offers
 * users, roles, and a users field of the record ("field-based" owners). The
 * generated machine resolves:
 *
 * - `users` / `user` / `owner users` — login emails or user ids;
 * - `roles` / `role` — the caller's role;
 * - `profiles` / `profile` — the caller's profile;
 * - `field` / `user field` — a users field of the governed form, read from
 *   the stored record.
 *
 * An owner setting that names none of these (`owners = ...`), a reporting-level
 * owner, and a field owner on a field that is not a users field are not
 * guessed: each is counted as a todo and the transition denies with the
 * reason, so an unresolved owner never opens the transition.
 *
 * Field settings say which fields are visible and which are updatable while a
 * record sits in a stage (stage properties) or during a transition (the
 * `during` phase). Field lists are comma or semicolon separated names.
 */
import { unquote, type App, type Form, type Property, type PropertyBlock, type Workflow, type BlueprintTransition } from '../../core/src/ir.js';
import type { TodoItem } from './translate.js';

/** Field settings of one stage or one transition's `during` phase. */
export interface PhaseFields {
  /** Allow-list: only these form fields are shown. Absent means every readable field. */
  visible?: string[];
  /** Fields that are not shown. */
  hidden?: string[];
  /** Allow-list: only these fields may be changed. Absent means no stage limit. */
  updatable?: string[];
  /** Fields that may not be changed. */
  readonly?: string[];
  /** During a transition: fields the caller must fill. Each is updatable too. */
  mandatory?: string[];
}

/** The blueprint field spec the machine, the record read, and the UI share. */
export interface BlueprintFieldSpec {
  /** The machine status column the stage is read from. */
  statusColumn: string;
  /** Per stage name; a stage without settings is absent. */
  stages: Record<string, PhaseFields>;
  /** Per transition display name; a transition without `during` settings is absent. */
  transitions: Record<string, PhaseFields>;
}

type FieldKind = keyof PhaseFields;

/** The field-setting kind a property key names, or null when it is not a field setting. */
export function phaseFieldKind(key: string): FieldKind | null {
  const k = key.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (/^(mandatory|required) fields?$/.test(k)) return 'mandatory';
  if (/^(read ?only|non editable|not editable|disabled?|disable) fields?$/.test(k)) return 'readonly';
  if (/^(hidden|hide) fields?$/.test(k)) return 'hidden';
  if (/^(visible|show|shown|display) fields?$/.test(k)) return 'visible';
  if (/^(editable|updatable|updateable|update|fields to update|fields to be updated|fields to fill|fields)( fields?)?$/.test(k)) return 'updatable';
  return null;
}

/**
 * A transition-owner property key: `owners`, `transition owners`, `owner
 * roles`, ..., or a bare kind (`users`, `roles`, `profiles`, `user field`,
 * `field`, `reporting level`). Other keys (`message`, ...) are not owners.
 */
export function isOwnerKey(key: string): boolean {
  const k = key.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const kind = '(users?|roles?|profiles?|approvers?|user field|users field|approver field|field|reporting level|level|type)';
  return new RegExp(`^(transition )?owners?( ${kind})?$`).test(k) || new RegExp(`^${kind}$`).test(k) && k !== 'type';
}

/** Phases whose properties are all owner settings: `owners { ... }` / `transition owners { ... }`. */
function isOwnerPhase(phase: string): boolean {
  return /^(transition )?owners?$/.test(phase.trim().toLowerCase());
}

/** A settings block that holds owner entries: `transition owner ( ... )`, `owners ( ... )`. */
export function isOwnerBlockName(name: string): boolean {
  return /^(transition )?owners?$/.test(name.trim().toLowerCase());
}

/**
 * The role/profile kinds a `permissions` name maps to, resolved against the
 * app's declared roles and profiles. With no app context both kinds are
 * emitted: the caller still needs a matching role or profile, so the guard
 * stays closed. A name matching neither a declared role nor a declared
 * profile maps to nothing, and the caller denies with a counted todo.
 */
function permissionKinds(name: string, app: App | undefined): ('role' | 'profile')[] {
  if (!app) return ['role', 'profile'];
  const lower = name.trim().toLowerCase();
  const kinds: ('role' | 'profile')[] = [];
  if (app.roles.some((role) => role.name.trim().toLowerCase() === lower)) kinds.push('role');
  if (app.profiles.some((profile) => profile.name.trim().toLowerCase() === lower)) kinds.push('profile');
  return kinds;
}

/**
 * The owner entries of one `transition owner`/`owners` block, expanded into
 * the property spellings resolveApprovers and approverGap already understand.
 * `permissions` lists the role or profile names Creator grants; `userfields`
 * names the record's users fields — its `{Field}` braces go through the same
 * fieldList split every other list takes. A key neither names is passed
 * through, where the owner walk counts it as an unresolvable owner kind and
 * the transition denies — never opens.
 */
function ownerBlockProperties(block: PropertyBlock, app: App | undefined): Property[] {
  const out: Property[] = [];
  const push = (key: string, value: string, span: Property['span']): void => {
    out.push({ key, value, span });
  };
  for (const p of block.properties) {
    const k = p.key.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    if (/^permissions?$/.test(k)) {
      const names = fieldList(p.value);
      if (!names.length) push(p.key, p.value, p.span);
      for (const name of names) {
        const kinds = permissionKinds(name, app);
        if (!kinds.length) push(p.key, name, p.span);
        else for (const kind of kinds) push(kind === 'role' ? 'roles' : 'profiles', name, p.span);
      }
      continue;
    }
    if (/^users? ?fields?$/.test(k)) {
      const names = fieldList(p.value);
      if (!names.length) push(p.key, p.value, p.span);
      for (const name of names) push('user field', name, p.span);
      continue;
    }
    push(p.key, p.value, p.span);
  }
  // A bare item in an owner block names no kind the machine resolves: it is an
  // unresolvable owner entry, counted and denied like any other unknown kind.
  for (const item of block.items) push('owners', item, block.span);
  for (const child of block.blocks) out.push(...ownerBlockProperties(child, app));
  return out;
}

/**
 * Every owner property of a transition: on the transition itself, in its
 * `before` phase, in an `owners { }` section, and in `transition owner` /
 * `owners` settings blocks of any phase. Generation and the todo walk share
 * this list so both count the same owner gaps.
 */
export function transitionOwnerProperties(t: BlueprintTransition, app?: App): Property[] {
  const out: Property[] = [];
  // On the transition itself any approver-kind key counts, as it always has.
  for (const p of t.properties) if (isOwnerKey(p.key) || /level|field|role|profile|user|approver/i.test(p.key)) out.push(p);
  for (const phase of t.phases) {
    const name = phase.phase.trim().toLowerCase();
    if (isOwnerPhase(name)) out.push(...phase.properties);
    else if (name === 'before') out.push(...phase.properties.filter((p) => isOwnerKey(p.key)));
    for (const block of phase.blocks) {
      if (isOwnerBlockName(block.name)) out.push(...ownerBlockProperties(block, app));
    }
  }
  return out;
}

/** Phase property keys emitBlueprint consumes as owner or field settings, so they raise no generic todo. */
export function isConsumedPhaseProperty(phase: string, key: string): boolean {
  const name = phase.trim().toLowerCase();
  if (isOwnerPhase(name)) return true;
  if (name === 'before' && isOwnerKey(key)) return true;
  if (name === 'during' && phaseFieldKind(key)) return true;
  return false;
}

/** `A, B`, `"A";"B"`, `{"A","B"}`, `(A, B)` → `['A', 'B']`. */
export function fieldList(value: string): string[] {
  let v = value.trim();
  while (/^[{([].*[})\]]$/s.test(v)) v = v.slice(1, -1).trim();
  return v
    .split(/[,;]/)
    .map((part) => unquote(part.trim()).trim())
    .filter(Boolean);
}

function collect(properties: readonly Property[], blocks: readonly PropertyBlock[], form: Form | undefined, todos: TodoItem[], where: string): PhaseFields | null {
  const out: PhaseFields = {};
  const known = new Set((form?.fields ?? []).map((f) => f.name));
  const add = (kind: FieldKind, names: string[], span: { start: number; end: number }): void => {
    const list = (out[kind] ??= []);
    for (const name of names) {
      // A name the form does not carry can never be shown or written: it is
      // dropped, which only narrows an allow-list, and listed for review.
      if (!known.has(name)) {
        todos.push({ construct: `blueprint-${where}-field-unknown`, start: span.start, end: span.end });
        continue;
      }
      if (!list.includes(name)) list.push(name);
    }
  };
  let any = false;
  for (const p of properties) {
    const kind = phaseFieldKind(p.key);
    if (!kind) continue;
    any = true;
    add(kind, fieldList(p.value), p.span);
  }
  // `fields { A  B (mandatory) }` — a block of bare field names.
  for (const b of blocks) {
    const kind = phaseFieldKind(b.name);
    if (!kind) continue;
    any = true;
    add(kind, b.items.flatMap((item) => fieldList(item.replace(/\s+/g, ','))), b.span);
    for (const p of b.properties) add(/mandatory|required/i.test(`${p.key} ${p.value}`) ? 'mandatory' : kind, [p.key.trim()], p.span);
  }
  if (!any) return null;
  // Mandatory fields are filled during the transition, so they are updatable.
  if (out.mandatory?.length) {
    const list = (out.updatable ??= []);
    for (const name of out.mandatory) if (!list.includes(name)) list.push(name);
  }
  return out;
}

/**
 * The field spec of one blueprint: stage settings and each transition's
 * `during` settings, keyed by stage and transition display name. Null when
 * the blueprint declares none, so an app without them generates the same bytes.
 */
export function blueprintFieldSpec(w: Workflow, form: Form | undefined, statusColumn: string, transitionName: (name: string) => string, todos: TodoItem[] = []): BlueprintFieldSpec | null {
  const stages: Record<string, PhaseFields> = {};
  const transitions: Record<string, PhaseFields> = {};
  for (const stage of w.blueprint?.stages ?? []) {
    const fields = collect(stage.properties, stage.blocks, form, todos, 'stage');
    if (fields) stages[unquote(stage.name)] = fields;
  }
  for (const t of w.blueprint?.transitions ?? []) {
    for (const phase of t.phases) {
      if (phase.phase.trim().toLowerCase() !== 'during') continue;
      const fields = collect(phase.properties, phase.blocks, form, todos, 'transition');
      if (fields) transitions[transitionName(t.name)] = { ...(transitions[transitionName(t.name)] ?? {}), ...fields };
    }
  }
  if (!Object.keys(stages).length && !Object.keys(transitions).length) return null;
  return { statusColumn, stages, transitions };
}

/** Stage property keys emitBlueprint consumes as field settings. */
export function isStageFieldProperty(key: string): boolean {
  return phaseFieldKind(key) !== null;
}
