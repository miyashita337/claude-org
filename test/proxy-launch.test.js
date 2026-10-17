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
      CLAUDE_ORG_UNSAFE_UPSTREAM: '1',
    });
    assert.match(r.stdout, /^args=--resume$/m);
    const m = r.stdout.match(/^base=http:\/\/127\.0\.0\.1:(\d+)$/m);
    assert.ok(m, `no base= line: ${r.stdout} ${r.stderr}`);
    // M3: the Bearer value is a per-session secret that only the child gets
    const secret = r.stdout.match(/^auth=([0-9a-f]{64})$/m);
    assert.ok(secret, `no per-session secret in auth=: ${r.stdout}`);
    assert.doesNotMatch(r.stderr, new RegExp(secret[1]));
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
    assert.doesNotMatch(logText, new RegExp(secret[1]));
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
      CLAUDE_ORG_UNSAFE_UPSTREAM: '1',
      CLAUDE_CODE_PROMPT_CACHE_TTL: '5m',
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_ORG_STRATEGY: 'least-utilized',
    });
    assert.match(r.stderr, /strategy: least-utilized,/, 'CLAUDE_ORG_STRATEGY not picked up by proxy');
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
      CLAUDE_ORG_UNSAFE_UPSTREAM: '1',
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

// A claude that reports its pid and then waits, for the signal tests.
const SLEEPING_CLAUDE_JS = `'use strict';
console.log('pid=' + process.pid);
setTimeout(() => {}, 60000);
`;
const POSIX = process.platform !== 'win32';

// Start `proxy` with the sleeping claude; resolves once claude printed its pid.
async function startSleepingProxy(t, upstream) {
  const { spawnBin } = require('./helpers');
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'), SLEEPING_CLAUDE_JS);
  const run = spawnBin(['proxy'], {
    PATH: stub + path.delimiter + process.env.PATH,
    CLAUDE_ORG_TOKEN_DIR: makeTokenDir(TOKEN_SET),
    CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    CLAUDE_ORG_UNSAFE_UPSTREAM: '1',
  });
  t.after(() => { try { run.child.kill('SIGKILL'); } catch { /* exited */ } });
  const deadline = Date.now() + 10000;
  while (!/^pid=\d+$/m.test(run.stdout()) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  const m = run.stdout().match(/^pid=(\d+)$/m);
  assert.ok(m, `claude stub did not start: ${run.stdout()} ${run.stderr()}`);
  return { run, claudePid: Number(m[1]) };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitGone(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  return !alive(pid);
}

// P31 / AC-2 (M2): SIGTERM to the launcher reaches claude; the launcher waits
// for it and reports 128+15
test('P31: SIGTERM to the launcher ends claude too', { skip: !POSIX }, async t => {
  const upstream = await stubUpstream();
  t.after(() => upstream.close());
  const { run, claudePid } = await startSleepingProxy(t, upstream);
  run.child.kill('SIGTERM');
  const r = await run.result;
  assert.ok(await waitGone(claudePid), `claude ${claudePid} still running after the launcher got SIGTERM`);
  assert.strictEqual(r.status, 143, `launcher exit: ${r.status} ${r.signal} ${r.stderr}`);
});

// P32 (M2): without a terminal, SIGINT is forwarded as well (a supervisor's
// interrupt); with one, claude already got it from the tty
test('P32: SIGINT to a headless launcher is forwarded', { skip: !POSIX }, async t => {
  const upstream = await stubUpstream();
  t.after(() => upstream.close());
  const { run, claudePid } = await startSleepingProxy(t, upstream);
  run.child.kill('SIGINT');
  const r = await run.result;
  assert.ok(await waitGone(claudePid), `claude ${claudePid} still running`);
  assert.strictEqual(r.status, 130);
});

// P33 (S1): a non-default upstream without the unsafe flag stops the launch
// before claude starts (org tokens would be sent there)
test('P33: unknown upstream without CLAUDE_ORG_UNSAFE_UPSTREAM -> exit 1, claude not launched', async t => {
  const upstream = await stubUpstream();
  t.after(() => upstream.close());
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'));
  const r = await runBinAsync(['proxy'], {
    PATH: stub + path.delimiter + process.env.PATH,
    CLAUDE_ORG_TOKEN_DIR: makeTokenDir(TOKEN_SET),
    CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
  });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /CLAUDE_ORG_UNSAFE_UPSTREAM=1/);
});

// P34 (S5): token files the proxy would refuse are reported at launch, and
// the launch fails when fewer than 2 usable orgs remain
test('P34: world-readable token files are reported at launch', { skip: !POSIX }, async t => {
  const upstream = await stubUpstream();
  t.after(() => upstream.close());
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'));
  const dir = makeTokenDir(TOKEN_SET);
  fs.chmodSync(path.join(dir, 'a.token'), 0o644);
  fs.chmodSync(path.join(dir, 'b.token'), 0o644);
  const r = await runBinAsync(['proxy'], {
    PATH: stub + path.delimiter + process.env.PATH,
    CLAUDE_ORG_TOKEN_DIR: dir,
    CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
    CLAUDE_ORG_UNSAFE_UPSTREAM: '1',
  });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.strictEqual(r.stdout, '', 'claude was launched');
  assert.match(r.stderr, /skipping org a: token file .*a\.token is readable by other users \(mode 644\); run: chmod 600/);
  assert.match(r.stderr, /skipping org b: /);
  assert.match(r.stderr, /2 つ以上/);
});

// Issue #31: once the proxy log is unwritable, ALERT lines are mirrored to
// stderr so an unattended session that only watches stderr still sees them.
// (Deleting the log dir does not fail an already-open fd on POSIX, so the
// failure is injected as a stream 'error' instead, as disk-full would.)
test('guardLogStream mirrors ALERT lines to stderr after the log fails', () => {
  const { EventEmitter } = require('events');
  const { guardLogStream } = require('../lib/proxy');
  const written = [];
  const stream = Object.assign(new EventEmitter(), { write: l => written.push(l) });
  const errs = [];
  const origErr = console.error;
  const origWrite = process.stderr.write;
  console.error = m => errs.push(m);
  process.stderr.write = l => { errs.push(l); return true; };
  try {
    const out = guardLogStream(stream, '/x/proxy.log');
    out.write('ALERT before\n');
    assert.deepStrictEqual(errs, [], 'no mirroring while the log works');
    stream.emit('error', new Error('ENOSPC'));
    out.write('plain line\n');
    out.write('ALERT token-rejected org=a\n');
    assert.strictEqual(errs.filter(e => /cannot write the proxy log/.test(e)).length, 1);
    assert.strictEqual(errs.filter(e => /ALERT token-rejected/.test(e)).length, 1);
    assert.ok(!errs.some(e => /plain line/.test(e)));
    assert.strictEqual(written.length, 2, 'non-ALERT lines still go to the stream; mirrored ALERTs do not');
  } finally {
    console.error = origErr;
    process.stderr.write = origWrite;
  }
});

// Issue #31 review: the write that first fails must not lose its ALERT line.
// A real fs.WriteStream on a read-only fd fails asynchronously (EBADF), the
// same shape as ENOSPC.
test('guardLogStream recovers the ALERT line whose write failed on a real stream', async () => {
  const { guardLogStream } = require('../lib/proxy');
  const file = path.join(tmpdir(), 'proxy.log');
  fs.writeFileSync(file, '');
  const stream = fs.createWriteStream(file, { fd: fs.openSync(file, 'r'), autoClose: false });
  const errs = [];
  const origErr = console.error;
  const origWrite = process.stderr.write;
  console.error = m => errs.push(m);
  process.stderr.write = l => { errs.push(l); return true; };
  try {
    const out = guardLogStream(stream, file);
    out.write('ALERT token-rejected org=a\n');
    await new Promise(r => setTimeout(r, 200));
    out.write('ALERT no-org-available\n');
    assert.strictEqual(errs.filter(e => /ALERT token-rejected/.test(e)).length, 1, 'first ALERT recovered once');
    assert.strictEqual(errs.filter(e => /ALERT no-org-available/.test(e)).length, 1, 'later ALERT mirrored once');
    assert.strictEqual(errs.filter(e => /cannot write the proxy log/.test(e)).length, 1);
  } finally {
    console.error = origErr;
    process.stderr.write = origWrite;
  }
});

// Issue #15: launches must not leave claude-org-proxy-* dirs behind forever.
function seedRunDirs(root, names) {
  const now = Date.now() / 1000;
  names.forEach((name, i) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'proxy.log'), 'x');
    // later index = newer
    fs.utimesSync(d, now - 1000 + i, now - 1000 + i);
  });
}

test('pruneRunDirs keeps the newest N matching dirs and touches nothing else', () => {
  const { pruneRunDirs } = require('../lib/proxy');
  const root = tmpdir();
  const names = Array.from({ length: 6 }, (_, i) => `claude-org-proxy-abc12${i}`);
  seedRunDirs(root, names);
  fs.mkdirSync(path.join(root, 'claude-org-proxy-toolong1'));   // not the mkdtemp shape
  fs.mkdirSync(path.join(root, 'other-dir'));
  fs.writeFileSync(path.join(root, 'claude-org-proxy-file12'), '');  // a file, not a dir
  const removed = pruneRunDirs(root, 3);
  assert.strictEqual(removed, 3);
  const left = fs.readdirSync(root).sort();
  assert.deepStrictEqual(left.filter(n => /^claude-org-proxy-abc12/.test(n)), names.slice(3), 'newest 3 kept');
  assert.ok(left.includes('claude-org-proxy-toolong1') && left.includes('other-dir') && left.includes('claude-org-proxy-file12'));
});

test('pruneRunDirs on a missing root is a no-op', () => {
  const { pruneRunDirs } = require('../lib/proxy');
  assert.strictEqual(pruneRunDirs(path.join(tmpdir(), 'nope')), 0);
});

test('repeated proxy launches keep the run dir count bounded and the printed log path exists', async () => {
  const upstream = await stubUpstream();
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'));
  const dir = makeTokenDir(TOKEN_SET);
  const tmpRoot = tmpdir();
  seedRunDirs(tmpRoot, Array.from({ length: 25 }, (_, i) => `claude-org-proxy-old${String(i).padStart(3, '0')}`));
  try {
    const r = await runBinAsync(['proxy'], {
      PATH: stub + path.delimiter + process.env.PATH,
      TMPDIR: tmpRoot, TEMP: tmpRoot, TMP: tmpRoot,
      CLAUDE_ORG_TOKEN_DIR: dir,
      CLAUDE_ORG_PREFER: 'a',
      CLAUDE_ORG_UPSTREAM: `http://127.0.0.1:${upstream.address().port}`,
      CLAUDE_ORG_UNSAFE_UPSTREAM: '1',
    });
    const logf = r.stderr.match(/log: (.+)\)$/m)[1];
    assert.ok(fs.existsSync(logf), `printed log path missing: ${logf}`);
    const runDirs = fs.readdirSync(tmpRoot).filter(n => /^claude-org-proxy-/.test(n));
    assert.strictEqual(runDirs.length, 21, '20 kept + the new run');
  } finally {
    upstream.close();
  }
});
