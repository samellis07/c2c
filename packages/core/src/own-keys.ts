/**
 * Maps keyed by names that come from an export or from the operator (tables, projects, row ids): a key
 * spelled __proto__, constructor or prototype must be an ordinary own entry. A plain `map[key]` read finds
 * the inherited Object.prototype member, and a plain `map[key] = value` on `__proto__` sets the prototype
 * instead of an entry.
 */

/** The own value for `key`, or undefined: an inherited member is never an entry. */
export function ownGet<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Set `key` as an own, enumerable entry whatever its spelling; returns the map. */
export function ownSet<T>(map: Record<string, T>, key: string, value: T): Record<string, T> {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
  return map;
}
