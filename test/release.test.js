'use strict';
// Pure parts of scripts/release.js: version arithmetic and the CHANGELOG rewrite.
// The git / npm side effects are not exercised here.
const test = require('node:test');
const assert = require('node:assert');
const { nextVersion, releaseChangelog, localDate } = require('../scripts/release');

test('R1: patch / minor / major bump', () => {
  assert.strictEqual(nextVersion('0.2.1', 'patch'), '0.2.2');
  assert.strictEqual(nextVersion('0.2.1', 'minor'), '0.3.0');
  assert.strictEqual(nextVersion('0.2.1', 'major'), '1.0.0');
});

test('R2: explicit version must be greater than the current one', () => {
  assert.strictEqual(nextVersion('0.2.1', '0.4.0'), '0.4.0');
  assert.throws(() => nextVersion('0.2.1', '0.2.1'), /greater than 0\.2\.1/);
  assert.throws(() => nextVersion('0.2.1', '0.1.9'), /greater than 0\.2\.1/);
});

test('R3: bad bump argument is rejected', () => {
  assert.throws(() => nextVersion('0.2.1', 'next'), /patch, minor, major or X\.Y\.Z/);
  assert.throws(() => nextVersion('0.2.1', ''), /patch, minor, major or X\.Y\.Z/);
  assert.throws(() => nextVersion('0.2', 'patch'), /current version/);
});

const BASE = '# Changelog\n\n## Unreleased\n\n- fix one\n- fix two\n\n## 0.2.1 — 2026-10-10\n\n- old\n';

test('R4: Unreleased becomes the version heading and a fresh Unreleased is added', () => {
  const out = releaseChangelog(BASE, '0.2.2', '2026-10-11');
  assert.strictEqual(out,
    '# Changelog\n\n## Unreleased\n\n## 0.2.2 — 2026-10-11\n\n- fix one\n- fix two\n\n## 0.2.1 — 2026-10-10\n\n- old\n');
});

test('R5: missing or empty Unreleased section stops the release', () => {
  assert.throws(() => releaseChangelog('# Changelog\n\n## 0.2.1 — x\n\n- old\n', '0.2.2', 'd'),
    /no "## Unreleased" section/);
  assert.throws(() => releaseChangelog('# Changelog\n\n## Unreleased\n\n## 0.2.1 — x\n\n- old\n', '0.2.2', 'd'),
    /"## Unreleased" has no entries/);
});

test('R6: CRLF changelog is handled and kept CRLF', () => {
  const out = releaseChangelog(BASE.replace(/\n/g, '\r\n'), '0.2.2', '2026-10-11');
  assert.match(out, /## Unreleased\r\n\r\n## 0\.2\.2 — 2026-10-11\r\n\r\n- fix one\r\n/);
  assert.ok(!/[^\r]\n/.test(out), 'a bare LF slipped in');
});

test('R7: local date is YYYY-MM-DD', () => {
  assert.strictEqual(localDate(new Date(2026, 0, 5)), '2026-01-05');
});
