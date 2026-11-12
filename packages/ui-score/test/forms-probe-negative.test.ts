/**
 * NEGATIVE fixtures (reviewer, RED at 2264fc5e). The forms probe judges rendered custom widgets, not only native controls.
 * Each test scores a synthetic bundle (static DOM per route through the real
 * scoreUi) shaped like one generated field widget, and asserts the verdict
 * of a single forms check id: a popup trigger, a radio option, a checkbox
 * role and a dropzone button suit their field kind, and an aria-required
 * group mark counts as mandatory marked, while a box with no control still
 * fails.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { scoreUi, type UiBundle, type Viewport } from '../src/score.js';

const SOURCE = `application "Widget App"
{
\tsection S
\t{
\t\tform W
\t\t{
\t\t\tdisplayname = "Widget"
\t\t\tmust have Agree
\t\t\t(
\t\t\t\ttype = checkbox
\t\t\t\tdisplayname = "Agree"
\t\t\t)
\t\t\tmust have Status
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Status"
\t\t\t\tvalues = {"Open","Done"}
\t\t\t)
\t\t\tPick
\t\t\t(
\t\t\t\ttype = picklist
\t\t\t\tdisplayname = "Pick"
\t\t\t\tvalues = {"A","B"}
\t\t\t)
\t\t\tPhoto
\t\t\t(
\t\t\t\ttype = image
\t\t\t\tdisplayname = "Photo"
\t\t\t)
\t\t\tmust have Mode
\t\t\t(
\t\t\t\ttype = radiobuttons
\t\t\t\tdisplayname = "Mode"
\t\t\t\tvalues = {"X","Y"}
\t\t\t)
\t\t\tDays
\t\t\t(
\t\t\t\ttype = checkboxes
\t\t\t\tdisplayname = "Days"
\t\t\t\tvalues = {"M","F"}
\t\t\t)
\t\t\tWhen
\t\t\t(
\t\t\t\ttype = date
\t\t\t\tdisplayname = "When"
\t\t\t)
\t\t\tNote
\t\t\t(
\t\t\t\ttype = text
\t\t\t\tdisplayname = "Note"
\t\t\t)
\t\t\tFlag
\t\t\t(
\t\t\t\ttype = checkbox
\t\t\t\tdisplayname = "Flag"
\t\t\t)
\t\t}
\t}
}
`;

const HIDDEN_NATIVE = 'style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"';

const FORM = `
<div data-field="Agree"><span>Agree</span><div role="checkbox"></div></div>
<div data-field="Status"><span>Status</span><button type="button" aria-haspopup="menu" aria-expanded="false" tabindex="-1" aria-hidden="true"></button></div>
<div data-field="Photo"><strong>Photo</strong><button type="button" tabindex="-1" aria-hidden="true"></button><input type="file" hidden></div>
<div data-field="Mode"><span>Mode</span><div role="radiogroup" aria-required="true"><div role="radio">X</div></div></div>
<div data-field="Note"><span>Note</span><button type="button" aria-haspopup="menu" aria-expanded="false">Help</button></div>
<div data-field="Days"><span>Days</span><div role="radio"></div></div>
<div data-field="When"><label for="when">When</label><button type="button" id="when" aria-haspopup="menu" aria-expanded="false">Pick</button></div>
<div data-field="Pick"><span>Pick</span><div role="radiogroup" aria-required="true"></div></div>
<div data-field="Flag"><span>Flag</span></div>
`;

function bundle(formHtml = FORM): UiBundle {
  const html = `<!doctype html><html lang="en"><head><title>Widget App</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./app.css"><script type="module" src="./runtime.js"></script></head><body><a href="#main">Skip</a><main id="main"></main></body></html>`;
  const runtime = `import { NOTHING } from "./model.t.js";
export function boot() {
  function render() {
    document.body.innerHTML = '<a href="#main">Skip</a><nav id="nav" aria-label="Main"><a href="#/form/W">Widget</a></nav>' +
      '<main id="main"><h1>Widget</h1><form data-form="W">${formHtml.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '')}</form></main>';
  }
  window.addEventListener("hashchange", render);
  render();
}
boot();
`;
  const model = 'export const NOTHING = 1;';
  return { html, css: '', runtime, model, modules: { 'runtime.js': runtime, 'model.t.js': model }, entry: 'runtime.js' };
}

function verdict(checks: { id: string; viewport: Viewport | 'both'; pass: boolean }[], id: string, vp: Viewport | 'both'): boolean {
  const hit = checks.find((c) => c.id === id && (c.viewport === vp || c.viewport === 'both'));
  assert.ok(hit, `check ${id} runs at ${vp}`);
  return hit.pass;
}


test('forms probe: decorative widget shells are not credited as controls', async () => {
  const app = deriveIr(parse(SOURCE));
  const result = await scoreUi(app, bundle());
  for (const vp of ['desktop', 'phone'] as const) {
    assert.equal(verdict(result.checks, 'control:W.Agree', vp), false, `${vp} nameless unfocusable role=checkbox div`);
    assert.equal(verdict(result.checks, 'control:W.Status', vp), false, `${vp} aria-hidden nameless popup button`);
    assert.equal(verdict(result.checks, 'control:W.Photo', vp), false, `${vp} aria-hidden button + hidden file input`);
    assert.equal(verdict(result.checks, 'control:W.Mode', vp), false, `${vp} nameless untabbable role=radio div`);
    assert.equal(verdict(result.checks, 'control:W.Note', vp), false, `${vp} a Help menu button is not a text control`);
    assert.equal(verdict(result.checks, 'control:W.When', vp), false, `${vp} a field-labelled menu popup is not a date control`);
  }
  assert.equal(verdict(result.checks, 'required:W.Mode', 'both'), false, 'aria-required on a group of decorative radios');
});

const UNLABELLED_POPUPS = `
<div data-field="Note"><span>Note</span><button type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Help">?</button></div>
<div data-field="Pick"><span>Pick</span><button type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Settings">S</button></div>
<div data-field="When"><span>When</span><button type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="hp">Help</button><div id="hp" role="dialog" hidden></div></div>
<div data-field="Days"><span>Days</span><button type="button" aria-haspopup="listbox" aria-expanded="false">Help</button></div>
<div data-field="Status"><span>Status</span><button type="button" aria-haspopup="true" aria-expanded="false" aria-label="Status">Open</button></div>
`;

test('forms probe: popup triggers not named by the field are not credited', async () => {
  const app = deriveIr(parse(SOURCE));
  const result = await scoreUi(app, bundle(UNLABELLED_POPUPS));
  for (const vp of ['desktop', 'phone'] as const) {
    assert.equal(verdict(result.checks, 'control:W.Note', vp), false, `${vp} a Help dialog button with aria-label on a text field is not the field control`);
    assert.equal(verdict(result.checks, 'control:W.Pick', vp), false, `${vp} a Settings listbox button with aria-label on a choice field is not the field control`);
    assert.equal(verdict(result.checks, 'control:W.When', vp), false, `${vp} an unlabelled Help dialog button with in-box aria-controls on a date field is not the field control`);
    assert.equal(verdict(result.checks, 'control:W.Days', vp), false, `${vp} an unlabelled Help listbox button on a multichoice field is not the field control`);
    assert.equal(verdict(result.checks, 'control:W.Status', vp), false, `${vp} an aria-haspopup=true menu button with aria-label on a choice field is not the field control`);
  }
});
