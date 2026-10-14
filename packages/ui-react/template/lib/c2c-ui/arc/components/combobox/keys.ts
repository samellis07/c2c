/**
 * Keyboard choices shared by the combobox and the multi-select. A control
 * inside a form must consume Enter while its menu is open: an Enter that
 * reaches the form submits the whole record.
 */

/**
 * What Enter does in an open or closed menu: choose an option (its index in
 * the filtered list), only consume the key, or let it through (menu closed).
 * With no highlighted option and a typed query, the first enabled match is
 * chosen; with no query nothing is chosen.
 */
export function enterAction(open: boolean, activeIndex: number, query: string, options: readonly { disabled?: boolean }[]): number | 'consume' | 'pass' {
  if (!open) return 'pass';
  if (activeIndex >= 0 && options[activeIndex] && !options[activeIndex]!.disabled) return activeIndex;
  if (query.trim() === '') return 'consume';
  const first = options.findIndex((option) => !option.disabled);
  return first >= 0 ? first : 'consume';
}

/** The id of a listbox option, by its position in the shown list. */
export function optionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}

/** The aria-activedescendant value: the highlighted option while the menu is open. */
export function activeDescendant(open: boolean, activeIndex: number, count: number, listboxId: string): string | undefined {
  return open && activeIndex >= 0 && activeIndex < count ? optionId(listboxId, activeIndex) : undefined;
}
