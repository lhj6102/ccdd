import { runDiagnostic } from './load-check.js';
try {
  const report = await runDiagnostic(JSON.parse(process.argv[2]));
  process.send?.(report);
  if (report.status !== 'GREEN' || report.completed !== report.requests) process.exitCode = 1;
} catch (error) { console.error(error); process.exitCode = 1; }
