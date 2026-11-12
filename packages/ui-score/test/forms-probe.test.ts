/**
 * The forms probe judges rendered custom widgets, not only native controls.
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
<div data-field="Agree"><label for="agree">Agree</label><button type="button" id="agree" role="checkbox" aria-checked="false" aria-required="true"></button><input type="hidden" name="Agree" value="false"></div>
<div data-field="Status"><label for="st">Status</label><button type="button" id="st" role="combobox" aria-expanded="false" aria-required="true" aria-autocomplete="none" dir="ltr" data-state="closed" data-placeholder="">Select an option</button><input type="hidden" name="Status" value=""><select required ${HIDDEN_NATIVE} tabindex="-1" aria-hidden="true"><option value=""></option><option>Open</option><option>Done</option></select></div>
<div data-field="Pick"><span class="field-title">Pick</span><p>Not generated yet</p></div>
<div data-field="Photo"><strong>Photo</strong><button type="button">Choose file</button><input type="file" name="Photo" tabindex="-1" aria-hidden="true" ${HIDDEN_NATIVE}></div>
<div data-field="Mode"><fieldset><legend>Mode</legend><div role="radiogroup" aria-required="true"><div role="radio" aria-checked="false" tabindex="0">X</div><div role="radio" aria-checked="false" tabindex="-1">Y</div></div></fieldset><input type="hidden" name="Mode" value=""></div>
<div data-field="Days"><span id="days-label">Days</span><button type="button" aria-labelledby="days-label days-value" aria-haspopup="listbox" aria-expanded="false" aria-controls="days-listbox"><span id="days-value">Select options</span></button><input type="hidden" name="Days" value=""></div>
<div data-field="When"><label for="when">When</label><button type="button" id="when" aria-haspopup="dialog" aria-expanded="false">Select a date</button><input type="hidden" name="When" value=""></div>
<div data-field="Note"><label for="note">Note</label><input type="text" id="note" name="Note"></div>
<div data-field="Flag"><label for="flag">Flag</label><span>off</span></div>
`;

function bundle(): UiBundle {
  const html = `<!doctype html><html lang="en"><head><title>Widget App</title><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="./app.css"><script type="module" src="./runtime.js"></script></head><body><a href="#main">Skip</a><main id="main"></main></body></html>`;
  const runtime = `import { NOTHING } from "./model.t.js";
export function boot() {
  function render() {
    document.body.innerHTML = '<a href="#main">Skip</a><nav id="nav" aria-label="Main"><a href="#/form/W">Widget</a></nav>' +
      '<main id="main"><h1>Widget</h1><form data-form="W">${FORM.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '')}</form></main>';
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

test('forms probe: custom widget controls suit their field kind', async () => {
  const app = deriveIr(parse(SOURCE));
  const result = await scoreUi(app, bundle());
  for (const vp of ['desktop', 'phone'] as const) {
    assert.equal(verdict(result.checks, 'control:W.Agree', vp), true, `${vp} decision button suits`);
    assert.equal(verdict(result.checks, 'control:W.Status', vp), true, `${vp} dropdown trigger suits`);
    assert.equal(verdict(result.checks, 'control:W.Mode', vp), true, `${vp} radio option suits`);
    assert.equal(verdict(result.checks, 'control:W.Days', vp), true, `${vp} multi trigger suits`);
    assert.equal(verdict(result.checks, 'control:W.When', vp), true, `${vp} date trigger suits`);
    assert.equal(verdict(result.checks, 'control:W.Photo', vp), true, `${vp} dropzone button suits`);
    assert.equal(verdict(result.checks, 'control:W.Note', vp), true, `${vp} native input still suits`);
    assert.equal(verdict(result.checks, 'control:W.Pick', vp), false, `${vp} a box with no control still fails`);
    assert.equal(verdict(result.checks, 'control:W.Flag', vp), false, `${vp} a decision box with no checkbox still fails`);
  }
});

test('forms probe: aria-required on an accessible field control marks it mandatory', async () => {
  const app = deriveIr(parse(SOURCE));
  const result = await scoreUi(app, bundle());
  const required = result.checks.filter((c) => c.id.startsWith('required:W.'));
  assert.ok(required.length > 0, 'required checks run');
  assert.equal(verdict(result.checks, 'required:W.Agree', 'both'), true, 'checkbox group marked');
  assert.equal(verdict(result.checks, 'required:W.Mode', 'both'), true, 'radiogroup marked');
  assert.equal(verdict(result.checks, 'required:W.Status', 'both'), true, 'combobox trigger aria-required mark counts');
});
