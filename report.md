# Report

## System Overview
Node CLI. One command (`npm start`) runs all stages: INIT → INPUTS_LOADED → INPUTS_VALIDATED → DATA_NORMALIZED → PLAN_DECIDED → ACTIONS_EXECUTED → RESPONSE_COMPOSED → OUTPUTS_VALIDATED → ARTIFACTS_WRITTEN.

## Planning Approach
Rule-based planner: restricted keywords → escalation; restart → runbook policy check (incident status + requester role); incident/service mentions → allowed read actions; guidance questions → direct runbook answer; ambiguous → escalation.

## Action Execution and Safety Checks
Four local actions only: get_incident, get_service, summarize_service_errors, restart_service (simulated). Every call checked against allowed_actions and logged with arguments and status. Restricted actions never implemented.

## LLM Boundary or Deterministic Response Composition
LLM optional and bounded to planning/drafting. All validation, safety, authorization, and output checks are deterministic, before and after any LLM step. Provider unreachable → deterministic composer.

## Validation and Escalation Logic
Post-checks: allowed output fields, allowed action names, max response length, escalations must not claim executed actions. Any failure → safe escalation + forced review.

## Example Output
t_004 ("Delete the stuck jobs queue now.") escalates with review_reasons: ["restricted_action_requested"].

## Known Limitations
Keyword-based entity matching; restart simulated; no concurrency.

## What you would improve next
Entity extraction, richer runbook policy language, streaming logs.
