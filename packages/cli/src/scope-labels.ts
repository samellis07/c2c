/**
 * Owner scope printed on every migration report.
 *
 * Payments, offline, Form Email, the C8 dialect, Cliq bots, and native
 * mobile / MDM are not supported in this version (counted; on the
 * roadmap). Marketplace publishing, the Zia AI builder, and on-prem
 * Data Bridge are not applicable (out of scope). The array order is the
 * published order.
 */

export const OWNER_SCOPE = [
  { feature: 'Payments', label: 'not supported in this version (counted)' },
  { feature: 'Offline', label: 'not supported in this version (counted)' },
  { feature: 'Form Email', label: 'not supported in this version (counted)' },
  { feature: 'C8 dialect', label: 'not supported in this version (counted)' },
  { feature: 'Cliq bots', label: 'not supported in this version (counted)' },
  { feature: 'Native mobile / MDM', label: 'not supported in this version (counted; on the roadmap)' },
  { feature: 'Marketplace publishing', label: 'not applicable (out of scope)' },
  { feature: 'Zia AI builder', label: 'not applicable (out of scope)' },
  { feature: 'On-prem Data Bridge', label: 'not applicable (out of scope)' },
] as const;

export type ScopeFeature = (typeof OWNER_SCOPE)[number]['feature'];
export type ScopeLabel = (typeof OWNER_SCOPE)[number]['label'];

export interface ScopeEntry {
  feature: ScopeFeature;
  label: ScopeLabel;
}

/** A fresh list, so a caller cannot mutate the published contract. */
export function ownerScope(): ScopeEntry[] {
  return OWNER_SCOPE.map((item) => ({ feature: item.feature, label: item.label }));
}
