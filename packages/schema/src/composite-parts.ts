/**
 * Parts a required name or address must contain.
 * First and last name are required when either exists; otherwise every part
 * except prefix and suffix. Address line 1 is required when it exists;
 * otherwise every part except the second line and the coordinates.
 * The form and the generated write rules both use this.
 */
export function requiredCompositePart(widget: 'name' | 'address', partName: string, partNames: readonly string[]): boolean {
  if (widget === 'name') {
    const hasFirstOrLast = partNames.some((part) => part === 'first_name' || part === 'last_name');
    return hasFirstOrLast ? partName === 'first_name' || partName === 'last_name' : partName !== 'prefix' && partName !== 'suffix';
  }
  const hasAddressLine1 = partNames.some((part) => part === 'address_line_1');
  return hasAddressLine1
    ? partName === 'address_line_1'
    : partName !== 'address_line_2' && partName !== 'latitude' && partName !== 'longitude';
}
