'use strict';
const { spawnClaude } = require('./claude-spawn');
const { readToken } = require('./config');

// After a forwarded SIGTERM / SIGHUP, how long claude gets to exit on its own
// before it is killed. Keeps a hung claude from outliving a supervisor's kill.
const KILL_GRACE_MS = 10 * 1000;
const FORWARDED_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'];

// Spawn claude with inherited stdio and extra env (a key set to undefined is
// removed from the inherited env). Resolves to the child's exit code (128+n
// when killed by signal n, like a shell would report).
//
// Signals sent to this launcher (a supervisor's reaper or timeout kills the
// launcher pid, not claude) are forwarded to claude, and the launcher waits
// for claude to exit instead of dying first and leaving claude orphaned with
// its proxy gone. SIGINT from a terminal (Ctrl-C) reaches both processes at
// once; forwarding it would give claude a second Ctrl-C, which it reads as
// "exit". So with a terminal on any of stdin/stdout/stderr, SIGINT is left to
// claude; with none (headless, under a supervisor) it is forwarded like the
// others.
// Windows env names are case-insensitive, so a removed key is matched that way
// there (an inherited "Anthropic_Auth_Token" must not survive).
function childEnv(envExtra = {}) {
  const env = { ...process.env, ...envExtra };
  const same = process.platform === 'win32' ? (a, b) => a.toUpperCase() === b.toUpperCase() : (a, b) => a === b;
  for (const [k, v] of Object.entries(envExtra)) {
    if (v !== undefined) continue;
    for (const name of Object.keys(env)) if (same(name, k)) delete env[name];
  }
  return env;
}

function runClaude(args, envExtra = {}) {
  return new Promise(resolve => {
    const child = spawnClaude(args, {
      stdio: 'inherit',
      env: childEnv(envExtra),
    });
    let killTimer = null;
    const handlers = new Map();
    for (const sig of FORWARDED_SIGNALS) {
      const h = () => {
        if (sig === 'SIGINT' && (process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY)) return;
        try { child.kill(sig); } catch { /* already exited */ }
        if (!killTimer) {
          killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already exited */ } }, KILL_GRACE_MS);
          killTimer.unref();
        }
      };
      handlers.set(sig, h);
      process.on(sig, h);
    }
    const done = code => {
      for (const [sig, h] of handlers) process.off(sig, h);
      if (killTimer) clearTimeout(killTimer);
      resolve(code);
    };
    child.on('error', e => {
      console.error(`claude-org: failed to launch claude: ${e.message}`);
      done(1);
    });
    child.on('exit', (code, signal) => {
      if (code !== null) return done(code);
      done(signal ? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1 }[signal] || 1) : 1);
    });
  });
}

// launch(name, args): 'default' launches a plain `claude`; a token org launches
// with CLAUDE_CODE_OAUTH_TOKEN set. Returns the process exit code.
// The token goes into claude's environment, where a prompt-injected claude can
// read it; unattended runs should use `claude-org proxy` instead (README).
async function launch(name, args) {
  if (name === 'default') return runClaude(args);
  const tok = readToken(name);
  if (tok === null) return 1;
  return runClaude(args, { CLAUDE_CODE_OAUTH_TOKEN: tok });
}

module.exports = { runClaude, launch, childEnv };
