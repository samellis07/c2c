/**
 * Creator `format = commadotwestern` display: integer digits grouped in threes
 * (1234567.5 shows as 1,234,567.5). The fraction stays as stored. Returns
 * undefined unless the format is that value and the value is a plain decimal,
 * so callers keep their own text for everything else. Inputs and posted values
 * are not passed through here.
 */
export function formattedNumber(value: unknown, format: string | undefined): string | undefined {
  if (String(format ?? '').toLowerCase() !== 'commadotwestern') return undefined;
  if (value == null || typeof value === 'object') return undefined;
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(String(value).trim());
  if (!match) return undefined;
  const grouped = match[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${match[1]}${grouped}${match[3] ?? ''}`;
}
