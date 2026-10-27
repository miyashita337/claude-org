'use strict';
const { readToken } = require('./config');
const { epochToHHMM } = require('./time');

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// With an OAuth token the API refused Opus with a header-less 429
// rate_limit_error when the request had no system prompt, and served it with
// this one, which Claude Code itself sends (2026-10-26, team and max, #40).
const SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

// Whether the org served the probed model. The 5h window is shared by every
// model, but a model can still be refused while it reads "allowed" (it needs
// usage credits, or its own weekly allowance is used up), so this is judged
// from the HTTP status, not from the window headers.
//   available    2xx
//   unavailable  any other 4xx, while neither the 5h nor the 7d window is
//                rejected
//   unknown      no response, 401/403 (token or org permission), 408, 5xx, or
//                a rejected window (which hides whether the model itself
//                would be served)
function judgeModel(res) {
  if (!res) return 'unknown';
  if (res.ok) return 'available';
  const h = name => res.headers.get(`anthropic-ratelimit-unified-${name}`);
  if (h('5h-status') === 'rejected' || h('7d-status') === 'rejected') return 'unknown';
  if ([401, 403, 408].includes(res.status) || res.status >= 500 || res.status < 400) return 'unknown';
  return 'unavailable';
}

// One 1-token request. Returns { res, errorType }: res is null when no response
// came; errorType is error.type of a non-2xx JSON body ('' otherwise).
async function send(tok, model) {
  const base = (process.env.CLAUDE_ORG_UPSTREAM || 'https://api.anthropic.com').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, max_tokens: 1, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(20000),
    });
    let errorType = '';
    if (res.ok) {
      res.body && res.body.cancel().catch(() => {});
    } else {
      try {
        errorType = String(JSON.parse(await res.text()).error.type || '').replace(/[^\w.-]/g, '_').slice(0, 60);
      } catch {
        errorType = ''; // not a JSON error body: the HTTP status still decides model_status
      }
    }
    return { res, errorType };
  } catch {
    return { res: null, errorType: '' };
  }
}

// probe(name, model): send a 1-token inference request and read the unified
// 5h rate-limit headers. Returns { line, status, util, reset, resetLocal,
// allowed, model, modelStatus, usable }. `line` is the canonical one-line output:
//   status=<allowed|rejected|unknown> 5h_util=<0.xx|?> 5h_reset=<epoch|?> 5h_reset_local=<HH:MM|?>
// When a model is given (argument, else CLAUDE_ORG_PROBE_MODEL), the request
// uses it and the line ends with ` model=<id> model_status=<see judgeModel>`,
// plus ` model_error=<error.type>` when the model was refused.
// Without one the request uses Haiku and the line is unchanged. `usable` is
// "allowed and the model was not refused".
//
// Test seam: CLAUDE_ORG_FORCE_PROBE = allowed | rejected[:<epoch>] |
// rejected_until:<epoch> (rejected_until flips to allowed once <epoch> passes).
// When forced, the token file is not required and no request is sent.
// CLAUDE_ORG_UPSTREAM overrides the API base URL (stub upstream in tests).
async function probe(name, model = process.env.CLAUDE_ORG_PROBE_MODEL || '') {
  const forced = process.env.CLAUDE_ORG_FORCE_PROBE;
  let status, util, reset;
  let modelStatus = 'unknown';
  let modelError = '';
  if (forced) {
    const idx = forced.indexOf(':');
    status = idx === -1 ? forced : forced.slice(0, idx);
    reset = idx === -1 ? '?' : forced.slice(idx + 1);
    if (status === 'rejected_until') {
      status = Math.floor(Date.now() / 1000) >= Number(reset) ? 'allowed' : 'rejected';
    }
    util = '?';
  } else {
    const tok = readToken(name);
    if (tok === null) {
      return { line: null, status: 'unknown', util: '?', reset: '?', resetLocal: '?', allowed: false, model, modelStatus, usable: false };
    }
    const first = await send(tok, model || DEFAULT_MODEL);
    let headers = first.res && first.res.headers;
    modelStatus = judgeModel(first.res);
    if (modelStatus === 'unavailable') modelError = first.errorType;
    // A refusal for the model itself carried no window headers on 2026-10-10
    // (Fable 5.1 on an org without usage credits), so the 5h state is read
    // from a second request with the default model.
    if (model && modelStatus === 'unavailable' && !headers.get('anthropic-ratelimit-unified-5h-status')) {
      const second = await send(tok, DEFAULT_MODEL);
      headers = second.res && second.res.headers;
      // A rejected window there means the first 429 may have been the window,
      // not the model, so the model cannot be judged.
      const w = name => headers && headers.get(`anthropic-ratelimit-unified-${name}`);
      if (w('5h-status') === 'rejected' || w('7d-status') === 'rejected') {
        modelStatus = 'unknown';
        modelError = '';
      }
    }
    status = (headers && (headers.get('anthropic-ratelimit-unified-5h-status')
      || headers.get('anthropic-ratelimit-unified-status'))) || 'unknown';
    util = (headers && headers.get('anthropic-ratelimit-unified-5h-utilization')) || '?';
    reset = (headers && headers.get('anthropic-ratelimit-unified-5h-reset')) || '?';
  }
  const resetLocal = reset !== '?' ? epochToHHMM(reset) : '?';
  let line = `status=${status} 5h_util=${util} 5h_reset=${reset} 5h_reset_local=${resetLocal}`;
  // The model is user input; keep the key=value line parseable.
  if (model) line += ` model=${model.replace(/[^\w.:@/-]/g, '_')} model_status=${modelStatus}${modelError ? ` model_error=${modelError}` : ''}`;
  const allowed = status === 'allowed';
  const usable = allowed && !(model && modelStatus === 'unavailable');
  return { line, status, util, reset, resetLocal, allowed, model, modelStatus, usable };
}

module.exports = { probe };
