/**
 * Translation blocks: the model carries `i18n` — language code → Creator
 * label key → text — verbatim from the export's `translation` JSON. This part
 * picks the selected language and rewrites the model's labels before the
 * first paint, and offers the switch in the nav. Values stay data-only: a
 * translation string is assigned to label fields that every renderer escapes,
 * so markup in a value renders as text, never as HTML.
 *
 * The reader: `?lang=<code>` on the URL wins, then the `c2c.lang` localStorage
 * entry the nav picker writes; an unknown or absent value leaves the default
 * language. Self-contained browser script: no imports.
 */

const I18N_STORAGE_KEY = 'c2c.lang';
const I18N_DEFAULT_LABEL = 'English';

/** Sorted language codes the model's i18n table carries. */
export function i18nLanguages(appModel) {
  const table = appModel && appModel.i18n;
  return table ? Object.keys(table).sort() : [];
}

/** The selected language code, or '' for the app's default language. */
export function i18nSelectedLanguage(appModel, view) {
  const languages = i18nLanguages(appModel);
  if (!languages.length || !view) return '';
  const pick = (code) => (code && languages.includes(code) ? code : '');
  try {
    const params = view.location && typeof view.location.search === 'string' ? new URLSearchParams(view.location.search) : null;
    const fromUrl = params ? pick(params.get('lang')) : '';
    if (fromUrl) return fromUrl;
  } catch {
    // A malformed query is no selection.
  }
  try {
    const stored = view.localStorage && view.localStorage.getItem(I18N_STORAGE_KEY);
    return pick(stored);
  } catch {
    return '';
  }
}

/** A `Languages List.<code>` label, else the code itself. */
function i18nLanguageName(strings, code) {
  const named = strings && strings[`Languages List.${code}`];
  return typeof named === 'string' && named.trim() ? named : code;
}

/** Rewrite the model's labels for `lang`, in place, before first render. */
export function applyLanguage(appModel, lang) {
  const strings = appModel && appModel.i18n && appModel.i18n[lang];
  if (!strings) return;
  const get = (key) => {
    const value = strings[key];
    return typeof value === 'string' ? value : undefined;
  };
  const apply = (target, key, prop) => {
    const value = get(key);
    if (value !== undefined) target[prop || 'label'] = value;
  };

  const appKey = Object.keys(strings).find((key) => key.startsWith('App.'));
  if (appKey) apply(appModel, appKey, 'name');

  const fieldLabel = (fields, formName) => {
    for (const field of fields || []) {
      apply(field, `FormField.${formName}.${field.name}`);
      if (field.choices) {
        for (let i = 0; i < field.choices.length; i++) {
          const value = get(`PicklistOption.${formName}.${field.name}.${i + 1}`);
          if (value !== undefined) field.choices[i] = value;
        }
      }
      for (const sub of field.subfields || []) {
        apply(sub, `CompositeSubFields.${formName}.${field.name}.${sub.name}`);
        apply(sub, `FormField.${formName}.${field.name}-${sub.name}`);
      }
    }
  };

  for (const form of appModel.forms || []) {
    apply(form, `Form.${form.name}`);
    for (const button of ['submit', 'reset', 'update', 'cancel']) {
      apply(form, `FormButton.${form.name}.${button}`, `${button}Label`);
    }
    fieldLabel(form.fields, form.name);
    // `Section.<name>` names a section heading: a section field's own name,
    // or the form's name for its single section — applied only when
    // unambiguous, so a multi-section form keeps its labels.
    const sections = (form.fields || []).filter((field) => field.widget === 'section');
    for (const field of sections) apply(field, `Section.${field.name}`);
    if (sections.length === 1) apply(sections[0], `Section.${form.name}`);
  }

  const reportFields = (fields, reportName) => {
    for (const item of fields || []) {
      if (item && item.field) apply(item, `ReportField.${reportName}.${item.field}`);
    }
  };
  for (const report of appModel.reports || []) {
    apply(report, `Report.${report.name}`);
    reportFields(report.columns, report.name);
    reportFields(report.phoneColumns, report.name);
    for (const block of report.detailBlocks || []) reportFields(block.fields, report.name);
    reportFields(report.filters, report.name);
  }

  for (const page of appModel.pages || []) {
    apply(page, `Page.${page.name}`);
  }

  for (const section of appModel.nav || []) {
    for (const item of section.items || []) {
      const kind = item.kind ? item.kind[0].toUpperCase() + item.kind.slice(1) : '';
      if (kind) apply(item, `${kind}.${item.name}`);
    }
  }
}

/**
 * The nav language switch: a `<select>` listing the default language plus
 * every migrated one, option labels read from `Languages List.<code>` in the
 * selected language. Changing it stores `c2c.lang` and reloads. Returns null
 * when the model carries no translations.
 */
export function i18nLanguagePicker(appModel, view, doc) {
  const languages = i18nLanguages(appModel);
  if (!languages.length || !doc) return null;
  const selected = i18nSelectedLanguage(appModel, view);
  const strings = (appModel.i18n && appModel.i18n[selected]) || {};
  const label = doc.createElement('label');
  label.setAttribute('data-i18n', '');
  const select = doc.createElement('select');
  select.setAttribute('data-i18n-lang', '');
  select.setAttribute('aria-label', 'Language');
  const option = (value, text) => {
    const el = doc.createElement('option');
    el.setAttribute('value', value);
    el.textContent = text;
    if (value === selected) el.setAttribute('selected', '');
    select.appendChild(el);
  };
  option('', i18nLanguageName(strings, 'en') === 'en' ? I18N_DEFAULT_LABEL : i18nLanguageName(strings, 'en'));
  for (const code of languages) option(code, i18nLanguageName(strings, code));
  select.addEventListener('change', () => {
    try {
      if (view && view.localStorage) {
        if (select.value) view.localStorage.setItem(I18N_STORAGE_KEY, select.value);
        else view.localStorage.removeItem(I18N_STORAGE_KEY);
      }
    } catch {
      // Storage is optional: the pick still applies to this page load.
    }
    if (view && view.location && typeof view.location.reload === 'function') view.location.reload();
  });
  label.appendChild(select);
  return label;
}
