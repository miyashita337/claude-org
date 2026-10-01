'use strict';
// Port of agent-base tests/test_claude_org.sh cases T15-T17 (watch) to
// node:test. Notification is externalized via CLAUDE_ORG_NOTIFY_CMD.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir, makeTokenDir, runBin } = require('./helpers');

const now = () => Math.floor(Date.now() / 1000);

// A notify stub: appends "title|message" to NOTIFY_LOG.
function makeNotify(dir) {
  const log = path.join(dir, 'notify.log');
  const js = path.join(dir, 'notify-stub.js');
  fs.writeFileSync(js,
    `require('fs').appendFileSync(process.env.NOTIFY_LOG, process.argv[2] + '|' + process.argv[3] + '\\n');\n`);
  return { log, cmd: `${process.execPath} "${js}"` };
}

function baseEnv(dir, extra = {}) {
  return { CLAUDE_ORG_TOKEN_DIR: dir, CLAUDE_ORG_PREFER: 'team', ...extra };
}

// T15: limited -> recovered is detected once, notify fires once, exit 0.
test('T15: watch detects recovery and notifies once', () => {
  const dir = makeTokenDir({ team: 'dummy' });
  const work = tmpdir();
  const n = makeNotify(work);
  const r = runBin(['watch'], baseEnv(dir, {
    CLAUDE_ORG_FORCE_PROBE: `rejected_until:${now() + 2}`,
    CLAUDE_ORG_WATCH_MAX_SLEEP: '1',
    CLAUDE_ORG_NOTIFY_CMD: n.cmd,
    NOTIFY_LOG: n.log,
  }), { timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /上限中 .* 1s 後に再確認/);
  assert.match(r.stdout, /team 復活/);
  const lines = fs.readFileSync(n.log, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /^Claude team 復活\|claude-org auto --resume/);
});

// T16: already allowed -> immediate exit, notify once
test('T16: watch exits immediately when already allowed', () => {
  const dir = makeTokenDir({ team: 'dummy' });
  const work = tmpdir();
  const n = makeNotify(work);
  const start = Date.now();
  const r = runBin(['watch'], baseEnv(dir, {
    CLAUDE_ORG_FORCE_PROBE: 'allowed',
    CLAUDE_ORG_NOTIFY_CMD: n.cmd,
    NOTIFY_LOG: n.log,
  }), { timeout: 30000 });
  const elapsed = (Date.now() - start) / 1000;
  assert.strictEqual(r.status, 0);
  assert.ok(elapsed <= 5, `elapsed=${elapsed}`);
  assert.strictEqual(fs.readFileSync(n.log, 'utf8').trim().split('\n').length, 1);
});

// T17: no notify command -> terminal-only message, still exit 0
test('T17: watch without notify command prints terminal-only note', () => {
  const dir = makeTokenDir({ team: 'dummy' });
  const r = runBin(['watch'], baseEnv(dir, { CLAUDE_ORG_FORCE_PROBE: 'allowed' }), { timeout: 30000 });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /端末通知のみ/);
});
