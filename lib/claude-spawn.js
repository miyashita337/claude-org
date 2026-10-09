'use strict';
const { spawn } = require('child_process');

// DEP0190: passing an args array with shell:true is deprecated (args are
// concatenated unescaped). On Windows a shell is still needed to resolve
// claude.cmd, so build a single quoted command string instead.
const q = s => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;

function spawnClaude(args, opts = {}) {
  if (process.platform === 'win32') {
    return spawn(['claude', ...args.map(q)].join(' '), { ...opts, shell: true });
  }
  return spawn('claude', args, opts);
}

module.exports = { spawnClaude, q };
