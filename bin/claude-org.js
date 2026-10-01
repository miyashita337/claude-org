#!/usr/bin/env node
'use strict';

const { printUsage } = require('../lib/usage');

// Subcommand implementations land incrementally; unknown subcommands are
// treated as org names once launch is wired up.
const cmd = process.argv[2];

if (cmd === undefined) {
  process.exit(printUsage(2));
}
if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
  process.exit(printUsage(0));
}
process.stdout.write(`claude-org: not implemented yet: ${cmd}\n`);
process.exit(2);
