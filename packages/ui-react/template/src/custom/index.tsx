/**
 * Your code. Everything under src/custom/ belongs to you: c2c writes these
 * files once, when the app is first generated, and never again. Regenerating
 * the app (after a Creator change, an edit-by-asking request or an admin
 * editor change) rewrites src/generated/ only.
 *
 * Change the generated screens from here, through the extension points:
 *
 *   components.fields[widget]   replace a field control everywhere (by widget: 'email', 'date', ...)
 *   forms[form].fields[name]    replace one field's control
 *   forms[form].slots           content before or after a form, or beside its buttons
 *   forms[form].beforeSubmit    change the record before it is posted, or return false to stop
 *   reports[report].cells       render one column's cells
 *   reports[report].rowActions  extra controls on each record row
 *   routes                      extra screens, added to the menu
 *   nav                         reorder, rename or hide menu entries
 *   api.headers                 extra request headers
 *
 * Example (uncomment to try):
 *
 *   import { defineCustomization, type FieldProps } from '@c2c/ui';
 *   import { Dashboard } from './pages/Dashboard';
 *
 *   export default defineCustomization({
 *     routes: [{ page: 'Dashboard', label: 'Dashboard', component: Dashboard }],
 *     reports: { All_Records: { cells: { Status: (value) => <strong>{String(value)}</strong> } } },
 *   });
 */
import { defineCustomization } from '@c2c/ui';

export default defineCustomization({});
