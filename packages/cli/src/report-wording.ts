/**
 * Business wording layer for the migration report.
 *
 * Every internal reason, matrix id, construct name or product-internal name is
 * mapped here to a sentence a non-developer can act on: what they will notice,
 * plus a concrete next step that names their own forms, fields and reports.
 * Internal detail is kept only in the appendix JSON (`technical` fields), never
 * in the markdown or the machine report.
 */

export interface BusinessWording {
  /** What the business user will notice. */
  notice: string;
  /** What to do about it, in their terms. */
  workaround: string;
}

/**
 * Internal jargon and product-internal identifiers that must never appear in
 * a business-facing report. Kept in one exported list so the wording test can
 * scan generated reports for exactly these terms.
 */
export const BANNED_TERMS: readonly string[] = [
  'PATTERN_NOT_MATCHED',
  'FK needs console',
  'junction table',
  'ON-DELETE',
  'API type',
  'foreign key',
  'ROWID',
  'ZCQL',
  'varchar',
  'bigint',
  '.ds',
  'Stratus',
  'SmartBrowz',
  'AppSail',
  'Zia',
  'Slate',
  'Deluge',
  'ZML',
  'sanitizer',
  'regex',
  'shim',
  'HTML Snippet',
  'openUrl',
  'iframe',
  'TODO',
  '<style',
  '<link',
  'JSON',
];

const SCRUB: readonly [RegExp, string][] = [
  [/PATTERN_NOT_MATCHED/g, 'a format check'],
  [/FK needs console/g, 'a link that needs a manual step'],
  [/junction tables?/gi, 'a linking table'],
  [/ON-DELETE-[A-Z-]+/g, 'delete behaviour'],
  [/API type/g, 'field kind'],
  [/foreign keys?/gi, 'linked record'],
  [/ROWIDs?/g, 'record id'],
  [/ZCQL/g, 'the query language'],
  [/varchar/gi, 'text'],
  [/bigint/gi, 'a number'],
  [/\.ds\b/g, 'the export file'],
  [/SmartBrowz/g, 'the PDF service'],
  [/Stratus/g, 'file storage'],
  [/AppSail/g, 'custom server hosting'],
  [/Zia/g, 'AI'],
  [/Slate/g, 'the hosted web app'],
  [/Deluge/g, 'the app script'],
  [/ZML/g, 'page markup'],
  [/sanitizer/gi, 'safety filter'],
  [/regex/gi, 'format check'],
  [/shims?/gi, 'compatibility helper'],
  [/HTML Snippet/g, 'custom embed'],
  [/openUrl/g, 'an open-link call'],
  [/an iframes?/gi, 'an embedded frame'],
  [/iframes?/gi, 'embedded frame'],
  [/TODO/g, 'item'],
  [/CSS/g, 'styling'],
  [/<style>/g, 'style blocks'],
  [/<link>/g, 'link tags'],
  [/JSON/g, 'data'],
];

/** Last-resort scrub for pass-through strings (manual steps, secret key names, feature names). */
export function scrubBusiness(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUB) out = out.replace(pattern, replacement);
  return out.replace(/\s{2,}/g, ' ').trim();
}

const AI_STEP = 'Keep the AI-filled value out of the automatic form, or add a reviewed post-submit enrichment step before go-live.';
const CONNECTION_STEP = 'Ask the person who owns the external account to authorize the matching connection during migration; otherwise keep the value as text and complete the lookup after launch.';

/**
 * One business sentence pair per field-type id (the internal `matrixId`). The
 * notice says what the user will see; the workaround names a concrete action.
 */
const FIELD_GAP_WORDING: Record<string, BusinessWording> = {
  'multi-line': {
    notice: 'Long text is kept, but entries longer than the storage limit are rejected by a generated length check.',
    workaround: 'If any record can exceed the limit, split the text or shorten it before relying on the field.',
  },
  email: {
    notice: 'The field still checks that entries look like email addresses, but the exact rule can differ from the original on edge cases.',
    workaround: 'Test one unusual but valid address and one invalid address against this field before go-live.',
  },
  phone: {
    notice: 'Phone numbers are stored as text; the country-specific digit rules may differ from the original checks.',
    workaround: 'Test one phone number in each country format the business uses before go-live.',
  },
  decimal: {
    notice: 'Decimal values are stored as exact text so no precision is lost; sorting and range checks still work.',
    workaround: 'Check that reports sorting or filtering on this field show records in the order you expect.',
  },
  percent: {
    notice: 'The percentage number is kept exactly as entered; the % sign is display only.',
    workaround: 'Confirm one entered percentage shows the same value in the generated form and reports.',
  },
  currency: {
    notice: 'The amount is kept exactly as entered and the currency code stays on the field.',
    workaround: 'Confirm one amount in each currency the app uses displays and totals correctly.',
  },
  'date-time': {
    notice: 'Date-and-time values are converted to the app timezone; the stored instant can display differently than in the original.',
    workaround: 'Check one record near a day boundary (early morning or late evening) shows the expected date and time.',
  },
  time: {
    notice: 'Time-of-day values are stored as text; comparisons such as “before 5 pm” are handled by generated code.',
    workaround: 'Test one workflow or report that compares times before go-live.',
  },
  'multi-select': {
    notice: 'Multiple choices are kept as a list; reports that filter on a single choice may behave differently.',
    workaround: 'Test each report or workflow that checks this field’s choices before go-live.',
  },
  'checkbox-multi': {
    notice: 'Ticked choices are kept as a list rather than a yes/no value.',
    workaround: 'Test each report or workflow that checks this field’s choices before go-live.',
  },
  'lookup-single': {
    notice: 'The link to the related record is kept; how it behaves when the related record is deleted follows the app’s link settings.',
    workaround: 'Open one record and confirm the linked record resolves; test deleting a linked record only in a trial run.',
  },
  'lookup-multi': {
    notice: 'The many-to-many link is kept through a linking table the migration creates.',
    workaround: 'Open one record and confirm all its linked records appear before sign-off.',
  },
  subform: {
    notice: 'The inline table becomes its own related table; rows are saved together with the parent record.',
    workaround: 'Submit one record with subform rows and confirm the rows appear under the record.',
  },
  users: {
    notice: 'The people referenced here must be invited into the new app; they are not carried over automatically.',
    workaround: 'Invite the affected people into the project and re-check the records that name them.',
  },
  'file-upload': {
    notice: 'Files are kept in file storage; the field stores a reference to each file.',
    workaround: 'Open one migrated record and download its attached file to confirm it opens.',
  },
  image: {
    notice: 'Images are kept in file storage; thumbnail, crop and annotation tools are not rebuilt.',
    workaround: 'Open one migrated record and view its image; plan a separate step if the editing tools are still needed.',
  },
  audio: {
    notice: 'Audio files are kept in file storage; an in-app player or recorder is not generated.',
    workaround: 'Open one migrated record and play or download its audio file.',
  },
  video: {
    notice: 'Video files are kept in file storage; an in-app player is not generated.',
    workaround: 'Open one migrated record and play or download its video file.',
  },
  signature: {
    notice: 'Signatures are kept as stored images in file storage.',
    workaround: 'Open one migrated record and confirm the signature image displays.',
  },
  url: {
    notice: 'Links are stored as full text so long addresses are not cut off.',
    workaround: 'Open one record with a long link and confirm the whole link works.',
  },
  'rich-text': {
    notice: 'Formatted text is kept up to a storage limit; longer content is rejected by a generated check.',
    workaround: 'Check the longest formatted entry you expect and confirm it saves and displays correctly.',
  },
  formula: {
    notice: 'The computed value is stored as its last result rather than recalculated on every change.',
    workaround: 'Enter one record, check the computed value, and plan a script or manual check if it must stay live.',
  },
  'auto-number': {
    notice: 'Numbering continues from a generated counter; the original prefix, start value and reset rules are not carried over.',
    workaround: 'Note the next number the business expects, verify the first new record gets it, and adjust the counter if needed.',
  },
  address: {
    notice: 'Each part of the address is kept in its own field; the map picker is not generated.',
    workaround: 'Open one record and confirm every address part is filled in correctly.',
  },
  integration: {
    notice: 'The link to the other product is stored as text or an external reference until a connection is authorized.',
    workaround: CONNECTION_STEP,
  },
  prediction: {
    notice: 'The AI-predicted value is not filled automatically in the generated app.',
    workaround: AI_STEP,
  },
  keyword: {
    notice: 'Keywords are no longer extracted automatically when a record is submitted.',
    workaround: AI_STEP,
  },
  sentiment: {
    notice: 'Sentiment is no longer scored automatically when a record is submitted.',
    workaround: AI_STEP,
  },
  ocr: {
    notice: 'Text is no longer read out of uploaded images automatically.',
    workaround: AI_STEP,
  },
  'object-detection': {
    notice: 'Objects in uploaded images are no longer labelled automatically.',
    workaround: AI_STEP,
  },
  barcode: {
    notice: 'The code value is stored as text; the code image is not rendered in the generated app.',
    workaround: 'Enter or paste the code value into the generated text field, or add a reviewed scanning flow if the device workflow is required.',
  },
  geolocation: {
    notice: 'There is no separate map-location field; coordinates travel inside the address field instead.',
    workaround: 'Capture the needed address or location in the supported address fields instead of a separate location field.',
  },
  'legacy-crm': {
    notice: 'The link to the old customer-record system is kept as its display text.',
    workaround: CONNECTION_STEP,
  },
  'legacy-crm-link': {
    notice: 'The link to the old customer-record system is kept as a reference number.',
    workaround: CONNECTION_STEP,
  },
  encrypted: {
    notice: 'The value is stored encrypted; it can only be matched exactly, not searched or sorted.',
    workaround: 'Check any report or workflow that filters or sorts on this field and adjust it to an exact match.',
  },
  unmapped: {
    notice: 'This field type is not one the converter recognizes, so no storage was generated for it.',
    workaround: 'Pick the closest supported field type in the original app and re-export, or keep this field out of the migration.',
  },
};

/** Business wording for one field gap; falls back to safe generic text for unknown ids. */
export function fieldGapWording(matrixId: string, label: string): BusinessWording {
  const known = FIELD_GAP_WORDING[matrixId];
  if (!known) {
    return {
      notice: 'This field works differently after migration and needs a manual check.',
      workaround: `Open ${label} in the generated app, check the stored value against the original, and keep the original behaviour as the fallback until it is verified.`,
    };
  }
  return { notice: known.notice, workaround: known.workaround };
}

/** Product-internal feature names reworded for a business reader. */
const FEATURE_NAME: Record<string, string> = {
  'Report|Spreadsheet': 'the spreadsheet-style report view',
  'Workflow|Batch workflow on import': 'bulk actions that run when records are imported',
  'Workflow|Batch workflow on a schedule': 'bulk actions that run on a schedule',
  'Deluge|Push / in-app notification': 'push and in-app notifications',
  'Deluge|File tasks': 'scripted file handling',
  'Deluge|Creator custom API (function as HTTP)': 'custom functions exposed as web endpoints',
  'Platform|Org-Level Microservices': 'shared services reused across apps',
  'Creating applications|Create application by importing a .ds export': 'rebuilding the app from an export file',
};

/** What a feature gap means for the business user, by feature area. */
export function featureName(area: string, feature: string): string {
  return scrubBusiness(FEATURE_NAME[`${area}|${feature}`] ?? `${area.toLowerCase()}: ${feature}`);
}

export function featureNotice(uses: number): string {
  return `${uses} ${uses === 1 ? 'place' : 'places'} in the app use this.`;
}

/** Guided-step service labels: console areas named in business terms. */
const SERVICE_LABEL: Record<string, { label: string; where: string }> = {
  stratus: { label: 'file storage', where: 'Cloud Scale → the file storage area' },
  smartbrowz: { label: 'the PDF service', where: 'the PDF service page' },
  slate: { label: 'the hosted web app', where: 'the hosted web app page' },
};

export function serviceStartSentence(stepId: string): string | undefined {
  const key = stepId.replace(/-enable$/, '');
  const service = SERVICE_LABEL[key];
  if (!service) return undefined;
  return `start ${service.label} (open the project → ${service.where} → Start Exploring)`;
}

/**
 * What one unconverted script item means, phrased for a business reader. The
 * internal construct name never leaves this function except into the appendix.
 */
export function constructNotice(scope: string, location: string): string {
  const where =
    scope === 'ui' && location.startsWith('field ')
      ? `the field ${location.slice('field '.length)}`
      : scope === 'ui' && location.startsWith('report ')
        ? `the report ${location.slice('report '.length)}`
        : scope === 'ui' && location.startsWith('page ')
          ? `the page ${location.slice('page '.length)}`
          : location;
  return `A part of ${where} could not be converted automatically and needs a manual check.`;
}

/** More specific notice lines for the most common unconverted items. */
const CONSTRUCT_NOTICE: [RegExp, (location: string) => string][] = [
  [/^report-criteria$/, (l) => `The filter that chooses which records ${l} shows was not converted.`],
  [/^report-conditional-format$/, (l) => `The colour/highlight rules in ${l} were not converted.`],
  [/^workflow-action-condition$/, (l) => `The condition deciding when ${l} runs was not converted.`],
  [/^workflow-empty$/, (l) => `${l} has no steps to convert.`],
  [/^approval-on-load$/, (l) => `The approval step in ${l} needs to be recreated.`],
  [/^approval-event$/, (l) => `The approval step in ${l} needs to be recreated.`],
  [/^blueprint-/, (l) => `Part of the approval process in ${l} needs to be recreated.`],
  [/^function-untranslated$/, (l) => `The function ${l} was not converted.`],
  [/^custom-function-api-/, (l) => `The web endpoint ${l} was not converted.`],
  [/^field-rule-condition$/, (l) => `A show/hide or validation rule on ${l} was not converted.`],
  [/^client-shim-unsupported$/, (l) => `A screen interaction in ${l} is not supported and needs a manual replacement.`],
  [/^event-async-onsuccess$/, (l) => `A follow-up action in ${l} needs to be recreated.`],
];

export function todoNotice(scope: string, location: string, construct: string): string {
  const where =
    scope === 'ui' && location.startsWith('field ')
      ? `field ${location.slice('field '.length)}`
      : scope === 'ui' && location.startsWith('report ')
        ? `report ${location.slice('report '.length)}`
        : scope === 'ui' && location.startsWith('page ')
          ? `page ${location.slice('page '.length)}`
          : location;
  for (const [pattern, sentence] of CONSTRUCT_NOTICE) {
    if (pattern.test(construct)) return sentence(where);
  }
  return constructNotice(scope, location);
}

/** UI stub reasons (field/report/page/zml) reworded for a business reader. */
export function uiReasonNotice(area: string, name: string, reason: string): string {
  if (/did not compile/i.test(reason)) {
    return `The automatic format check on ${name} could not be copied; the field accepts any text until one is added.`;
  }
  if (/^No schema mapping for type/.test(reason)) {
    return `The field ${name} uses a type the converter does not recognize, so no input was generated for it.`;
  }
  if (/no subform columns|no fields/i.test(reason)) {
    return `The inline table ${name} lists no columns to carry over.`;
  }
  if (/pivot/i.test(reason)) {
    return `The cross-tab report ${name} must be rebuilt by choosing its row, column and value fields again.`;
  }
  if (/named filter/i.test(reason)) {
    return `A saved filter on the report ${name} is not migrated; choosing it would show no rows.`;
  }
  if (area === 'zml' || /^ZML|no generated component|<style|Static <style>/i.test(reason)) {
    return `A part of the page ${name} could not be drawn automatically.`;
  }
  return scrubBusiness(reason);
}

/** Widget manual rows: strip the package file names, keep the widget name. */
export function widgetWording(name: string): BusinessWording {
  return {
    notice: `The custom page widget ${name} is not rebuilt automatically.`,
    workaround: `Rebuild ${name} with supported page elements, or provide a reviewed replacement before go-live.`,
  };
}

/** Connection secrets: one plain sentence, key names scrubbed. */
export function connectionSecretsWording(keys: readonly string[]): string {
  const list = keys.map(scrubBusiness).join(', ');
  return `Ask the person who owns the external accounts to enter the connection credentials (${list}) in the generated secrets file before go-live.`;
}
