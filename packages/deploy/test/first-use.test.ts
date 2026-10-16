import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGateProbe, FIRST_USE_GATE_LIST, FIRST_USE_GATES, gateConsoleLine, requiredGates } from '../src/first-use.js';

test('every gate is guided with one console line and a documented GET probe', () => {
  for (const gate of FIRST_USE_GATE_LIST) {
    assert.ok(gate.console.startsWith(`Catalyst console → the project → ${gate.page} → Start Exploring (`), gate.id);
    assert.match(gate.console, /^Catalyst console → the project → .*Start Exploring \(<console>\/baas\/<org>\/project\/<project>\/Development#\//);
    assert.equal(gate.console.includes('\n'), false);
    assert.match(gate.probe, /\/project\/<project>\//);
    assert.match(gate.doc, /^https:\/\/docs\.catalyst\.zoho\.com\/en\/api\/code-reference\//);
  }
  const line = gateConsoleLine(FIRST_USE_GATE_LIST[0]!, { console: 'https://console.example.test', org: '1', project: '2' });
  assert.match(line, /https:\/\/console\.example\.test\/baas\/1\/project\/2\/Development#\//);
});

test('the app decides which gates apply: Cloud Scale always, the rest by service use', () => {
  assert.deepEqual(requiredGates({ client: false, files: false, pdf: false }).map((gate) => gate.id), ['cloudscale']);
  assert.deepEqual(requiredGates({ client: true, files: true, pdf: true }).map((gate) => gate.id), ['cloudscale', 'stratus', 'smartbrowz', 'slate']);
});

test('probe answers: the access-the-service refusal is closed, a success envelope is open, anything else is unverified', () => {
  const { cloudscale, smartbrowz, slate, stratus } = FIRST_USE_GATES;
  assert.equal(classifyGateProbe({ status: 400, body: { status: 'failure', data: { message: "Please access the Slate service in your project's console before deploying via the CLI." } } }, slate), 'closed');
  assert.equal(classifyGateProbe({ status: 404, body: { status: 'failure', data: { error_code: 'INVALID_URL_PATTERN' } } }, slate), 'closed');
  assert.equal(classifyGateProbe({ status: 200, body: { status: 'success', data: [] } }, cloudscale), 'open');
  assert.equal(classifyGateProbe({ status: 200, body: { status: 'failure', data: { message: 'Please access the Stratus service' } } }, stratus), 'closed');
  // The Stratus first-use refusal (OPERATION_NOT_ALLOWED, "in session … first
  // time") is the closed gate, not an unknown answer — it needs the one
  // console bucket, never a retry. Both recorded shapes classify, whatever the
  // letter case or trailing punctuation.
  assert.equal(classifyGateProbe({ status: 400, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'User needs to be in session when accessing Stratus for the first time' } } }, stratus), 'closed');
  assert.equal(classifyGateProbe({ status: 405, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'You are not allowed to perform this operation. User needs to be in session when accessing Stratus for the first time.' } } }, stratus), 'closed');
  assert.equal(classifyGateProbe({ status: 400, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'user needs to be in session when accessing stratus for the first time' } } }, stratus), 'closed');
  // The same first-session sentence naming another service is not the Stratus
  // gate — neither on the Stratus probe nor anywhere else.
  assert.equal(classifyGateProbe({ status: 400, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'User needs to be in session when accessing SmartBrowz for the first time' } } }, stratus), 'unknown');
  assert.equal(classifyGateProbe({ status: 400, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'User needs to be in session when accessing SmartBrowz for the first time' } } }, smartbrowz), 'unknown');
  // The recorded Stratus refusal on another gate's probe is not that gate's
  // closed signal either.
  assert.equal(classifyGateProbe({ status: 400, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'User needs to be in session when accessing Stratus for the first time' } } }, cloudscale), 'unknown');
  // An OPERATION_NOT_ALLOWED that does not name the first-session refusal stays unverified.
  assert.equal(classifyGateProbe({ status: 400, body: { status: 'failure', data: { error_code: 'OPERATION_NOT_ALLOWED', message: 'You are not allowed to perform this operation' } } }, stratus), 'unknown');
  assert.equal(classifyGateProbe({ status: 200, body: { status: 'error', data: {} } }, cloudscale), 'unknown');
  assert.equal(classifyGateProbe({ status: 401, body: { data: { error_code: 'AUTHENTICATION_FAILURE' } } }, slate), 'unknown');
  assert.equal(classifyGateProbe({ status: 500, body: {} }, stratus), 'unknown');
});
