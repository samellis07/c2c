/**
 * Row and column attributes, one empty inline-grid row, and those rows on
 * the parent submit.
 */
const formLayoutBound = new WeakSet();

export function installFormLayout(doc) {
  if (!doc || formLayoutBound.has(doc)) return;
  formLayoutBound.add(doc);
  doc.addEventListener('click', function (event) {
    const node = event.target && event.target.closest ? event.target : event.target && event.target.parentElement;
    if (!node || !node.closest) return;
    const button = node.closest('[data-add-row]');
    if (!button || (typeof doc.contains === 'function' && !doc.contains(button))) return;
    formLayoutAddRow(button);
  });
  doc.addEventListener('change', function (event) {
    const input = event.target;
    if (!input || !input.matches || !input.matches('input[type="file"]')) return;
    const host = input.closest && input.closest('.filepick');
    const nameEl = host && host.querySelector ? host.querySelector('.filepick-name') : null;
    if (nameEl) nameEl.textContent = input.files && input.files.length ? input.files[0].name : '';
  });
}

const formLayoutFieldBlock = fieldBlock;
fieldBlock = function (field, prefix) {
  if (field && field.visibility === false) return '';
  return formLayoutAnnotate(formLayoutFieldBlock(field, prefix), field);
};

function formLayoutAnnotate(html, field) {
  if (!field) return html;
  let next = html;
  if (field.widget === 'subform') {
    const columns = [];
    for (const sub of field.subfields || []) {
      const spec = {
        name: sub.name,
        widget: sub.widget,
        required: !!sub.required,
        lookup: sub.lookup && sub.lookup.endpoint ? sub.lookup.endpoint : '',
        choices: sub.choices || [],
      };
      // Name and address columns are the same part controls as a top-level composite.
      const parts = compositePartSpecs(sub);
      if (parts.length) spec.parts = parts;
      columns.push(spec);
    }
    const encoded = escapeHtml(JSON.stringify(columns));
    next = next.replace('class="subform" data-field=', 'class="subform" data-columns="' + encoded + '" data-field=');
  }
  const height = field.height && safeStyleValue(field.height) ? String(field.height).replace(/[;<>"]/g, '') : '';
  if (field.row == null && field.column == null && !field.width && !height && !field.labelPlacement) return next;
  return next.replace(/^(<(?:div|label|h2|h3|p|fieldset)\b)/, function (open) {
    let attrs = '';
    if (field.name && !/\bdata-field=/.test(open)) attrs += ' data-field="' + escapeHtml(field.name) + '"';
    if (field.row != null) attrs += ' data-row="' + escapeHtml(field.row) + '"';
    if (field.column != null) attrs += ' data-column="' + escapeHtml(field.column) + '"';
    if (field.width) attrs += ' data-width="' + escapeHtml(field.width) + '"';
    if (height) attrs += ' data-height="' + escapeHtml(height) + '" style="--c2c-field-height:' + escapeHtml(height) + '"';
    if (field.labelPlacement) attrs += ' data-label-placement="' + escapeHtml(field.labelPlacement) + '"';
    return open + attrs;
  });
}

function formLayoutAddRow(button) {
  const subform = button.closest ? button.closest('.subform') : null;
  const body = subform && subform.querySelector ? subform.querySelector('tbody') : null;
  if (!subform || !body) return;
  let columns = [];
  try {
    columns = JSON.parse(subform.getAttribute('data-columns') || '[]');
  } catch {
    return;
  }
  const doc = button.ownerDocument;
  if (!doc) return;
  const tr = doc.createElement('tr');
  const rowKey = String(body.querySelectorAll('tr').length + 1);
  for (const column of columns) {
    const td = doc.createElement('td');
    // A column a `hide Sub.Field` action marked stays hidden in new rows.
    if (column.hidden) td.hidden = true;
    td.appendChild(formLayoutControl(doc, column, rowKey));
    tr.appendChild(td);
  }
  const ops = doc.createElement('td');
  ops.setAttribute('data-row-ops', '');
  const remove = doc.createElement('button');
  remove.type = 'button';
  remove.setAttribute('data-remove-row', '');
  remove.textContent = '×';
  ops.appendChild(remove);
  tr.appendChild(ops);
  body.appendChild(tr);
  // Lookup selects in the new row load their options like top-level fields.
  if (typeof loadLookupOptions === 'function' && typeof fillLookupSelect === 'function') {
    for (const select of tr.querySelectorAll('select[data-lookup]')) {
      const endpoint = select.getAttribute('data-lookup');
      if (!endpoint) continue;
      loadLookupOptions(viewOf(button), endpoint)
        .then((options) => fillLookupSelect(select, options))
        .catch(() => {});
    }
  }
}

/** Visible name and address parts. Hidden and unmapped parts are not controls. */
function compositePartSpecs(field) {
  if (!field || (field.widget !== 'name' && field.widget !== 'address') || !field.subfields) return [];
  const parts = [];
  for (const part of field.subfields) {
    if (!part || part.visibility === false || part.status === 'todo' || part.widget === 'unsupported') continue;
    parts.push({
      name: part.name,
      label: part.label || part.name,
      widget: part.widget,
      required: !!part.required,
      maxLength: part.maxLength || 0,
    });
  }
  return parts;
}

/** Element id for a composite part. The parent field name keeps it unique on the form. */
function compositePartId(column, part, rowKey) {
  const prefix = `f-${column && column.name ? column.name : 'field'}-${rowKey || '1'}-`;
  const raw = `${prefix}${part && part.name ? part.name : 'part'}`.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return raw || 'f-part';
}

function formLayoutControl(doc, column, rowKey) {
  if (column && column.parts && column.parts.length) {
    const box = doc.createElement('div');
    box.setAttribute('data-subfield', column.name);
    for (const part of column.parts) {
      const id = compositePartId(column, part, rowKey);
      const label = doc.createElement('label');
      label.htmlFor = id;
      label.textContent = part.label || part.name;
      const input = doc.createElement('input');
      input.id = id;
      input.name = part.name;
      input.type = 'text';
      input.setAttribute('data-part', part.name);
      if (part.widget === 'decimal' || part.widget === 'number' || part.widget === 'percent' || part.widget === 'currency') {
        input.setAttribute('inputmode', 'decimal');
      }
      if (part.maxLength) input.maxLength = part.maxLength;
      if (part.required) {
        input.required = true;
        input.setAttribute('aria-required', 'true');
      }
      box.appendChild(label);
      box.appendChild(input);
    }
    return box;
  }
  const widget = column && column.widget;
  let el;
  if (widget === 'select' || widget === 'multiselect' || widget === 'lookup' || widget === 'lookup-multi' || widget === 'users') {
    el = doc.createElement('select');
    if (widget === 'multiselect' || widget === 'lookup-multi') el.multiple = true;
    if (column.lookup) el.setAttribute('data-lookup', column.lookup);
    if (!el.multiple) {
      const blank = doc.createElement('option');
      blank.value = '';
      blank.textContent = '-Select-';
      el.appendChild(blank);
    }
    for (const choice of column.choices || []) {
      const option = doc.createElement('option');
      option.value = choice;
      option.textContent = choice;
      el.appendChild(option);
    }
  } else if (widget === 'decision') {
    el = doc.createElement('input');
    el.type = 'checkbox';
  } else if (widget === 'textarea' || widget === 'richtext') {
    el = doc.createElement('textarea');
  } else {
    el = doc.createElement('input');
    el.type = widget === 'email' ? 'email' : widget === 'phone' ? 'tel' : widget === 'date' ? 'date' : widget === 'time' ? 'time' : 'text';
    if (widget === 'number' || widget === 'decimal' || widget === 'percent' || widget === 'currency') el.setAttribute('inputmode', 'decimal');
  }
  if (column && column.name) el.setAttribute('data-subfield', column.name);
  // The column spec carries `required`. The cell control exposes it to validation and assistive tech.
  if (column && column.required) {
    el.required = true;
    el.setAttribute('aria-required', 'true');
  }
  return el;
}

/**
 * Prefill a grid from stored subform rows — the edit screen's record read.
 * Builds the same controls the add-row path builds, then writes each cell.
 * Lookup columns carry `data-prefill` so the async option load can restore
 * the stored pick after the options arrive.
 */
export function fillSubformRows(box, rows) {
  const body = box && box.querySelector ? box.querySelector('tbody') : null;
  if (!body) return;
  let columns = [];
  try {
    columns = JSON.parse(box.getAttribute('data-columns') || '[]');
  } catch {
    return;
  }
  const doc = box.ownerDocument;
  if (!doc) return;
  for (const tr of [...body.querySelectorAll('tr')]) tr.remove();
  for (const row of rows || []) {
    const tr = doc.createElement('tr');
    const rowKey = String(body.querySelectorAll('tr').length + 1);
    for (const column of columns) {
      const td = doc.createElement('td');
      if (column.hidden) td.hidden = true;
      const el = formLayoutControl(doc, column, rowKey);
      td.appendChild(el);
      tr.appendChild(td);
      if (!row || typeof row !== 'object' || !Object.prototype.hasOwnProperty.call(row, column.name)) continue;
      const value = row[column.name];
      if (column.parts && column.parts.length) {
        setGridCellValue(el, value);
        continue;
      }
      if (el.tagName === 'SELECT') {
        el.setAttribute('data-prefill', JSON.stringify(value ?? null));
      } else if (typeof setControlValue === 'function') {
        setControlValue(el, value);
      } else if (el.type === 'checkbox') {
        el.checked = value === true || value === 'true';
      } else {
        el.value = value == null ? '' : String(value);
      }
    }
    const ops = doc.createElement('td');
    ops.setAttribute('data-row-ops', '');
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.setAttribute('data-remove-row', '');
    remove.textContent = '×';
    ops.appendChild(remove);
    tr.appendChild(ops);
    body.appendChild(tr);
  }
  if (typeof loadLookupOptions === 'function' && typeof fillLookupSelect === 'function') {
    for (const select of body.querySelectorAll('select[data-lookup]')) {
      const endpoint = select.getAttribute('data-lookup');
      if (!endpoint) continue;
      loadLookupOptions(viewOf(box), endpoint)
        .then((options) => {
          fillLookupSelect(select, options);
          const raw = select.getAttribute('data-prefill');
          if (raw == null) return;
          let value = null;
          try {
            value = JSON.parse(raw);
          } catch {
            return;
          }
          if (select.multiple) {
            const list = (Array.isArray(value) ? value : [value]).map(String);
            for (const option of select.options) option.selected = list.includes(option.value);
          } else if (value != null) {
            select.value = String(value);
          }
        })
        .catch(() => {});
    }
  }
}

// Subform rows are not FormData inputs; merge them into the values object so
// validation (a required subform needs a row) and the submit see them.
const formLayoutRead = readValues;
readValues = function (formEl) {
  const values = formLayoutRead(formEl);
  if (!formEl || typeof formEl.querySelectorAll !== 'function') return values;
  for (const box of formEl.querySelectorAll('.subform[data-field]')) {
    const name = box.getAttribute('data-field');
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let columns = [];
    try {
      columns = JSON.parse(box.getAttribute('data-columns') || '[]');
    } catch {
      columns = [];
    }
    if (!columns.length) continue;
    const rows = [];
    for (const tr of box.querySelectorAll('tbody tr')) {
      const row = {};
      for (const column of columns) {
        if (!column || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column.name || '')) continue;
        row[column.name] = formLayoutValue(tr.querySelector('[data-subfield="' + column.name + '"]'), column);
      }
      rows.push(row);
    }
    values[name] = rows;
  }
  return values;
};

function formLayoutValue(el, sub) {
  if (!el) return null;
  if (sub && sub.parts && sub.parts.length) {
    const obj = {};
    for (const part of sub.parts) {
      if (!part || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part.name || '')) continue;
      const input = el.querySelector ? el.querySelector('[data-part="' + part.name + '"]') : null;
      const text = input && input.value != null ? String(input.value) : '';
      const numeric = part.widget === 'decimal' || part.widget === 'number' || part.widget === 'percent' || part.widget === 'currency';
      obj[part.name] = numeric && text.trim() === '' ? null : text;
    }
    return obj;
  }
  if (el.multiple && el.selectedOptions) {
    const picked = [];
    for (const option of el.selectedOptions) picked.push(option.value);
    return picked;
  }
  if (el.type === 'checkbox') return !!el.checked;
  const value = el.value == null ? '' : String(el.value);
  const typed =
    sub.widget === 'number' ||
    sub.widget === 'decimal' ||
    sub.widget === 'percent' ||
    sub.widget === 'currency' ||
    sub.widget === 'date' ||
    sub.widget === 'datetime' ||
    sub.widget === 'time';
  if (typed && value.trim() === '') return null;
  return value;
}

const formLayoutBoot = boot;
boot = function (appModel, doc) {
  const documentRef = doc || (typeof document !== 'undefined' ? document : null);
  installFormLayout(documentRef);
  return formLayoutBoot(appModel, doc);
};
