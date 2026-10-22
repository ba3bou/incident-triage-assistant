// Focused tests for the high-risk logic: escalation, authorization, validation.
const assert = require('assert');
const { planFor } = require('../src/pipeline');

const incidents = [
  { incident_id: 'INC-102', service: 'payments-api', severity: 'medium', status: 'investigating', symptom: 'x', created_at: 't' },
  { incident_id: 'INC-103', service: 'auth-worker', severity: 'high', status: 'identified', symptom: 'y', created_at: 't' },
];
const services = [
  { service: 'payments-api', owner_team: 'payments', error_rate_5m: 1, latency_p95_ms: 1, last_deploy: 't', recent_errors: ['e1'] },
  { service: 'auth-worker', owner_team: 'identity', error_rate_5m: 1, latency_p95_ms: 1, last_deploy: 't', recent_errors: ['e2'] },
];
const runbooks = require('../runbooks.json');

const mk = (request) => ({ task_id: 't_x', request, request_norm: request.toLowerCase(), requester_role: 'engineer' });

// restricted action always escalates
const p1 = planFor(mk('Delete the stuck jobs queue now.'), incidents, services, runbooks);
assert.strictEqual(p1.plan_type, 'escalation');
assert.ok(p1.review_reasons.includes('restricted_action_requested'));

// restart allowed when incident status is in policy
const p2 = planFor(mk('Restart service auth-worker for incident INC-103.'), incidents, services, runbooks);
assert.strictEqual(p2.plan_type, 'action_execution');
assert.deepStrictEqual(p2.proposed_actions, ['restart_service']);

// restart blocked when incident status is not allowed
const p3 = planFor(mk('Restart service payments-api for incident INC-102.'), incidents, services, runbooks);
assert.strictEqual(p3.plan_type, 'escalation');
assert.ok(p3.review_reasons.includes('restart_not_allowed_by_policy'));

// ambiguous request escalates
const p4 = planFor(mk('Can someone look at this weird thing?'), incidents, services, runbooks);
assert.strictEqual(p4.plan_type, 'escalation');
assert.ok(p4.review_reasons.includes('ambiguous_request'));

console.log('4 tests passed');
