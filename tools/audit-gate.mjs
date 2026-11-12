#!/usr/bin/env node
// npm audit gate: run `npm audit --json` in each package directory, keep only
// advisories at severity high or critical, subtract entries in
// tools/audit-allowlist.txt, and fail if anything remains.
//
// Usage: node tools/audit-gate.mjs [dir ...]
// Default dirs: the repository root and packages/ui-react/template.
// Exit 1 with a listing when an unallowlisted high/critical advisory exists.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = process.argv.slice(2);
const targets = dirs.length ? dirs : [".", "packages/ui-react/template"];

function loadAllowlist(path) {
  const today = new Date().toISOString().slice(0, 10);
  const entries = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [id, expiry, ...rest] = line.split("|").map((s) => s.trim());
    if (!id || !expiry || !rest.length) {
      console.error(`audit-allowlist: malformed line (need "id | YYYY-MM-DD | reason"): ${line}`);
      process.exit(2);
    }
    entries.push({ id, expiry, reason: rest.join(" | "), active: today <= expiry });
  }
  return entries;
}

const allowlist = loadAllowlist(join(root, "tools/audit-allowlist.txt"));

function audit(dir) {
  let out;
  try {
    out = execFileSync("npm", ["audit", "--json"], { cwd: join(root, dir), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.stdout) out = e.stdout;
    else {
      console.error(`audit-gate: npm audit failed in ${dir}: ${e.message}`);
      process.exit(2);
    }
  }
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    console.error(`audit-gate: could not parse npm audit output in ${dir}`);
    process.exit(2);
  }
  const bad = [];
  for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
    if (vuln.severity !== "high" && vuln.severity !== "critical") continue;
    const ids = (vuln.via ?? [])
      .filter((v) => typeof v === "object" && v !== null)
      .flatMap((v) => {
        const ghsa = /GHSA-[a-z0-9-]+/i.exec(v.url ?? "");
        return [String(v.source ?? ""), ghsa ? ghsa[0] : ""].filter(Boolean);
      });
    const key = ids.length ? ids.join(",") : name;
    bad.push({ dir, name, severity: vuln.severity, key });
  }
  return bad;
}

let remaining = 0;
for (const item of targets.flatMap(audit)) {
  const waiver = allowlist.find((w) => item.key.split(",").some((id) => id.toLowerCase() === w.id.toLowerCase()));
  if (waiver && waiver.active) {
    console.log(`audit-gate: WAIVED ${item.severity} ${item.name} (${item.dir}) — ${waiver.id} until ${waiver.expiry}: ${waiver.reason}`);
    continue;
  }
  if (waiver && !waiver.active) {
    console.log(`audit-gate: expired waiver ignored for ${item.name} (${waiver.id} ended ${waiver.expiry})`);
  }
  console.log(`audit-gate: ${item.severity.toUpperCase()} ${item.name} (${item.dir}) ids=${item.key}`);
  remaining += 1;
}
console.log(`audit-gate: ${remaining} unwaived high/critical advisory(ies)`);
process.exit(remaining ? 1 : 0);
