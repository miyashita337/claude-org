'use strict';
// probe's real HTTP path, against a stub upstream (CLAUDE_ORG_UPSTREAM).
// Verifies the ratelimit headers are read from the response.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { makeTokenDir, runBin, runBinAsync } = require('./helpers');

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

test('probe does not leak the token on failure', () => {
  const dir = makeTokenDir({ team: 'secret-token-value' });
  const r = runBin(['probe', 'team'], {
    CLAUDE_ORG_TOKEN_DIR: dir,
    CLAUDE_ORG_UPSTREAM: 'http://127.0.0.1:1',
  });
  assert.doesNotMatch(r.stdout + r.stderr, /secret-token-value/);
});
