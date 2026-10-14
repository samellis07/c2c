/**
 * Extension points. Generated code (src/generated/**) is rewritten on every
 * regeneration; everything a user changes lives in src/custom/** and reaches
 * the app only through this object, so a regeneration never loses it.
 *
 * - components: replace a building block everywhere (a field widget, the report table, the empty state)
 * - forms[name]: per-form field overrides, slots and submit hooks
 * - reports[name]: per-report cell renderers, slots and row actions
 * - routes: extra screens, added to the nav
 * - nav: reorder, rename or hide nav entries
 * - api.headers: extra request headers
 */
import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { FieldSpec, FormRecord, FormSpec, NavSection, ReportSpec } from '../types';
import type { HeaderHook } from './api';

export interface FieldProps {
  form: FormSpec;
  field: FieldSpec;
  /** Error text for this field after a submit attempt. */
  error?: string;
  /** Current record value when the form opens an existing record. */
  value?: unknown;
  /** Name prefix for nested controls (composite parts and subform cells). */
  path?: string;
  /** The 18-digit ID of the record being edited, if this is an edit form. */
  rowId?: string;
}

export interface ReportTableProps {
  report: ReportSpec;
  rows: Record<string, unknown>[];
}

export interface SubmitContext {
  form: FormSpec;
  mode: 'add' | 'edit';
  rowId?: string;
}

export interface FormCustomization {
  /** Replace the control of one field, by field name. */
  fields?: Record<string, ComponentType<FieldProps>>;
  slots?: { before?: ReactNode; after?: ReactNode; actions?: ReactNode };
  /** Change the record before it is posted, or return false to stop the submit. */
  beforeSubmit?: (record: FormRecord, ctx: SubmitContext) => FormRecord | false | Promise<FormRecord | false>;
  afterSubmit?: (reply: { ok: boolean; dryRun: boolean; body: unknown }, ctx: SubmitContext) => void | Promise<void>;
}

export interface ReportCustomization {
  /** Render one column's cells, by field name. */
  cells?: Record<string, (value: unknown, row: Record<string, unknown>) => ReactNode>;
  slots?: { before?: ReactNode; after?: ReactNode; toolbar?: ReactNode };
  /** Extra controls at the end of each row. */
  rowActions?: (row: Record<string, unknown>) => ReactNode;
}

export interface RouteAddition {
  /** The route key: `page/<name>` is reached at #/page/<name>. */
  page: string;
  label: string;
  /** Nav section label; a new section is created when none matches. */
  section?: string;
  component: ComponentType;
}

export interface Customization {
  components?: {
    /** By widget kind: `email`, `date`, `subform`, ... */
    fields?: Partial<Record<string, ComponentType<FieldProps>>>;
    ReportTable?: ComponentType<ReportTableProps>;
    EmptyState?: ComponentType<{ report: ReportSpec }>;
  };
  forms?: Record<string, FormCustomization>;
  reports?: Record<string, ReportCustomization>;
  routes?: RouteAddition[];
  nav?: (sections: NavSection[]) => NavSection[];
  api?: { headers?: HeaderHook };
}

/** Typed identity: `export default defineCustomization({ ... })` in src/custom/index.tsx. */
export function defineCustomization(customization: Customization): Customization {
  return customization;
}

export const CustomizationContext = createContext<Customization>({});

export function useCustomization(): Customization {
  return useContext(CustomizationContext);
}

/** A named slot: renders what the customization put there, else nothing. */
export function Slot({ children }: { children?: ReactNode }) {
  return children === undefined || children === null ? null : <>{children}</>;
}
