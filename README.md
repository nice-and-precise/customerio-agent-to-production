# Agent-to-Production Kit

Taking a scrappy GTM agent CLI to production-grade: an eval on every run, a prompt
you can harden and **measure**, and a trace for everything.

Built by Jordan Damhof for the Customer.io **GTM AI Engineer** role.
Live dashboard: *(deploy URL)* · Code: this repo.

> **What this is and isn't.** An illustrative prototype, not Customer.io data or
> systems. The example agent is mine. The sample campaign outputs in `web/data.json`
> are fixtures so the demo runs without an API key. Everything around them, the
> provider-agnostic agent, the JSON parser, the eval rubric, and the tracer, is
> real, runnable code. `npm run evals` scores the samples live. Point an API key at
> `npm run build-demo` and it regenerates the runs against a real model.

## Why this exists

From the job post, in Nick's words:

> "Over the last 3.5 months, our GTM AI team has built 11 agents now running in
> production, serving 120 active users and roughly 25,000 tool calls a day, all
> through custom CLIs that work, but weren't built to scale."

That is the exact gap this kit demonstrates against: an agent that works, wrapped
in the layer that makes a fleet dependable. The example agent turns a launch brief
plus a behavioral segment into a Customer.io-style lifecycle campaign. The
interesting part is not the agent, it's what surrounds it.

## Quickstart

```bash
node evals/run_evals.mjs        # score the sample runs with the real rubric (no key needed)
node agent/lifecycle_agent.mjs --case trial_no_activation --version v2_hardened   # needs a key
OPENAI_API_KEY=...  node scripts/build_demo_data.mjs    # regenerate all runs live
# or ANTHROPIC_API_KEY=... to run on Claude, which is the primary target
```

Open `web/index.html` (via any static server) for the dashboard.

## What the eval report shows

The scrappy prompt (`v1`) and the hardened prompt (`v2_hardened`) run the same three
cases. The rubric catches the classic scrappy-agent failures in v1, a PII address
in body copy, delays that run backwards in time, no exit criteria, over-messaging,
and confirms the hardened prompt closes them:

```
v1           mean 62% across 3 runs
v2_hardened  mean 100% across 3 runs
prompt hardening lift: 62% -> 100%  (+38 pts)
```

## How it maps to the role

| The role owns | Where it lives here |
| --- | --- |
| Take agents from working v1 to production-ready | `agent/prompts/v1.md` vs `v2_hardened.md`, measured by the rubric |
| Write evals, harden prompts and tool definitions | `evals/rubric.mjs` (10 weighted checks), `evals/run_evals.mjs` (CI gate) |
| Instrument tracing, logging, monitoring across the fleet | `observability/trace.mjs` (JSONL per run + `fleetHealth` rollup) |
| Deployment and release hygiene | static dashboard + `npm run build-demo`, no key ever ships to the browser |
| Comfort in the terminal with a real PR-and-deploy workflow | it's a CLI; runs, evals, and traces are all terminal-first |

## Layout

```
agent/            provider-agnostic agent + versioned prompts
evals/            rubric (pure, deterministic), report/CI gate, test cases
observability/    JSONL tracer + fleet-health rollup
scripts/          regenerate demo data (live, or from fixtures)
web/              single-file dashboard (no framework, no build step)
```

## About the fit, honestly

I build and ship AI agents Claude-natively and live in the terminal. I have
taken multi-agent systems from prototype to deployed (see
[github.com/nice-and-precise](https://github.com/nice-and-precise)). The honest
ramp for me is GCP and Kubernetes specifically; my production work has been on
Vercel and other cloud, and the patterns carry. This kit is me showing the work
rather than describing it.

Jordan Damhof · 320-212-2042 · jordandamhof@gmail.com · west-central Minnesota
