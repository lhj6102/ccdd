import { runDiagnostic } from './load-check.js';

/** Receive one bounded-lifetime initialization message, including large scenarios. */
const options = new Promise<Parameters<typeof runDiagnostic>[0]>((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error('Load-check initialization timed out.')); }, 30_000);
  const disconnected = () => { cleanup(); reject(new Error('Load-check parent disconnected before initialization.')); };
  const received = (value: unknown) => {
    cleanup();
    if (!value || typeof value !== 'object') reject(new Error('Invalid load-check initialization.'));
    else resolve(value as Parameters<typeof runDiagnostic>[0]);
  };
  const cleanup = () => { clearTimeout(timer); process.off('disconnect', disconnected); process.off('message', received); };
  process.once('message', received); process.once('disconnect', disconnected);
});
try {
  const report = await runDiagnostic(await options);
  await new Promise<void>((resolve, reject) => {
    if (!process.send) { reject(new Error('Load-check requires IPC.')); return; }
    process.send(report, error => error ? reject(error) : resolve());
  });
  if (report.status !== 'GREEN' || report.completed !== report.requests) process.exitCode = 1;
} catch (error) { console.error(error); process.exitCode = 1; }
finally { if (process.connected) process.disconnect(); }
