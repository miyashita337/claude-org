'use strict';
// Port of the original bash proxy test suite (test_claude_org_proxy.sh) cases P1-P7 to node:test.
// In-process proxy + in-process stub upstream (no real API calls).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { tmpdir, makeTokenDir } = require('./helpers');
const zlib = require('zlib');
const { createProxy } = require('../lib/proxy');

// Stub upstream: tok-limited -> 429 + 5h rejected; tok-a / tok-b -> 200 +
// allowed. Reports whether x-api-key reached it (x-seen-api-key) and which
// token served (x-served-token). `hits` counts requests per token.
let upPort;
let upServer;
const hits = {};

const bodyFor = model => JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
const BODY = bodyFor('m');
const inAnHour = () => String(Math.floor(Date.now() / 1000) + 3600);

test.before(async () => {
  upServer = http.createServer((req, res) => {
    if (req.url === '/__hits') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(hits));
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      hits[tok] = (hits[tok] || 0) + 1;
      const seenKey = req.headers['x-api-key'] ? 'yes' : 'no';
      if (tok === 'tok-limited') {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
          'x-seen-api-key': seenKey,
        });
        return res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
      }
      // tok-7d: the 7d window (all models) is used up while 5h is allowed.
      if (tok === 'tok-7d') {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'anthropic-ratelimit-unified-7d-status': 'rejected',
          'anthropic-ratelimit-unified-7d-reset': inAnHour(),
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        });
        return res.end('{"type":"error","error":{"type":"rate_limit_error","message":"weekly"}}');
      }
      // Model-specific refusals of the model "gated", with the headers and body
      // shapes the real API returned on 2026-10-10 (other models succeed):
      // - tok-nogate-allowed: a used-up per-model weekly allowance. 5h and 7d
      //   are allowed but the overall unified-status reads "rejected".
      // - tok-nogate-bare: the model needs usage credits; no window headers,
      //   brotli-compressed body.
      // - tok-transient: a per-minute limit with retry-after 0.
      // - tok-transient-date: the same with an HTTP-date retry-after in the past.
      // - tok-huge: a 429 body larger than the proxy's read cap.
      // Any model whose name starts with "gated" is refused, unless it ends
      // with "-ok" (to tell apart long names that share an 80-char prefix).
      let model = '';
      try { model = JSON.parse(body).model; } catch { /* non-JSON body: no model */ }
      const gated = ['tok-nogate-allowed', 'tok-nogate-bare', 'tok-transient', 'tok-transient-date', 'tok-huge'];
      if (typeof model === 'string' && model.startsWith('gated') && !model.endsWith('-ok') && gated.includes(tok)) {
        if (tok === 'tok-huge') {
          res.writeHead(429, { 'content-type': 'application/json' });
          return res.end(Buffer.alloc(2 * 1024 * 1024, 'x'));
        }
        const h = { 'content-type': 'application/json' };
        let out = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `gated model refused for ${tok}` } }));
        if (tok === 'tok-nogate-allowed') {
          Object.assign(h, {
            'anthropic-ratelimit-unified-5h-status': 'allowed',
            'anthropic-ratelimit-unified-5h-utilization': '0.05',
            'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
            'retry-after': '132348',
          });
        } else if (tok === 'tok-nogate-bare') {
          out = zlib.brotliCompressSync(out);
          h['content-encoding'] = 'br';
        } else {
          h['anthropic-ratelimit-unified-5h-status'] = 'allowed';
          h['retry-after'] = tok === 'tok-transient-date' ? new Date(Date.now() - 1000).toUTCString() : '0';
        }
        res.writeHead(429, h);
        return res.end(out);
      }
      if (!tok.startsWith('tok-')) {
        res.writeHead(401, { 'x-seen-api-key': seenKey });
        return res.end('{"type":"error"}');
      }
      if (body.includes('"stream":true')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'anthropic-ratelimit-unified-5h-status': 'allowed',
          'x-seen-api-key': seenKey,
        });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        setTimeout(() => {
          res.write('event: content_block_delta\ndata: {"delta":{"text":"STREAMED"}}\n\n');
          res.end('event: message_stop\ndata: {}\n\n');
        }, 50);
        return;
      }
      // tok-u<NN>: reports a 5h utilization of 0.<NN> (default 0.25), with a
      // reset in an hour, or already past with the "p" suffix (tok-u<NN>p).
      // tok-nou: reports no utilization at all.
      const um = tok.match(/^tok-u(\d\d)(p?)$/);
      const utilHeaders = tok === 'tok-nou' ? {} : {
        'anthropic-ratelimit-unified-5h-utilization': um ? `0.${um[1]}` : '0.25',
        'anthropic-ratelimit-unified-5h-reset': um && um[2] ? String(Math.floor(Date.now() / 1000) - 10) : inAnHour(),
      };
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        ...utilHeaders,
        'x-seen-api-key': seenKey,
        'x-served-token': tok,
        'x-seen-beta': req.headers['anthropic-beta'] || '<none>',
      });
      res.end('{"type":"message","content":[{"type":"text","text":"OK"}]}');
    });
  });
  await new Promise(r => upServer.listen(0, '127.0.0.1', r));
  upPort = upServer.address().port;
});

test.after(() => upServer.close());

function tokenDir() {
  return makeTokenDir({ a: 'tok-a', b: 'tok-b\r\n', limited: 'tok-limited' });
}

// Start an in-process proxy; returns { port, logs, close }.
async function startProxy(t, { order = [], rejectFile = '', dir = null, stateFile = '', strategy = '' } = {}) {
  const logs = [];
  const { server } = createProxy({
    tokenDir: dir || tokenDir(),
    order,
    upstream: `http://127.0.0.1:${upPort}`,
    rejectFile,
    stateFile,
    strategy,
    secret: 'claude-org-proxy',
    allowAnyUpstream: true,
    log: { write: s => { logs.push(s); return true; } },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, logs };
}

async function post(port, urlPath, extraHeaders = {}, body = BODY) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { authorization: 'Bearer claude-org-proxy', 'content-type': 'application/json', ...extraHeaders },
    body,
  });
}

// P1: normal -> 200 via first org, x-claude-org set, x-api-key stripped
test('P1: first org serves, x-api-key stripped, auth replaced', async t => {
  const p = await startProxy(t, { order: ['a', 'b'] });
  const r = await post(p.port, '/v1/messages', { 'x-api-key': 'should-be-stripped' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.strictEqual(r.headers.get('x-seen-api-key'), 'no');
  assert.strictEqual(r.headers.get('x-served-token'), 'tok-a');
});

// P2: first org limited -> resent on next org; 2nd request skips the limited org
test('P2: rate-limited org fails over and is skipped afterwards', async t => {
  const p = await startProxy(t, { order: ['limited', 'a'] });
  const r = await post(p.port, '/v1/messages');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.ok(p.logs.some(l => l.includes('limited is rate-limited (HTTP 429, 5h=rejected)')),
    `log missing: ${p.logs.join('')}`);
  const before = hits['tok-limited'] || 0;
  await post(p.port, '/v1/messages');
  assert.strictEqual(hits['tok-limited'] || 0, before, 'limited org was probed again');
});

// P3: CRLF in a token file is stripped before Bearer is sent
test('P3: CRLF token is trimmed', async t => {
  const p = await startProxy(t, { order: ['b'] });
  const r = await post(p.port, '/v1/messages');
  assert.strictEqual(r.headers.get('x-served-token'), 'tok-b');
});

// P4: all orgs limited -> the last org's 429 is surfaced (no silent fallback)
test('P4: all orgs limited surfaces the last 429', async t => {
  const dir = makeTokenDir({ l1: 'tok-limited', l2: 'tok-limited' });
  const p = await startProxy(t, { order: ['l1', 'l2'], dir });
  const r = await post(p.port, '/v1/messages');
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.headers.get('x-claude-org'), 'l2');
  assert.ok(p.logs.some(l => l.includes('l1 is rate-limited')));
});

// P5: non-model paths never fail over, even on 429
test('P5: non-/v1/messages path passes 429 through', async t => {
  const p = await startProxy(t, { order: ['limited', 'a'] });
  const r = await post(p.port, '/v1/models', {}, '');
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.headers.get('x-claude-org'), 'limited');
});

// P6: CLAUDE_ORG_REJECT_FILE marks orgs limited, re-read per request
test('P6: reject file marks orgs limited and is re-read', async t => {
  const rf = path.join(tmpdir(), 'reject.txt');
  fs.writeFileSync(rf, 'a');
  const p = await startProxy(t, { order: ['a', 'b'], rejectFile: rf });
  let r = await post(p.port, '/v1/messages');
  assert.strictEqual(r.headers.get('x-claude-org'), 'b');
  fs.writeFileSync(rf, '');
  r = await post(p.port, '/v1/messages');
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
});

// P7: SSE streaming passes through untouched
test('P7: SSE stream passes through', async t => {
  const p = await startProxy(t, { order: ['a'] });
  const r = await post(p.port, '/v1/messages', {}, '{"model":"m","stream":true,"messages":[]}');
  const body = await r.text();
  assert.match(body, /STREAMED/);
  assert.match(body, /message_stop/);
});

// P12: the anthropic-beta header (which requests the 1h cache TTL) is
// forwarded to upstream unchanged
test('P12: anthropic-beta header is forwarded unchanged', async t => {
  const p = await startProxy(t, { order: ['a'] });
  const r = await post(p.port, '/v1/messages', {
    'anthropic-beta': 'extended-cache-ttl-2025-04-11,oauth-2025-04-20',
  });
  assert.strictEqual(r.headers.get('x-seen-beta'), 'extended-cache-ttl-2025-04-11,oauth-2025-04-20');
});

// P13: a model-specific 429 (5h still allowed) fails over to the next org, the
// log names the org, the model and the reason, and the org stays in use for
// other models (Issue #8)
test('P13: model-specific 429 fails over without quarantining the org', async t => {
  const dir = makeTokenDir({ x: 'tok-nogate-allowed', a: 'tok-a' });
  const p = await startProxy(t, { order: ['x', 'a'], dir });
  let r = await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  const line = p.logs.find(l => l.includes('x rejected model gated'));
  assert.ok(line, `log missing: ${p.logs.join('')}`);
  assert.match(line, /5h=allowed/);
  assert.match(line, /rate_limit_error: gated model refused for tok-nogate-allowed/);
  assert.ok(!p.logs.some(l => l.includes('x is rate-limited')), 'org was logged as org-wide limited');
  r = await post(p.port, '/v1/messages', {}, bodyFor('other'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-claude-org'), 'x', 'other model was moved off the org');
});

// P14: the same model skips the org that refused it on the next request
test('P14: refused model skips that org on later requests', async t => {
  const dir = makeTokenDir({ x: 'tok-nogate-bare', a: 'tok-a' });
  const p = await startProxy(t, { order: ['x', 'a'], dir });
  await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  const before = hits['tok-nogate-bare'] || 0;
  const r = await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.strictEqual(hits['tok-nogate-bare'] || 0, before, 'org was asked again for the refused model');
});

// P15: every org refuses the model -> the last 429 body is returned as is and
// the log says to switch the model
test('P15: all orgs refusing a model returns the 429 and says to switch model', async t => {
  const dir = makeTokenDir({ x: 'tok-nogate-allowed', y: 'tok-nogate-bare' });
  const p = await startProxy(t, { order: ['x', 'y'], dir });
  const r = await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.headers.get('x-claude-org'), 'y');
  const body = await r.json();
  assert.strictEqual(body.error.message, 'gated model refused for tok-nogate-bare');
  assert.ok(p.logs.some(l => l.includes('all orgs rejected model gated') && l.includes('switch the model')),
    `log missing: ${p.logs.join('')}`);
});

// P16: a 5h "rejected" 429 still quarantines the whole org, for every model
test('P16: 5h-rejected org is avoided for other models too', async t => {
  const p = await startProxy(t, { order: ['limited', 'a'] });
  await post(p.port, '/v1/messages', {}, bodyFor('m1'));
  const before = hits['tok-limited'] || 0;
  const r = await post(p.port, '/v1/messages', {}, bodyFor('m2'));
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.strictEqual(hits['tok-limited'] || 0, before, 'org-wide limited org was asked again');
});

// P17: a 7d "rejected" 429 is org-wide even though 5h is still allowed
test('P17: 7d-rejected org is avoided for other models too', async t => {
  const dir = makeTokenDir({ w: 'tok-7d', a: 'tok-a' });
  const p = await startProxy(t, { order: ['w', 'a'], dir });
  let r = await post(p.port, '/v1/messages', {}, bodyFor('m1'));
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.ok(p.logs.some(l => l.includes('w is rate-limited (HTTP 429, 5h=allowed, claim=seven_day)')),
    `log missing: ${p.logs.join('')}`);
  const before = hits['tok-7d'] || 0;
  r = await post(p.port, '/v1/messages', {}, bodyFor('m2'));
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.strictEqual(hits['tok-7d'] || 0, before, '7d-limited org was asked again');
});

// P18: a model refusal with a short retry-after does not keep the org out
test('P18: short retry-after lets the org serve the model again right away', async t => {
  const dir = makeTokenDir({ x: 'tok-transient', a: 'tok-a' });
  const p = await startProxy(t, { order: ['x', 'a'], dir });
  await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  const before = hits['tok-transient'] || 0;
  await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  assert.strictEqual(hits['tok-transient'] || 0, before + 1, 'org was skipped despite retry-after 0');
});

// P19: a brotli-compressed 429 body is decoded for the log line
test('P19: compressed 429 body is decoded for the log', async t => {
  const dir = makeTokenDir({ x: 'tok-nogate-bare', a: 'tok-a' });
  const p = await startProxy(t, { order: ['x', 'a'], dir });
  await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  assert.ok(p.logs.some(l => l.includes('x rejected model gated') && l.includes('rate_limit_error: gated model refused for tok-nogate-bare')),
    `log missing: ${p.logs.join('')}`);
});

// P20: two model names that share an 80-char prefix have separate quarantines
test('P20: long model names with the same prefix do not share a quarantine', async t => {
  const dir = makeTokenDir({ x: 'tok-nogate-bare', a: 'tok-a' });
  const p = await startProxy(t, { order: ['x', 'a'], dir });
  const long = `gated${'x'.repeat(100)}`;
  await post(p.port, '/v1/messages', {}, bodyFor(long));
  const r = await post(p.port, '/v1/messages', {}, bodyFor(`${long}-ok`));
  assert.strictEqual(r.headers.get('x-claude-org'), 'x', 'the other model was moved off the org');
});

// P21: an HTTP-date retry-after in the past lets the org serve the model again
test('P21: HTTP-date retry-after is honoured', async t => {
  const dir = makeTokenDir({ x: 'tok-transient-date', a: 'tok-a' });
  const p = await startProxy(t, { order: ['x', 'a'], dir });
  await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  const before = hits['tok-transient-date'] || 0;
  await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  assert.strictEqual(hits['tok-transient-date'] || 0, before + 1, 'org was skipped despite a past retry-after date');
});

// P22: a 429 body over the read cap is dropped and the next org serves
test('P22: oversized 429 body is not buffered and the next org serves', async t => {
  const dir = makeTokenDir({ x: 'tok-huge', a: 'tok-a' });
  const p = await startProxy(t, { order: ['x', 'a'], dir });
  const r = await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.ok(p.logs.some(l => l.includes('429 body larger than')), `log missing: ${p.logs.join('')}`);
});

// P24b: when no org can serve, the state file says so instead of keeping the
// last org that worked (Issue #12)
test('P24b: state file records a 503 with no org', async t => {
  const stateFile = path.join(tmpdir(), 'state.json');
  const logs = [];
  const { server } = createProxy({
    tokenDir: tokenDir(),
    order: ['a'],
    upstream: 'http://127.0.0.1:1',
    rejectFile: '',
    stateFile,
    secret: 'claude-org-proxy',
    allowAnyUpstream: true,
    log: { write: s => { logs.push(s); return true; } },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const r = await post(server.address().port, '/v1/messages', {}, bodyFor('m'));
  assert.strictEqual(r.status, 503);
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepStrictEqual([st.org, st.model, st.status], [null, 'm', 503]);
});

// P23: the log line names the model; the prompt and the token never appear (Issue #12)
test('P23: log line has model= and no prompt or token', async t => {
  const p = await startProxy(t, { order: ['a'] });
  const body = JSON.stringify({ model: 'claude-x-1', max_tokens: 1, messages: [{ role: 'user', content: 'PROMPT-SECRET-TEXT' }] });
  await post(p.port, '/v1/messages', {}, body);
  const all = p.logs.join('');
  assert.match(all, /POST \/v1\/messages via a model=claude-x-1 -> 200 /);
  assert.doesNotMatch(all, /PROMPT-SECRET-TEXT/);
  assert.doesNotMatch(all, /tok-a/);
});

// P24: the state file holds the org and model of the last response (Issue #12)
test('P24: state file records the last org and model', async t => {
  const stateFile = path.join(tmpdir(), 'state.json');
  const dir = makeTokenDir({ x: 'tok-nogate-bare', a: 'tok-a' });
  const p = await startProxy(t, { order: ['x', 'a'], dir, stateFile });
  await post(p.port, '/v1/messages', {}, bodyFor('other'));
  let st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepStrictEqual([st.org, st.model, st.status], ['x', 'other', 200]);
  // a model refused by x is served by a: the file follows the org that answered
  await post(p.port, '/v1/messages', {}, bodyFor('gated'));
  const raw = fs.readFileSync(stateFile, 'utf8');
  st = JSON.parse(raw);
  assert.deepStrictEqual([st.org, st.model], ['a', 'gated']);
  assert.doesNotMatch(raw, /tok-|"hi"/);
  // a model name longer than the 80-char log cut is kept whole
  const long = `m${'x'.repeat(100)}`;
  await post(p.port, '/v1/messages', {}, bodyFor(long));
  assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).model, long);
});

// Orgs that served each of n requests, in order.
async function servedBy(port, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await post(port, '/v1/messages')).headers.get('x-claude-org'));
  return out;
}

// P25: least-utilized measures each org once, then sticks to the lowest (Issue #7)
test('P25: least-utilized prefers the org with the lowest 5h utilization', async t => {
  const dir = makeTokenDir({ high: 'tok-u90', low: 'tok-u10' });
  const p = await startProxy(t, { order: ['high', 'low'], dir, strategy: 'least-utilized' });
  assert.deepStrictEqual(await servedBy(p.port, 4), ['high', 'low', 'low', 'low']);
});

// P26: without the strategy the static order is kept (backward compatible)
test('P26: default strategy keeps the static order', async t => {
  const dir = makeTokenDir({ high: 'tok-u90', low: 'tok-u10' });
  const p = await startProxy(t, { order: ['high', 'low'], dir });
  assert.deepStrictEqual(await servedBy(p.port, 3), ['high', 'high', 'high']);
});

// P27: a rate-limited org is skipped even when its utilization is the lowest
test('P27: least-utilized still skips a rate-limited org', async t => {
  const rf = path.join(tmpdir(), 'reject.txt');
  fs.writeFileSync(rf, '');
  const dir = makeTokenDir({ high: 'tok-u90', low: 'tok-u10' });
  const p = await startProxy(t, { order: ['high', 'low'], dir, strategy: 'least-utilized', rejectFile: rf });
  await servedBy(p.port, 2);
  fs.writeFileSync(rf, 'low');
  assert.deepStrictEqual(await servedBy(p.port, 2), ['high', 'high']);
});

// P29: an org that never reports a utilization does not stay first forever
test('P29: least-utilized moves an org without utilization behind measured ones', async t => {
  const dir = makeTokenDir({ blind: 'tok-nou', mid: 'tok-u50' });
  const p = await startProxy(t, { order: ['blind', 'mid'], dir, strategy: 'least-utilized' });
  assert.deepStrictEqual(await servedBy(p.port, 4), ['blind', 'mid', 'mid', 'mid']);
});

// P30: a utilization whose 5h window has reset is measured again, so an org
// is not avoided for its old high value
test('P30: least-utilized forgets a utilization after its window resets', async t => {
  const dir = makeTokenDir({ reset: 'tok-u90p', low: 'tok-u10' });
  const p = await startProxy(t, { order: ['reset', 'low'], dir, strategy: 'least-utilized' });
  // its 0.90 is already past the reset each time, so it is never ranked behind
  // low's 0.10 (with the stale value it would be: reset, low, low)
  assert.deepStrictEqual(await servedBy(p.port, 3), ['reset', 'reset', 'reset']);
});

// P28: an unknown strategy value is reported, not silently ignored
test('P28: unknown strategy is logged and the static order is used', async t => {
  const dir = makeTokenDir({ high: 'tok-u90', low: 'tok-u10' });
  const p = await startProxy(t, { order: ['high', 'low'], dir, strategy: 'lowest' });
  assert.ok(p.logs.some(l => l.includes('unknown CLAUDE_ORG_STRATEGY "lowest"')), p.logs.join(''));
  assert.deepStrictEqual(await servedBy(p.port, 2), ['high', 'high']);
});
