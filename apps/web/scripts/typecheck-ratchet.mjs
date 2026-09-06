#!/usr/bin/env node
/**
 * Type-error ratchet.
 *
 * The production image builds with SKIP_TYPE_CHECK=true, so `next build` never
 * type-checks and errors accumulate silently — that is how a rejected email
 * still got sent (utils/dharahil/client.ts returned an action outside its own
 * union, and tsc said so). Until the count reaches zero and that flag can be
 * deleted, this keeps the number moving in one direction.
 *
 *   node scripts/typecheck-ratchet.mjs           # fail if worse than baseline
 *   node scripts/typecheck-ratchet.mjs --update  # record an improvement
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baselineFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "typecheck-baseline.json",
);

function countErrors() {
  let output = "";
  try {
    output = execSync("npx tsc --noEmit -p tsconfig.json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // tsc exits non-zero when there are errors; the report is still on stdout.
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  const lines = output
    .split("\n")
    .filter((line) => /^\S+\(\d+,\d+\): error TS\d+/.test(line));

  const source = lines.filter(
    (line) => !/^\S*(\.test\.tsx?|__tests__\/)/.test(line),
  );

  return { total: lines.length, source: source.length };
}

const current = countErrors();
const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));

if (process.argv.includes("--update")) {
  writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    `Baseline updated: ${current.total} total, ${current.source} in source.`,
  );
  process.exit(0);
}

console.log(
  `Type errors: ${current.total} total (${current.source} in source). ` +
    `Baseline: ${baseline.total} / ${baseline.source}.`,
);

// Source errors are ratcheted separately: they are the ones that can hide a
// real runtime bug, and they must never grow even if test fixtures churn.
const regressions = [];
if (current.total > baseline.total) {
  regressions.push(`total ${baseline.total} -> ${current.total}`);
}
if (current.source > baseline.source) {
  regressions.push(`source ${baseline.source} -> ${current.source}`);
}

if (regressions.length > 0) {
  console.error(`\nType errors increased: ${regressions.join(", ")}.`);
  console.error(
    "Fix them, or explain why in review. Do not raise the baseline.",
  );
  process.exit(1);
}

if (current.total < baseline.total || current.source < baseline.source) {
  console.log("\nImproved. Run with --update to lock the gain in.");
}
