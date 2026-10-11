'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function tokenDir() {
  return process.env.CLAUDE_ORG_TOKEN_DIR || path.join(os.homedir(), '.claude', 'org-tokens');
}

// An org name is used as a file name under the token dir, so anything that
// could leave the dir ("../x", "a/b") or confuse a shell is refused.
const ORG_NAME_RE = /^[\w-]+$/;
function validOrgName(name) {
  return typeof name === 'string' && ORG_NAME_RE.test(name);
}

// Saved org names: *.token files, extension stripped, sorted. A file whose
// name is not a valid org name is left out, and said so once.
const reportedBadNames = new Set();
function listOrgs(dir = tokenDir()) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const names = files.filter(f => f.endsWith('.token')).map(f => f.slice(0, -6));
  for (const n of names) {
    if (validOrgName(n) || reportedBadNames.has(n)) continue;
    reportedBadNames.add(n);
    console.error(`claude-org: ignoring ${path.join(dir, `${n}.token`)}: not an org name (letters, digits, _ and - only)`);
  }
  return names.filter(validOrgName).sort();
}

// Why a token file must be private to the user: the proxy sends its content
// as a Bearer token, so a file another local user can read hands them that
// org. Returns '' when the file is fine, else the reason it is refused.
// Not checked on Windows (no POSIX mode bits there).
function tokenFileProblem(file) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return '';
  const st = fs.statSync(file);
  const me = process.getuid();
  if (st.uid !== me) return `is owned by uid ${st.uid}, not by you (uid ${me})`;
  if (st.mode & 0o077) return `is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 600 ${file}`;
  return '';
}

// Read a token file, stripping CR/LF. Returns null (after printing guidance)
// when the name is invalid, the file is missing or empty, or the file is not
// private to the user.
function readToken(name, dir = tokenDir()) {
  if (!validOrgName(name)) {
    console.error(`claude-org: invalid org name "${name}" (letters, digits, _ and - only)`);
    return null;
  }
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
  const problem = tokenFileProblem(f);
  if (problem) {
    console.error(`claude-org: token file ${f} ${problem}`);
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

module.exports = { tokenDir, listOrgs, readToken, resolvePrefer, validOrgName, tokenFileProblem };
