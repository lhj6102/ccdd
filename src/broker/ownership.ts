import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface OwnerRecord { run_id: string; pid: number; process_identity: string | null; token: string; claimed_at: string }

function processIdentity(pid: number) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `linux:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    return `ps:${execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()}`;
  } catch { return null; }
}
export const ownProcessIdentity = processIdentity(process.pid);

export function ownerAlive(owner: OwnerRecord | undefined) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; }
  const identity = owner.pid === process.pid ? ownProcessIdentity : processIdentity(owner.pid);
  return !owner.process_identity || !identity || owner.process_identity === identity;
}
