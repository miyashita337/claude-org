'use strict';
// Port of agent-base tests/test_claude_org.sh cases T1-T14 to node:test.
// Mapping is documented in the PR body (AC-2).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { tmpdir, makeTokenDir, makeClaudeStub, runBin } = require('./helpers');

const TOKENS = { team: 'sk-ant-oat01-dummy-team', other: 'sk-ant-oat01-dummy-other\n' };

function env(extra = {}) {
  const stub = makeClaudeStub(path.join(tmpdir(), 'bin'));
  const dir = makeTokenDir(TOKENS);
  return {
    CLAUDE_ORG_TOKEN_DIR: dir,
    PATH: stub + path.delimiter + process.env.PATH,
    ...extra,
  };
}

const now = () => Math.floor(Date.now() / 1000);
const HHMM = /^[0-2][0-9]:[0-5][0-9]$/;

// T1: probe allowed -> exit 0, status=allowed
test('T1: probe allowed exits 0 with canonical line', () => {
  const r = runBin(['probe', 'team'], env({ CLAUDE_ORG_FORCE_PROBE: 'allowed' }));
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), 'status=allowed 5h_util=? 5h_reset=? 5h_reset_local=?');
});

// T2: probe rejected:<epoch> -> exit 1, epoch and local HH:MM shown
test('T2: probe rejected shows epoch and local reset time', () => {
  const epoch = now() + 3600;
  const r = runBin(['probe', 'team'], env({ CLAUDE_ORG_FORCE_PROBE: `rejected:${epoch}` }));
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /status=rejected /);
  assert.match(r.stdout, new RegExp(`5h_reset=${epoch} `));
  const m = r.stdout.match(/5h_reset_local=(\S+)/);
  assert.ok(m && HHMM.test(m[1]), `local time missing: ${r.stdout}`);
});

// T3: rejected_until:<past> -> flips to allowed
test('T3: rejected_until in the past becomes allowed', () => {
  const r = runBin(['probe', 'team'], env({ CLAUDE_ORG_FORCE_PROBE: `rejected_until:${now() - 10}` }));
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /^status=allowed/);
});

// T4: rejected_until:<future> -> still rejected
test('T4: rejected_until in the future stays rejected', () => {
  const r = runBin(['probe', 'team'], env({ CLAUDE_ORG_FORCE_PROBE: `rejected_until:${now() + 3600}` }));
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /^status=rejected/);
});

// T5: probe with no arg follows CLAUDE_ORG_PREFER (forced: no token needed)
test('T5: probe default arg follows CLAUDE_ORG_PREFER', () => {
  const r = runBin(['probe'], env({ CLAUDE_ORG_PREFER: 'nonexistent', CLAUDE_ORG_FORCE_PROBE: 'allowed' }));
  assert.strictEqual(r.status, 0, r.stderr);
});

// T6: pick allowed -> stdout=team, stderr carries the reason
test('T6: pick allowed prints name and reason', () => {
  const r = runBin(['pick'], env({ CLAUDE_ORG_PREFER: 'team', CLAUDE_ORG_FORCE_PROBE: 'allowed' }));
  assert.strictEqual(r.stdout.trim(), 'team');
  assert.match(r.stderr, /^-> team/m);
});

// T7: pick rejected -> stdout=default, stderr carries reset time
test('T7: pick rejected falls back to default', () => {
  const epoch = now() + 3600;
  const r = runBin(['pick'], env({ CLAUDE_ORG_PREFER: 'team', CLAUDE_ORG_FORCE_PROBE: `rejected:${epoch}` }));
  assert.strictEqual(r.stdout.trim(), 'default');
  assert.match(r.stderr, /^-> default \(team is rejected, resets [0-2][0-9]:[0-5][0-9]\)/m);
});

// T8: pick honors CLAUDE_ORG_PREFER
test('T8: pick honors CLAUDE_ORG_PREFER', () => {
  const r = runBin(['pick'], env({ CLAUDE_ORG_PREFER: 'other', CLAUDE_ORG_FORCE_PROBE: 'allowed' }));
  assert.strictEqual(r.stdout.trim(), 'other');
});

// T9: auto (allowed) -> claude gets the token env and args pass through
test('T9: auto allowed launches claude with token and args', () => {
  const r = runBin(['auto', '--resume'], env({ CLAUDE_ORG_PREFER: 'team', CLAUDE_ORG_FORCE_PROBE: 'allowed' }));
  assert.match(r.stdout, /^args=--resume$/m);
  assert.match(r.stdout, /^token=sk-ant-oat01-dummy-team$/m);
});

// T10: auto (rejected) -> launches default with no token env
test('T10: auto rejected launches default without token', () => {
  const r = runBin(['auto', '--resume'], env({ CLAUDE_ORG_PREFER: 'team', CLAUDE_ORG_FORCE_PROBE: `rejected:${now() + 3600}` }));
  assert.match(r.stdout, /^args=--resume$/m);
  assert.match(r.stdout, /^token=<unset>$/m, `token leaked into default launch: ${r.stdout}`);
});

// T11: <name> direct -> launches with that token; trailing newline trimmed
test('T11: direct org launch trims token CRLF', () => {
  const r = runBin(['other', '-p', 'hello'], env());
  assert.match(r.stdout, /^args=-p hello$/m);
  assert.match(r.stdout, /^token=sk-ant-oat01-dummy-other$/m, `newline not trimmed: ${r.stdout}`);
});

// T12: unknown org -> exit 1, token-file error, claude not launched
test('T12: unknown org exits 1 without launching claude', () => {
  const r = runBin(['nosuch'], env());
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /token file not found/);
  assert.strictEqual(r.stdout, '');
});

// T13: list -> saved org names, no extension, sorted
test('T13: list prints sorted org names', () => {
  const r = runBin(['list'], env());
  assert.strictEqual(r.stdout, 'other\nteam\n');
});

// T14.1: no args -> usage, exit 2
test('T14.1: no args prints usage and exits 2', () => {
  const r = runBin([], env());
  assert.strictEqual(r.status, 2);
  assert.match(r.stdout, /claude-org auto/);
});

// T14.2 (exception): --help -> usage, exit 0 (CLI convention; was exit 2 in bash)
test('T14.2: --help prints usage and exits 0', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const r = runBin([flag], env());
    assert.strictEqual(r.status, 0, flag);
    assert.match(r.stdout, /claude-org auto/);
  }
});

// T14.3: usage text does not leak source code
test('T14.3: usage output contains no source artifacts', () => {
  const r = runBin([], env());
  assert.doesNotMatch(r.stdout, /process\.exit|require\(|module\.exports/);
});

// Prefer resolution (new behavior): no env -> first token alphabetically;
// CLAUDE_ORG_ORDER head; no tokens -> error exit 1 with guidance.
test('prefer falls back to first token org alphabetically', () => {
  const r = runBin(['pick'], env({ CLAUDE_ORG_FORCE_PROBE: 'allowed' }));
  assert.strictEqual(r.stdout.trim(), 'other');
  assert.match(r.stderr, /^-> other/m);
});

test('prefer falls back to CLAUDE_ORG_ORDER head', () => {
  const r = runBin(['pick'], env({ CLAUDE_ORG_ORDER: 'team,other', CLAUDE_ORG_FORCE_PROBE: 'allowed' }));
  assert.strictEqual(r.stdout.trim(), 'team');
});

test('no tokens at all -> exit 1 with setup guidance', () => {
  const empty = tmpdir();
  const r = runBin(['pick'], { CLAUDE_ORG_TOKEN_DIR: empty });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no org tokens found/);
});
