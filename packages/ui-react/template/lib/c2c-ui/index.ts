/**
 * @c2c/ui: the component library and runtime of generated React apps.
 * Built on vendored Arc Library components (arc/, see ARC-UPSTREAM.md).
 * Import from '@c2c/ui' only; the folders below are internal.
 */
import { lazy } from 'react';
import './arc/foundation.css';
import './styles/tokens.css';
import './styles/shell.css';

export type * from './types';
export { bootApp, navSections, deniedTargets, type RouteTable, type ScreenProps } from './boot';
export { AppShell } from './shell/AppShell';
export { FormView } from './form/FormView';
export { RecordSummary } from './form/RecordSummary';
export {
  Field,
  defaultWidget,
  TextField,
  TextAreaField,
  SelectField,
  RadioCardsField,
  MultiSelectField,
  CheckboxField,
  CompositeField,
  FileDropzoneField,
  SignaturePadField,
  RichTextField,
  NumberFieldWrapper,
  MoneyFieldWrapper,
  PhoneFieldWrapper,
  DateFieldWrapper,
  TimeFieldWrapper,
  SubformField,
  SectionField,
  NotesField,
  ComputedField,
  TodoField,
} from './form/fields';
export { readRecord, validate } from './form/record';
export { applyHandlerActions, matchingHandlers, runHandlers } from './form/handlers';
export type { FormHandlers, HandlerAction, HandlerCtx, HandlerDraft, HandlerModule, ShimBox } from './form/handlers';
export { lookupSource, LookupSource, LOOKUP_PAGE_SIZE, type LookupOption, type LookupSnapshot } from './lookup/source';
export type { LookupControlProps } from './lookup/LookupField';
export const LookupField = lazy(() => import('./lookup/LookupField').then((m) => ({ default: m.LookupField })));
export const LookupMultiField = lazy(() => import('./lookup/LookupField').then((m) => ({ default: m.LookupMultiField })));
export const LookupControl = lazy(() => import('./lookup/LookupField').then((m) => ({ default: m.LookupControl })));
export const LookupMultiControl = lazy(() => import('./lookup/LookupField').then((m) => ({ default: m.LookupMultiControl })));
export const SubformGrid = lazy(() => import('./subform/SubformGrid').then((m) => ({ default: m.SubformGrid })));
export { subformRows, validateRows, validateSubforms, type SubformRow } from './subform/rows';
export { ReportView, formatValue, buildQuery, groupRows, parseFormat } from './report/ReportView';
export { matchCriteria, criteriaTodo } from './report/criteria';
export { SmokePage } from './smoke/SmokePage';
export { mountSmoke, runSmokePlan, sealSmokeBlock, smokeCanonical, smokeModel, readJson } from './smoke/run';
export type { SmokeFieldPlan, SmokeLine, SmokeModel, SmokeRun, SmokeStep } from './smoke/run';
export { ChartReport, ChartPanel, ChartBody } from './charts/ChartView';
export { MetricTile } from './charts/MetricTile';
export { RowsScope, useRows, readRows } from './charts/rows';
export { PageView } from './pages/PageView';
export { sanitizeSnippet } from './pages/sanitize';
export { createApi, apiCall, apiUrl, bridgeSignOut, type Api, type ApiInit, type ApiReply, type ApiResponse, type AppWindow } from './runtime/api';
export { useEnv, type AppEnv } from './runtime/env';
export { parseRoute, hrefFor, navigate, useRoute, type Route } from './runtime/router';
export { AuthGate, serviceUrl } from './runtime/auth';
export {
  defineCustomization,
  useCustomization,
  Slot,
  type Customization,
  type FieldProps,
  type FormCustomization,
  type ReportCustomization,
  type ReportTableProps,
  type RouteAddition,
  type SubmitContext,
} from './runtime/extend';
export { Button } from './arc/components/button/button';
export { Input } from './arc/components/input/input';
export { Alert } from './arc/components/alert/alert';
export { EmptyState } from './arc/components/empty-state/empty-state';
export { SortableDataTable } from './arc/components/sortable-data-table/sortable-data-table';
export { Pagination } from './arc/components/pagination/pagination';
export { FilterToolbar, FilterMenu, type FilterChip, type FilterField, type FilterOption } from './arc/components/filter-toolbar/filter-toolbar';
export { Textarea } from './arc/components/textarea/textarea';
export { Checkbox } from './arc/components/checkbox/checkbox';
export { MetricCard } from './arc/components/metric-card/metric-card';
export { BarChart } from './arc/components/bar-chart/bar-chart';
export { LineChart } from './arc/components/line-chart/line-chart';
export { DonutChart } from './arc/components/donut-chart/donut-chart';
// The heavy widgets re-export lazily so their chunk only loads when a field
// (or a customization) actually renders one.
export const NumberField = lazy(() => import('./arc/components/number-field/number-field').then((m) => ({ default: m.NumberField })));
export const MoneyInput = lazy(() => import('./arc/components/money-input/money-input').then((m) => ({ default: m.MoneyInput })));
export const PhoneInput = lazy(() => import('./arc/components/phone-input/phone-input').then((m) => ({ default: m.PhoneInput })));
export const DatePicker = lazy(() => import('./arc/components/date-picker/date-picker').then((m) => ({ default: m.DatePicker })));
export const TimePicker = lazy(() => import('./arc/components/time-picker/time-picker').then((m) => ({ default: m.TimePicker })));
export const Select = lazy(() => import('./arc/components/select/select').then((m) => ({ default: m.Select })));
export const MultiSelect = lazy(() => import('./arc/components/multi-select/multi-select').then((m) => ({ default: m.MultiSelect })));
export const RadioCards = lazy(() => import('./arc/components/radio-cards/radio-cards').then((m) => ({ default: m.RadioCards })));
export const FileDropzone = lazy(() => import('./arc/components/file-dropzone/file-dropzone').then((m) => ({ default: m.FileDropzone })));
export const SignaturePad = lazy(() => import('./arc/components/signature-pad/signature-pad').then((m) => ({ default: m.SignaturePad })));
export const RichTextEditor = lazy(() => import('./arc/components/rich-text-editor/rich-text-editor').then((m) => ({ default: m.RichTextEditor })));
export const Combobox = lazy(() => import('./arc/components/combobox/combobox').then((m) => ({ default: m.Combobox })));
export type { ComboboxOption } from './arc/components/combobox/combobox';
export type { MultiSelectOption } from './arc/components/multi-select/multi-select';
export { Stepper } from './arc/components/stepper/stepper';
export { Timeline } from './arc/components/timeline/timeline';
export { Dialog, DialogContent, DialogTrigger } from './arc/components/dialog/dialog';
export { CommentThread, type ThreadComment, type CommentAuthor } from './arc/components/comment-thread/comment-thread';
export { ApprovalsInbox } from './workflow/ApprovalsInbox';
export { FlowStageBar } from './workflow/FlowStageBar';
export { DecisionDialog, type FlowDecision, type FlowOutcome } from './workflow/DecisionDialog';
export {
  flowsForForm,
  approvalFlows,
  openStages,
  terminalStages,
  transitionsFrom,
  transitionLabel,
  stageBarStages,
  recordStage,
  type FlowEvent,
} from './workflow/flows';
