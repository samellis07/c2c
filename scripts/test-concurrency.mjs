export function getTestConcurrencyArgs(env = process.env, log = console.warn) {
  const val = env.C2C_TEST_CONCURRENCY;
  if (val === undefined || val === '') {
    return [];
  }
  const parsed = parseInt(val, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || String(parsed) !== val.trim()) {
    log(`Warning: ignoring invalid C2C_TEST_CONCURRENCY value '${val}'`);
    return [];
  }
  return [`--test-concurrency=${parsed}`];
}
