'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'claude-org.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-org-test-'));
}

// { 'team': 'sk-ant-oat01-dummy-team' } -> dir containing <name>.token files
function makeTokenDir(files) {
  const dir = path.join(tmpdir(), 'tokens');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.token`), content);
  }
  return dir;
}

const CLAUDE_STUB_JS = `'use strict';
const argline = 'args=' + process.argv.slice(2).join(' ');
console.log(argline);
console.log('token=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN || '<unset>'));
console.log('base=' + (process.env.ANTHROPIC_BASE_URL || '<unset>'));
console.log('auth=' + (process.env.ANTHROPIC_AUTH_TOKEN || '<unset>'));
console.log('proxyflag=' + (process.env.CLAUDE_ORG_PROXY || '<unset>'));
console.log('ttl=' + (process.env.CLAUDE_CODE_PROMPT_CACHE_TTL || '<unset>'));
console.log('toolsearch=' + (process.env.ENABLE_TOOL_SEARCH || '<unset>'));
const base = process.env.ANTHROPIC_BASE_URL;
if (base) {
  fetch(base + '/v1/models', { method: 'POST', body: '' })
    .then(r => console.log('proxy_alive=' + r.status))
    .catch(() => console.log('proxy_alive=000'));
}
`;

// Fake `claude` on PATH. POSIX runs ./claude (sh wrapper), Windows resolves
// claude.cmd; both defer to claude-stub.js so behavior is identical.
function makeClaudeStub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(js, CLAUDE_STUB_JS);
  const sh = path.join(dir, 'claude');
  fs.writeFileSync(sh, `#!/usr/bin/env sh\nexec node "${js.replace(/\\/g, '/')}" "$@"\n`);
  fs.chmodSync(sh, 0o755);
  fs.writeFileSync(path.join(dir, 'claude.cmd'), `@echo off\r\nnode "${js}" %*\r\n`);
  return dir;
}

// Vars that must not leak from the parent environment into the child
// (a real settings.json env block could set these and fake a PASS).
const STRIP_ENV = ['CLAUDE_CODE_PROMPT_CACHE_TTL', 'ENABLE_TOOL_SEARCH'];
function cleanEnv(extra = {}) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_ORG_')) delete e[k];
  for (const k of STRIP_ENV) delete e[k];
  return { ...e, ...extra };
}

// Run the real bin as a subprocess. CLAUDE_ORG_* inherited from the parent is
// stripped first so tests are deterministic.
function runBin(args, env = {}, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: cleanEnv(env),
    encoding: 'utf8',
    timeout: opts.timeout || 60000,
  });
}

// Async variant: use when the test's own event loop must stay alive
// (e.g. the test hosts a stub server the child talks to).
function runBinAsync(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN, ...args], { env: cleanEnv(env) });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', err => resolve({ status: 1, stdout, stderr: stderr + String(err) }));
    child.on('close', code => resolve({ status: code, stdout, stderr }));
  });
}

// Standalone upstream stub as a child process (also usable when the parent
// is blocked). Writes "upstream <port>" to stderr once listening.
function startUpstreamProc(code) {
  const dir = tmpdir();
  const file = path.join(dir, 'upstream.js');
  fs.writeFileSync(file, code);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('upstream did not start')), 10000);
    child.stderr.on('data', c => {
      buf += c;
      const m = buf.match(/upstream (\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    });
  });
}

module.exports = { BIN, tmpdir, makeTokenDir, makeClaudeStub, runBin, runBinAsync, startUpstreamProc };
