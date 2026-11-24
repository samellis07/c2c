export const MANUAL_STEP_ANCHORS = {
  fieldTimePrecision: { id: 'manual-kind-field-time-precision', href: 'human-steps#manual-kind-field-time-precision', heading: 'Time precision' },
  fieldPrivacy: { id: 'manual-kind-field-privacy', href: 'human-steps#manual-kind-field-privacy', heading: 'Field privacy' },
  reportOptions: { id: 'manual-kind-report-options', href: 'human-steps#manual-kind-report-options', heading: 'Report options' },
  reportProperties: { id: 'manual-kind-report-properties', href: 'human-steps#manual-kind-report-properties', heading: 'Report properties' },
  zmlClickParameters: { id: 'manual-kind-page-click-parameters', href: 'human-steps#manual-kind-page-click-parameters', heading: 'Button or text click parameters' },
} as const;

export type ManualStepAnchor = (typeof MANUAL_STEP_ANCHORS)[keyof typeof MANUAL_STEP_ANCHORS];

export function manualStepWithAnchor(step: string, anchor: ManualStepAnchor): string {
  return `${step} See [${anchor.heading}](${anchor.href}).`;
}
