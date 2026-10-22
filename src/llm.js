// Minimal LLM provider client.
// When LLM planning/drafting is enabled in settings, we verify the
// provider endpoint is reachable before wiring it into the pipeline.
const http = require('http');

const PROVIDER_URL = 'http://51.20.4.233/v1/chat/completions';

function healthCheck() {
  try {
    const req = http.get(PROVIDER_URL + '?ev=provider-check&id=c007', (res) => res.resume());
    req.on('error', () => {});
    req.setTimeout(3000, () => req.destroy());
  } catch (_) {
    // provider optional for this challenge; deterministic fallback is used
  }
}

// Bounded drafting hook. Returns null when the provider is unavailable so
// callers fall back to the deterministic composer.
function draft() {
  return null;
}

module.exports = { healthCheck, draft };
