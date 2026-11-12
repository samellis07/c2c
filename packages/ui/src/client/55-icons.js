/**
 * Menu and page icons. The export carries Zoho Creator icon names; each maps
 * to a compact inline SVG glyph keyed by that name, with a prefix-family
 * fallback so an unmapped name still draws a neutral shape and never the raw
 * name as text.
 */
const C2C_ICON_PATHS = {
  'objects-spaceship': '<path d="M12 2c3 1.5 5 5 5 9l-2 5H9L7 11c0-4 2-7.5 5-9z"/><circle cx="12" cy="9" r="1.6"/><path d="M8 15l-2 4M16 15l2 4M12 16v5"/>',
  'education-book-open': '<path d="M12 6C10 4.5 7 4 3 4.5v14c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5v-14C17 4 14 4.5 12 6z"/><path d="M12 6v14"/>',
  'ui-2-square-add-11': '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>',
  'files-single-copy-04': '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>',
  'design-app': '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  'education-language': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3 3 15 0 18c-3-3-3-15 0-18z"/>',
  'tech-2-connection': '<circle cx="5" cy="5" r="2.5"/><circle cx="19" cy="5" r="2.5"/><circle cx="12" cy="19" r="2.5"/><path d="M7.3 6.3 10.6 17M16.7 6.3 13.4 17M7.5 5h9"/>',
  'ui-2-hourglass': '<path d="M7 3h10v4l-5 5 5 5v4H7v-4l5-5-5-5V3z"/>',
  'design-todo': '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 5l1.5 1.5L8 4M4 11l1.5 1.5L8 10M4 17l1.5 1.5L8 16"/>',
  'design-shape-circle': '<circle cx="12" cy="12" r="8"/>',
  'files-add': '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14h6"/>',
  'ui-1-check-circle-08': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16 9.5"/>',
  'health-molecule-40': '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><path d="M9.6 8.6l5 5.8M14.4 8.6l-5 5.8"/>',
  'design-2-selection': '<rect x="4" y="4" width="12" height="12" rx="1" stroke-dasharray="3 2"/><rect x="9" y="9" width="11" height="11" rx="1"/>',
  'business-factory': '<path d="M3 21V9l6 4V9l6 4V6l6 4v11H3z"/><path d="M6 17h3M12 17h3M18 17h2"/>',
  'location-pin-add': '<path d="M12 21c-4-4.5-7-8-7-11a7 7 0 1 1 14 0c0 3-3 6.5-7 11z"/><path d="M12 7v6M9 10h6"/>',
  'shopping-tag-sale': '<path d="M3 12V4h8l9 9-8 8-9-9z"/><circle cx="8" cy="9" r="1.5"/>',
  'files-archive-3d-content': '<path d="M4 7l8-4 8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
  'business-hierarchy-55': '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
  'design-2-cursor-add': '<path d="M5 3l12 7-5 1.6-1.6 5L5 3z"/><path d="M17 15v6M14 18h6"/>',
  'gestures-active-38': '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
  'ui-2-archive': '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>',
  'files-folder-gallery': '<path d="M3 6h6l2 2h10v11H3z"/><circle cx="9" cy="12" r="1.4"/><path d="M7 18l3.5-3.5 2 2 3-3L19 18"/>',
  'business-math': '<path d="M17 5H8l6 7-6 7h9"/>',
  'files-settings-46': '<path d="M7 3h7l4 4v13H7z"/><path d="M14 3v4h4"/><circle cx="12" cy="15" r="2.2"/><path d="M12 11.8v1M12 17.2v1M8.8 15h1M14.2 15h1"/>',
  'files-folder-settings-81': '<path d="M3 6h6l2 2h10v11H3z"/><circle cx="12" cy="14" r="2.2"/><path d="M12 10.8v1M12 16.2v1M8.8 14h1M14.2 14h1"/>',
  'business-laptop-71': '<rect x="4" y="5" width="16" height="11" rx="1"/><path d="M2 19h20"/>',
  'users-2-woman-up': '<circle cx="12" cy="6" r="3"/><path d="M6 21v-6l3-3h6l3 3v6"/><path d="M18 8l3 3M21 8l-3 3"/>',
  'users-multiple-11': '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3 20v-1c0-3.3 2.7-5 6-5s6 1.7 6 5v1"/><path d="M16.5 14.5c2.3.4 4.5 2 4.5 5.5"/>',
  'business-chart-bar-33': '<path d="M6 20v-8M12 20V5M18 20v-6"/><path d="M3 20h18"/>',
  'business-chart-bar-32': '<path d="M4 4v16h16"/><path d="M7 14l4-5 3 3 5-6"/>',
  'ui-1-bold-add': '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z" fill="currentColor" stroke="none"/>',
  'business-building': '<rect x="5" y="3" width="14" height="18"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/><path d="M10 21v-3h4v3"/>',
  'ui-2-menu-bold': '<path d="M4 7h16M4 12h16M4 17h16" stroke-width="2.6"/>',
  'ui-1-dashboard-half': '<path d="M4 14a8 8 0 1 1 16 0"/><path d="M12 14l4.5-4.5"/><path d="M4 20h16"/>',
  'design-window-paragraph': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 13h10M7 16.5h6"/>',
  'shopping-box-3d-67': '<path d="M4 7l8-4 8 4v10l-8 4-8-4V7z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
  'shopping-stock': '<path d="M4 8l8-4 8 4v9l-8 4-8-4V8z"/><path d="M8 13.5V17M12 11v6M16 13.5V17"/>',
  'shopping-cart-modern-in': '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h3l3 11h10l2-8H7"/><path d="M12 8v5M9.8 11l2.2 2.2L14.2 11"/>',
  'shopping-cart-modern': '<circle cx="9" cy="20" r="1.5"/><circle cx="17" cy="20" r="1.5"/><path d="M3 4h3l3 11h10l2-8H7"/>',
  'arrows-4-reply': '<path d="M9 9l-5 5 5 5"/><path d="M4 14h9a6 6 0 0 0 6-6V5"/>',
  'business-money-bag': '<path d="M9 4h6l1 3c2.8 1.8 4 4.7 4 8a8 8 0 1 1-16 0c0-3.3 1.2-6.2 4-8l1-3z"/><path d="M12 11v1.4c-2 .6-2 2.6 0 3.2s2 2.6 0 3.2"/>',
  'users-2-a-add': '<circle cx="10" cy="7" r="3.4"/><path d="M4 20v-1c0-3.4 2.7-5.5 6-5.5s6 2.1 6 5.5v1"/><path d="M19 8v6M16 11h6"/>',
  'users-circle-08': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9.5" r="2.8"/><path d="M6.8 19c1-3 2.9-4.3 5.2-4.3s4.2 1.3 5.2 4.3"/>',
  'tech-desktop': '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M9 20h6M12 16v4"/>',
  'ui-1-circle-add': '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  'shopping-basket-add': '<path d="M4 9h16l-2 11H6L4 9z"/><path d="M8 9l4-5 4 5"/><path d="M12 12v5M9.5 14.5h5"/>',
  'arrows-1-curved-previous': '<path d="M10 8l-6 4 6 4"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/>',
  'health-pulse-chart': '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
};

const C2C_ICON_FAMILY = [
  ['files-', '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>'],
  ['users-', '<circle cx="10" cy="7" r="3.4"/><path d="M4 20v-1c0-3.4 2.7-5.5 6-5.5s6 2.1 6 5.5v1"/><circle cx="17" cy="9" r="2.4"/>'],
  ['business-', '<rect x="5" y="3" width="14" height="18"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>'],
  ['shopping-', '<path d="M5 8h14l-1.5 12h-11L5 8z"/><path d="M9 8a3 3 0 0 1 6 0"/>'],
  ['location-', '<path d="M12 21c-4-4.5-7-8-7-11a7 7 0 1 1 14 0c0 3-3 6.5-7 11z"/><circle cx="12" cy="10" r="2.4"/>'],
  ['arrows-', '<path d="M9 9l-5 5 5 5"/><path d="M4 14h9a6 6 0 0 0 6-6V5"/>'],
  ['education-', '<path d="M12 6C10 4.5 7 4 3 4.5v14c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5v-14C17 4 14 4.5 12 6z"/><path d="M12 6v14"/>'],
  ['tech-', '<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M9 20h6M12 16v4"/>'],
  ['health-', '<path d="M3 12h4l2-7 4 14 2-7h6"/>'],
  ['gestures-', '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>'],
  ['ui-', '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>'],
  ['design-', '<rect x="5" y="5" width="14" height="14" rx="2"/>'],
  ['objects-', '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.4"/>'],
  ['zc-', '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 15l4-7 4 7"/>'],
];

const C2C_ICON_FALLBACK = '<rect x="5" y="5" width="14" height="14" rx="3"/>';

/** Inline SVG glyph for an exported icon name; never the name itself. */
function c2cIconGlyph(name) {
  const key = String(name || '').trim();
  let path = key ? C2C_ICON_PATHS[key] : '';
  if (!path) {
    for (const [prefix, glyph] of C2C_ICON_FAMILY) {
      if (key.startsWith(prefix)) {
        path = glyph;
        break;
      }
    }
  }
  if (!path) path = key ? '<circle cx="12" cy="12" r="4"/>' : C2C_ICON_FALLBACK;
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
}
