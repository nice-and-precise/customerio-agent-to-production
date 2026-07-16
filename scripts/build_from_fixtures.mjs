#!/usr/bin/env node
/**
 * build_from_fixtures.mjs
 *
 * When there's no funded API key on hand, this seeds web/data.json from a set of
 * realistic raw model outputs. It runs them through the SAME production pipeline
 * the live agent uses: the real JSON parser (agent/lifecycle_agent.extractJson),
 * the real rubric (evals/rubric.scoreCampaign), and the real tracer. So the
 * eval scores and the v1 -> v2 lift below are genuinely computed, not typed in.
 * Only latency/token numbers are illustrative stand-ins for a live call.
 *
 * The v1 strings are deliberately messy (code fences, prose, the classic scrappy
 * failures: no exit criteria, a PII leak, backwards timing) so you can watch the
 * parser and the rubric catch them. Regenerate live anytime with:
 *   OPENAI_API_KEY=... npm run build-demo
 */

import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractJson } from "../agent/lifecycle_agent.mjs";
import { scoreCampaign } from "../evals/rubric.mjs";
import { RUNS_FILE, readTraces, fleetHealth, newRunId } from "../observability/trace.mjs";
import { appendFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// raw outputs "as if" returned by the model, one per case x version.
const FIXTURES = [
  {
    case: "trial_no_activation",
    version: "v1",
    latency_ms: 1680,
    output_tokens: 421,
    raw: '```json\n{\n  "campaign_name": "Trial Activation Nudge",\n  "messages": [\n    {"step":1,"channel":"email","trigger":{"type":"time_delay","value":"1 day after signup"},"delay_hours":24,"subject":"Connect your first data source","body_outline":"Show the value of connecting a source; link to the setup guide.","primary_cta":"Connect a data source"},\n    {"step":2,"channel":"email","trigger":{"type":"time_delay","value":"day 4"},"delay_hours":96,"subject":"Build your first automation","body_outline":"Walk through building one automation end to end.","primary_cta":"Build an automation"},\n    {"step":3,"channel":"push","trigger":{"type":"time_delay","value":"day 3"},"delay_hours":72,"subject":"","body_outline":"Reminder that the trial is ticking.","primary_cta":"Finish setup"}\n  ],\n  "guardrails":["Only message during business hours"]\n}\n```',
  },
  {
    case: "trial_no_activation",
    version: "v2_hardened",
    latency_ms: 2410,
    output_tokens: 763,
    raw: '{\n  "campaign_name": "Trial: First Data Source to First Automation",\n  "objective": "Get 40% of non-activated trials to fire data_source_connected within 7 days.",\n  "target_segment": {"name":"Trials not yet activated","behavioral_filter":"account_created within 14d AND login_count >= 1 AND NOT event:data_source_connected"},\n  "messages":[\n    {"step":1,"channel":"email","trigger":{"type":"event","value":"trial_started"},"delay_hours":1,"subject":"The one step that makes the trial click","body_outline":"Frame connecting a data source as the moment value shows up; one-click link to the connect flow.","primary_cta":"Connect a data source","success_metric":"data_source_connected within 48h"},\n    {"step":2,"channel":"in_app","trigger":{"type":"attribute","value":"still no data_source_connected at day 3"},"delay_hours":72,"subject":"","body_outline":"Contextual in-app tip pointing at the connect button when they next log in.","primary_cta":"Connect now","success_metric":"connect flow opened"},\n    {"step":3,"channel":"email","trigger":{"type":"attribute","value":"data_source_connected true, automation_created false"},"delay_hours":120,"subject":"You are one automation away","body_outline":"Nudge from connected to first working automation with a 3-minute template.","primary_cta":"Build one automation","success_metric":"automation_created within trial"}\n  ],\n  "exit_criteria":"Person fires automation_created, or the trial ends.",\n  "guardrails":["Max 1 message per 48h","Suppress anyone who opened a support ticket in last 24h","Respect quiet hours 9pm-8am local"]\n}',
  },
  {
    case: "feature_launch_power_users",
    version: "v1",
    latency_ms: 1520,
    output_tokens: 468,
    raw: 'Here is a campaign:\n\n{\n  "campaign_name":"AI Segments Launch",\n  "target_segment":{"name":"Power users","behavioral_filter":"active paid customers"},\n  "messages":[\n    {"step":1,"channel":"email","trigger":{"type":"event","value":"feature_flag_ai_segments_on"},"delay_hours":0,"subject":"Try AI Segments","body_outline":"Announce AI segments and ask them to try it. For early access questions email jordan.pm@ourco.com directly.","primary_cta":"Publish an AI segment"},\n    {"step":2,"channel":"email","trigger":{"type":"time_delay","value":"3 days later"},"delay_hours":72,"subject":"How was AI Segments?","body_outline":"Ask for feedback for a case study.","primary_cta":"Share feedback"}\n  ],\n  "guardrails":["Frequency cap 1/week"]\n}',
  },
  {
    case: "feature_launch_power_users",
    version: "v2_hardened",
    latency_ms: 2280,
    output_tokens: 691,
    raw: '{\n  "campaign_name":"AI Segments: Power-User Beta to Case Study",\n  "objective":"Get 25 power users to publish an AI-built segment and return usable feedback in 14 days.",\n  "target_segment":{"name":"Recently active power users","behavioral_filter":"plan=paid AND count(segment_created,30d) >= 5 AND login within 7d"},\n  "messages":[\n    {"step":1,"channel":"email","trigger":{"type":"event","value":"ai_segments_enabled_for_account"},"delay_hours":2,"subject":"You get AI Segments first","body_outline":"Position them as the group whose feedback shapes the feature; link straight into the AI-segment builder.","primary_cta":"Publish an AI segment","success_metric":"ai_segment_published within 5d"},\n    {"step":2,"channel":"in_app","trigger":{"type":"attribute","value":"enabled but no ai_segment_published at day 4"},"delay_hours":96,"subject":"","body_outline":"In-app nudge with a one-line example of a behavior-based segment they could build.","primary_cta":"Try a template segment","success_metric":"builder opened"},\n    {"step":3,"channel":"email","trigger":{"type":"event","value":"ai_segment_published"},"delay_hours":144,"subject":"Two minutes for a case study?","body_outline":"Thank them and ask for structured feedback via a short form, no personal contact details in the copy.","primary_cta":"Share feedback","success_metric":"feedback_form_submitted"}\n  ],\n  "exit_criteria":"Person submits feedback, or 14 days elapse.",\n  "guardrails":["Frequency cap 1 message / 72h","Suppress accounts with an open escalation","Respect quiet hours"]\n}',
  },
  {
    case: "winback_dormant",
    version: "v1",
    latency_ms: 1975,
    output_tokens: 505,
    raw: '```\n{\n  "campaign_name":"Winback",\n  "target_segment":{"name":"Dormant paid","behavioral_filter":""},\n  "messages":[\n    {"step":1,"channel":"email","trigger":{"type":"time_delay","value":"day 0"},"delay_hours":0,"subject":"We miss you","body_outline":"Generic we-miss-you note.","primary_cta":"Come back"},\n    {"step":2,"channel":"email","trigger":{"type":"time_delay","value":"day 2"},"delay_hours":48,"subject":"Still here","body_outline":"Second nudge.","primary_cta":"Log in"},\n    {"step":3,"channel":"email","trigger":{"type":"time_delay","value":"day 4"},"delay_hours":96,"subject":"One more thing","body_outline":"Third nudge.","primary_cta":"Log in"},\n    {"step":4,"channel":"sms","trigger":{"type":"time_delay","value":"day 5"},"delay_hours":120,"subject":"","body_outline":"SMS nudge.","primary_cta":"Log in"},\n    {"step":5,"channel":"email","trigger":{"type":"time_delay","value":"day 7"},"delay_hours":168,"subject":"Discount","body_outline":"Offer a discount.","primary_cta":"Claim offer"},\n    {"step":6,"channel":"email","trigger":{"type":"time_delay","value":"day 9"},"delay_hours":216,"subject":"Last call","body_outline":"Final nudge.","primary_cta":"Log in"},\n    {"step":7,"channel":"push","trigger":{"type":"time_delay","value":"day 10"},"delay_hours":240,"subject":"","body_outline":"Push nudge.","primary_cta":"Open app"}\n  ],\n  "guardrails":["None"]\n}\n```',
  },
  {
    case: "winback_dormant",
    version: "v2_hardened",
    latency_ms: 2630,
    output_tokens: 802,
    raw: '{\n  "campaign_name":"Reactivate Quiet Paid Accounts",\n  "objective":"Get one messaging workflow live again in 20% of dormant-but-not-churning accounts within 21 days.",\n  "target_segment":{"name":"Dormant, not churning","behavioral_filter":"last campaign_sent 30-90d ago AND NOT pageview:cancellation within 14d"},\n  "messages":[\n    {"step":1,"channel":"email","trigger":{"type":"attribute","value":"days_since_last_campaign_sent >= 30"},"delay_hours":0,"subject":"Your last workflow is still ready to run","body_outline":"Remind them of the specific workflow they paused and how close it is to live.","primary_cta":"Reactivate my workflow","success_metric":"workflow_activated within 7d"},\n    {"step":2,"channel":"in_app","trigger":{"type":"attribute","value":"logged in but no workflow_activated"},"delay_hours":96,"subject":"","body_outline":"In-app path straight to the paused workflow with a one-click resume.","primary_cta":"Resume workflow","success_metric":"workflow editor opened"},\n    {"step":3,"channel":"email","trigger":{"type":"attribute","value":"no reactivation by day 10"},"delay_hours":240,"subject":"Want a hand getting it running?","body_outline":"Offer a short setup call or a template, framed as help not discount-baiting.","primary_cta":"Get setup help","success_metric":"reply or call booked"}\n  ],\n  "exit_criteria":"workflow_activated fires, or the account visits the cancellation page, or 21 days elapse.",\n  "guardrails":["Frequency cap 1 message / 96h","Hard-suppress anyone who hits the cancellation page mid-flight","Respect quiet hours and per-account send limits"]\n}',
  },
];

const cases = readdirSync(join(ROOT, "evals", "cases"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(ROOT, "evals", "cases", f), "utf8")));
const caseById = Object.fromEntries(cases.map((c) => [c.id, c]));

writeFileSync(RUNS_FILE, ""); // fresh trace log

const runs = FIXTURES.map((fx) => {
  const parsed = extractJson(fx.raw); // real parser
  const campaign = parsed.ok ? parsed.value : null;
  const evaluation = scoreCampaign(campaign, parsed.ok ? null : parsed.error); // real rubric
  const trace = {
    run_id: newRunId(),
    ts: new Date().toISOString(),
    agent: "lifecycle-campaign",
    case: fx.case,
    prompt_version: fx.version,
    model: "fixture (regenerate live with an API key)",
    latency_ms: fx.latency_ms,
    input_tokens: null,
    output_tokens: fx.output_tokens,
    tool_calls: 0,
    eval_score: evaluation.score,
    evals_passed: evaluation.passed,
    evals_total: evaluation.total,
    status: evaluation.score >= 0.8 ? "pass" : evaluation.score >= 0.5 ? "warn" : "fail",
  };
  appendFileSync(RUNS_FILE, JSON.stringify(trace) + "\n");
  return {
    case: fx.case,
    prompt_version: fx.version,
    campaign,
    parse_error: parsed.ok ? null : parsed.error,
    raw_excerpt: parsed.ok ? null : fx.raw.slice(0, 400),
    evaluation: { score: evaluation.score, passed: evaluation.passed, total: evaluation.total, checks: evaluation.checks },
    trace,
  };
});

const data = {
  generated_at: new Date().toISOString(),
  model: "fixture sample runs (scored live by the real rubric; regenerate with an API key via npm run build-demo)",
  note: "Sample runs. Campaign outputs are illustrative fixtures, but the parser, eval scores, and traces are computed by the real pipeline. No key ships to the browser.",
  cases: cases.map((c) => ({ id: c.id, brief: c.brief, segment: c.segment })),
  runs,
  fleet: fleetHealth(readTraces()),
};
writeFileSync(join(ROOT, "web", "data.json"), JSON.stringify(data, null, 2));
console.error(`wrote web/data.json: ${runs.length} runs, fleet mean ${(data.fleet.mean_score * 100).toFixed(0)}%`);
