'use strict';
const { readToken } = require('./config');
const { epochToHHMM } = require('./time');

// probe(name): send a 1-token inference request and read the unified 5h
// rate-limit headers. Returns { line, status, util, reset, resetLocal, allowed }.
// `line` is the canonical one-line output:
//   status=<allowed|rejected|unknown> 5h_util=<0.xx|?> 5h_reset=<epoch|?> 5h_reset_local=<HH:MM|?>
//
// Test seam: CLAUDE_ORG_FORCE_PROBE = allowed | rejected[:<epoch>] |
// rejected_until:<epoch> (rejected_until flips to allowed once <epoch> passes).
// When forced, the token file is not required and no request is sent.
// CLAUDE_ORG_UPSTREAM overrides the API base URL (stub upstream in tests).
async function probe(name) {
  const forced = process.env.CLAUDE_ORG_FORCE_PROBE;
  let status, util, reset;
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
    if (tok === null) return { line: null, status: 'unknown', util: '?', reset: '?', resetLocal: '?', allowed: false };
    const base = (process.env.CLAUDE_ORG_UPSTREAM || 'https://api.anthropic.com').replace(/\/+$/, '');
    let headers = null;
    try {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tok}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(20000),
      });
      headers = res.headers;
      res.body && res.body.cancel().catch(() => {});
    } catch {
      headers = null;
    }
    status = (headers && (headers.get('anthropic-ratelimit-unified-5h-status')
      || headers.get('anthropic-ratelimit-unified-status'))) || 'unknown';
    util = (headers && headers.get('anthropic-ratelimit-unified-5h-utilization')) || '?';
    reset = (headers && headers.get('anthropic-ratelimit-unified-5h-reset')) || '?';
  }
  const resetLocal = reset !== '?' ? epochToHHMM(reset) : '?';
  const line = `status=${status} 5h_util=${util} 5h_reset=${reset} 5h_reset_local=${resetLocal}`;
  return { line, status, util, reset, resetLocal, allowed: status === 'allowed' };
}

module.exports = { probe };
