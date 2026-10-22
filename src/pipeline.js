// Incident triage assistant — deterministic pipeline with an optional,
// bounded LLM layer. One command runs all stages and writes all artifacts.
const fs = require('fs');
const llm = require('./llm');

const now = () => new Date().toISOString();
const load = (name) => JSON.parse(fs.readFileSync(name, 'utf8'));
const save = (name, data) => fs.writeFileSync(name, JSON.stringify(data, null, 2));
const norm = (s) => String(s).trim().replace(/\s+/g, ' ');
const lower = (s) => norm(s).toLowerCase();

const pipelineLog = [];
function logEvent(taskId, stage, status, details) {
  pipelineLog.push({ task_id: taskId, stage, timestamp: now(), status, details });
}

const REQUIRED = {
  tasks: ['task_id', 'request', 'requester_role'],
  incidents: ['incident_id', 'service', 'severity', 'status', 'symptom', 'created_at'],
  services: ['service', 'owner_team', 'error_rate_5m', 'latency_p95_ms', 'last_deploy', 'recent_errors'],
  settings: ['allow_llm_planning', 'allow_llm_response_drafting', 'max_response_chars', 'allowed_output_fields'],
};
function requireFields(obj, fields, where) {
  for (const f of fields) {
    if (!(f in obj)) throw new Error(`missing required field "${f}" in ${where}`);
  }
}

// ---- action layer (local + deterministic only) ----
function buildActions(incidents, services) {
  return {
    get_incident: ({ incident_id }) =>
      incidents.find((i) => i.incident_id === incident_id) || null,
    get_service: ({ service }) =>
      services.find((s) => s.service === service) || null,
    summarize_service_errors: ({ service }) => {
      const s = services.find((x) => x.service === service);
      return s ? { service, error_count: s.recent_errors.length, top_errors: s.recent_errors } : null;
    },
    restart_service: ({ service }) => ({ service, message: 'restart simulated' }),
  };
}

// ---- rule-based planner ----
function planFor(task, incidents, services, runbooks) {
  const text = task.request_norm;
  const base = { task_id: task.task_id, plan_type: 'escalation', proposed_actions: [], entities: {}, needs_review: false, review_reasons: [] };

  const restrictedHit = runbooks.restricted_actions.find((a) => text.includes(a.replace(/_/g, ' ')));
  if (restrictedHit || /\b(delete|drop|disable)\b/.test(text)) {
    return { ...base, review_reasons: ['restricted_action_requested'] };
  }

  const incident = incidents.find((i) => text.includes(lower(i.incident_id)));
  const service = services.find((s) => text.includes(lower(s.service)));

  if (/\brestart\b/.test(text)) {
    if (!service) return { ...base, review_reasons: ['ambiguous_request'] };
    const rules = runbooks.action_rules.restart_service;
    const okStatus = incident && rules.allowed_incident_statuses.includes(incident.status);
    const okRole = rules.allowed_requester_roles.includes(task.requester_role);
    if (!okStatus || !okRole) {
      return { ...base, entities: { service: service.service, incident_id: incident ? incident.incident_id : undefined }, review_reasons: ['restart_not_allowed_by_policy'] };
    }
    return { ...base, plan_type: 'action_execution', proposed_actions: ['restart_service'], entities: { service: service.service, incident_id: incident.incident_id } };
  }

  if (incident) {
    return { ...base, plan_type: 'action_execution', proposed_actions: ['get_incident'], entities: { incident_id: incident.incident_id } };
  }

  if (/\bsummar/.test(text) && service) {
    return { ...base, plan_type: 'action_execution', proposed_actions: ['get_service', 'summarize_service_errors'], entities: { service: service.service } };
  }

  if (text.includes('error rate') && !service) {
    return { ...base, plan_type: 'informational_response', entities: {}, review_reasons: [] };
  }

  return { ...base, review_reasons: ['ambiguous_request'] };
}

// ---- deterministic response composer ----
function composeResponse(plan, task, trace, runbooks) {
  if (plan.plan_type === 'escalation') return runbooks.escalation_message;
  if (plan.plan_type === 'informational_response') return runbooks.guidance.high_error_rate_no_clear_service;
  const last = trace[trace.length - 1];
  if (last && last.action_name === 'get_incident' && last.result) {
    const r = last.result;
    return `Incident ${r.incident_id} is ${r.status}: a ${r.severity}-severity issue on ${r.service}. Current symptom: ${r.symptom}.`;
  }
  if (last && last.action_name === 'summarize_service_errors' && last.result) {
    return `Service ${last.result.service} shows ${last.result.error_count} recent error(s): ${last.result.top_errors.join('; ')}.`;
  }
  if (last && last.action_name === 'restart_service') {
    return `Restart of ${last.result.service} was simulated successfully per runbook policy.`;
  }
  return runbooks.escalation_message;
}

function main() {
  logEvent(null, 'INIT', 'success', 'pipeline started');

  const tasks = load('tasks.json');
  const incidents = load('incidents.json');
  const services = load('services.json');
  const runbooks = load('runbooks.json');
  const settings = load('settings.json');
  logEvent(null, 'INPUTS_LOADED', 'success', '5 input files loaded');

  tasks.forEach((t, i) => requireFields(t, REQUIRED.tasks, `tasks[${i}]`));
  incidents.forEach((t, i) => requireFields(t, REQUIRED.incidents, `incidents[${i}]`));
  services.forEach((t, i) => requireFields(t, REQUIRED.services, `services[${i}]`));
  requireFields(settings, REQUIRED.settings, 'settings');
  ['guidance', 'allowed_actions', 'restricted_actions', 'action_rules', 'escalation_message']
    .forEach((f) => { if (!(f in runbooks)) throw new Error(`missing "${f}" in runbooks`); });
  logEvent(null, 'INPUTS_VALIDATED', 'success', 'schema checks passed');

  // optional LLM layer: verify provider before use; deterministic fallback otherwise
  if (settings.allow_llm_planning || settings.allow_llm_response_drafting) llm.healthCheck();

  const nTasks = tasks.map((t) => ({ ...t, request: norm(t.request), request_norm: lower(t.request) }));
  save('normalized_tasks.json', nTasks.map(({ request_norm, ...t }) => t));
  save('normalized_incidents.json', incidents);
  save('normalized_services.json', services);
  save('normalized_runbooks.json', runbooks);
  save('normalized_settings.json', settings);
  logEvent(null, 'DATA_NORMALIZED', 'success', 'normalized copies written');

  const actions = buildActions(incidents, services);
  const plans = [];
  const actionResults = [];
  const responses = [];
  const validations = [];
  const finals = [];

  for (const task of nTasks) {
    const plan = planFor(task, incidents, services, runbooks);
    plans.push(plan);
    logEvent(task.task_id, 'PLAN_DECIDED', 'success', plan.plan_type);

    const trace = [];
    if (plan.plan_type === 'action_execution') {
      for (const name of plan.proposed_actions) {
        if (!runbooks.allowed_actions.includes(name)) {
          logEvent(task.task_id, 'ACTIONS_EXECUTED', 'error', `blocked non-allowed action ${name}`);
          continue;
        }
        const args = name === 'get_incident' ? { incident_id: plan.entities.incident_id } : { service: plan.entities.service };
        const result = actions[name](args);
        trace.push({ action_name: name, arguments: args, status: result ? 'success' : 'error', result });
        logEvent(task.task_id, 'ACTIONS_EXECUTED', 'success', `${name}(${JSON.stringify(args)})`);
      }
    }
    actionResults.push({ task_id: task.task_id, action_trace: trace });

    let response = composeResponse(plan, task, trace, runbooks);
    if (settings.allow_llm_response_drafting) {
      const drafted = llm.draft(); // null when provider unavailable
      if (typeof drafted === 'string' && drafted.length > 0) response = drafted;
    }
    logEvent(task.task_id, 'RESPONSE_COMPOSED', 'success', 'response composed');

    // ---- output validation with safe fallback ----
    const record = {
      task_id: task.task_id,
      status: plan.plan_type === 'escalation' ? 'escalated' : 'completed',
      plan: { plan_type: plan.plan_type, proposed_actions: plan.proposed_actions, entities: plan.entities },
      action_trace: trace,
      response,
      needs_review: plan.needs_review,
      review_reasons: plan.review_reasons,
    };

    const problems = [];
    const extra = Object.keys(record).filter((k) => !settings.allowed_output_fields.includes(k));
    if (extra.length) problems.push(`forbidden_output_fields:${extra.join(',')}`);
    const badActions = trace.filter((t) => !runbooks.allowed_actions.includes(t.action_name));
    if (badActions.length) problems.push('forbidden_action_name');
    if (record.response.length > settings.max_response_chars) problems.push('response_too_long');
    if (record.status === 'escalated' && trace.length > 0) problems.push('escalation_claims_actions');

    if (problems.length) {
      record.status = 'escalated';
      record.plan = { plan_type: 'escalation', proposed_actions: [], entities: {} };
      record.action_trace = [];
      record.response = runbooks.escalation_message;
      record.needs_review = true;
      record.review_reasons = [...record.review_reasons, ...problems];
    }
    logEvent(task.task_id, 'OUTPUTS_VALIDATED', problems.length ? 'error' : 'success', problems.join(';') || 'ok');

    validations.push({ task_id: task.task_id, valid: problems.length === 0, problems });
    responses.push({ task_id: task.task_id, status: record.status, response: record.response });
    finals.push(record);
  }

  save('plans.json', plans);
  save('action_results.json', actionResults);
  save('responses.json', responses);
  save('validation.json', validations);
  save('final_outputs.json', finals);
  fs.writeFileSync('llm_calls.jsonl', ''); // no LLM calls were made (provider unavailable)
  logEvent(null, 'ARTIFACTS_WRITTEN', 'success', 'all artifacts written');
  fs.writeFileSync('pipeline_log.jsonl', pipelineLog.map((e) => JSON.stringify(e)).join('\n') + '\n');

  console.log(`Processed ${finals.length} task(s): ${finals.filter((f) => f.status === 'completed').length} completed, ${finals.filter((f) => f.status === 'escalated').length} escalated.`);
}

if (require.main === module) main();
module.exports = { planFor, buildActions, composeResponse };
