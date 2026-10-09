'use strict';
const { spawnClaude } = require('./claude-spawn');
const { listOrgs, readToken } = require('./config');
const { probe } = require('./probe');

const KEYS = '"(loggedIn|authMethod|orgName|subscriptionType|email)"';
const KEYS_RE = /"(loggedIn|authMethod|orgName|subscriptionType|email)"/;
const KEYS_RE_DEFAULT = /"(loggedIn|authMethod|orgName|subscriptionType)"/;

// Run `claude auth status` and return combined stdout+stderr (like 2>&1).
function authStatus(envExtra = {}) {
  return new Promise(resolve => {
    const child = spawnClaude(['auth', 'status'], {
      env: { ...process.env, ...envExtra },
    });
    const chunks = [];
    child.stdout.on('data', c => chunks.push(c));
    child.stderr.on('data', c => chunks.push(c));
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function statusAll() {
  for (const name of listOrgs()) {
    const tok = readToken(name);
    if (tok === null) continue;
    console.log(`== ${name} ==`);
    const out = await authStatus({ CLAUDE_CODE_OAUTH_TOKEN: tok });
    const lines = out.split('\n').filter(l => KEYS_RE.test(l));
    console.log(lines.length ? lines.join('\n') : '  (auth status failed)');
    const r = await probe(name);
    if (r.line) console.log(`  ${r.line}`);
  }
  console.log('== default (no env) ==');
  const out = await authStatus();
  console.log(out.split('\n').filter(l => KEYS_RE_DEFAULT.test(l)).join('\n'));
  return 0;
}

module.exports = { statusAll, KEYS };
