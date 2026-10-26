#!/usr/bin/env node
'use strict';

const { printUsage } = require('../lib/usage');
const { listOrgs, resolvePrefer } = require('../lib/config');
const { probe } = require('../lib/probe');
const { pick } = require('../lib/pick');
const { launch } = require('../lib/launch');
const { statusAll } = require('../lib/status');
const { watch } = require('../lib/watch');
const { proxyLaunch } = require('../lib/proxy');

// `--model <id>` / `--model=<id>` for probe and status. Returns the model
// ('' when absent) and the remaining args. A missing value is an error rather
// than a silent fall back to the default model.
function takeModel(args) {
  const rest = [];
  let model = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i].startsWith('--model=')) {
      model = args[i] === '--model' ? args[++i] : args[i].slice(8);
      if (!model || model.startsWith('-')) throw new Error('--model needs a model id, e.g. --model claude-fable-5-1');
    } else {
      rest.push(args[i]);
    }
  }
  return { model, rest };
}

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
      return statusAll(takeModel(rest).model || undefined);
    case 'probe': {
      const { model, rest: names } = takeModel(rest);
      const r = await probe(names[0] || resolvePrefer(), model || undefined);
      if (r.line) console.log(r.line);
      return r.usable ? 0 : 1;
    }
    case 'pick':
      console.log(await pick());
      return 0;
    case 'auto':
      return launch(await pick(), rest);
    case 'watch':
      return watch();
    case 'proxy':
      return proxyLaunch(rest);
    default:
      // <name> launches claude with that org's token.
      return launch(cmd, rest);
  }
}

// Exit by letting the event loop drain instead of process.exit(): on Windows
// (Node 24.10), process.exit() after two or more fetch() calls aborts with the
// libuv assertion "!(handle->flags & UV_HANDLE_CLOSING)" in src\win\async.c
// and exit code 127 instead of ours (#36). If something still holds the loop
// open, the unref'd timer exits the old way so the CLI never hangs.
const EXIT_GRACE_MS = 5000;
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), EXIT_GRACE_MS).unref();
}

main()
  .then(code => finish(code))
  .catch(e => {
    console.error(`claude-org: ${e.message}`);
    finish(1);
  });
