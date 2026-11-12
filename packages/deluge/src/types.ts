import { normalizeType } from '../../schema/src/mapping.js';

/** The canonical Deluge value types a declared type spelling normalises to. */
export type NormType = 'string' | 'int' | 'float' | 'bool' | 'date' | 'datetime' | 'list' | 'map' | 'void';

/**
 * The canonical type of a declared Deluge type spelling (`bool` and `boolean`
 * are both `bool`; `integer`, `long`, `bigint`, `number` are `int`;
 * `collection` is `list`). The parser, the type checker, and the generated
 * handlers all read this one table, so every spelling parses and coerces the
 * same way. A spelling with no known type is null.
 */
export function normType(type: string | null | undefined): NormType | null {
  const token = normalizeType(type ?? '');
  if (token === 'string' || token === 'text') return 'string';
  if (token === 'int' || token === 'integer' || token === 'long' || token === 'bigint' || token === 'number') return 'int';
  if (token === 'float' || token === 'double' || token === 'decimal') return 'float';
  if (token === 'bool' || token === 'boolean') return 'bool';
  if (token === 'date') return 'date';
  if (token === 'datetime' || token === 'date time' || token === 'timestamp') return 'datetime';
  if (token === 'list' || token === 'collection') return 'list';
  if (token === 'map') return 'map';
  if (token === 'void') return 'void';
  return null;
}
