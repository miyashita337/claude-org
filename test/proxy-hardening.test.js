'use strict';
// Issue #22: the proxy as an unattended launcher. It must not crash or hang
// (M1), only serve the claude it was started for (M3), and keep its tokens
// private (S1, S2, S4, S5, S7, org-name check).
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { tmpdir, makeTokenDir } = require('./helpers');
const { createProxy } = require('../lib/proxy');

const SECRET = 'test-secret';
const POSIX = process.platform !== 'win32';
const bodyFor = model => JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });

// Stub upstream. Per token: tok-401 -> 401; tok-hang -> never answers;
// tok-limited -> 429 5h rejected; anything else -> 200, echoing the request
// header names it saw (x-seen-headers) and sending hop-by-hop headers back.
// Model "stream" -> an SSE stream that never ends; `aborted` counts streams
// the proxy cut off. /__state (GET) reports { hits, aborted }.
let upPort;
let upServer;
const hits = {};
let aborted = 0;
const hanging = [];

test.before(async () => {
  upServer = http.createServer((req, res) => {
    if (req.url === '/__state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ hits, aborted }));
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
      hits[tok] = (hits[tok] || 0) + 1;
      let model = '';
      try { model = JSON.parse(Buffer.concat(chunks).toString()).model; } catch { /* no model */ }
      if (tok === 'tok-401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
      }
      if (tok === 'tok-hang') {
        hanging.push(res); // answered never; closed in test.after
        return;
      }
      if (tok === 'tok-limited') {
        res.writeHead(429, {
          'content-type': 'application/json',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 3600),
        });
        return res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
      }
      if (model === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const timer = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 20);
        res.on('close', () => { clearInterval(timer); if (!res.writableFinished) aborted++; });
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'x-seen-headers': Object.keys(req.headers).sort().join(','),
        'x-served-token': tok,
        'x-hop': '1',
        connection: 'close, x-hop',
        'proxy-authenticate': 'Basic',
      });
      res.end('{"type":"message"}');
    });
  });
  await new Promise(r => upServer.listen(0, '127.0.0.1', r));
  upPort = upServer.address().port;
});

test.after(() => {
  for (const res of hanging) res.destroy();
  upServer.close();
});

async function startProxy(t, { order = [], dir = null, ...rest } = {}) {
  const logs = [];
  const { server } = createProxy({
    tokenDir: dir || makeTokenDir({ a: 'tok-a', b: 'tok-b' }),
    order,
    upstream: `http://127.0.0.1:${upPort}`,
    secret: SECRET,
    allowAnyUpstream: true,
    log: { write: s => { logs.push(s); return true; } },
    ...rest,
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, logs, server };
}

function post(port, urlPath = '/v1/messages', extraHeaders = {}, body = bodyFor('m')) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', ...extraHeaders },
    body,
  });
}

// Raw request for headers fetch() would not let a test set (Host, Connection, TE).
function rawRequest(port, { method = 'POST', path: p = '/v1/messages', headers = {}, body = bodyFor('m') } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { authorization: `Bearer ${SECRET}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function upstreamState() {
  return (await fetch(`http://127.0.0.1:${upPort}/__state`)).json();
}
const upstreamHits = async () => Object.values((await upstreamState()).hits).reduce((a, b) => a + b, 0);

// M1 / AC-1: a token dir that cannot be read gives a 503, and the proxy goes
// on serving (in-process: the next request still gets an answer)
test('H1: unreadable token dir -> 503, proxy keeps serving', async t => {
  const p = await startProxy(t, { dir: path.join(tmpdir(), 'missing') });
  const r = await post(p.port);
  assert.strictEqual(r.status, 503);
  assert.ok(p.logs.some(l => l.includes('cannot list orgs')), p.logs.join(''));
  assert.ok(p.logs.some(l => /ALERT no-org-available model=m reason=no-tokens status=503/.test(l)), p.logs.join(''));
  assert.strictEqual((await post(p.port)).status, 503);
});

// M1 / AC-1, standalone: `node lib/proxy.js` with a missing token dir answers
// 5xx and the process is still alive afterwards
test('H1b: standalone proxy survives a request with no token dir', async t => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'proxy.js')], {
    env: {
      ...process.env,
      PORT: '0',
      CLAUDE_ORG_TOKEN_DIR: path.join(tmpdir(), 'missing'),
      CLAUDE_ORG_PROXY_SECRET: SECRET,
      CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${upPort}`,
      CLAUDE_ORG_UNSAFE_UPSTREAM: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`proxy did not start: ${buf}`)), 10000);
    child.stderr.on('data', c => {
      buf += c;
      const m = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', code => reject(new Error(`proxy exited with ${code}: ${buf}`)));
  });
  const r = await post(port);
  assert.ok(r.status >= 500 && r.status < 600, `status ${r.status}`);
  assert.strictEqual(child.exitCode, null, 'proxy process died');
  assert.strictEqual((await post(port)).status, 503);
});

// M1: standalone without a secret refuses to start (no open proxy by accident)
test('H1c: standalone proxy without CLAUDE_ORG_PROXY_SECRET exits 1', async () => {
  const r = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'proxy.js')], {
      env: { ...process.env, PORT: '0', CLAUDE_ORG_TOKEN_DIR: makeTokenDir({ a: 'tok-a' }), CLAUDE_ORG_PROXY_SECRET: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', code => resolve({ code, stderr }));
  });
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /CLAUDE_ORG_PROXY_SECRET/);
});

// M3 / AC-3: without the secret, or with a wrong one, nothing is forwarded
test('H2: missing or wrong secret -> 401, not forwarded', async t => {
  const p = await startProxy(t, { order: ['a'] });
  const before = await upstreamHits();
  for (const headers of [{ authorization: '' }, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${SECRET}x` }, { authorization: 'Basic abc' }]) {
    const r = await fetch(`http://127.0.0.1:${p.port}/v1/messages`, { method: 'POST', headers: { ...headers, 'x-api-key': 'k' }, body: bodyFor('m') });
    assert.strictEqual(r.status, 401, JSON.stringify(headers));
  }
  assert.strictEqual(await upstreamHits(), before, 'a request without the secret reached the upstream');
  assert.strictEqual((await post(p.port)).status, 200);
});

// M3: Host must name this proxy (DNS rebinding), only GET/POST/DELETE under
// /v1/ are forwarded
test('H3: wrong Host, path outside /v1/, odd method -> refused, not forwarded', async t => {
  const p = await startProxy(t, { order: ['a'] });
  const before = await upstreamHits();
  assert.strictEqual((await rawRequest(p.port, { headers: { host: `evil.example:${p.port}` } })).status, 403);
  assert.strictEqual((await rawRequest(p.port, { headers: { host: 'localhost:' + p.port } })).status, 403);
  assert.strictEqual((await rawRequest(p.port, { path: '/admin' })).status, 404);
  assert.strictEqual((await rawRequest(p.port, { path: '/v2/messages' })).status, 404);
  // nothing an upstream could normalise out of /v1/
  assert.strictEqual((await rawRequest(p.port, { path: '/v1/../admin' })).status, 404);
  assert.strictEqual((await rawRequest(p.port, { path: '/v1//messages' })).status, 404);
  assert.strictEqual((await rawRequest(p.port, { path: '/v1/%2e%2e/admin' })).status, 404);
  assert.strictEqual((await rawRequest(p.port, { method: 'PUT' })).status, 405);
  assert.strictEqual((await rawRequest(p.port, { method: 'OPTIONS', body: null })).status, 405);
  assert.strictEqual(await upstreamHits(), before);
  assert.ok(p.logs.some(l => /refused POST \/admin: only \/v1\/\* is forwarded \(HTTP 404\)/.test(l)), p.logs.join(''));
  // a refused request's query string never reaches the log (it may carry secrets)
  assert.strictEqual((await rawRequest(p.port, { method: 'PUT', path: '/v1/messages?api_key=QUERYSECRET' })).status, 405);
  assert.ok(p.logs.some(l => /refused PUT \/v1\/messages\?\.\.\.: /.test(l)), p.logs.join(''));
  assert.ok(!p.logs.join('').includes('QUERYSECRET'), 'query value leaked into the proxy log');
  assert.strictEqual((await post(p.port)).status, 200);
  assert.strictEqual((await rawRequest(p.port, { path: '/v1/messages?beta=true&x=//' })).status, 200, 'query string must not be inspected');
});

// S2: a body over the cap gets 413, announced (content-length) or streamed (chunked)
test('H4: oversized request body -> 413', async t => {
  const p = await startProxy(t, { order: ['a'], maxBodyBytes: 1024 });
  const before = await upstreamHits();
  const big = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(2048) }] });
  assert.strictEqual((await post(p.port, '/v1/messages', {}, big)).status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/v1/messages',
      headers: { authorization: `Bearer ${SECRET}`, 'transfer-encoding': 'chunked' } }, res => resolve(res.statusCode));
    req.on('error', reject);
    req.write(big.slice(0, 1000));
    req.write(big.slice(1000));
    req.end();
  });
  assert.strictEqual(chunked, 413);
  assert.strictEqual(await upstreamHits(), before);
  assert.strictEqual((await post(p.port)).status, 200, 'proxy stopped serving after a 413');
});

// S4: hop-by-hop headers are dropped in both directions
test('H5: hop-by-hop headers are not forwarded either way', async t => {
  const p = await startProxy(t, { order: ['a'] });
  const r = await rawRequest(p.port, { headers: {
    'content-type': 'application/json',
    connection: 'x-req-hop, keep-alive',
    'x-req-hop': '1',
    te: 'trailers',
    'proxy-authorization': 'Basic abc',
    'anthropic-beta': 'kept',
  } });
  assert.strictEqual(r.status, 200);
  const seen = r.headers['x-seen-headers'].split(',');
  // (connection is seen: node adds the proxy's own for its hop; the client's
  // "x-req-hop, keep-alive" value is what must not get through)
  for (const h of ['x-req-hop', 'te', 'proxy-authorization', 'transfer-encoding']) {
    assert.ok(!seen.includes(h), `${h} reached the upstream: ${seen}`);
  }
  assert.ok(seen.includes('anthropic-beta'), `end-to-end header lost: ${seen}`);
  assert.strictEqual(r.headers['x-hop'], undefined, 'header named in upstream Connection was copied');
  assert.strictEqual(r.headers['proxy-authenticate'], undefined);
  assert.strictEqual(r.headers['x-claude-org'], 'a');
});

// S5: a token file other users can read, or owned by someone else, is not used
test('H6: world-readable token file is skipped', { skip: !POSIX }, async t => {
  const dir = makeTokenDir({ loose: 'tok-loose', a: 'tok-a' });
  fs.chmodSync(path.join(dir, 'loose.token'), 0o644);
  const p = await startProxy(t, { order: ['loose', 'a'], dir });
  const r = await post(p.port);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.ok(p.logs.some(l => /skipping loose: token file .*loose\.token is readable by other users \(mode 644\); run: chmod 600/.test(l)), p.logs.join(''));
  assert.strictEqual((await upstreamState()).hits['tok-loose'], undefined, 'the loose token was sent upstream');
  fs.chmodSync(path.join(dir, 'loose.token'), 0o600);
  assert.strictEqual((await post(p.port)).headers.get('x-claude-org'), 'loose');
});

// S1: the upstream is pinned to api.anthropic.com unless a test says otherwise
test('H7: non-default upstream is refused without the unsafe flag', () => {
  assert.throws(() => createProxy({ tokenDir: makeTokenDir({ a: 'tok-a' }), upstream: `http://127.0.0.1:${upPort}`, secret: SECRET, allowAnyUpstream: false }),
    /CLAUDE_ORG_UPSTREAM=http:\/\/127\.0\.0\.1:\d+\/ is not https:\/\/api\.anthropic\.com/);
  assert.throws(() => createProxy({ tokenDir: makeTokenDir({ a: 'tok-a' }), upstream: 'https://api.anthropic.com.evil.example', secret: SECRET, allowAnyUpstream: false }),
    /is not https:\/\/api\.anthropic\.com/);
  const { server } = createProxy({ tokenDir: makeTokenDir({ a: 'tok-a' }), upstream: 'https://api.anthropic.com', secret: SECRET, allowAnyUpstream: false });
  assert.ok(server);
  assert.throws(() => createProxy({ tokenDir: makeTokenDir({ a: 'tok-a' }), secret: '' }), /proxy secret missing/);
});

// S7: an expired token (401) is reported on a fixed ALERT line, the org is
// taken out, and the next org serves
test('H8: 401 from an org -> ALERT token-rejected and failover', async t => {
  const dir = makeTokenDir({ dead: 'tok-401', a: 'tok-a' });
  const p = await startProxy(t, { order: ['dead', 'a'], dir });
  const r = await post(p.port);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.ok(p.logs.some(l => /ALERT token-rejected org=dead status=401 -> run: claude setup-token/.test(l)), p.logs.join(''));
  const before = (await upstreamState()).hits['tok-401'];
  await post(p.port);
  assert.strictEqual((await upstreamState()).hits['tok-401'], before, 'the dead org was tried again');
  assert.doesNotMatch(p.logs.join(''), /tok-401|tok-a/);
});

// S7: when every org is limited the pass-through 429 is also an ALERT line
test('H8b: all orgs limited -> ALERT no-org-available', async t => {
  const dir = makeTokenDir({ l1: 'tok-limited', l2: 'tok-limited' });
  const p = await startProxy(t, { order: ['l1', 'l2'], dir });
  assert.strictEqual((await post(p.port)).status, 429);
  assert.ok(p.logs.some(l => /ALERT no-org-available model=m reason=rate-limited status=429/.test(l)), p.logs.join(''));
});

// org names: a file whose name could leave the token dir is not an org
test('H9: token files with invalid org names are ignored', async t => {
  const dir = makeTokenDir({ a: 'tok-a', 'a b': 'tok-space', 'x.y': 'tok-dot' });
  const p = await startProxy(t, { order: ['../a', 'x.y', 'a'], dir });
  const r = await post(p.port);
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  const st = await upstreamState();
  assert.strictEqual(st.hits['tok-space'], undefined);
  assert.strictEqual(st.hits['tok-dot'], undefined);
  await post(p.port);
  const ignored = p.logs.filter(l => /ignoring .*\.token: not an org name/.test(l));
  assert.strictEqual(ignored.length, 2, `said once per file: ${p.logs.join('')}`);
});

// M1: a client that disconnects mid-stream stops the upstream stream
test('H10: client disconnect cancels the upstream stream', async t => {
  const p = await startProxy(t, { order: ['a'] });
  const before = (await upstreamState()).aborted;
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/v1/messages',
      headers: { authorization: `Bearer ${SECRET}` } }, res => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', reject);
    req.end(bodyFor('stream'));
  });
  const deadline = Date.now() + 5000;
  while ((await upstreamState()).aborted === before && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.strictEqual((await upstreamState()).aborted, before + 1, 'upstream stream kept going after the client left');
});

// M1: an upstream that never answers is given up after the idle timeout and
// the next org serves
test('H11: hung upstream times out and fails over', async t => {
  const dir = makeTokenDir({ hang: 'tok-hang', a: 'tok-a' });
  const p = await startProxy(t, { order: ['hang', 'a'], dir, upstreamTimeoutMs: 300 });
  const r = await post(p.port);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-claude-org'), 'a');
  assert.ok(p.logs.some(l => /upstream error via hang: no data from upstream for 300 ms/.test(l)), p.logs.join(''));
});

// M1: a client that gives up while the proxy waits for an org does not make
// the proxy try the other orgs for nobody
test('H12: client disconnect while waiting for upstream stops the failover', async t => {
  const dir = makeTokenDir({ hang: 'tok-hang', a: 'tok-a' });
  const p = await startProxy(t, { order: ['hang', 'a'], dir, upstreamTimeoutMs: 400 });
  const before = (await upstreamState()).hits['tok-a'] || 0;
  await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/v1/messages',
      headers: { authorization: `Bearer ${SECRET}` } });
    req.on('error', () => {});
    req.end(bodyFor('m'));
    setTimeout(() => { req.destroy(); resolve(); }, 100);
  });
  await new Promise(r => setTimeout(r, 700));
  assert.strictEqual((await upstreamState()).hits['tok-a'] || 0, before, 'the next org was tried after the client left');
});
