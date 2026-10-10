'use strict';
// probe's real HTTP path, against a stub upstream (CLAUDE_ORG_UPSTREAM).
// Verifies the ratelimit headers are read from the response.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { tmpdir, makeTokenDir, makeClaudeStub, runBin, runBinAsync } = require('./helpers');

function startUpstream(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('probe reads 5h headers from a real HTTP response', async () => {
  const epoch = Math.floor(Date.now() / 1000) + 3600;
  const server = await startUpstream((req, res) => {
    res.writeHead(200, {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': String(epoch),
    });
    res.end('{}');
  });
  try {
    const dir = makeTokenDir({ team: 'dummy-token-team' });
    const r = await runBinAsync(['probe', 'team'], {
      CLAUDE_ORG_TOKEN_DIR: dir,
      CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${server.address().port}`,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^status=allowed 5h_util=0\.25 /);
    assert.match(r.stdout, new RegExp(`5h_reset=${epoch} `));
  } finally {
    server.close();
  }
});

test('probe reports rejected on 429 + rejected headers', async () => {
  const server = await startUpstream((req, res) => {
    res.writeHead(429, { 'anthropic-ratelimit-unified-5h-status': 'rejected' });
    res.end('{"type":"error"}');
  });
  try {
    const dir = makeTokenDir({ team: 'dummy-token-team' });
    const r = await runBinAsync(['probe', 'team'], {
      CLAUDE_ORG_TOKEN_DIR: dir,
      CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${server.address().port}`,
    });
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /^status=rejected /);
  } finally {
    server.close();
  }
});

test('probe reports unknown when upstream is unreachable', () => {
  const dir = makeTokenDir({ team: 'dummy-token-team' });
  const r = runBin(['probe', 'team'], {
    CLAUDE_ORG_TOKEN_DIR: dir,
    CLAUDE_ORG_UPSTREAM: 'http://127.0.0.1:1',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^status=unknown /);
});

// Issue #9: probe with a chosen model. The stub refuses the model "gated" the
// way the real API did on 2026-10-10 (5h allowed, 429), serves any other model,
// and echoes the model it received.
function modelUpstream() {
  const seen = [];
  return startUpstream((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const model = JSON.parse(Buffer.concat(chunks).toString()).model;
      seen.push(model);
      // "bare": refused with no window headers, as Fable 5.1 was on 2026-10-10
      if (model === 'bare') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required"}}');
      }
      const h = { 'anthropic-ratelimit-unified-5h-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': '0.1' };
      res.writeHead(model === 'gated' ? 429 : 200, h);
      res.end('{}');
    });
  }).then(server => ({ server, seen }));
}

async function probeWith(args, extraEnv = {}) {
  const { server, seen } = await modelUpstream();
  try {
    const dir = makeTokenDir({ team: 'dummy-token-team', other: 'dummy-token-other' });
    const r = await runBinAsync(args, {
      CLAUDE_ORG_TOKEN_DIR: dir,
      CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${server.address().port}`,
      ...extraEnv,
    });
    return { ...r, seen };
  } finally {
    server.close();
  }
}

test('probe --model sends that model and reports it available', async () => {
  const r = await probeWith(['probe', 'team', '--model', 'claude-x-1']);
  assert.deepStrictEqual(r.seen, ['claude-x-1']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^status=allowed 5h_util=0\.1 .* model=claude-x-1 model_status=available$/m);
});

test('probe tells a refused model apart from the 5h window', async () => {
  const r = await probeWith(['probe', 'team', '--model=gated']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^status=allowed .* model=gated model_status=unavailable$/m);
});

test('a refusal without window headers still reports the 5h state', async () => {
  const r = await probeWith(['probe', 'team', '--model', 'bare']);
  assert.deepStrictEqual(r.seen, ['bare', 'claude-haiku-4-5-20251001']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^status=allowed 5h_util=0\.1 .* model=bare model_status=unavailable model_error=rate_limit_error$/m);
});

test('CLAUDE_ORG_PROBE_MODEL sets the probe model', async () => {
  const r = await probeWith(['probe', 'team'], { CLAUDE_ORG_PROBE_MODEL: 'gated' });
  assert.deepStrictEqual(r.seen, ['gated']);
  assert.match(r.stdout, /model_status=unavailable$/m);
});

test('probe without a model keeps Haiku and the old line', async () => {
  const r = await probeWith(['probe', 'team']);
  assert.deepStrictEqual(r.seen, ['claude-haiku-4-5-20251001']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /model/);
});

test('auto falls back to default when the preferred org refuses the probe model', async () => {
  const r = await probeWith(['pick'], { CLAUDE_ORG_PREFER: 'team', CLAUDE_ORG_PROBE_MODEL: 'gated' });
  assert.strictEqual(r.stdout.trim(), 'default');
  assert.match(r.stderr, /^-> default \(team refused model gated\)$/m);
});

test('status --model shows model_status for every org', async () => {
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'));
  const r = await probeWith(['status', '--model', 'gated'], { PATH: stub + path.delimiter + process.env.PATH });
  assert.deepStrictEqual(r.seen, ['gated', 'gated']);
  assert.strictEqual((r.stdout.match(/model=gated model_status=unavailable/g) || []).length, 2, r.stdout);
});

test('probe does not leak the token on failure', () => {
  const dir = makeTokenDir({ team: 'secret-token-value' });
  const r = runBin(['probe', 'team'], {
    CLAUDE_ORG_TOKEN_DIR: dir,
    CLAUDE_ORG_UPSTREAM: 'http://127.0.0.1:1',
  });
  assert.doesNotMatch(r.stdout + r.stderr, /secret-token-value/);
});
