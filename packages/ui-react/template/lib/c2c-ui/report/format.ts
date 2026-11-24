/** Shared display formatting used by workflow screens without loading the report renderer. */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '–';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(formatValue).join(', ');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.label === 'string') return obj.label;
    if (typeof obj.key === 'string') return obj.key.split('/').pop() ?? obj.key;
    return Object.values(obj).filter((v) => v !== '' && v !== null && v !== undefined).map(formatValue).join(', ') || '–';
  }
  return String(value);
}
