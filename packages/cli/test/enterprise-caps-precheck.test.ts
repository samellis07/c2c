import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveIr, parse } from '../../core/src/index.js';
import { precheck, STATEMENT_HOTSPOT_THRESHOLD, ENTERPRISE_SCHEDULE_QUOTA } from '../src/precheck.js';

function app(name: string, body: string): string {
  return `application "${name}"\n{\n${body}\n}\n`;
}

function itemForm(): string {
  return `\tform Item\n\t{\n\t\tTitle\n\t\t(\n\t\t\ttype = text\n\t\t)\n\t\tQty\n\t\t(\n\t\t\ttype = number\n\t\t)\n\t}\n`;
}

function scheduleWorkflow(name: string): string {
  return `\t\t\t${name} as "${name}"\n\t\t\t{\n\t\t\t\ttype = schedule\n\t\t\t\tstart = "2026-10-07 07:00:00"\n\t\t\t\tfrequency = daily\n\t\t\t\ttime zone = "Asia/Kolkata"\n\t\t\t\ton start\n\t\t\t\t{\n\t\t\t\t\tactions\n\t\t\t\t\t{\n\t\t\t\t\ton load\n\t\t\t\t\t(\n\t\t\t\t\t\tx = 1;\n\t\t\t\t\t)\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}`;
}

test('precheck flags scripts reaching the statement hotspot threshold as statement-limit-risk', () => {
  // Generate script with STATEMENT_HOTSPOT_THRESHOLD (5000) statements
  const stmts = Array.from({ length: STATEMENT_HOTSPOT_THRESHOLD }, (_, i) => `\t\t\t\t\t\t\tx${i % 10} = ${i};`).join('\n');
  const source = app('Statement_Risk_App', `${itemForm()}\tworkflow\n\t{\n\t\tform\n\t\t{\n\t\t\tItem\n\t\t\t{\n\t\t\t\ton success\n\t\t\t\t(\n${stmts}\n\t\t\t\t)\n\t\t\t}\n\t\t}\n\t}\n`);
  const ir = deriveIr(parse(source));
  const report = precheck(ir, source);
  const found = report.findings.filter((f) => f.check === 'statement-limit-risk');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, 'warning');
  assert.match(found[0]!.message, /5000 Deluge statements/);
  assert.match(found[0]!.message, /50,000 statements\/action/);
  assert.match(found[0]!.message, /30-second execution cutoff/);
  assert.match(found[0]!.fix, /runOrDefer/);
});

test('precheck does not flag scripts well below the statement hotspot threshold', () => {
  const stmts = Array.from({ length: 50 }, (_, i) => `\t\t\t\t\t\t\tx${i % 10} = ${i};`).join('\n');
  const source = app('Statement_Safe_App', `${itemForm()}\tworkflow\n\t{\n\t\tform\n\t\t{\n\t\t\tItem\n\t\t\t{\n\t\t\t\ton success\n\t\t\t\t(\n${stmts}\n\t\t\t\t)\n\t\t\t}\n\t\t}\n\t}\n`);
  const ir = deriveIr(parse(source));
  const report = precheck(ir, source);
  const found = report.findings.filter((f) => f.check === 'statement-limit-risk');
  assert.equal(found.length, 0);
});

test('precheck flags apps defining at or above the Enterprise schedule quota (600 schedules)', () => {
  const scheds = Array.from({ length: ENTERPRISE_SCHEDULE_QUOTA }, (_, i) => scheduleWorkflow(`Sched_${i}`)).join('\n');
  const source = app('Schedule_Risk_App', `${itemForm()}\tworkflow\n\t{\n\t\tschedule\n\t\t{\n${scheds}\n\t\t}\n\t}\n`);
  const ir = deriveIr(parse(source));
  const report = precheck(ir, source);
  const found = report.findings.filter((f) => f.check === 'schedule-quota-risk');
  assert.equal(found.length, 1);
  assert.equal(found[0]!.severity, 'warning');
  assert.match(found[0]!.message, /600 schedules/);
  assert.match(found[0]!.message, /600 custom schedules per user per month/);
  assert.match(found[0]!.message, /4-minute execution budget/);
});

test('precheck does not flag apps with normal schedule counts below the Enterprise quota', () => {
  const scheds = [scheduleWorkflow('Daily_Report'), scheduleWorkflow('Weekly_Report')].join('\n');
  const source = app('Schedule_Safe_App', `${itemForm()}\tworkflow\n\t{\n\t\tschedule\n\t\t{\n${scheds}\n\t\t}\n\t}\n`);
  const ir = deriveIr(parse(source));
  const report = precheck(ir, source);
  const found = report.findings.filter((f) => f.check === 'schedule-quota-risk');
  assert.equal(found.length, 0);
});
