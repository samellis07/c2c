/**
 * Guided residual items: one per coverage-ledger drop (C3).
 *
 * A drop is a declared construct the converter neither generates nor counts.
 * It stays a drop — it is still counted, and the app is still not
 * deterministic — but the customer gets an item that says what is not
 * converted, why, and what to do instead, so nothing is left unexplained.
 *
 * - reason: the field's schema mapping reason (the field-gap reason source)
 *   when the drop belongs to a field with a schema outcome — prefixed with the
 *   setting that is not carried for a field-property drop — else the ledger
 *   note.
 * - step: the precheck workaround text (CONVERTER_GAP_FIX) when one applies,
 *   else a generic manual step naming the construct. The generic step is
 *   marked `stepSource: 'generic'` so it is never mistaken for a converted
 *   setting.
 */

import type { FieldOutcome } from '../../schema/src/generator.js';
import type { DropKind, SilentDrop } from '../../quality/src/no-silent-drop.js';
import { CONVERTER_GAP_FIX } from './precheck.js';

export interface GuidedResidual {
  /** Stable id: `<kind>:<construct>`, with `#n` when the same construct drops more than once. */
  id: string;
  kind: DropKind;
  /** The construct that is not converted, as the coverage ledger names it. */
  construct: string;
  form?: string;
  field?: string;
  property?: string;
  reason: string;
  step: string;
  stepSource: 'workaround' | 'specific' | 'generic';
}

/** The manual step for a drop with no workaround text. */
export function genericResidualStep(drop: Pick<SilentDrop, 'name' | 'form' | 'field' | 'property'>): string {
  const what = drop.property !== undefined && drop.form !== undefined && drop.field !== undefined ? `${drop.property} on ${drop.form}.${drop.field}` : drop.name;
  return `Set ${what} manually in the Catalyst console/app; not converted.`;
}

/** Plain-language instructions for the highest-volume field/report gaps. */
export function specificResidualStep(drop: Pick<SilentDrop, 'kind' | 'name' | 'form' | 'field' | 'property'>): string | undefined {
  if (drop.kind === 'field-property' && drop.form && drop.field && drop.property) {
    const field = `${drop.form}.${drop.field}`;
    switch (drop.property.replace(/^property /, '')) {
      case 'displayformat':
        return `The lookup display format for ${field} was not converted. In the Catalyst console, set the lookup's display field or display format for ${field}, then preview the form and confirm the lookup shows the intended value.`;
      case 'sortorder':
        return `The sort order for ${field} was not converted. In the Catalyst console, set the field's sort order for ${field}, then preview the form or report and confirm values appear in that order.`;
      case 'format':
        return `The display format for ${field} was not converted. In the Catalyst console, set the field's number or currency format for ${field}, then preview a record and confirm the value is displayed correctly.`;
      case 'personal data':
        return `The personal-data setting for ${field} was not converted. In the Catalyst console, mark ${field} as personal or sensitive data if required by your policy, then inspect the field settings and verify the protection is enabled.`;
      default:
        return `The ${drop.property} setting for ${field} was not converted. In the Catalyst console, configure that setting for ${field}, then preview the form or report and confirm the field behaves as expected.`;
    }
  }
  if (drop.kind === 'report-feature' && / block options$/.test(drop.name)) {
    const report = drop.name.replace(/ block options$/, '');
    return `The options for the ${report} report were not converted. In the Catalyst console, open the ${report} report and configure its report options, then preview it and verify the filters, layout, and visible data match the source app.`;
  }
  if (drop.kind === 'report-feature' && / block report properties$/.test(drop.name)) {
    const report = drop.name.replace(/ block report properties$/, '');
    return `The report properties for ${report} were not converted. In the Catalyst console, open the ${report} report and configure its report properties, then preview it and verify the layout and visible data match the source app.`;
  }
  if (drop.kind === 'report-feature' && / column .+$/.test(drop.name)) {
    const match = /^(.*) column (.+)$/.exec(drop.name);
    if (match) {
      const [, report, column] = match;
      return `The ${column} column in the ${report} report was not converted. In the Catalyst console, open the ${report} report and add or configure that column, then preview the report and verify the displayed value matches the source app.`;
    }
  }
  if (drop.kind === 'page-element') {
    return `The ${drop.name} page element was not converted. In the Catalyst console, open the page and add or configure this element, then preview the page and verify it behaves as expected.`;
  }
  if (drop.kind === 'translation') {
    return `The ${drop.name} was not converted. In the Catalyst console, add the language and copy the source translation strings into the generated app, then preview the translated text and verify it is correct.`;
  }
  return undefined;
}

function workaround(drop: SilentDrop, outcome: FieldOutcome | undefined): string | undefined {
  if (drop.kind === 'field' && outcome?.status === 'unsupported') return CONVERTER_GAP_FIX.field;
  if (drop.kind === 'statement') return CONVERTER_GAP_FIX.deluge;
  return undefined;
}

/** The field-gap reason for a drop on a field with a schema outcome, else the ledger note. */
function reasonOf(drop: SilentDrop, outcome: FieldOutcome | undefined): string {
  if (!outcome?.reason.trim()) return drop.note;
  if (drop.property === undefined) return outcome.reason;
  return `${drop.property} is not carried by the generated ${outcome.matrixId} field. ${outcome.reason}`;
}

/** One guided item per drop, in ledger order. */
export function guidedResiduals(drops: readonly SilentDrop[], fields: readonly FieldOutcome[]): GuidedResidual[] {
  const outcomes = new Map(fields.map((outcome) => [`${outcome.form}\0${outcome.field}`, outcome]));
  const total = new Map<string, number>();
  for (const drop of drops) total.set(`${drop.kind}:${drop.name.trim()}`, (total.get(`${drop.kind}:${drop.name.trim()}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  return drops.map((drop) => {
    const base = `${drop.kind}:${drop.name.trim()}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const outcome = drop.form !== undefined && drop.field !== undefined ? outcomes.get(`${drop.form}\0${drop.field}`) : undefined;
    const fix = workaround(drop, outcome);
    const specific = fix ? undefined : specificResidualStep(drop);
    return {
      id: (total.get(base) ?? 0) > 1 ? `${base} #${n}` : base,
      kind: drop.kind,
      construct: drop.name,
      ...(drop.form === undefined ? {} : { form: drop.form }),
      ...(drop.field === undefined ? {} : { field: drop.field }),
      ...(drop.property === undefined ? {} : { property: drop.property }),
      reason: reasonOf(drop, outcome),
      step: fix ?? specific ?? genericResidualStep(drop),
      stepSource: fix ? 'workaround' : specific ? 'specific' : 'generic',
    };
  });
}
