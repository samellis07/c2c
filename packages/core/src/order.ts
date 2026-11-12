/**
 * Order for generated files that are committed or hashed.
 *
 * `String#localeCompare` with no locale follows LANG. da, lt, et, and cs
 * reorder docs/deluge-builtins.json (Danish treats "aa" as å, Estonian sorts
 * z between s and t, Czech sorts the ch digraph after h, Lithuanian sorts y
 * before j).
 *
 * UTF-16 code-unit order does not match the committed catalogue either:
 * uppercase names such as Average and Focus would jump ahead of lowercase
 * ones. This is the en-US collator that produced that file, including case.
 */
const collator = new Intl.Collator('en-US', {
  usage: 'sort',
  sensitivity: 'variant',
  ignorePunctuation: false,
  numeric: false,
  caseFirst: 'false',
});

export function compareEnUs(a: string, b: string): number {
  return collator.compare(a, b);
}
