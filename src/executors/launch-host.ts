import { spawn } from 'node:child_process';
// This inert host cannot start user work before its parent records the lease PID.
// It remains the detached group leader so orphan cleanup never confuses descendants.
const timer = setTimeout(() => process.exit(1), 10000);
let started = false;
const killGroup = () => { try { if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL'); } catch {} process.exit(1); };
process.once('disconnect', () => { if (started) killGroup(); else process.exit(1); });
process.once('message', message => {
  if (message !== 'admitted' || started) return;
  started = true; clearTimeout(timer);
  const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['inherit', 'inherit', 'inherit'], env: process.env, windowsHide: true });
  child.once('error', () => process.exit(1));
  child.once('exit', (code, signal) => { if (signal) { try { process.kill(process.pid, signal); } catch { process.exit(1); } } else process.exit(code ?? 1); });
});
