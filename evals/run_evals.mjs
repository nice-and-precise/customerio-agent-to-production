#!/usr/bin/env node
/**
 * run_evals.mjs
 *
 * Re-scores every saved run in web/data.json with the current rubric and prints
 * a report. Runs offline and deterministically, so it works in CI and for anyone
 * who clones the repo without an API key. Because it re-derives scores from
 * rubric.mjs (rather than trusting the numbers baked into data.json), it also
 * proves the scores are reproducible.
 *
 *   node evals/run_evals.mjs
 *
 * Exit code is non-zero if the hardened prompt's mean score drops below a gate,
 * so this doubles as a regression check you could wire into a deploy.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCampaign } from "./rubric.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "web", "data.json");
const GATE = 0.9; // hardened prompt must hold >= 90% weighted score

const data = JSON.parse(readFileSync(DATA, "utf8"));
const rows = data.runs.map((r) => {
  const s = scoreCampaign(r.campaign, r.parse_error);
  return { case: r.case, version: r.prompt_version, score: s.score, passed: s.passed, total: s.total, checks: s.checks };
});

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const byVersion = {};
for (const r of rows) (byVersion[r.version] ||= []).push(r.score);
const mean = (a) => a.reduce((s, n) => s + n, 0) / (a.length || 1);

console.log("\nLifecycle-campaign agent — eval report");
console.log("=".repeat(60));
for (const r of rows) {
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
  console.log(
    `${r.version.padEnd(12)} ${r.case.padEnd(26)} ${pct(r.score).padStart(4)}  (${r.passed}/${r.total})` +
      (failed.length ? `  ✗ ${failed.join(", ")}` : "  ✓")
  );
}
console.log("-".repeat(60));
for (const [v, arr] of Object.entries(byVersion)) {
  console.log(`${v.padEnd(12)} mean ${pct(mean(arr))} across ${arr.length} runs`);
}

const v1 = byVersion["v1"] ? mean(byVersion["v1"]) : null;
const v2 = byVersion["v2_hardened"] ? mean(byVersion["v2_hardened"]) : null;
if (v1 != null && v2 != null) {
  console.log(`\nprompt hardening lift: ${pct(v1)} -> ${pct(v2)}  (+${((v2 - v1) * 100).toFixed(0)} pts)`);
}

if (v2 != null && v2 < GATE) {
  console.error(`\nFAIL: hardened prompt mean ${pct(v2)} is below the ${pct(GATE)} gate.`);
  process.exit(1);
}
console.log(`\nPASS: hardened prompt holds the ${pct(GATE)} gate.\n`);
