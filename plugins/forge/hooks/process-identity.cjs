'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// A PID alone can name a different process after reuse. Query the OS birth
// identity, never infer it from wall time minus uptime. Unknown means retain
// ownership. Commands use only a validated integer, without a shell.
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^\d+$/.test(start) && boot ? `linux:${boot}:${start}` : null;
    }
    const options = { encoding: 'utf8', timeout: 200, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    if (process.platform === 'darwin') {
      const result = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
        { ...options, env: { ...process.env, LC_ALL: 'C' } }).trim();
      return /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(result) ? `darwin:${result}` : null;
    }
  } catch { /* unavailable, denied, or process exited: caller also checks PID */ }
  return null;
}

module.exports = { processIdentity };
