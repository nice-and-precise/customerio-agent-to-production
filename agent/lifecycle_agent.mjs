#!/usr/bin/env node
/**
 * lifecycle_agent.mjs
 *
 * A GTM lifecycle-campaign agent, the kind of scrappy CLI a marketing-ops team
 * builds first. It takes a launch brief + a behavioral segment and returns a
 * structured Customer.io lifecycle campaign.
 *
 * This file is deliberately provider-agnostic. It targets Claude first (matching
 * the Customer.io GTM AI stack) and falls back to any OpenAI-compatible endpoint,
 * so the same agent runs wherever the fleet runs.
 *
 * The point of the kit is not this one agent. It's the production layer around it:
 *   - evals/           a rubric that scores every run (evals/run_evals.mjs)
 *   - agent/prompts/   a versioned prompt you can harden and measure (v1 -> v2)
 *   - observability/   a structured trace for every run (observability/trace.mjs)
 *
 * Usage:
 *   node agent/lifecycle_agent.mjs --brief "..." --segment "..." --version v2_hardened
 *   node agent/lifecycle_agent.mjs --case trial_no_activation --version v1   # runs a saved case
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreCampaign } from "../evals/rubric.mjs";
import { writeTrace, newRunId } from "../observability/trace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// ---- prompt loading + templating -------------------------------------------

export function loadPrompt(version, { brief, segment }) {
  const file = join(HERE, "prompts", version.endsWith(".md") ? version : `${version}.md`);
  return readFileSync(file, "utf8")
    .replaceAll("{{BRIEF}}", brief)
    .replaceAll("{{SEGMENT}}", segment);
}

// ---- provider-agnostic model call ------------------------------------------

function selectProvider() {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      name: "anthropic",
      model: process.env.MODEL || "claude-sonnet-4-6",
      url: "https://api.anthropic.com/v1/messages",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "openai",
      model: process.env.MODEL || "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
    };
  }
  return null; // offline: caller should use saved demo runs
}

async function callModel(prompt) {
  const provider = selectProvider();
  if (!provider) {
    throw new Error(
      "No ANTHROPIC_API_KEY or OPENAI_API_KEY set. Run against the saved demo data instead (see web/data.json)."
    );
  }
  const started = Date.now();
  let body, headers;
  if (provider.name === "anthropic") {
    headers = {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    };
    body = {
      model: provider.model,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    };
  } else {
    headers = {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    };
    body = {
      model: provider.model,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    };
  }

  const res = await fetch(provider.url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${provider.name} ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const latency_ms = Date.now() - started;
  if (provider.name === "anthropic") {
    return {
      text: data.content?.[0]?.text ?? "",
      model: provider.model,
      input_tokens: data.usage?.input_tokens ?? null,
      output_tokens: data.usage?.output_tokens ?? null,
      latency_ms,
    };
  }
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    model: provider.model,
    input_tokens: data.usage?.prompt_tokens ?? null,
    output_tokens: data.usage?.completion_tokens ?? null,
    latency_ms,
  };
}

// ---- robust JSON extraction ------------------------------------------------
// Models wrap JSON in prose or code fences. Pull the first balanced object.

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start === -1) return { ok: false, error: "no JSON object found", raw: text };
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === "{") depth++;
    else if (candidate[i] === "}") {
      depth--;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return { ok: true, value: JSON.parse(slice) };
        } catch (e) {
          return { ok: false, error: `JSON parse failed: ${e.message}`, raw: slice };
        }
      }
    }
  }
  return { ok: false, error: "unbalanced JSON braces", raw: text };
}

// ---- one full run: prompt -> model -> parse -> self-eval -> trace -----------

export async function runAgent({ brief, segment, version = "v2_hardened", caseId = "adhoc" }) {
  const prompt = loadPrompt(version, { brief, segment });
  const model = await callModel(prompt);
  const parsed = extractJson(model.text);
  const campaign = parsed.ok ? parsed.value : null;
  const evaluation = scoreCampaign(campaign, parsed.ok ? null : parsed.error);

  const trace = {
    run_id: newRunId(),
    ts: new Date().toISOString(),
    agent: "lifecycle-campaign",
    case: caseId,
    prompt_version: version,
    model: model.model,
    latency_ms: model.latency_ms,
    input_tokens: model.input_tokens,
    output_tokens: model.output_tokens,
    tool_calls: 0,
    eval_score: evaluation.score,
    evals_passed: evaluation.passed,
    evals_total: evaluation.total,
    status: evaluation.score >= 0.8 ? "pass" : evaluation.score >= 0.5 ? "warn" : "fail",
  };
  writeTrace(trace);

  return { campaign, evaluation, trace, raw: model.text };
}

// ---- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

function loadCase(caseId) {
  const dir = join(ROOT, "evals", "cases");
  const file = readdirSync(dir).find((f) => f === `${caseId}.json`);
  if (!file) throw new Error(`unknown case '${caseId}'. Available: ${readdirSync(dir).map((f) => f.replace(".json", "")).join(", ")}`);
  return JSON.parse(readFileSync(join(dir, file), "utf8"));
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  let { brief, segment } = a;
  const version = a.version || "v2_hardened";
  const caseId = a.case || "adhoc";
  if (a.case) {
    const c = loadCase(a.case);
    brief = c.brief;
    segment = c.segment;
  }
  if (!brief || !segment) {
    console.error('Provide --brief "..." --segment "..."  OR  --case <name>');
    process.exit(1);
  }
  const { campaign, evaluation, trace } = await runAgent({ brief, segment, version, caseId });
  console.log(JSON.stringify(campaign, null, 2));
  console.error(
    `\n[${trace.status.toUpperCase()}] ${version}  score=${(evaluation.score * 100).toFixed(0)}%  ` +
      `(${evaluation.passed}/${evaluation.total} checks)  ${trace.latency_ms}ms  ` +
      `${trace.output_tokens ?? "?"} out-tokens  run=${trace.run_id}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("agent error:", e.message);
    process.exit(1);
  });
}
