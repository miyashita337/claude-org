'use strict';
const { spawn } = require('child_process');
const { resolvePrefer } = require('./config');
const { probe } = require('./probe');
const { hhmmss } = require('./time');

const sleep = s => new Promise(r => setTimeout(r, s * 1000));

// Externalized notification: CLAUDE_ORG_NOTIFY_CMD is run as
// `<cmd> <title> <message>` via the OS shell. Terminal output always happens.
function notify(title, message) {
  const cmd = process.env.CLAUDE_ORG_NOTIFY_CMD;
  if (!cmd) {
    console.log('  (CLAUDE_ORG_NOTIFY_CMD 未設定のため端末通知のみ)');
    return Promise.resolve();
  }
  // Quote args ourselves: spawn(shell:true) does not quote on Windows and the
  // title/message contain spaces.
  const q = s => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
  return new Promise(resolve => {
    const child = spawn(`${cmd} ${q(title)} ${q(message)}`, { shell: true, stdio: 'ignore' });
    child.on('error', () => {
      console.log('  (通知コマンドの実行に失敗。端末通知のみ)');
      resolve();
    });
    child.on('close', code => {
      if (code) console.log('  (通知コマンドが失敗。端末通知のみ)');
      resolve();
    });
  });
}

// watch: poll the preferred org until its 5h window recovers, notify once, exit.
// Re-check interval: (5h_reset - now + 30s), clamped to [min, max]. max is
// CLAUDE_ORG_WATCH_MAX_SLEEP (default 18000s); min is 60s unless max < 60,
// in which case min = max (so tests can shrink the loop).
async function watch() {
  const prefer = resolvePrefer();
  const maxSleep = Number(process.env.CLAUDE_ORG_WATCH_MAX_SLEEP || 18000);
  let minSleep = 60;
  if (maxSleep < minSleep) minSleep = maxSleep;

  for (;;) {
    const r = await probe(prefer);
    if (r.allowed) {
      console.log(`${hhmmss()} ${prefer} 復活: ${r.line}`);
      console.log('  → claude-org auto --resume で戻れます');
      await notify(`Claude ${prefer} 復活`, `claude-org auto --resume で ${prefer} に戻れます`);
      return 0;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    let wait;
    if (r.reset !== '?' && Number(r.reset) > nowSec) {
      wait = Number(r.reset) - nowSec + 30;
    } else {
      wait = 600;
    }
    wait = Math.min(Math.max(wait, minSleep), maxSleep);
    console.log(`${hhmmss()} ${prefer} 上限中 (${r.line}) → ${wait}s 後に再確認 (reset ${r.resetLocal})`);
    await sleep(wait);
  }
}

module.exports = { watch };
