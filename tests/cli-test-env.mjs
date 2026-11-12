/** Return a child environment without Node's color/warning noise. */
export function cleanCliEnv(base = process.env) {
  const env = { ...base };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  if (env.NODE_OPTIONS) {
    env.NODE_OPTIONS = env.NODE_OPTIONS
      .split(/\s+/)
      .filter((flag) => !['--trace-warnings', '--trace-deprecation', '--pending-deprecation'].includes(flag))
      .join(' ')
      .trim();
    if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  }
  return env;
}
