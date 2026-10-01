'use strict';
// Port of the original bash proxy test suite (test_claude_org_proxy.sh) cases P1-P7 to node:test.
// In-process proxy + in-process stub upstream (no real API calls).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { tmpdir, makeTokenDir } = require('./helpers');
const { createProxy } = require('../lib/proxy');

const UPSTREAM_CODE = {
  // tok-limited -> 429 + rejected; others -> 200 + allowed. Reports whether
  // x-api-key reached it (x-seen-api-key) and which token served (x-served-token).
  hits: {},
};

let upPort;
let upServer;
const hits = {};

const BODY = JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });

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
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.25',
        'x-seen-api-key': seenKey,
        'x-served-token': tok,
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
async function startProxy(t, { order = [], rejectFile = '', dir = null } = {}) {
  const logs = [];
  const { server } = createProxy({
    tokenDir: dir || tokenDir(),
    order,
    upstream: `http://127.0.0.1:${upPort}`,
    rejectFile,
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
