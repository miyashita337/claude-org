'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'claude-org.js');

function run(args, env = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_ORG_')) delete e[k];
  return spawnSync(process.execPath, [BIN, ...args], { env: { ...e, ...env }, encoding: 'utf8' });
}

test('no args prints usage and exits 2', () => {
  const r = run([]);
  assert.strictEqual(r.status, 2);
  assert.match(r.stdout, /claude-org auto/);
});

test('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /claude-org auto/);
});
