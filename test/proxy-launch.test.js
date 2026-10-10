'use strict';
// Port of the original bash proxy test suite (test_claude_org_proxy.sh) cases P8-P10:
// the `claude-org proxy` subcommand launches a session-scoped proxy, points
// claude at it, and tears the proxy down when claude exits.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { tmpdir, makeTokenDir, makeClaudeStub, runBinAsync } = require('./helpers');

function stubUpstream() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'anthropic-ratelimit-unified-5h-status': 'allowed' });
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const TOKEN_SET = { a: 'tok-a', b: 'tok-b', limited: 'tok-limited' };

// P8: proxy env is set on claude, the proxy is reachable from inside claude,
// and it is gone after claude exits.
test('P8: proxy subcommand wires env, serves, and cleans up', async () => {
  const upstream = await stubUpstream();
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'));
  const dir = makeTokenDir(TOKEN_SET);
  try {
    const r = await runBinAsync(['proxy', '--resume'], {
      PATH: stub + path.delimiter + process.env.PATH,
      CLAUDE_ORG_TOKEN_DIR: dir,
      CLAUDE_ORG_PREFER: 'a',
      CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.match(r.stdout, /^args=--resume$/m);
    const m = r.stdout.match(/^base=http:\/\/127\.0\.0\.1:(\d+)$/m);
    assert.ok(m, `no base= line: ${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /^auth=claude-org-proxy$/m);
    assert.match(r.stdout, /^proxyflag=1$/m);
    assert.match(r.stdout, /^proxy_alive=200$/m, `proxy not reachable from claude: ${r.stdout}`);
    // P8.8/P8.9: proxy defaults restore subscription-equivalent cache TTL and
    // tool search (the harness env is stripped by the test helper, so these
    // values can only come from claude-org itself)
    assert.match(r.stdout, /^ttl=1h$/m, `CLAUDE_CODE_PROMPT_CACHE_TTL default missing: ${r.stdout}`);
    assert.match(r.stdout, /^toolsearch=true$/m, `ENABLE_TOOL_SEARCH default missing: ${r.stdout}`);
    assert.match(r.stderr, /^-> proxy 127\.0\.0\.1:/m);
    // Issue #12: claude (and so its statusline / hooks) can read the org and
    // model in use, and the log line names the model without the prompt.
    const st = r.stdout.match(/^state=(.*)$/m);
    assert.ok(st, `no state= line: ${r.stdout}`);
    const state = JSON.parse(st[1]);
    assert.deepStrictEqual([state.org, state.model], ['a', 'stub-model']);
    const logf = r.stderr.match(/log: (.+)\)$/m)[1];
    const logText = fs.readFileSync(logf, 'utf8');
    assert.match(logText, /via a model=stub-model -> 200 /);
    assert.doesNotMatch(logText, /STUB-PROMPT|tok-a/);
    // After exit, the proxy must be gone.
    await new Promise(r2 => setTimeout(r2, 500));
    await assert.rejects(
      fetch(`http://127.0.0.1:${m[1]}/v1/models`, { method: 'POST', body: '' }),
      'proxy still alive after claude exited',
    );
  } finally {
    upstream.close();
  }
});

// P9: fewer than 2 org tokens -> exit 1 with guidance, claude not launched
test('P9: proxy requires 2+ org tokens', async () => {
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'));
  const dir = makeTokenDir({ a: 'tok-a' });
  const r = await runBinAsync(['proxy'], {
    PATH: stub + path.delimiter + process.env.PATH,
    CLAUDE_ORG_TOKEN_DIR: dir,
  });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /2 つ以上/);
});

// P11: user-set CLAUDE_CODE_PROMPT_CACHE_TTL / ENABLE_TOOL_SEARCH are not
// overwritten by the proxy defaults
test('P11: user-set cache TTL / tool search env are preserved', async () => {
  const upstream = await stubUpstream();
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'));
  const dir = makeTokenDir(TOKEN_SET);
  try {
    const r = await runBinAsync(['proxy'], {
      PATH: stub + path.delimiter + process.env.PATH,
      CLAUDE_ORG_TOKEN_DIR: dir,
      CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CLAUDE_CODE_PROMPT_CACHE_TTL: '5m',
      ENABLE_TOOL_SEARCH: 'false',
    });
    assert.match(r.stdout, /^ttl=5m$/m, `user env overwritten: ${r.stdout}`);
    assert.match(r.stdout, /^toolsearch=false$/m, `user env overwritten: ${r.stdout}`);
  } finally {
    upstream.close();
  }
});

// P10 (supersedes "proxy body missing -> exit 1" of the bash version, which
// tested CLAUDE_ORG_PROXY_JS lookup; the proxy is bundled in-process now):
// when claude itself cannot be spawned, proxy exits non-zero and cleans up.
test('P10: missing claude -> non-zero exit, proxy cleaned up', async () => {
  const upstream = await stubUpstream();
  const emptyBin = tmpdir();
  const dir = makeTokenDir(TOKEN_SET);
  try {
    const r = await runBinAsync(['proxy'], {
      PATH: emptyBin, // no claude on PATH
      CLAUDE_ORG_TOKEN_DIR: dir,
      CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    });
    assert.notStrictEqual(r.status, 0);
    const m = r.stderr.match(/proxy 127\.0\.0\.1:(\d+)/);
    if (m) {
      await new Promise(r2 => setTimeout(r2, 500));
      await assert.rejects(fetch(`http://127.0.0.1:${m[1]}/v1/models`, { method: 'POST', body: '' }));
    }
  } finally {
    upstream.close();
  }
});
