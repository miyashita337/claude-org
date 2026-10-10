'use strict';
const { resolvePrefer } = require('./config');
const { probe } = require('./probe');

// pick(): which org `auto` should launch on. Returns 'default' when the
// preferred org is over its 5h limit (or its token is missing), or refused the
// model set in CLAUDE_ORG_PROBE_MODEL. The decision reason goes to stderr as a
// single `-> ...` line.
async function pick() {
  const prefer = resolvePrefer();
  const r = await probe(prefer);
  if (r.usable) {
    let util = r.util;
    if (util !== '?') util = `${Math.trunc(Number(util) * 100)}%`;
    console.error(`-> ${prefer} (5h ${util} used)`);
    return prefer;
  }
  if (r.allowed) {
    console.error(`-> default (${prefer} refused model ${r.model})`);
  } else {
    console.error(`-> default (${prefer} is ${r.status}, resets ${r.resetLocal})`);
  }
  return 'default';
}

module.exports = { pick };
