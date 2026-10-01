#!/usr/bin/env node
'use strict';

const { printUsage } = require('../lib/usage');
const { listOrgs, resolvePrefer } = require('../lib/config');
const { probe } = require('../lib/probe');
const { pick } = require('../lib/pick');
const { launch } = require('../lib/launch');
const { statusAll } = require('../lib/status');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
      return printUsage(2);
    case '-h':
    case '--help':
    case 'help':
      return printUsage(0);
    case 'list':
      for (const o of listOrgs()) console.log(o);
      return 0;
    case 'status':
      return statusAll();
    case 'probe': {
      const r = await probe(rest[0] || resolvePrefer());
      if (r.line) console.log(r.line);
      return r.allowed ? 0 : 1;
    }
    case 'pick':
      console.log(await pick());
      return 0;
    case 'auto':
      return launch(await pick(), rest);
    case 'watch':
    case 'proxy':
      // Wired up in the proxy/watch port (S3).
      console.error(`claude-org: ${cmd} is not implemented yet`);
      return 2;
    default:
      // <name> launches claude with that org's token.
      return launch(cmd, rest);
  }
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(`claude-org: ${e.message}`);
    process.exit(1);
  });
