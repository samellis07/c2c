/**
 * Generated live-write source for forms with inline subforms or file fields.
 *
 * Shared by the Deluge on-success handlers and the UI submit stubs. A form with
 * neither gets exactly the writeLive it had before, byte for byte.
 *
 * - Subforms: the parent row is written without the subform arrays, then the
 *   child rows through `saveSubforms` (FK to the parent ROWID, 0-based row
 *   order). A failed child write on insert deletes the new parent again.
 * - Files, images, audio, video, signatures: the `{ key }` reference becomes the
 *   Stratus object key the column stores (`storeFileKeys`), and the key must
 *   belong to this form and field.
 */
import type { App, Field } from '../../core/src/ir.js';
import { fileColumnsOf, generateSchema, subformTablesOf, type SchemaPlan } from '../../schema/src/generator.js';
import type { SubformTable } from '../../shims/src/subforms.js';

export interface FieldStoreShape {
  /** Child tables of the form's inline subforms. */
  links: SubformTable[];
  /** Top-level Stratus-key columns of the form table. */
  files: string[];
}

const cache = new WeakMap<App, SchemaPlan>();

function planOf(app: App): SchemaPlan {
  let plan = cache.get(app);
  if (!plan) {
    plan = generateSchema(app);
    cache.set(app, plan);
  }
  return plan;
}

/** The child tables of one form, in schema order. Empty when it has no inline subform. */
export function subformLinksFor(app: App, form: string): SubformTable[] {
  const map = subformTablesOf(planOf(app));
  return [...(Object.hasOwn(map, form) ? map[form]! : []), ...linkedGridLinksFor(app, form)];
}

/**
 * A grid whose `values` names another form (`values = Product_Subform.ID`)
 * keeps its rows as records of that form: the schema gives the linked table a
 * foreign key to the parent ROWID (ON-DELETE-CASCADE). Each such grid is a
 * subform link onto that table with no order column; rows read back in ROWID
 * order. A grid whose foreign key cannot be told apart (two grids of one form
 * linking the same form) is left out rather than guessed.
 */
function linkedGridLinksFor(app: App, form: string): SubformTable[] {
  const parentForm = app.forms.find((item) => item.name === form);
  if (!parentForm) return [];
  const plan = planOf(app);
  const parentTable = plan.tables.find((table) => table.role === 'form' && table.form === form);
  if (!parentTable || parentTable.nosql) return [];
  const links: SubformTable[] = [];
  for (const field of parentForm.fields) {
    const target = linkedGridForm(app, field);
    if (!target) continue;
    const targetTable = plan.tables.find((table) => table.role === 'form' && table.form === target && !table.nosql);
    const backs = (targetTable?.columns ?? []).filter((column) => column.creatorType === 'subform' && column.relation?.table === parentTable.name);
    if (!targetTable || backs.length !== 1) continue;
    const grids = parentForm.fields.filter((item) => linkedGridForm(app, item) === target);
    if (grids.length !== 1) continue;
    links.push({ field: field.name, table: targetTable.name, parentColumn: backs[0]!.name });
  }
  return links;
}

/** The linked form of a `grid` field whose `values` names another form, else undefined. */
export function linkedGridForm(app: App, field: Field): string | undefined {
  const token = (field.type ?? '').trim().toLowerCase();
  if (token !== 'grid' || !field.lookup?.form) return undefined;
  return app.forms.some((item) => item.name === field.lookup!.form) ? field.lookup.form : undefined;
}

/** Stratus-key columns of the form's own table. */
export function fileFieldsFor(app: App, form: string): string[] {
  const plan = planOf(app);
  const table = plan.tables.find((item) => item.role === 'form' && item.form === form);
  if (!table) return [];
  const files = fileColumnsOf(plan);
  return Object.hasOwn(files, table.name) ? files[table.name]!.columns : [];
}

/** Form link name → its Stratus-key fields, for every form that has one. Sorted by form. */
export function fileFieldsByForm(app: App): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const forms = app.forms.map((form) => form.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const form of forms) {
    const fields = fileFieldsFor(app, form);
    if (fields.length) out[form] = fields;
  }
  return out;
}

export function fieldStoreShape(app: App, form: string): FieldStoreShape {
  return { links: subformLinksFor(app, form), files: fileFieldsFor(app, form) };
}

/** Names to add to the `creator-to-catalyst/shims` import. */
export function fieldStoreImports(shape: FieldStoreShape): string[] {
  return [...(shape.links.length ? ['saveSubforms', 'splitSubforms'] : []), ...(shape.files.length ? ['storeFileKeys'] : [])];
}

/** Extra argument for the writeLive call: the raw datastore adapter. */
export function fieldStoreWriteArg(shape: FieldStoreShape): string {
  return shape.links.length ? ', datastore' : '';
}

const PLAIN = `async function writeLive(runtime, ctx, targetForm) {
  const shim = ctx.shim;
  const rowId = typeof ctx.rowId === "string" ? ctx.rowId.trim() : "";
  if (rowId || ctx.writeOp === "update") {
    if (ctx.writeOp !== "update") await shim.record.prepare(ctx, targetForm);
    await shim.datastore.update(ctx, targetForm, { op: "==", field: "ROWID", value: rowId }, ctx.record);
    ctx.persisted = true;
    return { wrote: true, op: "update" };
  }
  if (!Object.prototype.hasOwnProperty.call(ctx.record, "Added_User")) shim.record.stamp(ctx, "insert");
  const result = await shim.datastore.insert(ctx, targetForm, ctx.record);
  mergeInserted(ctx.record, result);
  ctx.persisted = true;
  return { wrote: true, op: "insert" };
}`;

/** writeLive for the module. */
export function writeLiveSource(form: string, shape: FieldStoreShape): string {
  const { links, files } = shape;
  if (!links.length && !files.length) return PLAIN;
  const consts = [
    ...(links.length
      ? [`/** Inline subforms of this form, each a child table (FK to the parent ROWID, 0-based row order). */\nexport const subformTables = ${JSON.stringify({ [form]: links })};`]
      : []),
    ...(files.length ? [`/** File, image, audio, video, and signature fields: the column stores the Stratus object key. */\nexport const fileFields = ${JSON.stringify(files)};`] : []),
  ].join('\n');
  const keys = files.length ? '\n  storeFileKeys(targetForm, ctx.record, fileFields);' : '';
  if (!links.length) {
    return `${consts}

async function writeLive(runtime, ctx, targetForm) {
  const shim = ctx.shim;
  const rowId = typeof ctx.rowId === "string" ? ctx.rowId.trim() : "";${keys}
  if (rowId || ctx.writeOp === "update") {
    if (ctx.writeOp !== "update") await shim.record.prepare(ctx, targetForm);
    await shim.datastore.update(ctx, targetForm, { op: "==", field: "ROWID", value: rowId }, ctx.record);
    ctx.persisted = true;
    return { wrote: true, op: "update" };
  }
  if (!Object.prototype.hasOwnProperty.call(ctx.record, "Added_User")) shim.record.stamp(ctx, "insert");
  const result = await shim.datastore.insert(ctx, targetForm, ctx.record);
  mergeInserted(ctx.record, result);
  ctx.persisted = true;
  return { wrote: true, op: "insert" };
}`;
  }
  return `${consts}

async function writeLive(runtime, ctx, targetForm, datastore) {
  const shim = ctx.shim;
  const rowId = typeof ctx.rowId === "string" ? ctx.rowId.trim() : "";${keys}
  if (rowId || ctx.writeOp === "update") {
    if (ctx.writeOp !== "update") await shim.record.prepare(ctx, targetForm);
    const split = splitSubforms(ctx.record, subformTables, targetForm);
    if (split.children.length && !rowId) throw new Error("subform rows need the parent ROWID");
    await shim.datastore.update(ctx, targetForm, { op: "==", field: "ROWID", value: rowId }, split.parent);
    if (split.children.length) await saveSubforms(datastore, rowId, split.children, { replace: true });
    ctx.persisted = true;
    return { wrote: true, op: "update" };
  }
  if (!Object.prototype.hasOwnProperty.call(ctx.record, "Added_User")) shim.record.stamp(ctx, "insert");
  const split = splitSubforms(ctx.record, subformTables, targetForm);
  const result = await shim.datastore.insert(ctx, targetForm, split.parent);
  mergeInserted(ctx.record, result);
  if (split.children.length) {
    if (!ctx.record.ROWID) throw new Error("the inserted row has no ROWID; subform rows were not saved");
    await saveSubforms(datastore, ctx.record.ROWID, split.children, { parentTable: targetForm });
  }
  ctx.persisted = true;
  return { wrote: true, op: "insert" };
}`;
}
