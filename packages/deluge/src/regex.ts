/** Escape every regular-expression metacharacter, backslash included, so `text` matches itself literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}
