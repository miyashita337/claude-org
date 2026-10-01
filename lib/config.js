'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function tokenDir() {
  return process.env.CLAUDE_ORG_TOKEN_DIR || path.join(os.homedir(), '.claude', 'org-tokens');
}

// Saved org names: *.token files, extension stripped, sorted.
function listOrgs(dir = tokenDir()) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files.filter(f => f.endsWith('.token')).map(f => f.slice(0, -6)).sort();
}

// Read a token file, stripping CR/LF. Returns null (after printing guidance)
// when the file is missing or empty.
function readToken(name, dir = tokenDir()) {
  const f = path.join(dir, `${name}.token`);
  let raw = '';
  try {
    raw = fs.readFileSync(f, 'utf8');
  } catch {
    /* fall through to the error below */
  }
  if (!raw.trim()) {
    console.error(`claude-org: token file not found: ${f}`);
    console.error(`  取得: claude setup-token でブラウザから org '${name}' を選び、出力トークンを ${f} に保存（改行なし）`);
    return null;
  }
  return raw.replace(/[\r\n]/g, '');
}

// Preferred org resolution order:
//   1. CLAUDE_ORG_PREFER
//   2. first entry of CLAUDE_ORG_ORDER
//   3. first .token file in the token dir (alphabetical, same rule as the proxy)
//   4. no tokens at all -> print setup guidance and exit 1
function resolvePrefer() {
  if (process.env.CLAUDE_ORG_PREFER) return process.env.CLAUDE_ORG_PREFER;
  const order = (process.env.CLAUDE_ORG_ORDER || '').split(',').map(s => s.trim()).filter(Boolean);
  if (order.length) return order[0];
  const orgs = listOrgs();
  if (orgs.length) return orgs[0];
  console.error(`claude-org: no org tokens found in ${tokenDir()}`);
  console.error(`  取得: claude setup-token で org を選び、出力トークンを ${tokenDir()}/<name>.token に保存（改行なし）`);
  process.exit(1);
}

module.exports = { tokenDir, listOrgs, readToken, resolvePrefer };
