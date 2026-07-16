#!/usr/bin/env node
/**
 * build_demo_data.mjs
 *
 * Runs the agent for real across every case x prompt version, captures the
 * output + eval + trace, and writes web/data.json (the file the dashboard and
 * the offline eval report both read). Also resets observability/runs.jsonl so
 * the fleet view reflects exactly this batch.
 *
 * Needs ANTHROPIC_API_KEY or OPENAI_API_KEY. Run it once to regenerate the demo:
 *   OPENAI_API_KEY=... node scripts/build_demo_data.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAgent } from "../agent/lifecycle_agent.mjs";
import { RUNS_FILE, readTraces, fleetHealth } from "../observability/trace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CASES_DIR = join(ROOT, "evals", "cases");
const OUT = join(ROOT, "web", "data.json");
const VERSIONS = ["v1", "v2_hardened"];

// fresh trace log for this batch
writeFileSync(RUNS_FILE, "");

const cases = readdirSync(CASES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), "utf8")));

const runs = [];
let model = null;
for (const c of cases) {
  for (const version of VERSIONS) {
    process.stderr.write(`running ${version} / ${c.id} ... `);
    try {
      const { campaign, evaluation, trace, raw } = await runAgent({
        brief: c.brief,
        segment: c.segment,
        version,
        caseId: c.id,
      });
      model = trace.model;
      runs.push({
        case: c.id,
        prompt_version: version,
        campaign,
        parse_error: campaign ? null : "model output did not parse",
        raw_excerpt: campaign ? null : raw.slice(0, 400),
        evaluation: { score: evaluation.score, passed: evaluation.passed, total: evaluation.total, checks: evaluation.checks },
        trace,
      });
      process.stderr.write(`${(evaluation.score * 100).toFixed(0)}%  ${trace.latency_ms}ms\n`);
    } catch (e) {
      process.stderr.write(`ERROR ${e.message}\n`);
      runs.push({ case: c.id, prompt_version: version, campaign: null, parse_error: e.message, evaluation: null, trace: null });
    }
  }
}

const data = {
  generated_at: new Date().toISOString(),
  model,
  note: "Real agent runs. The dashboard reads this file; nothing here calls a model at view time, so no API key ships to the browser.",
  cases: cases.map((c) => ({ id: c.id, brief: c.brief, segment: c.segment })),
  runs,
  fleet: fleetHealth(readTraces()),
};
writeFileSync(OUT, JSON.stringify(data, null, 2));
console.error(`\nwrote ${OUT}: ${runs.length} runs across ${cases.length} cases on ${model}`);
