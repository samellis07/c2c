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
  stepSource: 'workaround' | 'generic';
}

/** The manual step for a drop with no workaround text. */
export function genericResidualStep(drop: Pick<SilentDrop, 'name' | 'form' | 'field' | 'property'>): string {
  const what = drop.property !== undefined && drop.form !== undefined && drop.field !== undefined ? `${drop.property} on ${drop.form}.${drop.field}` : drop.name;
  return `Set ${what} manually in the Catalyst console/app; not converted.`;
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
    return {
      id: (total.get(base) ?? 0) > 1 ? `${base} #${n}` : base,
      kind: drop.kind,
      construct: drop.name,
      ...(drop.form === undefined ? {} : { form: drop.form }),
      ...(drop.field === undefined ? {} : { field: drop.field }),
      ...(drop.property === undefined ? {} : { property: drop.property }),
      reason: reasonOf(drop, outcome),
      step: fix ?? genericResidualStep(drop),
      stepSource: fix ? 'workaround' : 'generic',
    };
  });
}
