/**
 * rubric.mjs
 *
 * A deterministic eval suite for the lifecycle-campaign agent. Every check is a
 * pure function of the campaign object, so a run is scored the same way in the
 * CLI, in CI, and on the dashboard. This is the layer that turns "the agent
 * usually works" into "the agent is measured on every run."
 *
 * Each check returns { id, ok, weight, detail }. The score is the weighted pass
 * rate. Weights encode what actually hurts in production: a schema break or a
 * PII leak matters more than a soft length preference.
 */

const CHANNELS = new Set(["email", "push", "in_app", "sms"]);
const TRIGGER_TYPES = new Set(["event", "attribute", "time_delay"]);
// crude but effective PII sniff: literal emails / phone numbers in body copy
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

function nonEmpty(s) {
  return typeof s === "string" && s.trim().length > 0;
}

export function checks(campaign, parseError) {
  // If the model output did not parse, that is the whole story: everything fails.
  if (!campaign) {
    return [
      { id: "schema_valid", ok: false, weight: 3, detail: parseError || "no campaign object" },
    ];
  }
  const msgs = Array.isArray(campaign.messages) ? campaign.messages : [];

  const out = [];
  const add = (id, ok, weight, detail) => out.push({ id, ok: !!ok, weight, detail });

  // 1. structural integrity
  add(
    "schema_valid",
    nonEmpty(campaign.campaign_name) && msgs.length > 0 && !!campaign.target_segment,
    3,
    msgs.length ? `${msgs.length} messages` : "no messages array"
  );

  // 2. every message routes somewhere valid
  const badChannel = msgs.find((m) => !CHANNELS.has(m.channel));
  add("channels_valid", msgs.length > 0 && !badChannel, 2, badChannel ? `bad channel: ${badChannel.channel}` : "all channels valid");

  // 3. every message has a concrete trigger
  const noTrigger = msgs.find((m) => !m.trigger || !TRIGGER_TYPES.has(m.trigger.type) || !nonEmpty(m.trigger.value));
  add("each_message_has_trigger", msgs.length > 0 && !noTrigger, 2, noTrigger ? `step ${noTrigger.step ?? "?"} missing trigger` : "all messages triggered");

  // 4. every message drives an action
  const noCta = msgs.find((m) => !nonEmpty(m.primary_cta));
  add("each_message_has_cta", msgs.length > 0 && !noCta, 2, noCta ? `step ${noCta.step ?? "?"} missing CTA` : "all messages have a CTA");

  // 5. the sequence moves forward in time (a classic scrappy-agent failure)
  let monotonic = true;
  let last = -Infinity;
  for (const m of msgs) {
    const h = Number(m.delay_hours);
    if (!Number.isFinite(h) || h < last) { monotonic = false; break; }
    last = h;
  }
  add("timing_monotonic", msgs.length > 0 && monotonic, 2, monotonic ? "delays non-decreasing" : "delay_hours goes backwards or is non-numeric");

  // 6. targeting is grounded in behavior, not a static dump
  add("segment_behavioral", nonEmpty(campaign.target_segment?.behavioral_filter), 2, campaign.target_segment?.behavioral_filter ? "behavioral filter present" : "no behavioral filter");

  // 7. brand/compliance: no raw PII in body copy
  const pii = msgs.find((m) => EMAIL_RE.test(m.body_outline || "") || PHONE_RE.test(m.body_outline || ""));
  add("no_pii_in_body", !pii, 3, pii ? `PII-like string in step ${pii.step ?? "?"}` : "no literal PII in bodies");

  // 8. people can leave (prevents over-messaging incidents)
  add("has_exit_criteria", nonEmpty(campaign.exit_criteria), 2, campaign.exit_criteria ? "exit criteria set" : "no exit criteria");

  // 9. real guardrails (frequency caps, quiet hours, suppression)
  add("guardrails_present", Array.isArray(campaign.guardrails) && campaign.guardrails.length >= 2, 1, `${campaign.guardrails?.length ?? 0} guardrails`);

  // 10. quality over volume
  add("reasonable_length", msgs.length >= 3 && msgs.length <= 6, 1, `${msgs.length} messages (want 3-6)`);

  return out;
}

export function scoreCampaign(campaign, parseError) {
  const c = checks(campaign, parseError);
  const total = c.reduce((s, x) => s + x.weight, 0);
  const earned = c.reduce((s, x) => s + (x.ok ? x.weight : 0), 0);
  return {
    score: total ? earned / total : 0,
    passed: c.filter((x) => x.ok).length,
    total: c.length,
    weighted_earned: earned,
    weighted_total: total,
    checks: c,
  };
}
