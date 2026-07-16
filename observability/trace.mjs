/**
 * trace.mjs
 *
 * Minimal structured tracing for the agent fleet. Every run appends one JSON
 * line to observability/runs.jsonl: run id, timing, tokens, tool calls, and the
 * eval score. That single file is enough to answer the questions you actually
 * get paged about, which agent regressed, which prompt version is live, where
 * latency and cost are going, without standing up a whole platform on day one.
 *
 * JSONL on purpose: append-only, greppable, and it streams straight into
 * BigQuery / Cloud Logging when the fleet outgrows a flat file.
 */

import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNS_FILE = join(HERE, "runs.jsonl");

export function newRunId() {
  return "run_" + randomUUID().slice(0, 8);
}

export function writeTrace(trace) {
  appendFileSync(RUNS_FILE, JSON.stringify(trace) + "\n");
  return trace;
}

export function readTraces(file = RUNS_FILE) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Fleet-health rollup, the kind of summary you'd put on a dashboard or an alert. */
export function fleetHealth(traces) {
  if (!traces.length) return { runs: 0 };
  const scores = traces.map((t) => t.eval_score).filter((n) => Number.isFinite(n));
  const lat = traces.map((t) => t.latency_ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : null);
  const byVersion = {};
  for (const t of traces) {
    (byVersion[t.prompt_version] ||= []).push(t.eval_score);
  }
  return {
    runs: traces.length,
    pass_rate: traces.filter((t) => t.status === "pass").length / traces.length,
    mean_score: scores.reduce((s, n) => s + n, 0) / (scores.length || 1),
    p50_latency_ms: pct(lat, 50),
    p95_latency_ms: pct(lat, 95),
    total_output_tokens: traces.reduce((s, t) => s + (t.output_tokens || 0), 0),
    score_by_version: Object.fromEntries(
      Object.entries(byVersion).map(([v, arr]) => [v, arr.reduce((s, n) => s + n, 0) / arr.length])
    ),
  };
}
