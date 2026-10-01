'use strict';
const { resolvePrefer } = require('./config');
const { probe } = require('./probe');

// pick(): which org `auto` should launch on. Returns 'default' when the
// preferred org is over its 5h limit (or its token is missing). The decision
// reason goes to stderr as a single `-> ...` line.
async function pick() {
  const prefer = resolvePrefer();
  const r = await probe(prefer);
  if (r.allowed) {
    let util = r.util;
    if (util !== '?') util = `${Math.trunc(Number(util) * 100)}%`;
    console.error(`-> ${prefer} (5h ${util} used)`);
    return prefer;
  }
  console.error(`-> default (${prefer} is ${r.status}, resets ${r.resetLocal})`);
  return 'default';
}

module.exports = { pick };
