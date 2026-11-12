'use strict';
/**
 * c2c_jobs: the Catalyst Job function every cron of the app targets. Catalyst
 * calls module.exports(jobRequest, context); the cron's job_meta.params.module
 * names the generated job file (job-scheduling.json). Only a module that file
 * lists runs, so a job parameter cannot load any other file.
 *
 * Data: the job's datastore is the zcatalyst-sdk adapter (admin scope),
 * initialized from the job context and installed for the run. The job module
 * closes the context itself (closeWithSuccess / closeWithFailure); this entry
 * closes it with failure only when no module runs.
 */
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEDULING = JSON.parse(readFileSync(join(__dirname, 'job-scheduling.json'), 'utf8'));
const COLUMNS = JSON.parse(readFileSync(join(__dirname, 'c2c-columns.json'), 'utf8'));
const SCHEMA = existsSync(join(__dirname, 'c2c-schema.json')) ? JSON.parse(readFileSync(join(__dirname, 'c2c-schema.json'), 'utf8')) : {};
function projectionsFromSchema(schema) {
  const out = {};
  for (const table of Object.keys(schema)) {
    const columns = schema[table];
    if (!Array.isArray(columns)) continue;
    const names = ['ROWID'];
    for (const column of columns) {
      if (typeof column === 'string' && !names.includes(column)) names.push(column);
    }
    out[table] = names;
  }
  return out;
}
const projectionPath = join(__dirname, 'c2c-projections.json');
const PROJECTIONS = existsSync(projectionPath) ? JSON.parse(readFileSync(projectionPath, 'utf8')) : projectionsFromSchema(SCHEMA);
const renamesPath = join(__dirname, 'c2c-renames.json');
const RENAMES = existsSync(renamesPath) ? JSON.parse(readFileSync(renamesPath, 'utf8')) : {};
const rulesPath = join(__dirname, 'c2c-rules.json');
const WRITE_RULES = existsSync(rulesPath) ? JSON.parse(readFileSync(rulesPath, 'utf8')) : {};

/** Every module a cron of job-scheduling.json targets. */
const MODULES = new Set(
  (Array.isArray(SCHEDULING.crons) ? SCHEDULING.crons : [])
    .map((cron) => cron && cron.job_meta && cron.job_meta.params && cron.job_meta.params.module)
    .filter((module) => typeof module === 'string' && /^job\/[a-z0-9][a-z0-9-]*\.mjs$/.test(module)),
);

function appTimeZone() {
  const fromEnv = typeof process.env.C2C_APP_TIMEZONE === 'string' ? process.env.C2C_APP_TIMEZONE.trim() : '';
  if (fromEnv) return fromEnv;
  try {
    const deploy = JSON.parse(readFileSync(join(__dirname, 'c2c-deploy.json'), 'utf8'));
    return deploy && typeof deploy.appTimeZone === 'string' && deploy.appTimeZone.trim() ? deploy.appTimeZone.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The module job parameter, from the job request accessors or a plain params object. */
function moduleParam(jobRequest) {
  if (!jobRequest) return '';
  if (typeof jobRequest.getJobParam === 'function') {
    const value = jobRequest.getJobParam('module');
    if (typeof value === 'string') return value;
  }
  if (typeof jobRequest.getAllJobParams === 'function') {
    const all = jobRequest.getAllJobParams();
    if (all && typeof all.module === 'string') return all.module;
  }
  return jobRequest.params && typeof jobRequest.params.module === 'string' ? jobRequest.params.module : '';
}

function fail(context, message) {
  console.error(`c2c_jobs: ${message}`);
  if (context && typeof context.closeWithFailure === 'function') context.closeWithFailure();
}

async function load(spec) {
  return import(pathToFileURL(join(__dirname, spec)).href);
}

module.exports = async function c2cJobs(jobRequest, context) {
  const module = moduleParam(jobRequest);
  if (!MODULES.has(module)) {
    fail(context, 'job parameter "module" names no scheduled job module');
    return;
  }
  let datastore;
  let store;
  let job;
  try {
    const sdk = require('zcatalyst-sdk-node');
    const { createSdkDatastore } = await load('c2c-sdk-datastore.mjs');
    let checkWrite;
    if (existsSync(rulesPath)) {
      const { assertWritable, quantizeRow } = await load('vendor/shims/write-rules.js');
      checkWrite = (form, row, kind) =>
        assertWritable(form, WRITE_RULES[form], quantizeRow(WRITE_RULES[form], row), { required: kind === 'insert' });
    }
    datastore = createSdkDatastore(sdk.initialize(context, { scope: 'admin' }), {
      columns: COLUMNS,
      projections: PROJECTIONS,
      renames: RENAMES,
      appTimeZone: appTimeZone(),
      checkWrite,
    });
    store = await load('c2c-store.mjs');
    job = (await load(module)).default;
  } catch (err) {
    const name = err && typeof err.name === 'string' && err.name ? err.name : 'Error';
    fail(context, `${module} did not load: name=${name}`);
    return;
  }
  if (typeof job !== 'function') {
    fail(context, `${module} has no default export`);
    return;
  }
  await store.runWithDatastore(datastore, () => job(jobRequest, context));
};
