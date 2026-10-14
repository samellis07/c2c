/**
 * Node test reporter that stays silent while the suite runs and, at the end,
 * prints one line per failing test: its file, its full nested name, and the
 * first line of the error. Pair it with the spec reporter so the run keeps
 * its usual output and counts; this reporter only adds the closing list so a
 * failing test's name is never lost to truncated output.
 *
 *   --test-reporter=spec --test-reporter-destination=stdout \
 *   --test-reporter=scripts/failure-summary-reporter.mjs \
 *   --test-reporter-destination=stdout
 *
 * Parent tests whose only failure is a failing subtest are skipped: the leaf
 * already names the real failure. Tests marked todo or skip that fail do not
 * fail the run, so they are not listed; failing todo tests surface as a
 * one-line `todo-failing: N` count instead.
 */
const MAX_FAILURES = 15;
const MAX_ERROR_LEN = 160;

function firstErrorLine(error) {
  if (!error) return '';
  const text = String(error.message !== undefined ? error.message : error);
  const line = text.split('\n').find((l) => l.trim().length > 0) || '';
  return line.length > MAX_ERROR_LEN ? `${line.slice(0, MAX_ERROR_LEN)}…` : line;
}

export default async function* failureSummaryReporter(source) {
  const stacks = new Map();
  const failures = [];
  let todoFailures = 0;
  for await (const event of source) {
    const { type, data } = event;
    if (!data) continue;
    if (type === 'test:enqueue' || type === 'test:start') {
      const stack = stacks.get(data.file) ?? [];
      stack[data.nesting] = data.name;
      stack.length = data.nesting + 1;
      stacks.set(data.file, stack);
    } else if (type === 'test:fail') {
      if (data.todo) {
        todoFailures += 1;
        continue;
      }
      if (data.skip) continue;
      if (data.details?.error?.failureType === 'subtestsFailed') continue;
      const stack = stacks.get(data.file) ?? [];
      const name = [...stack.slice(0, data.nesting), data.name]
        .filter((part) => part !== undefined && part !== '')
        .join(' > ');
      failures.push({ file: data.file || '<unknown>', name, error: firstErrorLine(data.details?.error) });
    }
  }
  if (failures.length > 0) {
    yield `\n--- failing tests (${failures.length}) ---\n`;
    for (const failure of failures.slice(0, MAX_FAILURES)) {
      yield `${failure.file}: ${failure.name}\n    ${failure.error}\n`;
    }
    if (failures.length > MAX_FAILURES) yield `... and ${failures.length - MAX_FAILURES} more\n`;
  }
  if (todoFailures > 0) yield `todo-failing: ${todoFailures}\n`;
}
