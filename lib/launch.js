'use strict';
const { spawnClaude } = require('./claude-spawn');
const { readToken } = require('./config');

// Spawn claude with inherited stdio and extra env. Resolves to the child's
// exit code (128+n when killed by signal n, like a shell would report).
function runClaude(args, envExtra = {}) {
  return new Promise(resolve => {
    const child = spawnClaude(args, {
      stdio: 'inherit',
      env: { ...process.env, ...envExtra },
    });
    child.on('error', e => {
      console.error(`claude-org: failed to launch claude: ${e.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (code !== null) return resolve(code);
      resolve(signal ? 128 + ({ SIGINT: 2, SIGTERM: 15 }[signal] || 1) : 1);
    });
  });
}

// launch(name, args): 'default' launches a plain `claude`; a token org launches
// with CLAUDE_CODE_OAUTH_TOKEN set. Returns the process exit code.
async function launch(name, args) {
  if (name === 'default') return runClaude(args);
  const tok = readToken(name);
  if (tok === null) return 1;
  return runClaude(args, { CLAUDE_CODE_OAUTH_TOKEN: tok });
}

module.exports = { runClaude, launch };
