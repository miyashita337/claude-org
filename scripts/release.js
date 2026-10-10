#!/usr/bin/env node
'use strict';
// One-command release: checks -> tests -> CHANGELOG + package.json -> commit ->
// tag -> push -> npm publish -> confirm the registry serves the new version.
//
//   npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--no-publish]
//
// --dry-run    run every check and print the plan; change nothing
// --no-publish stop after pushing the commit and tag (publish later with
//              `npm publish`)
//
// Release notes come from the "## Unreleased" section of CHANGELOG.md, which
// must have at least one entry. It is renamed to "## X.Y.Z — YYYY-MM-DD" and a
// fresh empty "## Unreleased" is put above it for the next release.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BRANCH = 'main';
const REMOTE = 'origin';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function nextVersion(current, bump) {
  const cur = SEMVER.exec(current || '');
  if (!cur) throw new Error(`current version "${current}" in package.json is not X.Y.Z`);
  const [maj, min, pat] = cur.slice(1).map(Number);
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  if (bump === 'major') return `${maj + 1}.0.0`;
  const want = SEMVER.exec(bump || '');
  if (!want) throw new Error(`version argument must be patch, minor, major or X.Y.Z (got "${bump}")`);
  const a = want.slice(1).map(Number);
  const b = [maj, min, pat];
  const greater = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  if (!greater) throw new Error(`version ${bump} must be greater than ${current}`);
  return bump;
}

// Rename "## Unreleased" to the version heading and add a new empty
// "## Unreleased" above it. Keeps the file's line endings.
function releaseChangelog(text, version, date) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => l.trim() === '## Unreleased');
  if (start === -1) throw new Error('CHANGELOG.md has no "## Unreleased" section; add one with the changes to release');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  if (!lines.slice(start + 1, end).some(l => l.trim().startsWith('- '))) {
    throw new Error('"## Unreleased" has no entries in CHANGELOG.md; write the release notes there first');
  }
  lines.splice(start, 1, '## Unreleased', '', `## ${version} — ${date}`);
  return lines.join(eol);
}

function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// git is a real executable on every platform, so it runs without a shell.
function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || '').trim()}`);
  }
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

// npm is npm.cmd on Windows and needs a shell. A single command string avoids
// the Node DEP0190 warning; every argument passed here is a fixed word or a
// validated X.Y.Z version, so nothing needs quoting.
function npm(argStr, { inherit = false, allowFail = false } = {}) {
  const r = spawnSync(`npm ${argStr}`, {
    cwd: ROOT, shell: true, encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe',
  });
  if (r.status !== 0 && !allowFail) throw new Error(`npm ${argStr} failed (exit ${r.status})`);
  return { ok: r.status === 0, out: (r.stdout || '').trim() };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const pos = argv.filter(a => !a.startsWith('--'));
  for (const f of flags) {
    if (f !== '--dry-run' && f !== '--no-publish') throw new Error(`unknown option ${f}`);
  }
  if (pos.length !== 1) {
    throw new Error('usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--no-publish]');
  }
  const dryRun = flags.has('--dry-run');
  const publish = !flags.has('--no-publish');

  const pkgPath = path.join(ROOT, 'package.json');
  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText);
  const version = nextVersion(pkg.version, pos[0]);
  const tag = `v${version}`;
  const say = m => console.log(`release: ${m}`);
  say(`${pkg.name} ${pkg.version} -> ${version}${dryRun ? ' (dry run)' : ''}`);

  // --- checks (nothing is changed before all of these pass) ---
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (branch !== BRANCH) throw new Error(`run on ${BRANCH} (current branch: ${branch})`);
  if (git(['status', '--porcelain', '--untracked-files=no']).out) {
    throw new Error('tracked files have uncommitted changes; commit or stash them first');
  }
  git(['fetch', '--quiet', REMOTE, BRANCH, '--tags']);
  if (git(['rev-parse', 'HEAD']).out !== git(['rev-parse', `${REMOTE}/${BRANCH}`]).out) {
    throw new Error(`${BRANCH} is not in sync with ${REMOTE}/${BRANCH}; pull or push first`);
  }
  if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFail: true }).ok) {
    throw new Error(`tag ${tag} already exists`);
  }
  if (npm(`view ${pkg.name}@${version} version`, { allowFail: true }).out === version) {
    throw new Error(`${pkg.name}@${version} is already on the npm registry`);
  }
  if (publish && !npm('whoami', { allowFail: true }).ok) {
    throw new Error('not logged in to npm; run "npm login" first (or pass --no-publish)');
  }
  const changelogPath = path.join(ROOT, 'CHANGELOG.md');
  const changelog = releaseChangelog(fs.readFileSync(changelogPath, 'utf8'), version, localDate());
  say('checks passed');

  say('running tests');
  npm('test', { inherit: true });

  if (dryRun) {
    say(`dry run: would write CHANGELOG.md / package.json, commit "chore: release ${tag}", tag ${tag}, push ${BRANCH} + ${tag}${publish ? ', npm publish' : ''}`);
    return 0;
  }

  // --- changes ---
  fs.writeFileSync(changelogPath, changelog);
  fs.writeFileSync(pkgPath, pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`));
  git(['add', 'CHANGELOG.md', 'package.json']);
  git(['commit', '-q', '-m', `chore: release ${tag}`]);
  git(['tag', tag]);
  say(`committed and tagged ${tag}`);
  try {
    git(['push', '-q', REMOTE, BRANCH]);
    git(['push', '-q', REMOTE, tag]);
  } catch (e) {
    throw new Error(`${e.message}\nThe release commit and tag exist only locally. Fix the push problem, then run:\n  git push ${REMOTE} ${BRANCH} && git push ${REMOTE} ${tag}${publish ? ' && npm publish' : ''}`);
  }
  say(`pushed ${BRANCH} and ${tag}`);

  if (!publish) {
    say(`skipped npm publish; run "npm publish" when ready`);
    return 0;
  }
  say('publishing to npm (enter the one-time password if npm asks for it)');
  try {
    npm('publish', { inherit: true });
  } catch (e) {
    throw new Error(`${e.message}\n${tag} is already pushed. Fix the cause and run "npm publish" again.`);
  }
  // The registry can take a few seconds to serve a new version.
  for (let i = 0; i < 10; i++) {
    if (npm(`view ${pkg.name} version`, { allowFail: true }).out === version) {
      say(`npm now serves ${pkg.name}@${version}. Update with: npm install -g ${pkg.name}@latest`);
      return 0;
    }
    sleep(3000);
  }
  throw new Error(`npm publish finished but the registry does not report ${version} yet; check with "npm view ${pkg.name} version"`);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { nextVersion, releaseChangelog, localDate };
