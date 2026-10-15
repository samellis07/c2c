/**
 * Record-read authorization shared by server handlers and the client prefetch
 * endpoint. A prefetch must not return a row or a field the caller's profile
 * could not read, including the record filter of a Creator report they can view.
 *
 * Missing profile data is deny. A client-supplied body is not a principal.
 */

import { criteriaHasRecordQuery, criteriaHasTodo, type Criteria } from './criteria.js';

export class RecordAccessError extends Error {
  readonly code = 'RECORD_ACCESS_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'RecordAccessError';
  }
}

export interface Principal {
  /** Users_Permissions profile name. Table and field grants hang off this. */
  profile: string;
  /** Data-hierarchy role, when the platform user has one. */
  role?: string;
  /**
   * zoho.loginuserid: the user's email, not a numeric account id.
   * https://www.zoho.com/deluge/help/zoho-variables.html
   */
  userId?: string;
  /**
   * zoho.loginuser: the Creator username stored in Added_User. Not the email and not userId.
   * https://www.zoho.com/deluge/help/zoho-variables.html
   * https://help.zoho.com/portal/en/kb/creator/developer-guide/forms/add-and-manage-fields/articles/understand-system-fields
   */
  loginUser?: string;
}

/** Value substituted from the principal or the deploy environment at read time. Never taken from the request body. */
export interface BoundValue {
  __bind: 'loginUser' | 'loginUserId' | 'adminUser' | 'adminUserId';
}

/**
 * Dry-run placeholders for the application owner identity (`zoho.adminuser` /
 * `zoho.adminuserid`) when no owner is configured — the same sentinels
 * `shim.zoho.adminUser` / `shim.zoho.adminUserId` return, so a report criteria
 * comparing them fails closed instead of matching a stored value.
 * https://www.zoho.com/deluge/help/zoho-variables.html
 */
export const DRY_RUN_ADMIN_USER = '<c2c-dry-run:adminuser>';
export const DRY_RUN_ADMIN_USER_ID = '<c2c-dry-run:adminuserid>';

/** Deploy environment override for the application owner identity. */
function envIdentity(key: 'C2C_ADMIN_USER' | 'C2C_ADMIN_USER_ID'): string | undefined {
  const value = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface FormGrant {
  /**
   * Fields this profile may read. Absent means every field.
   * An empty list means the form is readable but no field value may be returned.
   */
  fields?: string[];
  /**
   * Extra criteria ANDed onto every read (OR of the report filters this profile
   * can view). Absent means those reports do not narrow the rows.
   */
  recordFilter?: Criteria;
  /** Profile may insert or update this form. Absent means no insert or update. Does not allow delete. */
  write?: boolean;
  /**
   * Profile may delete records of this form. Absent means no delete.
   * Creator keeps Delete separate from Create and Edit. The write bit does not set this.
   * Predefined presets: Administrator yes; Write, Read, and portal-add no.
   */
  delete?: boolean;
  /**
   * Fields this profile may write. Absent, when `write` is set, means every
   * field the caller names except read-only ones. An empty list means no field
   * may be written. Hidden fields are not included.
   */
  writable?: string[];
  /**
   * `false` when the profile may add records to this form but has no View and
   * no View All on it (a Create-only grant). No row or field may be read.
   * Absent means readable.
   */
  read?: false;
  /** Insert allowed. Absent follows `write`. `false` refuses an insert when `write` is set. */
  create?: boolean;
  /** Update allowed. Absent follows `write`. `false` refuses an update when `write` is set. */
  edit?: boolean;
  /**
   * Record sharing by owner. The owner of a row is its `Added_User`, matched
   * against the signed-in principal's login user.
   * - `view`: no View All. Only the caller's own rows can be read, edited or deleted.
   * - `modify`: View All without Modify All. Every granted row can be read; only
   *   the caller's own rows can be edited or deleted.
   * Absent means no owner restriction.
   */
  ownerScope?: 'view' | 'modify';
}

/** Column that names a row's owner for `ownerScope`. */
export const OWNER_FIELD = 'Added_User';

/**
 * What the caller is about to do with the rows a read finds. `modify` adds the
 * owner restriction of a `modify` grant (edit or delete of the row found).
 */
export type ReadIntent = 'read' | 'modify';

/** Write kind for `authorizeWrite`. Absent checks only the `write` bit. */
export type WriteOp = 'insert' | 'update';

export interface AccessPolicy {
  /** Profile name → form name → grant. A missing profile or form cannot be read. */
  profiles: Record<string, Record<string, FormGrant>>;
  /** Role names from the export. A principal role outside this list is denied. */
  roles: string[];
  /**
   * Forms, reports, and pages that appear only in a hidden menu section.
   * Direct navigation is denied even when a profile could otherwise read them.
   */
  hidden?: string[];
}

export type WriteFieldKind = 'lookup' | 'subform' | 'composite' | 'file';

/**
 * Scalar storage family of a plain leaf field. Only these columns reject a
 * blank string at the store (400 INVALID_INPUT on date, and the same
 * class for number/decimal): a blank for one of them normalises to null.
 * Text-family leaves (text, textarea, email, phone, url, rich text) keep ""
 * because Creator's empty text is the empty string, not null.
 */
export type WriteScalar = 'number' | 'decimal' | 'date' | 'datetime' | 'time';

export interface WriteField {
  /** Link name as stored on the form or subform. */
  name: string;
  readOnly?: boolean;
  /**
   * `lookup` values accept only the exact keys `id` and `label`.
   * `subform` rows and `composite` (address / name) values accept only `fields`.
   * `file` values accept only the exact key `key` (the upload reference).
   */
  kind?: WriteFieldKind;
  /** Child fields of a subform or the parts of an address or name. */
  fields?: readonly WriteField[];
  /** Storage family of a plain leaf field; marks blank-to-null candidates. */
  scalar?: WriteScalar;
  /**
   * Static Creator initial value (unquoted literal text), applied by the
   * submit handler to fields absent from the request on insert.
   * Absent when the field has no initial value or a dynamic one.
   */
  defaultValue?: string;
}

/**
 * One unconditional field-rule denial. A `hide` or `disable` action with no
 * criteria is static: the client never renders the field writable in the
 * record events the rule covers, so a posted value for it could not have come
 * from the form. `Subform.Field` names a subform column at row depth.
 */
export interface FieldRuleDenial {
  /** Field link name (`Subform.Field` names a subform column). */
  field: string;
  /** The field-rule action that denies the write. */
  action: 'hide' | 'disable';
  /**
   * Write ops the denying rule covers, from the workflow's record event
   * (`on add` → insert, `on edit` → update). Absent means both.
   */
  ops?: readonly WriteOp[];
}

export interface WriteSchema {
  /** Widget-level read-only fields (formula, autonumber, and the same). */
  readonlyFields?: readonly string[];
  /**
   * Flat field names. Used only when `fields` is omitted. Subform and composite
   * writes need `fields`; a flat list cannot say which names exist at which depth.
   */
  fieldNames?: readonly string[];
  /** Top-level fields of this form. Each depth allows only its own children. */
  fields?: readonly WriteField[];
  /**
   * Unconditional field-rule denials for this form. A listed field is refused
   * at the matching depth even when the profile grant would otherwise write it.
   */
  ruleDenied?: readonly FieldRuleDenial[];
}

/**
 * Never taken from a client body, at any depth, in any case.
 * `Owner` is the one exception, and only for the exact key `Owner` when this
 * depth has an editable field whose link name is `Owner`.
 */
const SYSTEM_WRITE_DENY = new Set([
  'rowid',
  'creatorid',
  'createdtime',
  'modifiedtime',
  'added_time',
  'modified_time',
  'c2c_source_id',
  'added_user',
  'modified_user',
  'owner',
]);

/** Platform-managed columns cannot be targeted by a single-field write. */
export function isSystemWriteDenied(field: string): boolean {
  return field.toLowerCase() !== 'owner' && SYSTEM_WRITE_DENY.has(field.toLowerCase());
}

const LOOKUP_KEYS = new Set(['id', 'label']);

export function principalFromRequest(req: unknown): Principal | null {
  if (!req || typeof req !== 'object') return null;
  const record = req as Record<string, unknown>;
  const catalyst = record.catalyst;
  // Trusted sources only: req.user and req.catalyst.user, which the Catalyst auth layer sets. Anything else
  // (req.auth, body, query, headers) can be caller-controlled and must never become the principal.
  const candidates = [
    record.user,
    catalyst && typeof catalyst === 'object' ? (catalyst as Record<string, unknown>).user : undefined,
  ];
  for (const candidate of candidates) {
    const principal = asPrincipal(candidate);
    if (principal) return principal;
  }
  return null;
}

// Profile and form names arrive from the request (a route segment or a token
// claim): "constructor" or "__proto__" must not resolve to an inherited member.
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function authorizeRead(
  policy: AccessPolicy,
  principal: Principal | undefined,
  form: string,
  criteria: Criteria,
  field?: string,
  intent: ReadIntent = 'read',
): { criteria: Criteria; fields?: readonly string[] } {
  if (!principal?.profile) throw new RecordAccessError('record access: authenticated profile required');
  if (principal.role && policy.roles.length > 0 && !policy.roles.includes(principal.role)) {
    throw new RecordAccessError(`record access: unknown role ${principal.role}`);
  }
  const forms = own(policy.profiles, principal.profile);
  if (!forms) throw new RecordAccessError(`record access: profile ${principal.profile} has no table permissions`);
  const grant = own(forms, form);
  if (!grant) throw new RecordAccessError(`record access: profile ${principal.profile} cannot read ${form}`);
  if (grant.read === false) throw new RecordAccessError(`record access: profile ${principal.profile} cannot read ${form}`);
  if (field && grant.fields && !grant.fields.includes(field)) {
    throw new RecordAccessError(`record access: profile ${principal.profile} cannot read ${form}.${field}`);
  }
  let filter = grant.recordFilter;
  if (filter) {
    // An unmigrated criteria or a dependent record query narrows the same way:
    // neither can be applied synchronously, so the read is refused.
    if (criteriaHasTodo(filter) || criteriaHasRecordQuery(filter)) {
      throw new RecordAccessError(`record access: record filter for ${form} could not be applied`);
    }
    filter = resolveBinds(filter, principal);
  }
  const owner = ownerFilter(grant, principal, intent);
  const extra = filter && owner ? { op: 'and' as const, args: [filter, owner] } : filter ?? owner;
  // A report's own criteria carries the same {__bind} placeholders the record
  // filter does (zoho.loginuser / zoho.loginuserid). Resolve them the same way
  // — an unresolved bind must never be compiled as a literal value.
  if (criteriaHasRecordQuery(criteria)) {
    throw new RecordAccessError(`record access: record filter for ${form} could not be applied`);
  }
  const bound = resolveBinds(criteria, principal);
  // ZCQL has no literal true: an unfiltered read narrows to the scope alone.
  const scoped = extra ? (bound.op === 'true' ? extra : { op: 'and' as const, args: [bound, extra] }) : bound;
  return { criteria: scoped, fields: grant.fields };
}

/**
 * The owner restriction a grant adds for this intent, bound to the caller.
 * A principal without a login user cannot own a row, so the read is refused.
 */
function ownerFilter(grant: FormGrant, principal: Principal, intent: ReadIntent): Criteria | undefined {
  const scope = grant.ownerScope;
  if (scope !== 'view' && !(scope === 'modify' && intent === 'modify')) return undefined;
  const user = principal.loginUser?.trim();
  if (!user) throw new RecordAccessError('record access: login user is required to apply the record owner');
  return { op: '==', field: OWNER_FIELD, value: user };
}

/**
 * Reply values a caller may see after a write: the readable fields of the
 * grant plus the row's system columns. A Create-only grant (`read: false`)
 * keeps only the keys the caller itself submitted, plus the row id. Values a
 * script or a stored row added to a hidden field never reach the reply.
 */
export function projectReadable(
  policy: AccessPolicy,
  principal: Principal | undefined,
  form: string,
  values: Record<string, unknown>,
  submitted?: readonly string[],
): Record<string, unknown> {
  const forms = principal?.profile ? own(policy.profiles, principal.profile) : undefined;
  const grant = forms ? own(forms, form) : undefined;
  if (!grant) return pick(values, REPLY_ID_KEYS);
  if (grant.read === false) return pick(values, [...REPLY_ID_KEYS, ...(submitted ?? [])]);
  if (!grant.fields) return { ...values };
  return pick(values, [...REPLY_ID_KEYS, ...REPLY_SYSTEM_KEYS, ...grant.fields]);
}

const REPLY_ID_KEYS = ['ID', 'ROWID'];
const REPLY_SYSTEM_KEYS = ['Added_User', 'Added_Time', 'Modified_User', 'Modified_Time'];

function pick(values: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(values, key)) out[key] = values[key];
  }
  return out;
}

/**
 * Submit and upload authorization. The form must be viewable and editable.
 *
 * Policy is reject, not drop, at every depth. A key is accepted only when it
 * is a known writable field of the form or subform at that depth. Hidden
 * fields, read-only fields, unknown keys, and system columns are rejected
 * with RecordAccessError. Nothing is stripped into a successful write, so a
 * later insert cannot receive the rejected key.
 *
 * Lookup values accept only the exact keys `id` and `label` (a scalar id is
 * also accepted). Address and name values accept only their known parts: a
 * grant naming the composite field allows every known sub-part, because
 * grants only ever name top-level fields. File, image, audio, video, and
 * signature values accept only `{ key }`, the
 * reference returned by the upload endpoint. A bare string or any other
 * object, including `{}`, is rejected.
 * ROWID, CREATORID, CREATEDTIME/Added_Time, MODIFIEDTIME/Modified_Time,
 * c2c_source_id, added_user, modified_user, and Owner are rejected in any
 * case. The exact key `Owner` is accepted only when this depth has an
 * editable field named `Owner`.
 *
 * The returned values are the ones a dry run may accept.
 */
export function authorizeWrite(
  policy: AccessPolicy,
  principal: Principal | undefined,
  form: string,
  values: Record<string, unknown>,
  schema?: WriteSchema,
  op?: WriteOp,
): { values: Record<string, unknown> } {
  if (!principal?.profile) throw new RecordAccessError('record access: authenticated profile required');
  if (principal.role && policy.roles.length > 0 && !policy.roles.includes(principal.role)) {
    throw new RecordAccessError(`record access: unknown role ${principal.role}`);
  }
  const forms = own(policy.profiles, principal.profile);
  if (!forms) throw new RecordAccessError(`record access: profile ${principal.profile} has no table permissions`);
  const grant = own(forms, form);
  if (!grant) throw new RecordAccessError(`record access: profile ${principal.profile} cannot view ${form}`);
  if (!grant.write) throw new RecordAccessError(`record access: profile ${principal.profile} cannot edit ${form}`);
  if (op === 'insert' && grant.create === false) {
    throw new RecordAccessError(`record access: profile ${principal.profile} cannot add ${form}`);
  }
  if (op === 'update' && grant.edit === false) {
    throw new RecordAccessError(`record access: profile ${principal.profile} cannot edit ${form}`);
  }
  const readonlyList = schema?.readonlyFields ?? [];
  const denied = ruleDeniedFor(schema?.ruleDenied, op);
  const depth = depthOf(schema, grant, readonlyList);
  return {
    values: screenObject(form, values ?? {}, '', depth, principal, grant, readonlyList, denied, true),
  };
}

/**
 * The denials in force for this write op. When the caller did not say which
 * op runs, a denial listed for either op applies: the rule hides or disables
 * the field in a context the request cannot be distinguished from.
 */
function ruleDeniedFor(list: readonly FieldRuleDenial[] | undefined, op: WriteOp | undefined): readonly FieldRuleDenial[] {
  if (!list?.length) return [];
  return list.filter((item) => !item.ops || !op || item.ops.includes(op));
}

/**
 * Live delete authorization. View, create, and edit do not imply delete.
 *
 * The form must be granted to the profile, and `grant.delete` must be set.
 * A missing principal, an unknown role, or a missing profile is denied before
 * any read. The record filter is not applied here; the scoped read that finds
 * ROWIDs does that.
 */
export function authorizeDelete(policy: AccessPolicy, principal: Principal | undefined, form: string): void {
  if (!principal?.profile) throw new RecordAccessError('record access: authenticated profile required');
  if (principal.role && policy.roles.length > 0 && !policy.roles.includes(principal.role)) {
    throw new RecordAccessError(`record access: unknown role ${principal.role}`);
  }
  const forms = own(policy.profiles, principal.profile);
  if (!forms) throw new RecordAccessError(`record access: profile ${principal.profile} has no table permissions`);
  const grant = own(forms, form);
  if (!grant) throw new RecordAccessError(`record access: profile ${principal.profile} cannot view ${form}`);
  if (!grant.delete) throw new RecordAccessError(`record access: profile ${principal.profile} cannot delete ${form}`);
}

interface DepthField {
  name: string;
  readOnly: boolean;
  kind?: WriteFieldKind;
  scalar?: WriteScalar;
  children: DepthField[];
}

interface Depth {
  /** No field list: only non-system scalars. Subforms need `schema.fields`. */
  open: boolean;
  fields: DepthField[];
}

function depthOf(schema: WriteSchema | undefined, grant: FormGrant, readonlyNames: readonly string[]): Depth {
  if (schema?.fields) {
    return { open: false, fields: schema.fields.map((field) => toDepth(field, readonlyNames)) };
  }
  const names = schema?.fieldNames ?? grant.writable ?? grant.fields;
  if (!names) return { open: true, fields: [] };
  return {
    open: false,
    fields: names.map((name) => ({
      name,
      readOnly: readonlyNames.some((item) => item.toLowerCase() === name.toLowerCase()),
      children: [],
    })),
  };
}

function toDepth(field: WriteField, readonlyNames: readonly string[]): DepthField {
  const readOnly =
    !!field.readOnly || readonlyNames.some((name) => name.toLowerCase() === field.name.toLowerCase());
  return {
    name: field.name,
    readOnly,
    ...(field.kind ? { kind: field.kind } : {}),
    ...(field.scalar ? { scalar: field.scalar } : {}),
    children: (field.fields ?? []).map((child) => toDepth(child, readonlyNames)),
  };
}

/**
 * Creator initial values for fields absent from the request
 * (API and import inserts, which never saw the Slate prefill). Only fields
 * whose value is missing, undefined or null are filled, and only on insert —
 * the caller guards the edit path. Read-only fields, lookups and file
 * references never take a static default. A posted "" stays "": it is
 * present, not absent (the user, or the API caller, cleared the cell).
 */
export function applyInitialValues(values: Record<string, unknown>, fields: readonly WriteField[] | undefined): void {
  if (!fields) return;
  for (const field of fields) {
    if (field.readOnly) continue;
    if (field.kind === 'subform') {
      const rows = values[field.name];
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (isPlainRecord(row)) applyInitialValues(row, field.fields);
        }
      }
      continue;
    }
    if (field.kind === 'composite') {
      const inner = values[field.name];
      if (isPlainRecord(inner)) applyInitialValues(inner, field.fields);
      continue;
    }
    if (field.kind === 'lookup' || field.kind === 'file') continue;
    if (field.defaultValue === undefined) continue;
    const current = values[field.name];
    if (current === undefined || current === null) values[field.name] = field.defaultValue;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function systemDenied(key: string, depth: Depth): boolean {
  if (!SYSTEM_WRITE_DENY.has(key.toLowerCase())) return false;
  if (key !== 'Owner') return true;
  const field = depth.fields.find((item) => item.name === 'Owner');
  return !(field && !field.readOnly);
}

function screenObject(
  form: string,
  values: Record<string, unknown>,
  prefix: string,
  depth: Depth,
  principal: Principal,
  grant: FormGrant,
  readonlyList: readonly string[],
  denied: readonly FieldRuleDenial[],
  grantApplies: boolean,
): Record<string, unknown> {
  const accepted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    // A parsed "__proto__" key is an own key; accepted[key] = value would set the
    // prototype of the accepted values instead of writing a field.
    if (key === '__proto__' || systemDenied(key, depth)) {
      throw new RecordAccessError(`record access: ${form}.${dotted} is not client-writable`);
    }
    const rule = ruleDenialAt(dotted, denied);
    if (rule) {
      throw new RecordAccessError(`record access: ${form}.${dotted} is ${rule.action === 'hide' ? 'hidden' : 'disabled'} by a field rule`);
    }
    if (depth.open) {
      if (readonlyList.some((name) => name.toLowerCase() === key.toLowerCase())) {
        throw new RecordAccessError(`record access: ${form}.${dotted} is read-only`);
      }
      accepted[key] = screenScalar(form, dotted, value, principal);
      continue;
    }
    const field = matchField(depth.fields, key);
    if (!field) {
      throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${dotted}`);
    }
    assertAllowed(form, dotted, field, principal, grant, readonlyList, grantApplies);
    accepted[key] = screenFieldValue(form, dotted, field, value, principal, grant, readonlyList, denied);
  }
  return accepted;
}

/**
 * The denial for this key path, or undefined. `Sub[0].Field` normalises to
 * the field-rule target `Sub.Field`, so a rule naming a subform column
 * refuses writes to that column in every row.
 */
function ruleDenialAt(dotted: string, denied: readonly FieldRuleDenial[]): FieldRuleDenial | undefined {
  const path = dotted.replace(/\[\d+\]/g, '');
  const lower = path.toLowerCase();
  return denied.find((item) => item.field === path || item.field.toLowerCase() === lower);
}

function matchField(fields: readonly DepthField[], key: string): DepthField | undefined {
  return fields.find((field) => field.name === key) ?? fields.find((field) => field.name.toLowerCase() === key.toLowerCase());
}

function assertAllowed(
  form: string,
  dotted: string,
  field: DepthField,
  principal: Principal,
  grant: FormGrant,
  readonlyList: readonly string[],
  grantApplies: boolean,
): void {
  if (field.readOnly || readonlyList.some((name) => name.toLowerCase() === field.name.toLowerCase())) {
    throw new RecordAccessError(`record access: ${form}.${dotted} is read-only`);
  }
  // Inside a granted composite the parent's grant covers every known
  // sub-part: grants only name top-level fields, so a sub-part can never
  // appear in grant.fields or grant.writable. Read-only, system-column and
  // unknown-key checks still apply at every depth.
  if (!grantApplies) return;
  if (grant.fields && !grant.fields.includes(field.name)) {
    throw new RecordAccessError(`record access: profile ${principal.profile} cannot write hidden ${form}.${dotted}`);
  }
  if (grant.writable && !grant.writable.includes(field.name)) {
    throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${dotted}`);
  }
}

function screenFieldValue(
  form: string,
  dotted: string,
  field: DepthField,
  value: unknown,
  principal: Principal,
  grant: FormGrant,
  readonlyList: readonly string[],
  denied: readonly FieldRuleDenial[],
): unknown {
  if (value == null) return value;
  if (field.kind === 'file') return screenFile(form, dotted, value, principal);
  if (field.kind === 'lookup') return screenLookup(form, dotted, value, principal);
  if (field.kind === 'subform') {
    if (!Array.isArray(value)) {
      throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${dotted}`);
    }
    return value.map((row, index) => {
      const path = `${dotted}[${index}]`;
      if (!isPlainRecord(row)) {
        throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${path}`);
      }
      return screenObject(form, row, path, { open: false, fields: field.children }, principal, grant, readonlyList, denied, true);
    });
  }
  if (field.kind === 'composite') {
    if (!isPlainRecord(value)) {
      throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${dotted}`);
    }
    return screenObject(form, value, dotted, { open: false, fields: field.children }, principal, grant, readonlyList, denied, false);
  }
  // A blank optional scalar is "no value", not "". The store rejects
  // "" for typed columns (400 INVALID_INPUT on date), so it becomes null.
  // Text-family leaves have no scalar marker and keep "" (Creator's empty
  // text is the empty string). This runs on insert and on update alike:
  // clearing a typed cell posts null either way.
  if (field.scalar && typeof value === 'string' && value.trim() === '') return null;
  return screenScalar(form, dotted, value, principal);
}

function screenFile(form: string, dotted: string, value: unknown, principal: Principal): { key: string } {
  const key = isPlainRecord(value) ? value.key : undefined;
  const keys = isPlainRecord(value) ? Object.keys(value) : [];
  if (keys.length !== 1 || keys[0] !== 'key' || typeof key !== 'string' || key.length === 0) {
    throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${dotted}: file reference must be { key }`);
  }
  return { key };
}

function screenLookup(form: string, dotted: string, value: unknown, principal: Principal): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => screenLookup(form, `${dotted}[${index}]`, item, principal));
  }
  if (!isPlainRecord(value)) return value;
  const accepted: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const path = `${dotted}.${key}`;
    if (SYSTEM_WRITE_DENY.has(key.toLowerCase()) || !LOOKUP_KEYS.has(key)) {
      throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${path}`);
    }
    if (inner != null && (isPlainRecord(inner) || Array.isArray(inner))) {
      throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${path}`);
    }
    accepted[key] = inner;
  }
  return accepted;
}

/**
 * Flat-store expansion for composite (name/address) values on the write
 * path. The store keeps one column per part (`Name_first_name`), while
 * `authorizeWrite` keeps the posted nesting (`Name: { first_name }`), so the
 * runtime expands a nested plain object into `Parent_child` keys before its
 * write-rule check — but ONLY when a matching flat rule exists for every
 * sub-key. A nested value shaped like a lookup (`{ id, label }`) or a file
 * reference (`{ key }`) is a single store column already and is never
 * expanded. A nested object with no flat match at all passes through
 * untouched (the write-rule check still refuses a missing mandatory column);
 * a partial match — some sub-key without a flat column — is refused with
 * RecordAccessError, never dropped silently. The input is never mutated, and
 * error texts name fields only, never record values.
 */
export function expandCompositeWrites(
  form: string,
  values: Record<string, unknown>,
  rules: readonly { name: string }[] | undefined,
): Record<string, unknown> {
  if (!rules?.length) return values;
  const columns = new Set(rules.map((rule) => rule.name));
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(values)) {
    if (!isPlainRecord(value)) continue;
    const parts = Object.keys(value);
    if (parts.length === 0) continue;
    // Lookup and file references are single store columns already.
    if (parts.length === 1 && parts[0] === 'key') continue;
    if (parts.every((part) => LOOKUP_KEYS.has(part))) continue;
    const flat = parts.map((part) => `${key}_${part}`);
    if (!flat.some((name) => columns.has(name))) continue;
    for (let index = 0; index < parts.length; index += 1) {
      if (!columns.has(flat[index]!)) {
        throw new RecordAccessError(`record access: ${form}.${key}.${parts[index]} is not a writable column`);
      }
    }
    if (!out) out = { ...values };
    delete out[key];
    for (let index = 0; index < parts.length; index += 1) {
      out[flat[index]!] = (value as Record<string, unknown>)[parts[index]!];
    }
  }
  return out ?? values;
}

function screenScalar(form: string, dotted: string, value: unknown, principal: Principal): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item != null && (isPlainRecord(item) || Array.isArray(item))) {
        throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${dotted}[${index}]`);
      }
      return item;
    });
  }
  if (isPlainRecord(value)) {
    throw new RecordAccessError(`record access: profile ${principal.profile} cannot write ${form}.${dotted}`);
  }
  return value;
}

export function projectFields(
  values: Record<string, unknown>,
  fields: readonly string[] | undefined,
): Record<string, unknown> {
  if (!fields) return { ...values };
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(values, field)) out[field] = values[field];
  }
  return out;
}

function asPrincipal(value: unknown): Principal | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const profile = text(record.profile ?? record.profileName ?? record.profile_name);
  if (!profile) return null;
  const role = text(record.role ?? record.roleName ?? record.role_name);
  const userId = text(record.userId ?? record.user_id ?? record.email ?? record.id);
  const loginUser = text(record.loginUser ?? record.login_user);
  const principal: Principal = { profile };
  if (role) principal.role = role;
  if (userId) principal.userId = userId;
  if (loginUser) principal.loginUser = loginUser;
  return principal;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveBinds(criteria: Criteria, principal: Principal): Criteria {
  switch (criteria.op) {
    case 'and':
    case 'or':
      return { ...criteria, args: criteria.args.map((arg) => resolveBinds(arg, principal)) };
    case 'not':
      return { ...criteria, arg: resolveBinds(criteria.arg, principal) };
    case '==':
    case '!=':
    case '<':
    case '>':
    case '<=':
    case '>=':
    case 'contains':
    case 'startsWith':
    case 'endsWith':
    case 'in':
      return { ...criteria, value: resolveValue(criteria.value, principal) };
    default:
      return criteria;
  }
}

function resolveValue(value: unknown, principal: Principal): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, principal));
  if (!value || typeof value !== 'object' || !('__bind' in value)) return value;
  const bind = (value as { __bind?: unknown }).__bind;
  if (bind === 'loginUser') {
    if (!principal.loginUser) throw new RecordAccessError('record access: login user is required to apply the record filter');
    return principal.loginUser;
  }
  if (bind === 'loginUserId') {
    if (!principal.userId) throw new RecordAccessError('record access: login user is required to apply the record filter');
    return principal.userId;
  }
  // The application owner is deploy configuration, not the caller: C2C_ADMIN_USER /
  // C2C_ADMIN_USER_ID set it, the labelled sentinel is the dry-run default.
  if (bind === 'adminUserId') return envIdentity('C2C_ADMIN_USER_ID') ?? DRY_RUN_ADMIN_USER_ID;
  if (bind === 'adminUser') return envIdentity('C2C_ADMIN_USER') ?? DRY_RUN_ADMIN_USER;
  throw new RecordAccessError('record access: record filter could not be applied');
}
