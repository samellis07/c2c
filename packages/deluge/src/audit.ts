/**
 * Opt-in translation audit for exact decimals. Off unless a caller runs work
 * inside {@link withDecimalAudit}; generated output never depends on it.
 *
 * - `arithmetic`: a raw JS `+ - * /` (or unary minus) the translator emitted where
 *   an operand reads a decimal, currency, or percent field or a decimal local.
 *   Each one bypasses `shim.decimal` and computes in binary64.
 * - `queries`: every `Form[criteria] sort by … range …` the translator emitted,
 *   with its leaf fields and sort field, so a caller can count the sites that
 *   filter or sort on an exact-decimal column.
 */
export interface DecimalAudit {
  arithmetic: { op: string; code: string }[];
  queries: { form: string; leaves: { op: string; field: string }[]; sort?: string }[];
}

let sink: DecimalAudit | null = null;

export function decimalAuditSink(): DecimalAudit | null {
  return sink;
}

export function withDecimalAudit<T>(fn: () => T): { result: T; audit: DecimalAudit } {
  const prev = sink;
  const audit: DecimalAudit = { arithmetic: [], queries: [] };
  sink = audit;
  try {
    return { result: fn(), audit };
  } finally {
    sink = prev;
  }
}
