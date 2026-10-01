'use strict';

// epoch seconds -> local HH:MM ('?' on garbage). Replaces the GNU/BSD `date`
// dependency of the bash version.
function epochToHHMM(epochSec) {
  const d = new Date(Number(epochSec) * 1000);
  if (Number.isNaN(d.getTime())) return '?';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function hhmmss(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = { epochToHHMM, hhmmss };
